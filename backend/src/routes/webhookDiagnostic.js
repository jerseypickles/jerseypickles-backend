// backend/src/routes/webhookDiagnostic.js
// 🔧 Diagnostic endpoint to debug webhook HMAC issues
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

/**
 * Diagnostic endpoint - logs everything about the incoming webhook
 * Add this TEMPORARILY to debug HMAC issues
 * 
 * Usage: Point a test webhook to /api/webhook-debug
 */
router.post('/debug', (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const topic = req.headers['x-shopify-topic'];
  const shopDomain = req.headers['x-shopify-shop-domain'];
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  
  console.log('\n' + '='.repeat(60));
  console.log('🔍 WEBHOOK DIAGNOSTIC');
  console.log('='.repeat(60));
  
  // Headers
  console.log('\n📋 HEADERS:');
  console.log(`   x-shopify-hmac-sha256: ${hmac || 'MISSING'}`);
  console.log(`   x-shopify-topic: ${topic || 'MISSING'}`);
  console.log(`   x-shopify-shop-domain: ${shopDomain || 'MISSING'}`);
  console.log(`   content-type: ${req.headers['content-type']}`);
  console.log(`   content-length: ${req.headers['content-length']}`);
  
  // Secret
  console.log('\n🔑 SECRET:');
  console.log(`   Configured: ${secret ? 'YES' : 'NO'}`);
  console.log(`   Length: ${secret ? secret.length : 0}`);
  console.log(`   First 4 chars: ${secret ? secret.substring(0, 4) + '...' : 'N/A'}`);
  console.log(`   Last 4 chars: ${secret ? '...' + secret.slice(-4) : 'N/A'}`);
  
  // Body
  console.log('\n📦 BODY:');
  console.log(`   Type: ${typeof req.body}`);
  console.log(`   Is Buffer: ${Buffer.isBuffer(req.body)}`);
  console.log(`   Has rawBody: ${!!req.rawBody}`);
  
  let rawBody;
  
  if (Buffer.isBuffer(req.body)) {
    rawBody = req.body;
    console.log(`   Buffer length: ${rawBody.length}`);
  } else if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
    rawBody = req.rawBody;
    console.log(`   rawBody length: ${rawBody.length}`);
  } else if (typeof req.body === 'object') {
    console.log('   ⚠️  Body was already parsed as JSON!');
    rawBody = Buffer.from(JSON.stringify(req.body));
    console.log(`   Reconstructed length: ${rawBody.length}`);
  } else {
    console.log('   ❌ No valid body found');
    rawBody = Buffer.from('');
  }
  
  // Show body content
  const bodyStr = rawBody.toString('utf8');
  console.log(`\n   First 200 chars:\n   ${bodyStr.substring(0, 200)}...`);
  console.log(`\n   Last 100 chars:\n   ...${bodyStr.slice(-100)}`);
  
  // HMAC Calculation
  console.log('\n🔐 HMAC CALCULATION:');
  
  if (secret && rawBody.length > 0) {
    const calculatedHmac = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');
    
    console.log(`   Expected (Shopify): ${hmac}`);
    console.log(`   Calculated:         ${calculatedHmac}`);
    console.log(`   Match: ${hmac === calculatedHmac ? '✅ YES' : '❌ NO'}`);
    
    if (hmac !== calculatedHmac) {
      // Try different encodings
      console.log('\n🔄 TRYING DIFFERENT APPROACHES:');
      
      // Try with trimmed secret
      const trimmedSecret = secret.trim();
      if (trimmedSecret !== secret) {
        const hmacTrimmed = crypto
          .createHmac('sha256', trimmedSecret)
          .update(rawBody)
          .digest('base64');
        console.log(`   With trimmed secret: ${hmacTrimmed}`);
        console.log(`   Match: ${hmac === hmacTrimmed ? '✅ YES' : '❌ NO'}`);
      }
      
      // Try with body as string
      const hmacString = crypto
        .createHmac('sha256', secret)
        .update(bodyStr, 'utf8')
        .digest('base64');
      console.log(`   With body as string: ${hmacString}`);
      console.log(`   Match: ${hmac === hmacString ? '✅ YES' : '❌ NO'}`);
      
      // Check for BOM or hidden characters
      const hasBOM = rawBody[0] === 0xEF && rawBody[1] === 0xBB && rawBody[2] === 0xBF;
      console.log(`\n   Has BOM: ${hasBOM}`);
      console.log(`   First 5 bytes: ${Array.from(rawBody.slice(0, 5)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')}`);
      console.log(`   Last 5 bytes: ${Array.from(rawBody.slice(-5)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')}`);
    }
  } else {
    console.log('   ❌ Cannot calculate - missing secret or body');
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('END DIAGNOSTIC');
  console.log('='.repeat(60) + '\n');
  
  res.json({
    received: true,
    diagnostic: {
      hasHmac: !!hmac,
      hasTopic: !!topic,
      hasSecret: !!secret,
      bodyType: typeof req.body,
      isBuffer: Buffer.isBuffer(req.body),
      hasRawBody: !!req.rawBody,
      bodyLength: rawBody.length
    }
  });
});

/**
 * Test endpoint to generate a valid HMAC for testing
 */
router.post('/generate-hmac', express.json(), (req, res) => {
  const { payload, secret } = req.body;
  
  if (!payload || !secret) {
    return res.status(400).json({ error: 'Provide payload and secret' });
  }
  
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(body, 'utf8')
    .digest('base64');
  
  res.json({
    hmac,
    bodyLength: body.length,
    secretLength: secret.length
  });
});

module.exports = router;