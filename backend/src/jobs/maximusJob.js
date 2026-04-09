// backend/src/jobs/maximusJob.js
// 🏛️ MAXIMUS - Daily Cron Job
// Runs daily, Maximus decides if/when/what to send

const cron = require('node-cron');
const maximusService = require('../services/maximusService');
const MaximusConfig = require('../models/MaximusConfig');
const MaximusCampaignLog = require('../models/MaximusCampaignLog');

let job = null;
let metricsJob = null;
let isRunning = false;

/**
 * Main daily execution
 * Runs at the start of the send window so Maximus can pick his hour
 */
const runMaximus = async () => {
  if (isRunning) {
    console.log('🏛️ Maximus job already running, skipping...');
    return;
  }

  isRunning = true;

  try {
    const result = await maximusService.execute();

    if (result.executed) {
      console.log('🏛️ Maximus: Campaign scheduled successfully');
      console.log(`   Subject: "${result.subjectLine}"`);
      console.log(`   List: ${result.listName}`);
      console.log(`   Send hour: ${result.sendHour}:00`);
    } else {
      console.log(`🏛️ Maximus: No action (${result.reason})`);
    }
  } catch (error) {
    console.error('🏛️ Maximus job error:', error.message);
  } finally {
    isRunning = false;
  }
};

/**
 * Metrics update job
 * Runs every 6 hours to update campaign performance metrics
 */
const updateMetrics = async () => {
  try {
    // Find logs from the last 7 days that need metrics update
    const recentLogs = await MaximusCampaignLog.find({
      sentAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    }).select('campaign metricsUpdatedAt').lean();

    let updated = 0;
    for (const log of recentLogs) {
      // Update if metrics are older than 6 hours or never updated
      const needsUpdate = !log.metricsUpdatedAt ||
        (Date.now() - new Date(log.metricsUpdatedAt).getTime()) > 6 * 60 * 60 * 1000;

      if (needsUpdate) {
        await maximusService.updateCampaignMetrics(log.campaign);
        updated++;
      }
    }

    if (updated > 0) {
      console.log(`🏛️ Maximus: Updated metrics for ${updated} campaigns`);
    }
  } catch (error) {
    console.error('🏛️ Maximus metrics update error:', error.message);
  }
};

/**
 * Initialize Maximus
 * Daily job at 10:55 AM ET (5 min before send window opens)
 * Metrics job every 6 hours
 */
const init = () => {
  console.log('🏛️ Initializing Maximus Agent...');

  // Initialize the service
  maximusService.init();

  // Daily execution - 10:55 AM ET (just before the 11 AM window)
  job = cron.schedule('55 10 * * *', runMaximus, {
    scheduled: true,
    timezone: 'America/New_York'
  });

  // Metrics update - every 6 hours
  metricsJob = cron.schedule('0 */6 * * *', updateMetrics, {
    scheduled: true,
    timezone: 'America/New_York'
  });

  console.log('🏛️ Maximus: Scheduled');
  console.log('   Daily execution: 10:55 AM ET');
  console.log('   Metrics update: Every 6 hours');
  console.log('   Send window: 11 AM - 7 PM ET');
  console.log('   Max campaigns/week: 5-6');

  // Check config on startup
  setTimeout(async () => {
    try {
      const config = await MaximusConfig.getConfig();
      console.log(`🏛️ Maximus status: ${config.active ? 'ACTIVE' : 'DORMANT'}`);
      console.log(`   Creative agent: ${config.creativeAgentReady ? 'READY' : 'NOT READY'}`);
      console.log(`   Lists configured: ${config.lists.length}`);
      console.log(`   Learning phase: ${config.learning.phase}`);
    } catch (e) {
      console.log('🏛️ Maximus: Config check deferred');
    }
  }, 5000);
};

/**
 * Stop Maximus
 */
const stop = () => {
  if (job) {
    job.stop();
    job = null;
  }
  if (metricsJob) {
    metricsJob.stop();
    metricsJob = null;
  }
  console.log('🏛️ Maximus: Stopped');
};

/**
 * Manual trigger (for testing)
 */
const runNow = async () => {
  console.log('🏛️ Maximus: Manual execution triggered');
  return runMaximus();
};

/**
 * Get status
 */
const getStatus = async () => {
  return maximusService.getStatus();
};

module.exports = {
  init,
  stop,
  runNow,
  getStatus,
  updateMetrics
};
