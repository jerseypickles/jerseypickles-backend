// backend/src/routes/webhooks.js
const express = require('express');
const router = express.Router();
const webhooksController = require('../controllers/webhooksController');
const { validateShopifyWebhook } = require('../middleware/validateWebhook');
const { webhookLimiter } = require('../middleware/rateLimiter');

// Aplicar rate limiter a todos los webhooks
router.use(webhookLimiter);

// ⚠️ IMPORTANTE: NO aplicar validateShopifyWebhook a todas las rutas
// Aplicarlo solo a rutas específicas de Shopify

// ==================== WEBHOOKS DE SHOPIFY ====================
// Aplicar validación de Shopify solo a estas rutas
router.post('/customers/create', validateShopifyWebhook, webhooksController.customerCreate);
router.post('/customers/update', validateShopifyWebhook, webhooksController.customerUpdate);
router.post('/orders/create', validateShopifyWebhook, webhooksController.orderCreate);
router.post('/orders/update', validateShopifyWebhook, webhooksController.orderUpdate);

// ==================== WEBHOOKS DE RESEND ====================
// Esta ruta NO tiene validación de Shopify
router.post('/resend', express.json(), async (req, res) => {
  try {
    const event = req.body;
    
    console.log('📨 Resend webhook recibido:', event.type);
    console.log('📦 Body completo:', JSON.stringify(event, null, 2));
    
    const { type, data } = event;
    
    // Extraer tags (vienen como objeto según los logs)
    let campaignId, customerId;
    
    if (data.tags && Array.isArray(data.tags)) {
      campaignId = data.tags.find(t => t.name === 'campaign_id')?.value;
      customerId = data.tags.find(t => t.name === 'customer_id')?.value;
    } else if (data.tags && typeof data.tags === 'object') {
      campaignId = data.tags.campaign_id;
      customerId = data.tags.customer_id;
    }
    
    if (!campaignId || !customerId) {
      console.log('⚠️  Evento sin tags de campaign/customer');
      console.log('Tags recibidos:', data.tags);
      return res.status(200).json({ received: true });
    }
    
    const EmailEvent = require('../models/EmailEvent');
    const Campaign = require('../models/Campaign');
    const Customer = require('../models/Customer');
    
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
    
    // Para opens, verificar duplicados
    if (eventType === 'opened') {
      const existingEvent = await EmailEvent.findOne({
        campaign: campaignId,
        customer: customerId,
        eventType: 'opened',
        source: 'resend'
      }).catch(() => null);
      
      if (existingEvent) {
        console.log('⏭️  Open de Resend ya registrado');
        return res.status(200).json({ received: true });
      }
    }
    
    // 🆕 ARREGLAR: Extraer email correctamente (viene como array)
    const emailAddress = Array.isArray(data.to) ? data.to[0] : (data.to || data.email || 'unknown');
    
    // Registrar evento
    await EmailEvent.create({
      campaign: campaignId,
      customer: customerId,
      email: emailAddress,
      eventType: eventType,
      source: 'resend',
      clickedUrl: data.click?.link || null,
      bounceReason: data.bounce?.message || null,
      userAgent: data.click?.user_agent || null,
      metadata: {
        resendEventId: data.email_id,
        timestamp: data.created_at,
        rawTags: data.tags
      }
    });
    
    // Actualizar stats
    try {
      await Campaign.updateStats(campaignId, eventType);
      await Customer.updateEmailStats(customerId, eventType);
    } catch (error) {
      console.log('⚠️  No se pudieron actualizar stats:', error.message);
    }
    
    console.log(`✅ Evento ${eventType} registrado desde Resend`);
    
    res.status(200).json({ received: true });
    
  } catch (error) {
    console.error('❌ Error procesando webhook de Resend:', error);
    res.status(200).json({ received: true, error: error.message });
  }
});

module.exports = router;