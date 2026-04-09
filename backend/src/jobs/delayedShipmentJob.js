// backend/src/jobs/delayedShipmentJob.js
// 📱 Delayed Shipment SMS Job - Notifies customers when orders are unfulfilled > 72 hours
const cron = require('node-cron');
const shopifyService = require('../services/shopifyService');
const smsTransactionalService = require('../services/smsTransactionalService');
const DelayedShipmentQueue = require('../models/DelayedShipmentQueue');

let job = null;
let syncJob = null;
let isRunning = false;
let isSyncing = false;

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
 * Sync unfulfilled orders from Shopify to queue
 */
const syncOrdersToQueue = async () => {
  if (isSyncing) {
    console.log('⏳ Queue sync already running, skipping...');
    return;
  }

  isSyncing = true;
  console.log('\n📦 Syncing unfulfilled orders to queue...');

  try {
    const delayHours = smsTransactionalService.getDelayHours();

    // Get all unfulfilled orders (not just old ones)
    const orders = await shopifyService.getUnfulfilledOrders(0, 100);

    // Clean up orders that are no longer unfulfilled (were fulfilled in Shopify)
    const currentOrderIds = orders.map(o => o.id);
    const cleanupResult = await DelayedShipmentQueue.cleanupFulfilledOrders(currentOrderIds);
    if (cleanupResult.modifiedCount > 0) {
      console.log(`   🧹 Marked ${cleanupResult.modifiedCount} fulfilled orders as skipped`);
    }

    if (orders.length === 0) {
      console.log('   ✅ No unfulfilled orders found');
      return { synced: 0, cleaned: cleanupResult.modifiedCount || 0 };
    }

    let added = 0;
    let updated = 0;

    for (const order of orders) {
      const result = await DelayedShipmentQueue.upsertOrder(order, delayHours);
      if (result.createdAt && result.createdAt.getTime() === result.updatedAt.getTime()) {
        added++;
      } else {
        updated++;
      }
    }

    console.log(`   ✅ Synced ${orders.length} orders (${added} new, ${updated} updated)`);
    return { synced: orders.length, added, updated, cleaned: cleanupResult.modifiedCount || 0 };

  } catch (error) {
    console.error('❌ Queue sync error:', error.message);
    return { error: error.message };
  } finally {
    isSyncing = false;
  }
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
      console.log('⏰ Outside sending hours (9am-9pm Eastern). Skipping send...');
      // Still sync orders even outside hours
      await syncOrdersToQueue();
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

    // Sync orders to queue first
    await syncOrdersToQueue();

    // Get orders ready to send from queue
    const queuedOrders = await DelayedShipmentQueue.getReadyToSend(MAX_PER_RUN);

    if (queuedOrders.length === 0) {
      console.log('✅ No orders ready to send. All good!');
      isRunning = false;
      return { processed: 0, success: 0, skipped: 0 };
    }

    console.log(`\n📤 Processing ${queuedOrders.length} queued orders...`);

    let processed = 0;
    let success = 0;
    let skipped = 0;
    let failed = 0;

    for (const queueItem of queuedOrders) {
      processed++;
      const orderNumber = queueItem.orderNumber;
      const hoursOld = queueItem.hoursUnfulfilled;

      console.log(`\n   [${processed}/${queuedOrders.length}] Order #${orderNumber} (${hoursOld}h old)`);

      try {
        // Build order object for SMS service
        const orderData = {
          id: queueItem.orderId,
          order_number: queueItem.orderNumber,
          customer: {
            first_name: queueItem.customerName?.split(' ')[0],
            last_name: queueItem.customerName?.split(' ').slice(1).join(' ')
          },
          shipping_address: {
            phone: queueItem.phone
          },
          created_at: queueItem.orderCreatedAt
        };

        const result = await smsTransactionalService.sendDelayedShipmentNotification(orderData);

        if (result.success) {
          success++;
          await DelayedShipmentQueue.markSent(queueItem.orderId, result.messageId);
          console.log(`   ✅ SMS sent successfully`);
        } else if (result.reason === 'already_sent') {
          skipped++;
          await DelayedShipmentQueue.markSkipped(queueItem.orderId, 'already_sent');
          console.log(`   ⏭️ Already notified, skipping`);
        } else if (result.reason === 'no_phone') {
          skipped++;
          await DelayedShipmentQueue.markSkipped(queueItem.orderId, 'no_phone');
          console.log(`   ⚠️ No phone number, skipping`);
        } else {
          failed++;
          await DelayedShipmentQueue.markFailed(queueItem.orderId, result.reason);
          console.log(`   ❌ Failed: ${result.reason}`);
        }
      } catch (err) {
        failed++;
        await DelayedShipmentQueue.markFailed(queueItem.orderId, err.message);
        console.error(`   ❌ Error: ${err.message}`);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    // Get updated queue stats
    const queueStats = await DelayedShipmentQueue.getStats();

    console.log('\n╔════════════════════════════════════════════════╗');
    console.log('║           DELAYED SHIPMENT JOB RESULTS         ║');
    console.log('╠════════════════════════════════════════════════╣');
    console.log(`║  Orders Processed:  ${processed.toString().padStart(4)}                      ║`);
    console.log(`║  SMS Sent:          ${success.toString().padStart(4)}                      ║`);
    console.log(`║  Skipped:           ${skipped.toString().padStart(4)}                      ║`);
    console.log(`║  Failed:            ${failed.toString().padStart(4)}                      ║`);
    console.log(`║  Still in Queue:    ${queueStats.pending.toString().padStart(4)}                      ║`);
    console.log(`║  Duration:          ${duration.padStart(4)}s                     ║`);
    console.log('╚════════════════════════════════════════════════╝\n');

    return { processed, success, skipped, failed, queueStats };

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
const init = (schedule = '0 9 * * *') => {
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
 * Get job status with queue info
 */
const getStatus = async () => {
  let queueStats = { pending: 0, queued: 0, sent: 0, skipped: 0, failed: 0 };

  try {
    queueStats = await DelayedShipmentQueue.getStats();
  } catch (e) {
    console.log('Could not get queue stats:', e.message);
  }

  return {
    initialized: !!job,
    running: isRunning,
    syncing: isSyncing,
    withinSendingHours: isWithinSendingHours(),
    delayHours: smsTransactionalService.getDelayHours(),
    triggerEnabled: smsTransactionalService.getSettings().delayed_shipment?.enabled,
    queue: queueStats
  };
};

/**
 * Get queue items for frontend
 */
const getQueueItems = async (options = {}) => {
  return DelayedShipmentQueue.getQueueItems(options);
};

/**
 * Sync orders to queue manually
 */
const syncNow = async () => {
  console.log('🔧 Syncing orders to queue manually...');
  return syncOrdersToQueue();
};

module.exports = {
  init,
  stop,
  runNow,
  syncNow,
  getStatus,
  getQueueItems
};
