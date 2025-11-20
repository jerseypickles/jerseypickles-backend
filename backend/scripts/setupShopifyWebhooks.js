// scripts/setupShopifyWebhooks.js
require('dotenv').config();
const axios = require('axios');

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL;

// Validación
if (!SHOPIFY_DOMAIN) {
  console.error('❌ SHOPIFY_STORE_URL no configurado');
  process.exit(1);
}

if (!SHOPIFY_ACCESS_TOKEN) {
  console.error('❌ SHOPIFY_ACCESS_TOKEN no configurado');
  console.log('\n📖 Obtén el token:');
  console.log('Shopify Admin → Settings → Apps and sales channels → Develop apps\n');
  process.exit(1);
}

if (!WEBHOOK_BASE_URL) {
  console.error('❌ WEBHOOK_BASE_URL no configurado');
  process.exit(1);
}

const webhooks = [
  {
    topic: 'customers/create',
    address: `${WEBHOOK_BASE_URL}/api/webhooks/customers/create`,
    format: 'json'
  },
  {
    topic: 'customers/update',
    address: `${WEBHOOK_BASE_URL}/api/webhooks/customers/update`,
    format: 'json'
  },
  {
    topic: 'orders/create',
    address: `${WEBHOOK_BASE_URL}/api/webhooks/orders/create`,
    format: 'json'
  },
  {
    topic: 'orders/updated',
    address: `${WEBHOOK_BASE_URL}/api/webhooks/orders/update`,
    format: 'json'
  }
];

async function createWebhooks() {
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║   🔧 CONFIGURANDO WEBHOOKS DE SHOPIFY         ║');
  console.log('╚════════════════════════════════════════════════╝\n');
  
  console.log(`📍 Tienda: ${SHOPIFY_DOMAIN}`);
  console.log(`🌐 Backend: ${WEBHOOK_BASE_URL}`);
  console.log(`🔑 Token: ${SHOPIFY_ACCESS_TOKEN.substring(0, 15)}...\n`);
  
  let created = 0;
  let existing = 0;
  let failed = 0;
  
  for (const webhook of webhooks) {
    try {
      const response = await axios.post(
        `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/webhooks.json`,
        { webhook },
        {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
            'Content-Type': 'application/json'
          }
        }
      );
      
      console.log(`✅ Creado: ${webhook.topic}`);
      console.log(`   URL: ${webhook.address}`);
      console.log(`   ID: ${response.data.webhook.id}\n`);
      created++;
      
    } catch (error) {
      if (error.response?.status === 422) {
        const errorMsg = error.response?.data?.errors?.address?.[0] || 'Ya existe';
        console.log(`⚠️  ${webhook.topic}: ${errorMsg}\n`);
        existing++;
      } else {
        console.error(`❌ Error en ${webhook.topic}:`);
        console.error(`   Status: ${error.response?.status}`);
        console.error(`   Error: ${JSON.stringify(error.response?.data, null, 2)}\n`);
        failed++;
      }
    }
  }
  
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║   📊 RESUMEN                                   ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log(`✅ Creados: ${created}`);
  console.log(`⚠️  Ya existían: ${existing}`);
  console.log(`❌ Fallidos: ${failed}`);
  console.log(`📊 Total: ${webhooks.length}\n`);
  
  if (created > 0 || existing > 0) {
    console.log('🎉 Webhooks configurados!\n');
    console.log('📝 SIGUIENTE PASO: Obtener el SHOPIFY_WEBHOOK_SECRET');
    console.log('   1. Shopify Admin → Settings → Notifications');
    console.log('   2. Scroll a "Webhooks"');
    console.log('   3. Click en cualquier webhook');
    console.log('   4. Copia "Webhook signing secret"');
    console.log('   5. Agrégalo a .env como SHOPIFY_WEBHOOK_SECRET\n');
  }
}

async function listWebhooks() {
  try {
    const response = await axios.get(
      `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/webhooks.json`,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
        }
      }
    );
    
    console.log('\n📋 Webhooks configurados en Shopify:\n');
    
    if (response.data.webhooks.length === 0) {
      console.log('   (Ninguno configurado)\n');
    } else {
      response.data.webhooks.forEach((webhook, index) => {
        console.log(`${index + 1}. ${webhook.topic}`);
        console.log(`   URL: ${webhook.address}`);
        console.log(`   ID: ${webhook.id}`);
        console.log(`   Creado: ${new Date(webhook.created_at).toLocaleString()}\n`);
      });
    }
    
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

async function deleteAllWebhooks() {
  try {
    const response = await axios.get(
      `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/webhooks.json`,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
        }
      }
    );
    
    if (response.data.webhooks.length === 0) {
      console.log('\n✅ No hay webhooks para borrar\n');
      return;
    }
    
    console.log(`\n🗑️  Borrando ${response.data.webhooks.length} webhooks...\n`);
    
    for (const webhook of response.data.webhooks) {
      await axios.delete(
        `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/webhooks/${webhook.id}.json`,
        {
          headers: {
            'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
          }
        }
      );
      console.log(`✅ Borrado: ${webhook.topic}`);
    }
    
    console.log('\n✅ Todos los webhooks eliminados\n');
    
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
  }
}

// CLI
const command = process.argv[2];

switch (command) {
  case 'list':
    listWebhooks();
    break;
  case 'delete':
    deleteAllWebhooks();
    break;
  case 'create':
  default:
    createWebhooks();
    break;
}