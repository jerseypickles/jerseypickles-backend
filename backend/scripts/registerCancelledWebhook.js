// scripts/registerCancelledWebhook.js
// Register the orders/cancelled webhook in Shopify

require('dotenv').config();
const axios = require('axios');

// Uses SHOPIFY_STORE_URL which should be like "jersey-pickles.myshopify.com"
const SHOPIFY_STORE_URL = process.env.SHOPIFY_STORE_URL;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const APP_URL = process.env.APP_URL || 'https://jerseypickles-backend.onrender.com';

async function registerCancelledWebhook() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║  📱 REGISTER orders/cancelled WEBHOOK  ║');
  console.log('╚════════════════════════════════════════╝\n');

  console.log('Store URL:', SHOPIFY_STORE_URL);
  console.log('App URL:', APP_URL);
  console.log('Token exists:', SHOPIFY_TOKEN ? 'YES' : 'NO');
  console.log('');

  if (!SHOPIFY_STORE_URL || !SHOPIFY_TOKEN) {
    console.error('❌ Missing SHOPIFY_STORE_URL or SHOPIFY_ACCESS_TOKEN');
    process.exit(1);
  }

  try {
    const baseUrl = `https://${SHOPIFY_STORE_URL}/admin/api/2024-01`;
    const headers = {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json'
    };

    // First, list existing webhooks
    console.log('🔍 Listing existing webhooks...\n');

    const listResponse = await axios.get(`${baseUrl}/webhooks.json`, { headers });

    const webhooks = listResponse.data.webhooks || [];
    console.log(`Found ${webhooks.length} webhooks:\n`);

    webhooks.forEach(w => {
      console.log(`  ${w.topic === 'orders/cancelled' ? '✅' : '  '} ${w.topic}`);
      console.log(`     ${w.address}`);
    });

    // Check if orders/cancelled exists
    const cancelledWebhook = webhooks.find(w => w.topic === 'orders/cancelled');

    if (cancelledWebhook) {
      console.log('\n✅ orders/cancelled webhook ALREADY EXISTS');
      console.log(`   ID: ${cancelledWebhook.id}`);
      console.log(`   Address: ${cancelledWebhook.address}`);

      // Check if URL is correct
      const expectedUrl = `${APP_URL}/api/webhooks/orders/cancelled`;
      if (cancelledWebhook.address !== expectedUrl) {
        console.log('\n⚠️  URL mismatch! Updating...');
        console.log(`   Current: ${cancelledWebhook.address}`);
        console.log(`   Expected: ${expectedUrl}`);

        // Delete and recreate
        await axios.delete(`${baseUrl}/webhooks/${cancelledWebhook.id}.json`, { headers });
        console.log('   Deleted old webhook');

        const createResponse = await axios.post(`${baseUrl}/webhooks.json`, {
          webhook: {
            topic: 'orders/cancelled',
            address: expectedUrl,
            format: 'json'
          }
        }, { headers });

        console.log('   ✅ Created new webhook with correct URL');
        console.log(`   ID: ${createResponse.data.webhook.id}`);
      }
    } else {
      console.log('\n❌ orders/cancelled webhook NOT FOUND');
      console.log('   Creating...\n');

      const webhookUrl = `${APP_URL}/api/webhooks/orders/cancelled`;

      const createResponse = await axios.post(`${baseUrl}/webhooks.json`, {
        webhook: {
          topic: 'orders/cancelled',
          address: webhookUrl,
          format: 'json'
        }
      }, { headers });

      console.log('✅ Webhook created successfully!');
      console.log(`   ID: ${createResponse.data.webhook.id}`);
      console.log(`   Topic: ${createResponse.data.webhook.topic}`);
      console.log(`   Address: ${createResponse.data.webhook.address}`);
    }

    console.log('\n✨ Done!\n');

  } catch (error) {
    console.error('\n❌ Error:', error.response?.data || error.message);
    process.exit(1);
  }
}

registerCancelledWebhook();
