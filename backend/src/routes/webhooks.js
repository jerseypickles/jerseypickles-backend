// backend/src/routes/webhooks.js - CORREGIDO (sin duplicados)
const express = require('express');
const router = express.Router();
const webhooksController = require('../controllers/webhooksController');
const { validateShopifyWebhook } = require('../middleware/validateWebhook');
const { webhookLimiter } = require('../middleware/rateLimiter');

// Aplicar rate limiter a todos los webhooks
router.use(webhookLimiter);

// ==================== WEBHOOKS DE CUSTOMERS ====================
router.post('/customers/create', validateShopifyWebhook, webhooksController.customerCreate);
router.post('/customers/update', validateShopifyWebhook, webhooksController.customerUpdate);

// ==================== WEBHOOKS DE ORDERS ====================
router.post('/orders/create', validateShopifyWebhook, webhooksController.orderCreate);
router.post('/orders/update', validateShopifyWebhook, webhooksController.orderUpdate);

// 🆕 NUEVOS WEBHOOKS PARA FLOWS
router.post('/orders/fulfilled', validateShopifyWebhook, webhooksController.orderFulfilled);
router.post('/orders/cancelled', validateShopifyWebhook, webhooksController.orderCancelled);
router.post('/orders/paid', validateShopifyWebhook, webhooksController.orderPaid);

// ==================== WEBHOOKS DE CHECKOUTS (Cart Abandonment) ====================
router.post('/checkouts/create', validateShopifyWebhook, webhooksController.checkoutCreate);
router.post('/checkouts/update', validateShopifyWebhook, webhooksController.checkoutUpdate);

// ==================== WEBHOOKS DE PRODUCTS ====================
router.post('/products/update', validateShopifyWebhook, webhooksController.productUpdate);

// ==================== WEBHOOKS DE REFUNDS ====================
router.post('/refunds/create', validateShopifyWebhook, webhooksController.refundCreate);

// ==================== WEBHOOKS DE RESEND ====================
/**
 * Handler de webhooks de Resend - CORREGIDO
 * 
 * IMPORTANTE - Lógica de stats:
 * - 'sent' → Se incrementa en emailQueue.js worker (NO aquí)
 * - 'delivered' → Se incrementa AQUÍ vía webhook
 * - 'opened', 'clicked', etc → Se incrementan AQUÍ vía webhook
 * 
 * Esto evita el doble conteo que causaba sent: 1840 con 920 recipients
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
    
    // ========== IDEMPOTENCIA: Verificar duplicados ==========
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
    
    // ✅ RESPONDER INMEDIATAMENTE (Resend espera respuesta rápida)
    res.status(200).json({ received: true });
    
    // ========== PROCESAR EN BACKGROUND ==========
    setImmediate(async () => {
      try {
        // 1. Crear EmailEvent
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
            rawTags: data.tags
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
        
        // 2. Actualizar EmailSend status (si existe)
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
        
        // 3. Actualizar Campaign stats
        // ⚠️ IMPORTANTE: NO incrementar 'sent' aquí - ya se hace en el worker
        if (campaignId) {
          const statsToIncrement = {};
          
          switch (eventType) {
            // 'sent' → NO SE INCREMENTA AQUÍ (ya se hace en emailQueue.js)
            case 'delivered':
              statsToIncrement['stats.delivered'] = 1;
              break;
            case 'opened':
              statsToIncrement['stats.opened'] = 1;
              break;
            case 'clicked':
              statsToIncrement['stats.clicked'] = 1;
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
          }
          
          // Actualizar rates para delivered/opened/clicked
          if (['delivered', 'opened', 'clicked'].includes(eventType)) {
            const campaign = await Campaign.findById(campaignId);
            if (campaign && typeof campaign.updateRates === 'function') {
              campaign.updateRates();
              await campaign.save();
            }
          }
          
          // Verificar si campaña terminó (después de delivered)
          if (eventType === 'delivered') {
            try {
              const { checkAndFinalizeCampaign, isAvailable } = require('../jobs/emailQueue');
              if (isAvailable()) {
                await checkAndFinalizeCampaign(campaignId);
              }
            } catch (err) {
              // Queue might not be available, that's ok
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
        
        // 5. Actualizar Flow stats (si aplica)
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
              await Flow.findByIdAndUpdate(flowId, {
                $inc: { [`metrics.${metricName}`]: 1 }
              });
            }
          } catch (err) {
            console.log(`   ⚠️  Flow not available: ${err.message}`);
          }
        }
        
        console.log(`   ✅ Webhook procesado completamente\n`);
        
      } catch (error) {
        console.error('❌ Error en background:', error);
      }
    });
    
  } catch (error) {
    console.error('❌ Error procesando webhook Resend:', error);
    // Siempre responder 200 para evitar reintentos
    res.status(200).json({ received: true, error: error.message });
  }
});

module.exports = router;