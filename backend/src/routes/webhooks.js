// backend/src/routes/webhooks.js (ACTUALIZADO CON IDEMPOTENCIA)
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
router.post('/resend', async (req, res) => {
  try {
    const event = req.body;
    
    console.log('📨 Resend webhook recibido:', event?.type || 'sin type');
    
    // ✅ Validación defensiva
    if (!event || !event.data) {
      console.error('❌ Payload inválido:', req.body);
      return res.status(400).json({ error: 'Invalid payload' });
    }
    
    const { type, data } = event;
    
    console.log('📦 Event type:', type);
    console.log('📦 Data tags:', data.tags);
    
    // Extraer tags (vienen como objeto según los logs)
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
    
    console.log(`🏷️  Tags extraídos: campaign=${campaignId}, flow=${flowId}, customer=${customerId}`);
    
    // Si no es de campaign ni de flow, ignorar
    if (!campaignId && !flowId) {
      console.log('⚠️  Evento sin tags de campaign/flow');
      return res.status(200).json({ received: true });
    }
    
    if (!customerId) {
      console.log('⚠️  Evento sin customer ID');
      return res.status(200).json({ received: true });
    }
    
    const EmailEvent = require('../models/EmailEvent');
    const Campaign = require('../models/Campaign');
    const Customer = require('../models/Customer');
    const Flow = require('../models/Flow');
    
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
      console.log(`⚠️  Tipo de evento desconocido: ${type}`);
      return res.status(200).json({ received: true });
    }
    
    // ✅ IDEMPOTENCIA: Verificar duplicados PARA TODOS LOS EVENTOS
    const resendEventId = data.email_id || data.id;
    
    if (resendEventId) {
      const existingEvent = await EmailEvent.findOne({
        'metadata.resendEventId': resendEventId,
        eventType: eventType
      });
      
      if (existingEvent) {
        console.log(`⏭️  Evento duplicado detectado: ${resendEventId} (${eventType})`);
        return res.status(200).json({ received: true, duplicate: true });
      }
    }
    
    // Extraer email correctamente (viene como array)
    const emailAddress = Array.isArray(data.to) ? data.to[0] : (data.to || data.email || 'unknown');
    
    // Registrar evento
    const eventData = {
      customer: customerId,
      email: emailAddress,
      eventType: eventType,
      source: 'resend',
      clickedUrl: data.click?.link || null,
      bounceReason: data.bounce?.message || null,
      userAgent: data.click?.user_agent || null,
      metadata: {
        resendEventId: resendEventId, // ← Importante: guardamos el ID único
        timestamp: data.created_at,
        rawTags: data.tags
      }
    };
    
    // Asociar con campaign o flow
    if (campaignId) {
      eventData.campaign = campaignId;
    }
    
    if (flowId) {
      eventData.flow = flowId;
      eventData.flowExecution = executionId;
    }
    
    await EmailEvent.create(eventData);
    console.log(`✅ EmailEvent creado: ${eventType}`);
    
    // Actualizar stats
    try {
      // ✅ Campaign stats
      if (campaignId) {
        await Campaign.updateStats(campaignId, eventType);
        console.log(`✅ Campaign stats updated: ${campaignId}`);
      }
      
      // ✅ Customer stats
      await Customer.updateEmailStats(customerId, eventType);
      console.log(`✅ Customer stats updated: ${customerId}`);
      
      // 🆕 Flow stats
      if (flowId) {
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
          console.log(`✅ Flow metric updated: ${flowId} - metrics.${metricName} +1`);
        }
      }
    } catch (error) {
      console.log('⚠️  No se pudieron actualizar stats:', error.message);
    }
    
    console.log(`✅ Evento ${eventType} registrado desde Resend\n`);
    
    res.status(200).json({ received: true });
    
  } catch (error) {
    console.error('❌ Error procesando webhook de Resend:', error);
    console.error('Stack:', error.stack);
    res.status(200).json({ received: true, error: error.message });
  }
});

module.exports = router;