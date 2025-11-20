require('dotenv').config();
const axios = require('axios');

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

async function getWebhooks() {
  try {
    const response = await axios.get(
      `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/webhooks.json`,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
        }
      }
    );
    
    console.log('\n📋 Webhooks configurados:\n');
    
    response.data.webhooks.forEach((webhook, index) => {
      console.log(`${index + 1}. ${webhook.topic}`);
      console.log(`   URL: ${webhook.address}`);
      console.log(`   ID: ${webhook.id}`);
      console.log(`   Created: ${webhook.created_at}\n`);
    });
    
    console.log('⚠️  IMPORTANTE: El webhook secret NO se puede obtener por API');
    console.log('Ve a Shopify Admin → Settings → Notifications → Webhooks');
    console.log('Haz clic en cualquier webhook y copia el "Webhook signing secret"\n');
    
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

getWebhooks();