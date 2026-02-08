// backend/src/middleware/validateWebhook.js
// 🔧 FIXED - Robust HMAC validation for Shopify webhooks
const crypto = require('crypto');

const getWebhookSecrets = () => {
  const raw = [
    process.env.SHOPIFY_WEBHOOK_SECRET,
    process.env.SHOPIFY_WEBHOOK_SECRETS,
    process.env.SHOPIFY_WEBHOOK_SECRET_PREVIOUS,
    process.env.SHOPIFY_WEBHOOK_SECRET_OLD,
    process.env.SHOPIFY_API_SECRET,
    process.env.SHOPIFY_API_SECRET_KEY
  ]
    .filter(Boolean)
    .flatMap(value => String(value).split(','))
    .map(value => value.trim())
    .filter(Boolean);

  return [...new Set(raw)];
};

/**
 * Middleware para capturar raw body ANTES de cualquier parseo
 * Debe usarse ANTES de express.json()
 */
const captureRawBody = (req, res, next) => {
  // Solo para rutas de webhooks de Shopify
  if (!req.path.startsWith('/webhooks/') && !req.path.startsWith('/api/webhooks/')) {
    return next();
  }
  
  // Si ya tiene rawBody, continuar
  if (req.rawBody) {
    return next();
  }
  
  const chunks = [];
  
  req.on('data', (chunk) => {
    chunks.push(chunk);
  });
  
  req.on('end', () => {
    if (chunks.length > 0) {
      req.rawBody = Buffer.concat(chunks);
    }
    next();
  });
  
  req.on('error', (err) => {
    console.error('❌ Error capturing raw body:', err);
    next(err);
  });
};

/**
 * Validar webhook de Shopify usando HMAC-SHA256
 */
const validateShopifyWebhook = (req, res, next) => {
  try {
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const topic = req.headers['x-shopify-topic'];
    const shopDomain = req.headers['x-shopify-shop-domain'];
    const webhookId = req.headers['x-shopify-webhook-id'];
    const secrets = getWebhookSecrets();
    
    console.log(`\n🔍 Validating Shopify Webhook`);
    console.log(`   Topic: ${topic}`);
    console.log(`   Shop: ${shopDomain}`);
    if (webhookId) console.log(`   Webhook ID: ${webhookId}`);
    
    // Validar headers requeridos
    if (!hmac) {
      console.error('❌ Missing X-Shopify-Hmac-Sha256 header');
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'Missing HMAC header'
      });
    }
    
    if (secrets.length === 0) {
      console.error('❌ Shopify webhook secret(s) not configured');
      return res.status(500).json({ 
        error: 'Configuration error',
        message: 'Webhook secret not configured'
      });
    }
    
    // Obtener el raw body (puede venir de diferentes fuentes)
    let rawBody;
    
    // Opción 1: Body ya es Buffer (express.raw)
    if (Buffer.isBuffer(req.body)) {
      rawBody = req.body;
      console.log(`   ✅ Body is Buffer (express.raw)`);
    }
    // Opción 2: rawBody capturado por middleware
    else if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
      rawBody = req.rawBody;
      console.log(`   ✅ Using captured rawBody`);
    }
    // Opción 3: Body es objeto, necesitamos stringify (NO IDEAL - puede fallar)
    else if (typeof req.body === 'object' && req.body !== null) {
      console.warn('   ⚠️  Body was already parsed! Attempting to reconstruct...');
      // Esto puede fallar si el JSON original tenía formato diferente
      rawBody = Buffer.from(JSON.stringify(req.body));
    }
    else {
      console.error('❌ No valid body found');
      console.error(`   Body type: ${typeof req.body}`);
      return res.status(400).json({ 
        error: 'Bad request',
        message: 'No valid body'
      });
    }
    
    console.log(`   Buffer length: ${rawBody.length}`);
    console.log(`   Configured secrets: ${secrets.length}`);

    // Comparar HMAC contra todos los secretos configurados (current + previous)
    const hmacBuffer = Buffer.from(hmac, 'base64');
    let isValid = false;
    let calculatedHmac = null;

    for (const secret of secrets) {
      const candidateHmac = crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('base64');

      if (!calculatedHmac) calculatedHmac = candidateHmac;

      const candidateBuffer = Buffer.from(candidateHmac, 'base64');
      if (hmacBuffer.length === candidateBuffer.length && crypto.timingSafeEqual(hmacBuffer, candidateBuffer)) {
        isValid = true;
        calculatedHmac = candidateHmac;
        break;
      }
    }
    
    if (!isValid) {
      console.error('❌ HMAC validation failed');
      console.error(`   Calculated: ${calculatedHmac}`);
      console.error(`   Expected:   ${hmac}`);
      console.error(`   Topic:      ${topic}`);
      
      // Debug info
      console.error(`   First 50 chars: ${rawBody.toString('utf8').substring(0, 50)}...`);
      console.error(`   Last 50 chars: ...${rawBody.toString('utf8').slice(-50)}`);
      
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'Invalid HMAC signature',
        debug: {
          topic,
          bodyLength: rawBody.length,
          hmacProvided: hmac.substring(0, 10) + '...',
          hmacCalculated: calculatedHmac.substring(0, 10) + '...'
        }
      });
    }
    
    console.log(`   ✅ HMAC valid`);
    
    // Parsear body si aún es Buffer
    if (Buffer.isBuffer(req.body)) {
      try {
        req.body = JSON.parse(rawBody.toString('utf8'));
        console.log(`   ✅ Body parsed successfully`);
      } catch (parseError) {
        console.error('❌ JSON parse error:', parseError.message);
        return res.status(400).json({ 
          error: 'Bad request',
          message: 'Invalid JSON body'
        });
      }
    }
    
    // Guardar metadata del webhook
    req.shopifyWebhook = {
      topic,
      shopDomain,
      hmacValid: true,
      receivedAt: new Date()
    };
    
    console.log(`✅ Webhook verified: ${topic}\n`);
    
    next();
    
  } catch (error) {
    console.error('❌ Webhook validation error:', error);
    console.error(error.stack);
    res.status(500).json({ 
      error: 'Internal error',
      message: 'Error validating webhook'
    });
  }
};

/**
 * Middleware alternativo: skip validation en desarrollo
 * SOLO USAR PARA TESTING
 */
const validateShopifyWebhookDev = (req, res, next) => {
  if (process.env.NODE_ENV === 'development' && process.env.SKIP_WEBHOOK_VALIDATION === 'true') {
    console.log('⚠️  WEBHOOK VALIDATION SKIPPED (dev mode)');
    
    // Parsear body si es Buffer
    if (Buffer.isBuffer(req.body)) {
      try {
        req.body = JSON.parse(req.body.toString('utf8'));
      } catch (e) {
        return res.status(400).json({ error: 'Invalid JSON' });
      }
    }
    
    req.shopifyWebhook = {
      topic: req.headers['x-shopify-topic'],
      shopDomain: req.headers['x-shopify-shop-domain'],
      hmacValid: false,
      skipped: true
    };
    
    return next();
  }
  
  // En producción, usar validación real
  return validateShopifyWebhook(req, res, next);
};

module.exports = { 
  validateShopifyWebhook,
  validateShopifyWebhookDev,
  captureRawBody
};
