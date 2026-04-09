// backend/src/jobs/schedulerJob.js
// Campaign Scheduler - Checks for scheduled campaigns and sends them
// Runs every minute, picks up campaigns where scheduledAt <= now

const cron = require('node-cron');
const Campaign = require('../models/Campaign');
const { sendCampaign } = require('../services/campaignSendService');

let job = null;
let isRunning = false;

/**
 * Check for scheduled campaigns and send them
 */
const checkAndSendScheduled = async () => {
  if (isRunning) return;
  isRunning = true;

  try {
    // Find campaigns that are scheduled and ready to send
    const readyCampaigns = await Campaign.find({
      status: 'scheduled',
      scheduledAt: { $lte: new Date() }
    }).select('_id name scheduledAt').lean();

    if (readyCampaigns.length === 0) {
      isRunning = false;
      return;
    }

    console.log(`\n📅 Scheduler: Found ${readyCampaigns.length} campaign(s) ready to send`);

    for (const campaign of readyCampaigns) {
      console.log(`📅 Scheduler: Sending "${campaign.name}" (scheduled for ${campaign.scheduledAt})`);

      try {
        const result = await sendCampaign(campaign._id.toString());

        if (result.success) {
          console.log(`📅 Scheduler: ✅ "${campaign.name}" - ${result.totalRecipients} recipients`);
        } else {
          console.error(`📅 Scheduler: ❌ "${campaign.name}" - ${result.error}`);
        }
      } catch (error) {
        console.error(`📅 Scheduler: ❌ Error sending "${campaign.name}":`, error.message);
        // Mark as failed so we don't retry infinitely
        await Campaign.findByIdAndUpdate(campaign._id, { status: 'failed' });
      }
    }
  } catch (error) {
    console.error('📅 Scheduler error:', error.message);
  } finally {
    isRunning = false;
  }
};

/**
 * Initialize the scheduler
 * Runs every minute to check for scheduled campaigns
 */
const init = () => {
  console.log('📅 Campaign Scheduler initialized');
  console.log('   Schedule: Every minute');

  job = cron.schedule('* * * * *', checkAndSendScheduled, {
    scheduled: true,
    timezone: 'America/New_York'
  });

  console.log('✅ Campaign Scheduler ready');
};

const stop = () => {
  if (job) {
    job.stop();
    job = null;
    console.log('📅 Campaign Scheduler stopped');
  }
};

const getStatus = () => ({
  initialized: !!job,
  running: isRunning
});

module.exports = { init, stop, getStatus, checkAndSendScheduled };
