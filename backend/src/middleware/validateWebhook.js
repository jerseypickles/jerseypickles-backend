// backend/src/middleware/validateWebhook.js
const crypto = require('crypto');

const validateShopifyWebhook = (req, res, next) => {
  try {
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const topic = req.headers['x-shopify-topic'];
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
    
    // 🆕 El body viene como Buffer desde express.raw()
    let body;
    
    if (Buffer.isBuffer(req.body)) {
      // Si es Buffer, convertir a string
      body = req.body.toString('utf8');
      // También guardar el objeto parseado en req.body para los controllers
      req.bodyParsed = JSON.parse(body);
    } else if (typeof req.body === 'string') {
      body = req.body;
      req.bodyParsed = JSON.parse(body);
    } else {
      // Fallback: ya está parseado
      body = JSON.stringify(req.body);
      req.bodyParsed = req.body;
    }
    
    // Calcular HMAC
    const hash = crypto
      .createHmac('sha256', secret)
      .update(body, 'utf8')
      .digest('base64');
    
    // Comparar HMAC
    if (hash !== hmac) {
      console.error('❌ HMAC inválido');
      console.error(`   Calculated: ${hash}`);
      console.error(`   Shopify:    ${hmac}`);
      console.error(`   Topic:      ${topic}`);
      console.error(`   Body type:  ${Buffer.isBuffer(req.body) ? 'Buffer' : typeof req.body}`);
      console.error(`   Body len:   ${body.length}`);
      return res.status(401).json({ error: 'Invalid HMAC signature' });
    }
    
    console.log(`✅ Webhook verificado: ${topic}`);
    
    // Reemplazar req.body con el objeto parseado
    req.body = req.bodyParsed;
    
    next();
    
  } catch (error) {
    console.error('❌ Error validando webhook:', error);
    res.status(500).json({ error: 'Error validating webhook' });
  }
};

module.exports = { validateShopifyWebhook };