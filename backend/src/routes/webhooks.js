// backend/src/routes/webhooks.js
// 📡 COMPLETE WEBHOOK ROUTES - Shopify, Resend, Telnyx SMS, Monitoring, Testing
// ✅ FIXED: Unique opens/clicks counting for accurate rates
// ✅ FIXED: Removed duplicate SMS attribution (now in webhooksController)
// ✅ FIXED: Removed JSON.parse error on req.body
const express = require('express');
const router = express.Router();
const webhooksController = require('../controllers/webhooksController');
const { validateShopifyWebhook } = require('../middleware/validateWebhook');
const { webhookLimiter } = require('../middleware/rateLimiter');

// ==================== SMS IMPORTS ====================
let smsController = null;
let SmsSubscriber = null;

try {
  smsController = require('../controllers/smsController');
  SmsSubscriber = require('../models/SmsSubscriber');
  console.log('📱 SMS Controller loaded for webhooks');
} catch (err) {
  console.log('⚠️  SMS Controller not available:', err.message);
}

// Aplicar rate limiter a todos los webhooks
router.use(webhookLimiter);

// ==================== SHOPIFY WEBHOOKS ====================

// Customer webhooks
router.post('/customers/create', validateShopifyWebhook, webhooksController.customerCreate);
router.post('/customers/update', validateShopifyWebhook, webhooksController.customerUpdate);

// Order webhooks (SMS attribution is now handled inside webhooksController.orderCreate)
router.post('/orders/create', validateShopifyWebhook, webhooksController.orderCreate);
router.post('/orders/update', validateShopifyWebhook, webhooksController.orderUpdate);
router.post('/orders/fulfilled', validateShopifyWebhook, webhooksController.orderFulfilled);
router.post('/orders/cancelled', validateShopifyWebhook, webhooksController.orderCancelled);
router.post('/orders/paid', validateShopifyWebhook, webhooksController.orderPaid);

// Checkout webhooks (Abandoned Cart Tracking)
router.post('/checkouts/create', validateShopifyWebhook, webhooksController.checkoutCreate);
router.post('/checkouts/update', validateShopifyWebhook, webhooksController.checkoutUpdate);

// Cart webhooks (alternative to checkout)
router.post('/carts/create', validateShopifyWebhook, webhooksController.checkoutCreate);
router.post('/carts/update', validateShopifyWebhook, webhooksController.checkoutUpdate);

// Product webhooks
router.post('/products/update', validateShopifyWebhook, webhooksController.productUpdate);

// Refund webhooks
router.post('/refunds/create', validateShopifyWebhook, webhooksController.refundCreate);

// ==================== TELNYX SMS WEBHOOKS ====================

/**
 * Handler de webhooks de Telnyx SMS
 * Eventos: message.sent, message.finalized, message.received
 */
router.post('/telnyx', async (req, res) => {
  // Responder inmediatamente (Telnyx requiere respuesta rápida)
  res.status(200).json({ received: true });
  
  if (!smsController) {
    console.log('⚠️  SMS Controller not available for Telnyx webhook');
    return;
  }
  
  // Procesar en background
  setImmediate(async () => {
    try {
      const telnyxService = require('../services/telnyxService');
      const webhookData = telnyxService.processWebhook(req.body);
      
      if (!webhookData.valid) {
        console.log('⚠️  Invalid Telnyx webhook:', webhookData.error);
        return;
      }
      
      if (webhookData.ignored) {
        console.log(`📨 Telnyx webhook ignored: ${webhookData.eventType}`);
        return;
      }
      
      console.log(`📱 Telnyx webhook: ${webhookData.eventType} - ${webhookData.messageId} - ${webhookData.status}`);
      
      // Manejar mensaje entrante (STOP para opt-out)
      if (webhookData.isInbound) {
        await handleInboundSms(webhookData);
        return;
      }
      
      // Actualizar estado del SMS saliente
      if (webhookData.messageId) {
        await updateSmsStatus(webhookData);
      }
      
    } catch (error) {
      console.error('❌ Telnyx Webhook Error:', error);
    }
  });
});

// ==================== MONITORING ENDPOINTS ====================

// Get recent webhook logs
router.get('/logs', webhooksController.getWebhookLogs);

