// backend/src/routes/webhooks.products.js
// 📦 Product Webhook Handlers - Procesa webhooks de productos de Shopify
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const productService = require('../services/productService');
const WebhookLog = require('../models/WebhookLog');

/**
 * Verificar firma HMAC de Shopify
 */
const verifyShopifyWebhook = (req, res, next) => {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  
  if (!secret) {
    console.log('⚠️ SHOPIFY_WEBHOOK_SECRET no configurado - saltando verificación');
    return next();
  }
  
  if (!hmacHeader) {
    console.log('⚠️ No HMAC header in product webhook');
    return res.status(401).json({ error: 'No HMAC header' });
  }
  
  const body = req.body;
  const hash = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64');
  
  if (hash !== hmacHeader) {
    console.log('❌ Invalid HMAC signature for product webhook');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  next();
};

/**
 * POST /api/webhooks/products
 * Procesa webhooks de productos de Shopify
 */
router.post('/', verifyShopifyWebhook, async (req, res) => {
  const startTime = Date.now();
  
  try {
    // Parsear body si viene como Buffer
    let payload;
    if (Buffer.isBuffer(req.body)) {
      payload = JSON.parse(req.body.toString('utf8'));
    } else {
      payload = req.body;
    }
    
    const topic = req.headers['x-shopify-topic'];
    const shopifyId = payload.id?.toString();
    
    console.log(`\n📦 Product Webhook: ${topic}`);
    console.log(`   Product ID: ${shopifyId}`);
    console.log(`   Title: ${payload.title || 'N/A'}`);
    
    // Loggear webhook
    const webhookLog = await WebhookLog.logWebhook({
      topic,
      source: 'shopify',
      shopifyId,
      payload,
      headers: {
        shopifyTopic: topic,
        shopifyHmac: req.headers['x-shopify-hmac-sha256'],
        shopifyShopDomain: req.headers['x-shopify-shop-domain'],
        shopifyWebhookId: req.headers['x-shopify-webhook-id']
      },
      metadata: {
        ip: req.ip,
        contentLength: req.headers['content-length']
      }
    });
    
    await webhookLog.markProcessing();
    
    // Procesar según el topic
    const actions = [];
    let result = null;
    
    switch (topic) {
      case 'products/create':
        result = await productService.handleProductWebhook(topic, payload);
        actions.push({
          type: 'product_created',
          details: { title: payload.title, id: shopifyId },
          success: !!result
        });
        break;
        
      case 'products/update':
        result = await productService.handleProductWebhook(topic, payload);
        actions.push({
          type: 'product_updated',
          details: { 
            title: payload.title, 
            id: shopifyId,
            variantsCount: payload.variants?.length || 0
          },
          success: !!result
        });
        break;
        
      case 'products/delete':
        result = await productService.handleProductWebhook(topic, payload);
        actions.push({
          type: 'product_deleted',
          details: { id: shopifyId },
          success: !!result
        });
        break;
        
      default:
        console.log(`⚠️ Unknown product topic: ${topic}`);
        actions.push({
          type: 'unknown_topic',
          details: { topic },
          success: false
        });
    }
    
    // Marcar como procesado
    await webhookLog.markProcessed(actions);
    
    const duration = Date.now() - startTime;
    console.log(`✅ Product webhook processed in ${duration}ms`);
    
    res.status(200).json({ 
      success: true, 
      topic,
      productId: shopifyId,
      duration 
    });
    
  } catch (error) {
    console.error('❌ Error processing product webhook:', error);
    
    res.status(200).json({ 
      success: false, 
      error: error.message 
    });
  }
});

module.exports = router;