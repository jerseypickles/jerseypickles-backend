// backend/src/middleware/validateWebhook.js
const crypto = require('crypto');

const validateShopifyWebhook = (req, res, next) => {
  try {
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const topic = req.headers['x-shopify-topic'];
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
    const shopDomain = req.headers['x-shopify-shop-domain'];
    
    console.log('\n🔍 ==================== WEBHOOK DEBUG ====================');
    console.log(`📋 Topic: ${topic}`);
    console.log(`🏪 Shop: ${shopDomain}`);
    console.log(`📊 Headers:`, JSON.stringify({
      'x-shopify-hmac-sha256': hmac,
      'x-shopify-topic': topic,
      'x-shopify-shop-domain': shopDomain,
      'content-type': req.headers['content-type'],
      'content-length': req.headers['content-length']
    }, null, 2));
    
    // Validar requisitos básicos
    if (!hmac) {
      console.error('❌ Webhook sin HMAC header');
      return res.status(401).json({ error: 'No HMAC header' });
    }
    
    if (!secret) {
      console.error('❌ SHOPIFY_WEBHOOK_SECRET no configurado');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }
    
    console.log(`🔑 Secret length: ${secret.length}`);
    console.log(`🔑 Secret first 10 chars: ${secret.substring(0, 10)}...`);
    console.log(`🔑 Secret last 10 chars: ...${secret.substring(secret.length - 10)}`);
    
    // Analizar el body
    let body;
    let bodyBuffer;
    
    if (Buffer.isBuffer(req.body)) {
      console.log('✅ Body es Buffer (correcto)');
      bodyBuffer = req.body;
      body = req.body.toString('utf8');
    } else if (typeof req.body === 'string') {
      console.log('⚠️  Body es String');
      body = req.body;
      bodyBuffer = Buffer.from(body, 'utf8');
    } else {
      console.log('❌ Body ya está parseado (incorrecto)');
      body = JSON.stringify(req.body);
      bodyBuffer = Buffer.from(body, 'utf8');
    }
    
    console.log(`📦 Body length: ${body.length}`);
    console.log(`📦 Body Buffer length: ${bodyBuffer.length}`);
    console.log(`📦 Body first 200 chars: ${body.substring(0, 200)}...`);
    console.log(`📦 Body last 100 chars: ...${body.substring(body.length - 100)}`);
    
    // 🆕 MÉTODO 1: HMAC directo con string
    const hash1 = crypto
      .createHmac('sha256', secret)
      .update(body, 'utf8')
      .digest('base64');
    
    // 🆕 MÉTODO 2: HMAC con Buffer
    const hash2 = crypto
      .createHmac('sha256', secret)
      .update(bodyBuffer)
      .digest('base64');
    
    // 🆕 MÉTODO 3: HMAC con Buffer del secret
    const hash3 = crypto
      .createHmac('sha256', Buffer.from(secret, 'utf8'))
      .update(bodyBuffer)
      .digest('base64');
    
    // 🆕 MÉTODO 4: Hex primero, luego base64
    const hashHex = crypto
      .createHmac('sha256', secret)
      .update(bodyBuffer)
      .digest('hex');
    const hash4 = Buffer.from(hashHex, 'hex').toString('base64');
    
    // 🆕 MÉTODO 5: Con secret trimmed (por si tiene espacios)
    const hash5 = crypto
      .createHmac('sha256', secret.trim())
      .update(bodyBuffer)
      .digest('base64');
    
    console.log('\n🔐 HMAC Calculations:');
    console.log(`   Shopify HMAC:     ${hmac}`);
    console.log(`   Method 1 (str):   ${hash1} ${hash1 === hmac ? '✅ MATCH!' : '❌'}`);
    console.log(`   Method 2 (buf):   ${hash2} ${hash2 === hmac ? '✅ MATCH!' : '❌'}`);
    console.log(`   Method 3 (sec+b): ${hash3} ${hash3 === hmac ? '✅ MATCH!' : '❌'}`);
    console.log(`   Method 4 (hex):   ${hash4} ${hash4 === hmac ? '✅ MATCH!' : '❌'}`);
    console.log(`   Method 5 (trim):  ${hash5} ${hash5 === hmac ? '✅ MATCH!' : '❌'}`);
    console.log(`   Hex digest:       ${hashHex.substring(0, 40)}...`);
    
    // Verificar si alguno coincide
    const hashes = [hash1, hash2, hash3, hash4, hash5];
    const matchingHash = hashes.find(h => h === hmac);
    
    if (!matchingHash) {
      console.error('\n❌ NINGÚN MÉTODO COINCIDE');
      console.error('🔍 Análisis adicional:');
      console.error(`   HMAC length: Shopify=${hmac.length}, Calculated=${hash1.length}`);
      console.error(`   Secret tiene espacios: ${secret !== secret.trim()}`);
      console.error(`   Body tiene BOM: ${body.charCodeAt(0) === 0xFEFF}`);
      console.error(`   Content-Type: ${req.headers['content-type']}`);
      
      // Verificar byte por byte los primeros caracteres
      console.error('\n🔬 Byte analysis (first 20 bytes):');
      for (let i = 0; i < Math.min(20, bodyBuffer.length); i++) {
        console.error(`   [${i}] ${bodyBuffer[i]} (0x${bodyBuffer[i].toString(16)}) = '${String.fromCharCode(bodyBuffer[i])}'`);
      }
      
      console.log('='.repeat(60) + '\n');
      
      return res.status(401).json({ error: 'Invalid HMAC signature' });
    }
    
    console.log(`\n✅ WEBHOOK VERIFICADO con método que coincidió`);
    console.log('='.repeat(60) + '\n');
    
    // Parsear body para los controllers
    try {
      req.body = JSON.parse(body);
    } catch (e) {
      console.error('❌ Error parseando body:', e);
    }
    
    next();
    
  } catch (error) {
    console.error('❌ Error en validateWebhook:', error);
    console.error(error.stack);
    res.status(500).json({ error: 'Error validating webhook' });
  }
};

module.exports = { validateShopifyWebhook };