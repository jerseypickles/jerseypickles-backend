// backend/src/jobs/vulcanJob.js
// 🔨 VULCAN - Daily Segmentation Cron Job

const cron = require('node-cron');
const vulcanService = require('../services/vulcanService');

let job = null;
let isRunning = false;

const runVulcan = async () => {
  if (isRunning) {
    console.log('🔨 Vulcan job already running, skipping...');
    return;
  }

  isRunning = true;
  try {
    await vulcanService.runSegmentation();
  } catch (error) {
    console.error('🔨 Vulcan job error:', error.message);
  } finally {
    isRunning = false;
  }
};

const init = () => {
  console.log('🔨 Initializing Vulcan Agent...');
  vulcanService.init();

  // Daily at 3 AM ET
  job = cron.schedule('0 3 * * *', runVulcan, {
    scheduled: true,
    timezone: 'America/New_York'
  });

  console.log('🔨 Vulcan: Scheduled');
  console.log('   Daily run: 3:00 AM ET');

  // Run once on startup (after 60s delay) if never run before
  setTimeout(async () => {
    try {
      const VulcanConfig = require('../models/VulcanConfig');
      const config = await VulcanConfig.getConfig();
      if (!config.lastRunAt) {
        console.log('🔨 Vulcan: No prior run detected, running initial segmentation...');
        await runVulcan();
      }
    } catch (e) {
      console.log('🔨 Vulcan: Startup check deferred');
    }
  }, 60000);
};

const stop = () => {
  if (job) {
    job.stop();
    job = null;
    console.log('🔨 Vulcan: Stopped');
  }
};

const runNow = async () => {
  console.log('🔨 Vulcan: Manual execution triggered');
  return runVulcan();
};

module.exports = { init, stop, runNow };
