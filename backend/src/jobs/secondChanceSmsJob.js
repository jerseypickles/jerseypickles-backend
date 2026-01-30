// backend/src/jobs/secondChanceSmsJob.js
// 📱 Second Chance SMS Cron Job - Runs every hour
const cron = require('node-cron');
const secondChanceSmsService = require('../services/secondChanceSmsService');

let job = null;
let isRunning = false;

/**
 * Process second chance SMS batch
 * Called by cron job every hour
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
    
    // Step 1: Schedule any eligible subscribers
    console.log('\n📅 Step 1: Scheduling eligible subscribers...');
    const scheduleResult = await secondChanceSmsService.scheduleSecondSmsForEligible();
    console.log(`   Scheduled: ${scheduleResult.scheduled}`);
    
    // Step 2: Process scheduled SMS
    console.log('\n📤 Step 2: Processing scheduled second SMS...');
    const processResult = await secondChanceSmsService.processScheduledSecondSms(30);
    
    console.log(`\n📊 Results:`);
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
 * @param {string} schedule - Cron schedule (default: every hour at minute 30)
 */
const init = (schedule = '30 * * * *') => {
  if (job) {
    console.log('⚠️ Second Chance SMS job already initialized');
    return;
  }
  
  console.log(`📱 Initializing Second Chance SMS Job...`);
  console.log(`   Schedule: ${schedule}`);
  console.log(`   Sending hours: 9:00 AM - 9:00 PM`);
  console.log(`   Delay: 6-8 hours after first SMS`);
  console.log(`   Discount: 20% OFF, expires in 2 hours`);
  
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