// Get webhook statistics
router.get('/stats', webhooksController.getWebhookStats);

// Get single webhook log details
router.get('/logs/:id', webhooksController.getWebhookLog);

// Get abandoned cart tracker status
router.get('/abandoned-carts/status', webhooksController.getAbandonedCartStatus);

// ==================== TESTING ENDPOINT ====================

// Send test webhook
router.post('/test', webhooksController.testWebhook);

// ==================== RESEND WEBHOOKS ====================

/**
 * Handler de webhooks de Resend - CON BOUNCE MANAGEMENT AUTOMÁTICO
 * 
 * IMPORTANTE - Lógica de stats:
 * - 'sent' → Se incrementa en emailQueue.js worker (NO aquí)
 * - 'delivered' → Se incrementa AQUÍ vía webhook
 * - 'opened', 'clicked', etc → Se incrementan AQUÍ vía webhook (✅ ÚNICOS solamente)
 * - 'bounced' → ✅ Auto-marca customer como bounced
 */
router.post('/resend', async (req, res) => {
  try {
    const event = req.body;
    
    if (!event || !event.data) {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    
    const { type, data } = event;
    
    // Extraer tags (soporta array y objeto)
    let campaignId, customerId, flowId, executionId;
    
    if (data.tags && Array.isArray(data.tags)) {
      campaignId = data.tags.find(t => t.name === 'campaign_id')?.value;
      customerId = data.tags.find(t => t.name === 'customer_id')?.value;
      flowId = data.tags.find(t => t.name === 'flow_id')?.value;
      executionId = data.tags.find(t => t.name === 'execution_id')?.value;
    } else if (data.tags && typeof data.tags === 'object') {
      campaignId = data.tags.campaign_id;
      customerId = data.tags.customer_id;
      flowId = data.tags.flow_id;
      executionId = data.tags.execution_id;
    }
    
    // Si no hay campaign ni flow, ignorar
    if (!campaignId && !flowId) {
      return res.status(200).json({ received: true });
    }
    
    const EmailEvent = require('../models/EmailEvent');
    const EmailSend = require('../models/EmailSend');
    const Campaign = require('../models/Campaign');
    const Customer = require('../models/Customer');
    const WebhookLog = require('../models/WebhookLog');
    
    // Mapeo de tipos de eventos
    const eventTypeMap = {
      'email.sent': 'sent',
      'email.delivered': 'delivered',
      'email.delivery_delayed': 'delayed',
      'email.bounced': 'bounced',
      'email.opened': 'opened',
      'email.clicked': 'clicked',
      'email.complained': 'complained'
    };
    
    const eventType = eventTypeMap[type];
    
    if (!eventType) {
      return res.status(200).json({ received: true });
    }
    
    // ========== IDEMPOTENCIA: Verificar duplicados exactos ==========
    const resendEventId = data.email_id || data.id;
    const idempotencyKey = `${resendEventId}:${eventType}`;
    
    if (resendEventId) {
      const existingEvent = await EmailEvent.findOne({
        $or: [
          { 'metadata.resendEventId': resendEventId, eventType: eventType },
          { 'metadata.idempotencyKey': idempotencyKey }
        ]
      });
      
      if (existingEvent) {
        console.log(`⏭️  Duplicado ignorado: ${resendEventId} (${eventType})`);
        return res.status(200).json({ received: true, duplicate: true });
      }
    }
    
    const emailAddress = Array.isArray(data.to) ? data.to[0] : (data.to || data.email || 'unknown');
    
    console.log(`\n📬 Resend Webhook: ${type}`);
    console.log(`   Email: ${emailAddress}`);
    console.log(`   Campaign: ${campaignId || 'N/A'}`);
    console.log(`   Flow: ${flowId || 'N/A'}`);
    
    // Log to WebhookLog
    const webhookLog = await WebhookLog.logWebhook({
      topic: `resend/${type}`,
      source: 'resend',
      email: emailAddress,
      payload: event,
      headers: {},
      metadata: { receivedAt: new Date() }
    });
    
    // ✅ RESPONDER INMEDIATAMENTE (Resend espera respuesta rápida)
    res.status(200).json({ received: true });
    
    // ========== PROCESAR EN BACKGROUND ==========
    setImmediate(async () => {
      const actions = [];
      
      try {
        await webhookLog.markProcessing();
        
        // ✅ VERIFICAR SI ES PRIMER OPEN/CLICK PARA ESTE EMAIL EN ESTA CAMPAÑA
        let isFirstOpenForEmail = true;
        let isFirstClickForEmail = true;
        
        if (campaignId && (eventType === 'opened' || eventType === 'clicked')) {
          // Buscar eventos PREVIOS (antes de crear el nuevo)
          if (eventType === 'opened') {
            const previousOpen = await EmailEvent.findOne({
              campaign: campaignId,
              email: emailAddress,
              eventType: 'opened'
            });
            isFirstOpenForEmail = !previousOpen;
            if (!isFirstOpenForEmail) {
              console.log(`   ℹ️  Open repetido para ${emailAddress} (no cuenta para stats)`);
            }
          }
          
          if (eventType === 'clicked') {
            const previousClick = await EmailEvent.findOne({
              campaign: campaignId,
              email: emailAddress,
              eventType: 'clicked'
            });
            isFirstClickForEmail = !previousClick;
            if (!isFirstClickForEmail) {
              console.log(`   ℹ️  Click repetido para ${emailAddress} (no cuenta para stats)`);
            }
          }
        }
        
        // 1. Crear EmailEvent (siempre se crea para historial completo)
        const eventData = {
          customer: customerId || null,
          email: emailAddress,
          eventType: eventType,
          source: 'resend',
          clickedUrl: data.click?.link || null,
          bounceReason: data.bounce?.message || null,
          userAgent: data.click?.user_agent || null,
          metadata: {
            resendEventId: resendEventId,
            idempotencyKey: idempotencyKey,
            timestamp: data.created_at,
            rawTags: data.tags,
            bounceType: data.bounce?.type || null,
            isUniqueOpen: eventType === 'opened' ? isFirstOpenForEmail : undefined,
            isUniqueClick: eventType === 'clicked' ? isFirstClickForEmail : undefined
          }
        };
        
        if (campaignId) {
          eventData.campaign = campaignId;
        }
        
        if (flowId) {
          eventData.flow = flowId;
          eventData.flowExecution = executionId;
        }
        
        await EmailEvent.create(eventData);
        console.log(`   ✅ EmailEvent creado: ${eventType}`);
        
        actions.push({
          type: `email_event_${eventType}`,
          details: { email: emailAddress },
          success: true
        });
        
        // ========== 🆕 BOUNCE MANAGEMENT AUTOMÁTICO ==========
        if (eventType === 'bounced') {
          await handleBounce(emailAddress, data, campaignId);
          actions.push({
            type: 'bounce_handled',
            details: { email: emailAddress, bounceType: data.bounce?.type },
            success: true
          });
        }
        
        // ========== COMPLAINT MANAGEMENT ==========
        if (eventType === 'complained') {
          await handleComplaint(emailAddress, data, campaignId);
          actions.push({
            type: 'complaint_handled',
            details: { email: emailAddress },
            success: true
          });
        }
        
        // 2. Actualizar EmailSend status
        if (resendEventId) {
          const emailSendUpdates = {};
          
          switch (eventType) {
            case 'delivered':
              emailSendUpdates.status = 'delivered';
              emailSendUpdates.deliveredAt = new Date();
              break;
            case 'bounced':
              emailSendUpdates.status = 'bounced';
              emailSendUpdates.lastError = data.bounce?.message || 'Email bounced';
              break;
            case 'complained':
              emailSendUpdates.status = 'bounced';
              emailSendUpdates.lastError = 'Spam complaint';
              break;
          }
          
          if (Object.keys(emailSendUpdates).length > 0) {
            await EmailSend.findOneAndUpdate(
              { externalMessageId: resendEventId },
              { $set: emailSendUpdates, $inc: { version: 1 } }
            );
          }
        }
        
        // 3. Actualizar Campaign stats (✅ SOLO ÚNICOS PARA OPENS/CLICKS)
        if (campaignId) {
          const statsToIncrement = {};
          
          switch (eventType) {
            case 'delivered':
              statsToIncrement['stats.delivered'] = 1;
              break;
            case 'opened':
              // ✅ SOLO incrementar si es el PRIMER open de este email
              if (isFirstOpenForEmail) {
                statsToIncrement['stats.opened'] = 1;
                console.log(`   ✅ Unique open contado para stats`);
              }
              break;
            case 'clicked':
              // ✅ SOLO incrementar si es el PRIMER click de este email
              if (isFirstClickForEmail) {
                statsToIncrement['stats.clicked'] = 1;
                console.log(`   ✅ Unique click contado para stats`);
              }
              break;
            case 'bounced':
              statsToIncrement['stats.bounced'] = 1;
              break;
            case 'complained':
              statsToIncrement['stats.complained'] = 1;
              break;
          }
          
          if (Object.keys(statsToIncrement).length > 0) {
            await Campaign.findByIdAndUpdate(campaignId, {
              $inc: statsToIncrement
            });
            console.log(`   ✅ Campaign stats: ${eventType} +1`);
            
            actions.push({
              type: 'campaign_stats_updated',
              details: { campaignId, eventType, unique: eventType === 'opened' ? isFirstOpenForEmail : (eventType === 'clicked' ? isFirstClickForEmail : true) },
              success: true
            });
          }
          
          // Actualizar rates
          if (['delivered', 'opened', 'clicked'].includes(eventType)) {
            // Solo recalcular si realmente se incrementó algo
            const shouldRecalculate = eventType === 'delivered' || 
              (eventType === 'opened' && isFirstOpenForEmail) ||
              (eventType === 'clicked' && isFirstClickForEmail);
            
            if (shouldRecalculate) {
              const campaign = await Campaign.findById(campaignId);
              if (campaign && typeof campaign.updateRates === 'function') {
                campaign.updateRates();
                await campaign.save();
              }
            }
          }
          
          // Verificar si campaña terminó
          if (eventType === 'delivered') {
            try {
              const { checkAndFinalizeCampaign, isAvailable } = require('../jobs/emailQueue');
              if (isAvailable()) {
                await checkAndFinalizeCampaign(campaignId);
              }
            } catch (err) {
              // Queue might not be available
            }
          }
        }
        
        // 4. Actualizar Customer stats
        if (customerId) {
          try {
            await Customer.updateEmailStats(customerId, eventType);
          } catch (err) {
            console.log(`   ⚠️  Error updating customer stats: ${err.message}`);
          }
        }
        
        // 5. Actualizar Flow stats (también solo únicos)
        if (flowId) {
          try {
            const Flow = require('../models/Flow');
            const metricMap = {
              'sent': 'emailsSent',
              'delivered': 'delivered',
              'opened': 'opens',
              'clicked': 'clicks',
              'bounced': 'bounced',
              'complained': 'complained'
            };
            
            const metricName = metricMap[eventType];
            if (metricName) {
              // Para flows, también solo contar únicos
              const shouldIncrementFlow = 
                (eventType === 'opened' && isFirstOpenForEmail) ||
                (eventType === 'clicked' && isFirstClickForEmail) ||
                !['opened', 'clicked'].includes(eventType);
              
              if (shouldIncrementFlow) {
                await Flow.findByIdAndUpdate(flowId, {
                  $inc: { [`metrics.${metricName}`]: 1 }
                });
                
                actions.push({
                  type: 'flow_stats_updated',
                  details: { flowId, metric: metricName },
                  success: true
                });
              }
            }
          } catch (err) {
            console.log(`   ⚠️  Flow not available: ${err.message}`);
          }
        }
        
        await webhookLog.markProcessed(actions, []);
        
        console.log(`   ✅ Webhook procesado completamente\n`);
        
      } catch (error) {
        console.error('❌ Error en background:', error);
        await webhookLog.markFailed(error);
      }
    });
    
  } catch (error) {
    console.error('❌ Error procesando webhook Resend:', error);
    res.status(200).json({ received: true, error: error.message });
  }
});

// ==================== TELNYX SMS HELPER FUNCTIONS ====================

/**
 * Formatea teléfono para búsqueda (E.164)
 */
function formatPhoneForSearch(phone) {
  if (!phone) return null;
  
  let cleaned = phone.toString().replace(/[^\d+]/g, '');
  
  if (cleaned.startsWith('+1') && cleaned.length === 12) {
    return cleaned;
  }
  
  if (cleaned.startsWith('+')) {
    return cleaned.length >= 11 ? cleaned : null;
  }
  
  if (cleaned.startsWith('1') && cleaned.length === 11) {
    return '+' + cleaned;
  }
  
  if (cleaned.length === 10) {
    return '+1' + cleaned;
  }
  
  return null;
}

/**
 * Actualiza el estado de un SMS en la DB
 */
async function updateSmsStatus(webhookData) {
  try {
    // 1. Update SmsTransactional (order confirmation, shipping, delivery)
    try {
      const SmsTransactional = require('../models/SmsTransactional');
      const transactionalSms = await SmsTransactional.findOne({
        telnyxMessageId: webhookData.messageId
      });

      if (transactionalSms) {
        transactionalSms.status = webhookData.status;
        transactionalSms.statusUpdatedAt = new Date();

        if (webhookData.status === 'delivered') {
          transactionalSms.deliveredAt = new Date();
        }

        if (webhookData.errors?.length > 0) {
          transactionalSms.error = webhookData.errors[0]?.detail || 'Unknown error';
        }

        await transactionalSms.save();
        console.log(`   ✅ Updated Transactional SMS status: ${transactionalSms.orderNumber} -> ${webhookData.status}`);
        return;
      }
    } catch (e) {
      // SmsTransactional model might not exist
    }

    // 2. Update SmsSubscriber (welcome SMS)
    if (!SmsSubscriber) return;

    let subscriber = await SmsSubscriber.findOne({
      welcomeSmsMessageId: webhookData.messageId
    });

    if (subscriber) {
      subscriber.welcomeSmsStatus = webhookData.status;

      if (webhookData.status === 'delivered') {
        subscriber.welcomeSmsSentAt = subscriber.welcomeSmsSentAt || new Date();
        subscriber.totalSmsDelivered = (subscriber.totalSmsDelivered || 0) + 1;
      }

      if (webhookData.errors?.length > 0) {
        subscriber.welcomeSmsError = webhookData.errors[0]?.detail || 'Unknown error';
      }

      await subscriber.save();
      console.log(`   ✅ Updated SMS status: ${subscriber.phone} -> ${webhookData.status}`);
      return;
    }

  } catch (error) {
    console.error('❌ Error updating SMS status:', error);
  }
}

/**
 * Maneja SMS entrantes (opt-out, etc.)
 */
async function handleInboundSms(webhookData) {
  if (!SmsSubscriber) return;
  
  try {
    const fromPhone = formatPhoneForSearch(webhookData.fromPhone);
    
    if (!fromPhone) return;

    const subscriber = await SmsSubscriber.findOne({ phone: fromPhone });
    
    if (!subscriber) {
      console.log(`📨 Inbound SMS from unknown number: ${fromPhone}`);
      return;
    }

    // Manejar opt-out keywords
    const text = (webhookData.text || '').toLowerCase().trim();
    const optOutKeywords = ['stop', 'unsubscribe', 'cancel', 'quit', 'end'];
    const optInKeywords = ['start', 'yes', 'unstop'];
    
    if (optOutKeywords.includes(text)) {
      subscriber.status = 'unsubscribed';
      subscriber.unsubscribedAt = new Date();
      subscriber.unsubscribeReason = 'stop_keyword';
      await subscriber.save();
      
      console.log(`🚫 Unsubscribed via SMS STOP: ${fromPhone}`);
      
      // Enviar confirmación de opt-out
      try {
        const telnyxService = require('../services/telnyxService');
        await telnyxService.sendStopConfirmation(fromPhone);
      } catch (e) {
        console.log('Could not send STOP confirmation:', e.message);
      }
      
    } else if (optInKeywords.includes(text)) {
      // Re-subscribe
      if (subscriber.status === 'unsubscribed') {
        subscriber.status = 'active';
        subscriber.unsubscribedAt = null;
        subscriber.unsubscribeReason = null;
        await subscriber.save();
        
        console.log(`✅ Re-subscribed via SMS START: ${fromPhone}`);
        
        // Enviar confirmación
        try {
          const telnyxService = require('../services/telnyxService');
          await telnyxService.sendStartConfirmation(fromPhone);
        } catch (e) {
          console.log('Could not send START confirmation:', e.message);
        }
      }
      
    } else if (text === 'help' || text === 'info') {
      // Enviar mensaje de ayuda
      try {
        const telnyxService = require('../services/telnyxService');
        await telnyxService.sendHelpResponse(fromPhone);
      } catch (e) {
        console.log('Could not send HELP response:', e.message);
      }
      
    } else {
      console.log(`📨 Inbound SMS from ${fromPhone}: ${webhookData.text}`);
    }

  } catch (error) {
    console.error('❌ Error handling inbound SMS:', error);
  }
}

// ==================== BOUNCE & COMPLAINT HANDLERS ====================

/**
 * Maneja bounces automáticamente
 */
async function handleBounce(email, data, campaignId) {
  try {
    const Customer = require('../models/Customer');
    
    const customer = await Customer.findOne({ email });
    
    if (!customer) {
      console.log(`   ⚠️  Customer no encontrado para bounce: ${email}`);
      return;
    }
    
    // Determinar tipo de bounce
    let bounceType = 'soft';
    const bounceMessage = data.bounce?.message || data.bounce?.type || '';
    
    const hardBounceIndicators = [
      'hard', 'permanent', 'does not exist', 'invalid',
      'unknown user', 'no such user', 'mailbox not found',
      'address rejected', 'user unknown', 'domain not found',
      'recipient address rejected'
    ];
    
    const isHardBounce = hardBounceIndicators.some(indicator =>
      bounceMessage.toLowerCase().includes(indicator)
    );
    
    if (isHardBounce) {
      bounceType = 'hard';
    }
    
    console.log(`   🚫 Bounce detectado: ${email}`);
    console.log(`      Tipo: ${bounceType}`);
    console.log(`      Razón: ${bounceMessage.substring(0, 100)}`);
    
    // Marcar como bounced
    if (typeof customer.markAsBounced === 'function') {
      await customer.markAsBounced(bounceType, bounceMessage || 'Email bounced', campaignId);
    } else {
      // Fallback si el método no existe
      customer.emailStatus = 'bounced';
      customer.bounceInfo = {
        isBounced: true,
        bounceType,
        lastBounceDate: new Date(),
        bounceReason: bounceMessage,
        bouncedCampaignId: campaignId
      };
      await customer.save();
      
      // Si es hard bounce, remover de listas
      if (bounceType === 'hard') {
        const List = require('../models/List');
        await List.updateMany(
          { members: customer._id },
          { 
            $pull: { members: customer._id },
            $inc: { memberCount: -1 }
          }
        );
        console.log(`   ✅ Hard bounce - removido de listas`);
      }
    }
    
  } catch (error) {
    console.error(`   ❌ Error handling bounce: ${error.message}`);
  }
}

/**
 * Maneja spam complaints automáticamente
 */
async function handleComplaint(email, data, campaignId) {
  try {
    const Customer = require('../models/Customer');
    const List = require('../models/List');
    
    const customer = await Customer.findOne({ email });
    
    if (!customer) {
      console.log(`   ⚠️  Customer no encontrado para complaint: ${email}`);
      return;
    }
    
    console.log(`   🚨 SPAM COMPLAINT: ${email}`);
    
    // Marcar como complained
    customer.emailStatus = 'complained';
    customer.bounceInfo = {
      isBounced: true,
      bounceType: 'hard',
      lastBounceDate: new Date(),
      bounceReason: 'Spam complaint',
      bouncedCampaignId: campaignId
    };
    
    await customer.save();
    
    // Remover de TODAS las listas
    const result = await List.updateMany(
      { members: customer._id },
      { 
        $pull: { members: customer._id },
        $inc: { memberCount: -1 }
      }
    );
    
    console.log(`   ✅ Complaint procesado - removido de ${result.modifiedCount} lista(s)`);
    
  } catch (error) {
    console.error(`   ❌ Error handling complaint: ${error.message}`);
  }
}

module.exports = router;