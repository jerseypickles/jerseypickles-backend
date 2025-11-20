// backend/src/middleware/validateWebhook.js
const crypto = require('crypto');

const validateShopifyWebhook = (req, res, next) => {
  try {
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const topic = req.headers['x-shopify-topic'];
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
    
    if (!hmac) {
      console.error('❌ Webhook sin HMAC header');
      return res.status(401).json({ error: 'No HMAC header' });
    }
    
    if (!secret) {
      console.error('❌ SHOPIFY_WEBHOOK_SECRET no configurado');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }
    
    // Verificar que el body sea Buffer
    if (!Buffer.isBuffer(req.body)) {
      console.error('❌ Body no es Buffer:', typeof req.body);
      return res.status(500).json({ error: 'Body must be Buffer' });
    }
    
    // 🆕 SOLUCIÓN: Usar el Buffer DIRECTAMENTE sin convertir a string
    const bodyBuffer = req.body;
    
    console.log(`🔍 Webhook: ${topic}`);
    console.log(`   Buffer length: ${bodyBuffer.length}`);
    console.log(`   Secret length: ${secret.length}`);
    
    // Calcular HMAC con el Buffer RAW completo
    const hash = crypto
      .createHmac('sha256', secret)
      .update(bodyBuffer)  // ← Usar el Buffer directamente
      .digest('base64');
    
    if (hash !== hmac) {
      console.error('❌ HMAC inválido');
      console.error(`   Calculated: ${hash}`);
      console.error(`   Shopify:    ${hmac}`);
      console.error(`   Topic:      ${topic}`);
      
      // Debug: Mostrar últimos bytes del buffer
      console.error(`   Last 10 bytes: ${Array.from(bodyBuffer.slice(-10)).map(b => `0x${b.toString(16)}`).join(' ')}`);
      
      return res.status(401).json({ error: 'Invalid HMAC signature' });
    }
    
    console.log(`✅ Webhook verificado: ${topic}`);
    
    // Parsear body para los controllers
    try {
      req.body = JSON.parse(bodyBuffer.toString('utf8'));
    } catch (e) {
      console.error('❌ Error parseando body:', e);
      return res.status(500).json({ error: 'Invalid JSON' });
    }
    
    next();
    
  } catch (error) {
    console.error('❌ Error en validateWebhook:', error);
    console.error(error.stack);
    res.status(500).json({ error: 'Error validating webhook' });
  }
};

module.exports = { validateShopifyWebhook };