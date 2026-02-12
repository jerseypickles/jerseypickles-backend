// backend/src/jobs/compileTimeReportJob.js
// 🧠 Compile Time Reports - Generates performance snapshots for sent campaigns

const cron = require('node-cron');
const mongoose = require('mongoose');

let smartScheduleService = null;
try {
  smartScheduleService = require('../services/smartScheduleService');
} catch (e) {
  console.log('⚠️  CompileTimeReport: smartScheduleService not available');
}

class CompileTimeReportJob {
  constructor() {
    this.isRunning = false;
    this.lastRun = null;
    this.lastResult = null;
    this.schedule = null;
    this.initialized = false;
  }

  /**
   * Initialize the job
   * Default: Every 6 hours - checks for campaigns completed 48+ hours ago
   */
  init(cronExpression = '0 */6 * * *') {
    console.log('🧠 Compile Time Report Job initialized');
    console.log(`   Schedule: ${cronExpression}`);

    this.schedule = cron.schedule(cronExpression, async () => {
      console.log('\n🧠 [CRON] Running Compile Time Report Job...');
      await this.run();
    });

    this.initialized = true;

    // First run after 3 minutes - compile any pending reports
    setTimeout(async () => {
      console.log('\n🧠 [STARTUP] Checking for pending time report compilations...');
      await this.run();
    }, 180000);

    console.log('✅ Compile Time Report Job ready');
  }

  /**
   * Main execution
   */
  async run() {
    if (this.isRunning) {
      console.log('⚠️  CompileTimeReport already running, skipping...');
      return { success: false, reason: 'already_running' };
    }

    this.isRunning = true;
    this.lastRun = new Date();

    const startTime = Date.now();
    let result = { success: false, compiled: 0, analyzed: 0 };

    try {
      const SmsCampaign = mongoose.model('SmsCampaign');
      const SmsCampaignTimeReport = mongoose.model('SmsCampaignTimeReport');

      // 1. Find completed campaigns without a time report
      const completedCampaigns = await SmsCampaign.find({
        status: 'sent',
        completedAt: {
          $lte: new Date(Date.now() - 4 * 60 * 60 * 1000), // 4h ago (enough time for clicks/conversions to accumulate)
          $gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) // within 90 days
        }
      }).select('_id').lean();

      const campaignIds = completedCampaigns.map(c => c._id);

      // Find which ones already have reports
      const existingReports = await SmsCampaignTimeReport.find({
        campaign: { $in: campaignIds },
        status: { $in: ['compiled', 'analyzed'] }
      }).select('campaign').lean();

      const existingCampaignIds = new Set(existingReports.map(r => r.campaign.toString()));
      const needsCompilation = campaignIds.filter(id => !existingCampaignIds.has(id.toString()));

      console.log(`   Found ${needsCompilation.length} campaigns needing compilation`);

      // 2. Compile each campaign
      for (const campaignId of needsCompilation) {
        try {
          console.log(`   📊 Compiling report for campaign ${campaignId}...`);
          const report = await smartScheduleService.compileCampaignReport(campaignId);

          if (report) {
            result.compiled++;

            // 3. Analyze with AI
            try {
              console.log(`   🧠 Analyzing with AI...`);
              await smartScheduleService.analyzeWithAI(report._id);
              result.analyzed++;
            } catch (aiErr) {
              console.log(`   ⚠️  AI analysis skipped: ${aiErr.message}`);
            }
          }
        } catch (err) {
          console.error(`   ❌ Error compiling campaign ${campaignId}: ${err.message}`);
        }
      }

      // 4. Also re-analyze any pending reports that are 48h+ old
      const pendingReports = await SmsCampaignTimeReport.findPendingCompilation();
      for (const report of pendingReports) {
        try {
          console.log(`   📊 Re-compiling pending report ${report._id}...`);
          const compiled = await smartScheduleService.compileCampaignReport(report.campaign._id || report.campaign);
          if (compiled) {
            result.compiled++;
            try {
              await smartScheduleService.analyzeWithAI(compiled._id);
              result.analyzed++;
            } catch (aiErr) {
              console.log(`   ⚠️  AI analysis skipped: ${aiErr.message}`);
            }
          }
        } catch (err) {
          console.error(`   ❌ Error re-compiling: ${err.message}`);
        }
      }

      result.success = true;

    } catch (error) {
      console.error(`   ❌ CompileTimeReport Job error: ${error.message}`);
      result.error = error.message;
    } finally {
      this.isRunning = false;
      this.lastResult = result;

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`   ${result.success ? '✅' : '❌'} CompileTimeReport: ${result.compiled} compiled, ${result.analyzed} analyzed (${duration}s)`);
    }

    return result;
  }

  /**
   * Force compile a specific campaign
   */
  async compileForCampaign(campaignId) {
    if (!smartScheduleService) throw new Error('SmartScheduleService not available');

    const report = await smartScheduleService.compileCampaignReport(campaignId);
    if (report) {
      await smartScheduleService.analyzeWithAI(report._id);
    }
    return report;
  }

  getStatus() {
    return {
      initialized: this.initialized,
      isRunning: this.isRunning,
      lastRun: this.lastRun,
      lastResult: this.lastResult,
      schedule: '0 */6 * * *',
      scheduleDescription: 'Every 6 hours'
    };
  }

  stop() {
    if (this.schedule) {
      this.schedule.stop();
      console.log('🛑 Compile Time Report Job stopped');
    }
  }
}

const compileTimeReportJob = new CompileTimeReportJob();
module.exports = compileTimeReportJob;
