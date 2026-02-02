// backend/scripts/syncSecondSmsStatus.js
// 📱 Script to sync Second SMS status from Telnyx API
// Fixes the issue where webhooks aren't updating the status

require('dotenv').config();
const mongoose = require('mongoose');
const SmsSubscriber = require('../src/models/SmsSubscriber');
const telnyxService = require('../src/services/telnyxService');

const BATCH_SIZE = 50;
const DELAY_MS = 200; // 200ms between API calls to avoid rate limiting

async function syncSecondSmsStatus() {
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║   📱 SYNC SECOND SMS STATUS FROM TELNYX       ║');
  console.log('╚════════════════════════════════════════════════╝\n');

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Find all subscribers with secondSmsSent=true but status != delivered
    const subscribers = await SmsSubscriber.find({
      secondSmsSent: true,
      secondSmsMessageId: { $exists: true, $ne: null },
      secondSmsStatus: { $nin: ['delivered', 'failed', 'undelivered'] }
    }).limit(500);

    console.log(`Found ${subscribers.length} subscribers to sync\n`);

    if (subscribers.length === 0) {
      console.log('✅ All subscribers already synced!');
      await mongoose.disconnect();
      return;
    }

    const results = {
      synced: 0,
      delivered: 0,
      failed: 0,
      sent: 0,
      errors: 0
    };

    for (let i = 0; i < subscribers.length; i++) {
      const subscriber = subscribers[i];

      try {
        // Get status from Telnyx API
        const telnyxStatus = await telnyxService.getMessageStatus(subscriber.secondSmsMessageId);

        if (telnyxStatus.success) {
          const newStatus = telnyxStatus.status;

          // Update subscriber
          subscriber.secondSmsStatus = newStatus;

          if (newStatus === 'delivered') {
            subscriber.totalSmsDelivered = (subscriber.totalSmsDelivered || 0) + 1;
            results.delivered++;
          } else if (newStatus === 'failed' || newStatus === 'undelivered') {
            results.failed++;
          } else {
            results.sent++;
          }

          await subscriber.save();
          results.synced++;

          console.log(`${i + 1}/${subscribers.length} - ***${subscriber.phone.slice(-4)}: ${newStatus}`);
        } else {
          console.log(`${i + 1}/${subscribers.length} - ***${subscriber.phone.slice(-4)}: Error - ${telnyxStatus.error}`);
          results.errors++;
        }

        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));

      } catch (error) {
        console.error(`Error syncing ${subscriber.phone.slice(-4)}:`, error.message);
        results.errors++;
      }
    }

    console.log('\n╔════════════════════════════════════════════════╗');
    console.log('║              SYNC RESULTS                       ║');
    console.log('╠════════════════════════════════════════════════╣');
    console.log(`║  Total Synced:  ${results.synced.toString().padStart(4)}                         ║`);
    console.log(`║  Delivered:     ${results.delivered.toString().padStart(4)}                         ║`);
    console.log(`║  Failed:        ${results.failed.toString().padStart(4)}                         ║`);
    console.log(`║  Still Sent:    ${results.sent.toString().padStart(4)}                         ║`);
    console.log(`║  Errors:        ${results.errors.toString().padStart(4)}                         ║`);
    console.log('╚════════════════════════════════════════════════╝');

    await mongoose.disconnect();
    console.log('\n✅ Disconnected from MongoDB');

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  syncSecondSmsStatus();
}

module.exports = { syncSecondSmsStatus };
