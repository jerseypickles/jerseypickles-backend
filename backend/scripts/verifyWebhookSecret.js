// scripts/verifyWebhookSecret.js
require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');

const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

console.log('🔍 Verificando configuración de webhook secret\n');

// 1. Verificar el secret
console.log('1️⃣ VERIFICANDO SECRET:');
console.log(`   Length: ${secret.length}`);
console.log(`   First 10: ${secret.substring(0, 10)}...`);
console.log(`   Last 10: ...${secret.substring(secret.length - 10)}`);
console.log(`   Tiene espacios al inicio: ${secret[0] === ' '}`);
console.log(`   Tiene espacios al final: ${secret[secret.length - 1] === ' '}`);
console.log(`   Tiene saltos de línea: ${secret.includes('\n')}`);
console.log(`   Secret trimmed === original: ${secret === secret.trim()}`);

if (secret !== secret.trim()) {
  console.log('\n⚠️  WARNING: El secret tiene espacios o saltos de línea!');
  console.log(`   Original length: ${secret.length}`);
  console.log(`   Trimmed length: ${secret.trim().length}`);
  console.log('\n💡 SOLUCIÓN: Actualiza el secret en Render sin espacios extras');
}

console.log('\n2️⃣ VERIFICANDO WEBHOOKS EN SHOPIFY:');

async function checkWebhooks() {
  try {
    const response = await axios.get(
      `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/webhooks.json`,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
        }
      }
    );
    
    console.log(`   Total webhooks: ${response.data.webhooks.length}\n`);
    
    response.data.webhooks.forEach((webhook, index) => {
      console.log(`   ${index + 1}. ${webhook.topic}`);
      console.log(`      URL: ${webhook.address}`);
      console.log(`      Created: ${webhook.created_at}`);
    });
    
  } catch (error) {
    console.error('   Error:', error.message);
  }
}

checkWebhooks();

// 3. Test HMAC con ejemplo
console.log('\n3️⃣ TEST HMAC CON EJEMPLO:');
const testBody = JSON.stringify({ test: 'data', id: 12345 });
const testHmac = crypto
  .createHmac('sha256', secret)
  .update(testBody, 'utf8')
  .digest('base64');

console.log(`   Test body: ${testBody}`);
console.log(`   Test HMAC: ${testHmac}`);
console.log('\n💡 Copia este HMAC y compáralo con lo que ves en Shopify\n');