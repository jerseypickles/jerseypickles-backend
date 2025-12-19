// backend/src/routes/webhooks.js
// 📡 COMPLETE WEBHOOK ROUTES - Shopify, Resend, Telnyx SMS, Monitoring, Testing
// ✅ FIXED: Unique opens/clicks counting for accurate rates
// ✅ NEW: Telnyx SMS webhooks + SMS Revenue Attribution
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

// Order webhooks (con atribución SMS)
router.post('/orders/create', validateShopifyWebhook, async (req, res, next) => {
  // Primero procesar el webhook normal
  await webhooksController.orderCreate(req, res, next);
  
  // Luego verificar atribución SMS en background
  if (SmsSubscriber) {
    setImmediate(async () => {
      try {
        const orderData = JSON.parse(req.body.toString());
        await checkSmsAttribution(orderData);
      } catch (err) {
        console.log('⚠️  SMS Attribution check failed:', err.message);
      }
    });
  }
});

router.post('/orders/update', validateShopifyWebhook, webhooksController.orderUpdate);
router.post('/orders/fulfilled', validateShopifyWebhook, webhooksController.orderFulfilled);
router.post('/orders/cancelled', validateShopifyWebhook, webhooksController.orderCancelled);

router.post('/orders/paid', validateShopifyWebhook, async (req, res, next) => {
  // Primero procesar el webhook normal
  await webhooksController.orderPaid(req, res, next);
  
  // Luego verificar atribución SMS en background (también en paid por si acaso)
  if (SmsSubscriber) {
    setImmediate(async () => {
      try {
        const orderData = JSON.parse(req.body.toString());
        await checkSmsAttribution(orderData);
      } catch (err) {
        console.log('⚠️  SMS Attribution check failed:', err.message);
      }
    });
  }
});

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

// ==================== SMS ATTRIBUTION FUNCTIONS ====================

/**
 * Verifica atribución SMS en una orden
 * Busca por código de descuento O por teléfono
 */
async function checkSmsAttribution(orderData) {
  if (!SmsSubscriber) return { attributed: false };
  
  try {
    // 1. Buscar por código de descuento usado
    const usedDiscountCodes = orderData.discount_codes || [];
    
    for (const discount of usedDiscountCodes) {
      const code = discount.code?.toUpperCase();
      
      // Solo buscar códigos que parecen ser nuestros (JP-XXXXX)
      if (!code || !code.startsWith('JP-')) continue;
      
      const subscriber = await SmsSubscriber.findOne({ 
        discountCode: code 
      });
      
      if (subscriber && !subscriber.converted) {
        console.log(`🎯 SMS Attribution found! Code: ${code}, Phone: ${subscriber.phone}`);
        
        // Registrar conversión
        await subscriber.recordConversion(orderData);
        
        return {
          attributed: true,
          method: 'discount_code',
          subscriberId: subscriber._id,
          phone: subscriber.phone,
          discountCode: code,
          revenue: parseFloat(orderData.total_price || 0)
        };
      }
    }

    // 2. Si no encontramos por código, buscar por teléfono
    const orderPhone = orderData.phone || 
                       orderData.customer?.phone || 
                       orderData.billing_address?.phone ||
                       orderData.shipping_address?.phone;
    
    if (orderPhone) {
      const formattedPhone = formatPhoneForSearch(orderPhone);
      
      if (formattedPhone) {
        const subscriber = await SmsSubscriber.findOne({ 
          phone: formattedPhone,
          status: 'active'
        });
        
        if (subscriber && !subscriber.converted) {
          // Verificar que el SMS se envió en los últimos 30 días
          const daysSinceSubscription = (Date.now() - subscriber.subscribedAt) / (1000 * 60 * 60 * 24);
          
          if (daysSinceSubscription <= 30) {
            console.log(`🎯 SMS Attribution by phone! Phone: ${formattedPhone}`);
            
            await subscriber.recordConversion(orderData);
            
            return {
              attributed: true,
              method: 'phone_match',
              subscriberId: subscriber._id,
              phone: formattedPhone,
              discountCode: subscriber.discountCode,
              revenue: parseFloat(orderData.total_price || 0)
            };
          }
        }
      }
    }

    return { attributed: false };

  } catch (error) {
    console.error('❌ SMS Attribution Error:', error);
    return { attributed: false, error: error.message };
  }
}

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

// ==================== TELNYX SMS HELPER FUNCTIONS ====================

/**
 * Actualiza el estado de un SMS en la DB
 */
async function updateSmsStatus(webhookData) {
  if (!SmsSubscriber) return;
  
  try {
    // Buscar por messageId en welcomeSmsId
    let subscriber = await SmsSubscriber.findOne({ 
      welcomeSmsId: webhookData.messageId 
    });

    if (subscriber) {
      subscriber.welcomeSmsStatus = webhookData.status;
      
      if (webhookData.status === 'delivered') {
        subscriber.welcomeSmsDeliveredAt = new Date();
        subscriber.totalSmsDelivered = (subscriber.totalSmsDelivered || 0) + 1;
      }
      
      if (webhookData.cost) {
        subscriber.welcomeSmsCost = webhookData.cost;
      }

      if (webhookData.errors?.length > 0) {
        subscriber.welcomeSmsError = webhookData.errors[0]?.detail || 'Unknown error';
      }

      await subscriber.save();
      console.log(`   ✅ Updated SMS status: ${subscriber.phone} -> ${webhookData.status}`);
      return;
    }

    // Buscar en historial de SMS
    subscriber = await SmsSubscriber.findOne({
      'smsHistory.messageId': webhookData.messageId
    });

    if (subscriber) {
      await subscriber.updateSmsStatus(
        webhookData.messageId, 
        webhookData.status,
        webhookData.status === 'delivered' ? new Date() : null
      );
      console.log(`   ✅ Updated SMS history status: ${subscriber.phone} -> ${webhookData.status}`);
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

    // Manejar opt-out
    if (webhookData.isOptOut) {
      subscriber.status = 'unsubscribed';
      subscriber.unsubscribedAt = new Date();
      subscriber.unsubscribeReason = 'SMS STOP';
      await subscriber.save();
      
      console.log(`🚫 Unsubscribed via SMS STOP: ${fromPhone}`);
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