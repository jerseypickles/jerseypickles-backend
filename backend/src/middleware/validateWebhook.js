// backend/src/middleware/validateWebhook.js
const crypto = require('crypto');

const validateShopifyWebhook = (req, res, next) => {
  try {
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
    
    // Validar que existan los requisitos
    if (!hmac) {
      console.error('❌ Webhook sin HMAC header');
      return res.status(401).json({ error: 'No HMAC header' });
    }
    
    if (!secret) {
      console.error('❌ SHOPIFY_WEBHOOK_SECRET no configurado');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }
    
    // Usar raw body (el string original sin parsear)
    const body = req.rawBody || JSON.stringify(req.body);
    
    // Calcular HMAC
    const hash = crypto
      .createHmac('sha256', secret)
      .update(body, 'utf8')
      .digest('base64');
    
    // Comparar HMAC
    if (hash !== hmac) {
      console.error('❌ HMAC inválido');
      console.error(`   Expected: ${hash}`);
      console.error(`   Received: ${hmac}`);
      console.error(`   Topic: ${req.headers['x-shopify-topic']}`);
      return res.status(401).json({ error: 'Invalid HMAC signature' });
    }
    
    console.log(`✅ Webhook verificado: ${req.headers['x-shopify-topic']}`);
    next();
    
  } catch (error) {
    console.error('❌ Error validando webhook:', error);
    res.status(500).json({ error: 'Error validating webhook' });
  }
};

module.exports = { validateShopifyWebhook };