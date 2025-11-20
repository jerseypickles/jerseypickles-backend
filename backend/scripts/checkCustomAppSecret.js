// scripts/checkCustomAppSecret.js
require('dotenv').config();
const axios = require('axios');

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_URL;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

console.log('🔍 Verificando Custom App Configuration\n');

async function checkApp() {
  try {
    // Verificar access token
    const response = await axios.get(
      `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/shop.json`,
      {
        headers: {
          'X-Shopify-Access-Token': ACCESS_TOKEN
        }
      }
    );
    
    console.log('✅ Custom App está conectado correctamente');
    console.log(`   Shop: ${response.data.shop.name}`);
    console.log(`   Domain: ${response.data.shop.domain}`);
    
    console.log('\n📝 NEXT STEPS:');
    console.log('1. Ve a: Shopify Admin → Settings → Apps and sales channels');
    console.log('2. Click en "Develop apps"');
    console.log('3. Click en tu app');
    console.log('4. Click en "API credentials"');
    console.log('5. Copia el "API secret key" (NO el Admin API access token)');
    console.log('6. Actualiza SHOPIFY_WEBHOOK_SECRET en Render con ese valor');
    console.log('\n⚠️  IMPORTANTE: El secret que ves en Settings → Notifications');
    console.log('   es DIFERENTE y solo funciona para webhooks manuales.');
    
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
    console.error('\n💡 Esto probablemente significa que no tienes un Custom App configurado.');
    console.error('   Necesitas crear uno para usar webhooks por API.\n');
  }
}

checkApp();