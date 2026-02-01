// backend/src/jobs/delayedShipmentJob.js
// 📱 Delayed Shipment SMS Job - Notifies customers when orders are unfulfilled > 72 hours
const cron = require('node-cron');
const shopifyService = require('../services/shopifyService');
const smsTransactionalService = require('../services/smsTransactionalService');

let job = null;
let isRunning = false;

// Configuration
const DEFAULT_DELAY_HOURS = 72;
const MAX_PER_RUN = 50;

/**
 * Check if within reasonable sending hours (9am-9pm Eastern)
 */
const isWithinSendingHours = () => {
  const now = new Date();
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hour = eastern.getHours();
  return hour >= 9 && hour < 21;
};

/**
 * Process unfulfilled orders and send delay notifications
 */
const runDelayedShipmentJob = async () => {
  if (isRunning) {
    console.log('⏳ Delayed Shipment job already running, skipping...');
    return;
  }

  isRunning = true;
  const startTime = Date.now();

  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║     📦 DELAYED SHIPMENT SMS JOB STARTED        ║');
  console.log(`║     ${new Date().toISOString()}             ║`);
  console.log('╚════════════════════════════════════════════════╝');

  try {
    // Check if within sending hours
    if (!isWithinSendingHours()) {
      console.log('⏰ Outside sending hours (9am-9pm Eastern). Skipping...');
      isRunning = false;
      return { skipped: true, reason: 'outside_hours' };
    }

    // Check if trigger is enabled
    const settings = smsTransactionalService.getSettings();
    if (!settings.delayed_shipment?.enabled) {
      console.log('⚠️ Delayed shipment trigger is disabled. Skipping...');
      isRunning = false;
      return { skipped: true, reason: 'trigger_disabled' };
    }

    const delayHours = smsTransactionalService.getDelayHours();
    console.log(`\n🔍 Looking for orders unfulfilled > ${delayHours} hours...`);

    // Get unfulfilled orders from Shopify
    const orders = await shopifyService.getUnfulfilledOrders(delayHours, MAX_PER_RUN);

    if (orders.length === 0) {
      console.log('✅ No delayed orders found. All good!');
      isRunning = false;
      return { processed: 0, success: 0, skipped: 0 };
    }

    console.log(`\n📤 Processing ${orders.length} delayed orders...`);

    let processed = 0;
    let success = 0;
    let skipped = 0;
    let failed = 0;

    for (const order of orders) {
      processed++;
      const orderNumber = order.order_number || order.name?.replace('#', '');
      const hoursOld = Math.round((Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60));

      console.log(`\n   [${processed}/${orders.length}] Order #${orderNumber} (${hoursOld}h old)`);

      try {
        const result = await smsTransactionalService.sendDelayedShipmentNotification(order);

        if (result.success) {
          success++;
          console.log(`   ✅ SMS sent successfully`);
        } else if (result.reason === 'already_sent') {
          skipped++;
          console.log(`   ⏭️ Already notified, skipping`);
        } else if (result.reason === 'no_phone') {
          skipped++;
          console.log(`   ⚠️ No phone number, skipping`);
        } else {
          failed++;
          console.log(`   ❌ Failed: ${result.reason}`);
        }
      } catch (err) {
        failed++;
        console.error(`   ❌ Error: ${err.message}`);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log('\n╔════════════════════════════════════════════════╗');
    console.log('║           DELAYED SHIPMENT JOB RESULTS         ║');
    console.log('╠════════════════════════════════════════════════╣');
    console.log(`║  Orders Processed:  ${processed.toString().padStart(4)}                      ║`);
    console.log(`║  SMS Sent:          ${success.toString().padStart(4)}                      ║`);
    console.log(`║  Skipped:           ${skipped.toString().padStart(4)}                      ║`);
    console.log(`║  Failed:            ${failed.toString().padStart(4)}                      ║`);
    console.log(`║  Duration:          ${duration.padStart(4)}s                     ║`);
    console.log('╚════════════════════════════════════════════════╝\n');

    return { processed, success, skipped, failed };

  } catch (error) {
    console.error('❌ Delayed Shipment Job Error:', error);
    return { error: error.message };
  } finally {
    isRunning = false;
  }
};

/**
 * Initialize the cron job
 * @param {string} schedule - Cron schedule (default: every 6 hours)
 */
const init = (schedule = '0 */6 * * *') => {
  if (job) {
    console.log('⚠️ Delayed Shipment job already initialized');
    return;
  }

  const delayHours = smsTransactionalService.getDelayHours();

  console.log(`📦 Initializing Delayed Shipment SMS Job...`);
  console.log(`   Schedule: ${schedule} (every 6 hours)`);
  console.log(`   Delay threshold: ${delayHours} hours`);
  console.log(`   Sending hours: 9:00 AM - 9:00 PM (Eastern)`);
  console.log(`   Max per run: ${MAX_PER_RUN}`);

  job = cron.schedule(schedule, runDelayedShipmentJob, {
    scheduled: true,
    timezone: 'America/New_York'
  });

  console.log(`✅ Delayed Shipment SMS Job scheduled`);

  return job;
};

/**
 * Stop the cron job
 */
const stop = () => {
  if (job) {
    job.stop();
    job = null;
    console.log('🛑 Delayed Shipment SMS Job stopped');
  }
};

/**
 * Run job manually (for testing)
 */
const runNow = async () => {
  console.log('🔧 Running Delayed Shipment SMS Job manually...');
  return runDelayedShipmentJob();
};

/**
 * Get job status
 */
const getStatus = () => {
  return {
    initialized: !!job,
    running: isRunning,
    withinSendingHours: isWithinSendingHours(),
    delayHours: smsTransactionalService.getDelayHours(),
    triggerEnabled: smsTransactionalService.getSettings().delayed_shipment?.enabled
  };
};

module.exports = {
  init,
  stop,
  runNow,
  getStatus
};
