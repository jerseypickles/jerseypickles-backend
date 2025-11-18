// backend/src/middleware/validateWebhook.js
const crypto = require('crypto');

const validateShopifyWebhook = (req, res, next) => {
  try {
    // Obtener HMAC del header
    const hmac = req.headers['x-shopify-hmac-sha256'];
    
    if (!hmac) {
      console.error('❌ Webhook sin HMAC');
      return res.status(401).json({ error: 'No HMAC header' });
    }
    
    // Obtener el raw body
    const body = req.body;
    const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
    
    // Calcular HMAC
    const hash = crypto
      .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
      .update(bodyString, 'utf8')
      .digest('base64');
    
    // Comparar
    if (hash !== hmac) {
      console.error('❌ HMAC inválido');
      return res.status(401).json({ error: 'Invalid HMAC' });
    }
    
    console.log('✅ Webhook verificado');
    
    // Parsear body si es string
    if (typeof body === 'string') {
      req.body = JSON.parse(body);
    }
    
    next();
    
  } catch (error) {
    console.error('❌ Error validando webhook:', error);
    res.status(500).json({ error: 'Error validating webhook' });
  }
};

module.exports = { validateShopifyWebhook };