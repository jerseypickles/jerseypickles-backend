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
    console.log('📦 Body completo:', JSON.stringify(event, null, 2)); // Debug
    
    // Extraer información del evento
    const { type, data } = event;
    
    // Resend envía los tags de forma diferente según el evento
    // Intentar múltiples formas de extraer los tags
    let campaignId, customerId;
    
    if (data.tags && Array.isArray(data.tags)) {
      // Tags como array de objetos: [{ name: 'campaign_id', value: '123' }]
      campaignId = data.tags.find(t => t.name === 'campaign_id')?.value;
      customerId = data.tags.find(t => t.name === 'customer_id')?.value;
    } else if (data.tags && typeof data.tags === 'object') {
      // Tags como objeto: { campaign_id: '123', customer_id: '456' }
      campaignId = data.tags.campaign_id;
      customerId = data.tags.customer_id;
    }
    
    if (!campaignId || !customerId) {
      console.log('⚠️  Evento sin tags de campaign/customer');
      console.log('Tags recibidos:', data.tags);
      return res.status(200).json({ received: true });
    }
    
    // Importar modelos aquí para evitar problemas de dependencias circulares
    const EmailEvent = require('../models/EmailEvent');
    const Campaign = require('../models/Campaign');
    const Customer = require('../models/Customer');
    
    // Mapear tipos de evento de Resend a tu sistema
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
    
    // Para opens, verificar si ya existe (evitar duplicados)
    if (eventType === 'opened') {
      const existingEvent = await EmailEvent.findOne({
        campaign: campaignId,
        customer: customerId,
        eventType: 'opened',
        source: 'resend'
      }).catch(() => null); // Si falla el cast, ignorar
      
      if (existingEvent) {
        console.log('⏭️  Open de Resend ya registrado');
        return res.status(200).json({ received: true });
      }
    }
    
    // Registrar evento en tu base de datos
    await EmailEvent.create({
      campaign: campaignId,
      customer: customerId,
      email: data.to || data.email || 'unknown',
      eventType: eventType,
      source: 'resend', // Identificar que viene de webhook de Resend
      clickedUrl: data.click?.link || null,
      bounceReason: data.bounce?.message || null,
      userAgent: data.click?.user_agent || null,
      metadata: {
        resendEventId: data.email_id,
        timestamp: data.created_at,
        rawTags: data.tags
      }
    });
    
    // Actualizar stats si existen campaign/customer válidos
    try {
      await Campaign.updateStats(campaignId, eventType);
      await Customer.updateEmailStats(customerId, eventType);
    } catch (error) {
      console.log('⚠️  No se pudieron actualizar stats (probablemente test):', error.message);
    }
    
    console.log(`✅ Evento ${eventType} registrado desde Resend`);
    
    res.status(200).json({ received: true });
    
  } catch (error) {
    console.error('❌ Error procesando webhook de Resend:', error);
    // Resend espera 200 para confirmar recepción
    res.status(200).json({ received: true, error: error.message });
  }
});

module.exports = router;