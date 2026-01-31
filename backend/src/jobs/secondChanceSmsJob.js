// backend/src/jobs/secondChanceSmsJob.js
// 📱 Second Chance SMS Cron Job - Runs every 5 minutes, processes ALL pending
const cron = require('node-cron');
const secondChanceSmsService = require('../services/secondChanceSmsService');

let job = null;
let isRunning = false;

// Configuration
const MAX_PER_RUN = 500; // Maximum SMS per job run (safety limit)
const BATCH_SIZE = 50;   // Process in batches of 50

/**
 * Process ALL pending second chance SMS
 * Called by cron job every 5 minutes
 */
const runSecondChanceJob = async () => {
  if (isRunning) {
    console.log('⏳ Second Chance SMS job already running, skipping...');
    return;
  }

  isRunning = true;
  const startTime = Date.now();

  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║     📱 SECOND CHANCE SMS JOB STARTED           ║');
  console.log(`║     ${new Date().toISOString()}             ║`);
  console.log('╚════════════════════════════════════════════════╝');

  try {
    // Check if within sending hours
    if (!secondChanceSmsService.isWithinSendingHours()) {
      const nextSend = secondChanceSmsService.getNextSendingTime();
      console.log(`⏰ Outside sending hours (9am-9pm).`);
      console.log(`   Next run will process at: ${nextSend.toISOString()}`);
      isRunning = false;
      return;
    }

    // Step 1: Schedule any eligible subscribers (increased limit)
    console.log('\n📅 Step 1: Scheduling eligible subscribers...');
    const scheduleResult = await secondChanceSmsService.scheduleSecondSmsForEligible();
    console.log(`   Scheduled: ${scheduleResult.scheduled}`);

    // Step 2: Process ALL scheduled SMS in batches
    console.log('\n📤 Step 2: Processing ALL scheduled second SMS...');

    let totalProcessed = 0;
    let totalSuccess = 0;
    let totalFailed = 0;
    let batchNumber = 0;

    // Keep processing until no more pending or hit safety limit
    while (totalProcessed < MAX_PER_RUN) {
      batchNumber++;
      console.log(`   📦 Batch ${batchNumber}: Processing up to ${BATCH_SIZE}...`);

      const batchResult = await secondChanceSmsService.processScheduledSecondSms(BATCH_SIZE);

      if (batchResult.processed === 0) {
        console.log(`   ✅ No more pending SMS to process`);
        break;
      }

      totalProcessed += batchResult.processed;
      totalSuccess += batchResult.success;
      totalFailed += batchResult.failed;

      console.log(`   Batch ${batchNumber}: ${batchResult.success} sent, ${batchResult.failed} failed`);
    }

    const processResult = { processed: totalProcessed, success: totalSuccess, failed: totalFailed };

    console.log(`\n📊 Results:`);
    console.log(`   Total Batches: ${batchNumber}`);
    console.log(`   Processed: ${processResult.processed}`);
    console.log(`   Success: ${processResult.success}`);
    console.log(`   Failed: ${processResult.failed}`);
    
    // Step 3: Get current stats
    console.log('\n📈 Step 3: Getting stats...');
    const stats = await secondChanceSmsService.getSecondChanceStats();
    
    console.log(`\n╔════════════════════════════════════════════════╗`);
    console.log(`║              CONVERSION BREAKDOWN              ║`);
    console.log(`╠════════════════════════════════════════════════╣`);
    console.log(`║  First SMS (15%):  ${stats.conversions.first.toString().padStart(4)} converted (${stats.rates.firstConversion}%)  ║`);
    console.log(`║  Second SMS (20%): ${stats.conversions.second.toString().padStart(4)} recovered (${stats.rates.secondConversion}%)  ║`);
    console.log(`║  No conversion:    ${stats.conversions.none.toString().padStart(4)}                      ║`);
    console.log(`║  Pending 2nd SMS:  ${stats.secondSms.pending.toString().padStart(4)}                      ║`);
    console.log(`╠════════════════════════════════════════════════╣`);
    console.log(`║  Revenue (1st):    $${stats.revenue.first.toFixed(2).padStart(8)}              ║`);
    console.log(`║  Revenue (2nd):    $${stats.revenue.second.toFixed(2).padStart(8)}              ║`);
    console.log(`║  Total Revenue:    $${stats.revenue.total.toFixed(2).padStart(8)}              ║`);
    console.log(`╚════════════════════════════════════════════════╝`);
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n✅ Job completed in ${duration}s`);
    
  } catch (error) {
    console.error('❌ Second Chance SMS Job Error:', error);
  } finally {
    isRunning = false;
  }
};

/**
 * Initialize the cron job
 * @param {string} schedule - Cron schedule (default: every 5 minutes)
 */
const init = (schedule = '*/5 * * * *') => {
  if (job) {
    console.log('⚠️ Second Chance SMS job already initialized');
    return;
  }

  console.log(`📱 Initializing Second Chance SMS Job...`);
  console.log(`   Schedule: ${schedule} (every 5 minutes)`);
  console.log(`   Sending hours: 9:00 AM - 9:00 PM (Eastern)`);
  console.log(`   Delay: 6+ hours after first SMS`);
  console.log(`   Discount: 20% OFF, expires in 2 hours`);
  console.log(`   Max per run: ${MAX_PER_RUN}, Batch size: ${BATCH_SIZE}`);

  job = cron.schedule(schedule, runSecondChanceJob, {
    scheduled: true,
    timezone: 'America/New_York' // Eastern Time
  });

  console.log(`✅ Second Chance SMS Job scheduled`);

  return job;
};

/**
 * Stop the cron job
 */
const stop = () => {
  if (job) {
    job.stop();
    job = null;
    console.log('🛑 Second Chance SMS Job stopped');
  }
};

/**
 * Run job manually (for testing)
 */
const runNow = async () => {
  console.log('🔧 Running Second Chance SMS Job manually...');
  return runSecondChanceJob();
};

/**
 * Get job status
 */
const getStatus = () => {
  return {
    initialized: !!job,
    running: isRunning,
    withinSendingHours: secondChanceSmsService.isWithinSendingHours(),
    nextSendingWindow: secondChanceSmsService.getNextSendingTime()
  };
};

module.exports = {
  init,
  stop,
  runNow,
  getStatus,
  runSecondChanceJob
};