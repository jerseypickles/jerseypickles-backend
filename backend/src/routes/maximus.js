// backend/src/routes/maximus.js
// 🏛️ MAXIMUS - Agent API Routes

const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const MaximusConfig = require('../models/MaximusConfig');
const MaximusCampaignLog = require('../models/MaximusCampaignLog');
const maximusService = require('../services/maximusService');

// All routes require admin auth
router.use(auth);

// ==================== STATUS ====================

/**
 * GET /api/maximus/status
 * Full status of the Maximus agent
 */
router.get('/status', authorize('admin'), async (req, res) => {
  try {
    const status = await maximusService.getStatus();
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('Maximus status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== CONFIGURATION ====================

/**
 * PUT /api/maximus/config
 * Update Maximus configuration
 */
router.put('/config', authorize('admin'), async (req, res) => {
  try {
    const config = await MaximusConfig.getConfig();
    const { active, creativeAgentReady, lists, maxCampaignsPerWeek, sendWindowStart, sendWindowEnd } = req.body;

    if (typeof active === 'boolean') config.active = active;
    if (typeof creativeAgentReady === 'boolean') config.creativeAgentReady = creativeAgentReady;
    if (lists) config.lists = lists;
    if (maxCampaignsPerWeek) config.maxCampaignsPerWeek = maxCampaignsPerWeek;
    if (sendWindowStart) config.sendWindowStart = sendWindowStart;
    if (sendWindowEnd) config.sendWindowEnd = sendWindowEnd;

    await config.save();

    console.log(`🏛️ Maximus config updated: active=${config.active}, lists=${config.lists.length}`);

    res.json({ success: true, config });
  } catch (error) {
    console.error('Maximus config error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/maximus/activate
 * Activate Maximus (shortcut)
 */
router.post('/activate', authorize('admin'), async (req, res) => {
  try {
    const config = await MaximusConfig.getConfig();
    config.active = true;
    await config.save();

    console.log('🏛️ Maximus: ACTIVATED');
    res.json({ success: true, message: 'Maximus activated', active: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/maximus/deactivate
 * Deactivate Maximus (shortcut)
 */
router.post('/deactivate', authorize('admin'), async (req, res) => {
  try {
    const config = await MaximusConfig.getConfig();
    config.active = false;
    await config.save();

    console.log('🏛️ Maximus: DEACTIVATED');
    res.json({ success: true, message: 'Maximus deactivated', active: false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== LISTS ====================

/**
 * PUT /api/maximus/lists
 * Set the lists Maximus can use
 */
router.put('/lists', authorize('admin'), async (req, res) => {
  try {
    const { listIds } = req.body;
    if (!listIds || !Array.isArray(listIds)) {
      return res.status(400).json({ error: 'listIds array required' });
    }

    const List = require('../models/List');
    const lists = await List.find({ _id: { $in: listIds } }).select('_id name').lean();

    const config = await MaximusConfig.getConfig();
    config.lists = lists.map(l => ({ listId: l._id, name: l.name }));
    await config.save();

    console.log(`🏛️ Maximus: Lists updated - ${lists.map(l => l.name).join(', ')}`);

    res.json({ success: true, lists: config.lists });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== WEEKLY PLAN ====================

/**
 * GET /api/maximus/weekly-plan
 * Get current weekly plan
 */
router.get('/weekly-plan', authorize('admin'), async (req, res) => {
  try {
    const result = await maximusService.getWeeklyPlan();
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/maximus/propose-week
 * Generate a full week plan (background — Apollo can take 2-3 min)
 */
router.post('/propose-week', authorize('admin'), async (req, res) => {
  try {
    console.log('🏛️ Maximus: Weekly plan requested from API');

    // Quick validation before kicking off background work
    const config = await MaximusConfig.getConfig();
    if (config.pendingWeeklyPlan?.active) {
      return res.json({ success: false, reason: 'pending_weekly_plan_exists' });
    }
    if (!config.lists || config.lists.length === 0) {
      return res.json({ success: false, reason: 'no_lists' });
    }

    // Mark as "generating" so the frontend can poll
    config.pendingWeeklyPlan = {
      active: true,
      generating: true,
      createdAt: new Date(),
      weekLabel: 'Generating...',
      campaigns: []
    };
    await config.save();

    // Respond immediately so HTTP doesn't time out
    res.json({
      success: true,
      generating: true,
      message: 'Weekly plan generation started. Poll /weekly-plan to see progress.'
    });

    // Run in background
    setImmediate(async () => {
      try {
        const result = await maximusService.generateWeeklyPlan({ skipPendingCheck: true });
        if (!result.success) {
          // Clear the placeholder so user can retry
          const c = await MaximusConfig.getConfig();
          c.pendingWeeklyPlan = { active: false };
          await c.save();
          console.error('🏛️ Maximus: Weekly plan generation failed:', result.reason, result.detail || '');
        }
      } catch (err) {
        console.error('🏛️ Maximus: Weekly plan background error:', err.message);
        const c = await MaximusConfig.getConfig();
        c.pendingWeeklyPlan = { active: false };
        await c.save();
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/maximus/weekly-plan/approve-all
 * Approve all pending campaigns in the weekly plan
 */
router.post('/weekly-plan/approve-all', authorize('admin'), async (req, res) => {
  try {
    const result = await maximusService.approveAllWeekCampaigns();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/maximus/weekly-plan/:index/approve
 * Approve a specific campaign by index
 */
router.post('/weekly-plan/:index/approve', authorize('admin'), async (req, res) => {
  try {
    const result = await maximusService.approveWeekCampaign(parseInt(req.params.index));
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/maximus/weekly-plan/:index/reject
 * Reject a specific campaign by index
 */
router.post('/weekly-plan/:index/reject', authorize('admin'), async (req, res) => {
  try {
    const result = await maximusService.rejectWeekCampaign(parseInt(req.params.index));
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/maximus/weekly-plan/discard
 * Discard the entire weekly plan
 */
router.post('/weekly-plan/discard', authorize('admin'), async (req, res) => {
  try {
    const result = await maximusService.discardWeeklyPlan();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== CAMPAIGN HISTORY ====================

/**
 * GET /api/maximus/campaigns
 * Get Maximus campaign history
 */
router.get('/campaigns', authorize('admin'), async (req, res) => {
  try {
    const { limit = 20, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [campaigns, total] = await Promise.all([
      MaximusCampaignLog.find()
        .sort({ sentAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      MaximusCampaignLog.countDocuments()
    ]);

    res.json({
      success: true,
      campaigns,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/maximus/campaigns/week
 * Get this week's campaigns
 */
router.get('/campaigns/week', authorize('admin'), async (req, res) => {
  try {
    const campaigns = await MaximusCampaignLog.getCampaignsThisWeek();
    res.json({ success: true, campaigns, count: campaigns.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== LEARNING DATA ====================

/**
 * GET /api/maximus/learning
 * Get Maximus learning data
 */
router.get('/learning', authorize('admin'), async (req, res) => {
  try {
    const config = await MaximusConfig.getConfig();
    const [byDay, byHour, byList, summary] = await Promise.all([
      MaximusCampaignLog.getPerformanceByDay(),
      MaximusCampaignLog.getPerformanceByHour(),
      MaximusCampaignLog.getPerformanceByList(),
      MaximusCampaignLog.getLearningSummary()
    ]);

    res.json({
      success: true,
      phase: config.learning.phase,
      campaignsAnalyzed: config.learning.campaignsAnalyzed,
      summary: summary[0] || null,
      bestDays: config.learning.bestDays,
      bestHours: config.learning.bestHours,
      bestList: config.learning.bestList,
      restDays: config.learning.restDays,
      raw: { byDay, byHour, byList },
      lastUpdate: config.learning.lastLearningUpdate
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== PROPOSAL SYSTEM ====================

/**
 * GET /api/maximus/proposal
 * Get current pending proposal
 */
router.get('/proposal', authorize('admin'), async (req, res) => {
  try {
    const result = await maximusService.getProposal();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Maximus proposal get error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/maximus/propose
 * Generate a new proposal for review
 */
router.post('/propose', authorize('admin'), async (req, res) => {
  try {
    console.log('🏛️ Maximus: Proposal requested from API');
    const result = await maximusService.generateProposal();
    res.json(result);
  } catch (error) {
    console.error('Maximus propose error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/maximus/proposal/test
 * Send a test email with the proposal's creative to preview
 */
router.post('/proposal/test', authorize('admin'), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email address required' });
    }

    const result = await maximusService.getProposal();
    if (!result.exists) {
      return res.status(404).json({ error: 'No pending proposal' });
    }

    const { decision, htmlContent } = result.proposal;

    if (!htmlContent) {
      return res.status(400).json({ error: 'Proposal has no creative content' });
    }

    const emailService = require('../services/emailService');
    const sendResult = await emailService.sendEmail({
      to: email,
      subject: `[TEST] ${decision.subjectLine}`,
      html: htmlContent,
      from: 'Jersey Pickles <info@jerseypickles.com>',
      includeUnsubscribe: false,
      tags: [{ name: 'type', value: 'maximus-test' }]
    });

    console.log(`🏛️ Maximus: Test email sent to ${email}`);
    res.json({ success: true, message: `Test sent to ${email}`, resendId: sendResult.id });
  } catch (error) {
    console.error('Maximus test email error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/maximus/proposal/approve
 * Approve pending proposal → schedule campaign
 */
router.post('/proposal/approve', authorize('admin'), async (req, res) => {
  try {
    const result = await maximusService.approveProposal();
    res.json(result);
  } catch (error) {
    console.error('Maximus approve error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/maximus/proposal/reject
 * Reject pending proposal
 */
router.post('/proposal/reject', authorize('admin'), async (req, res) => {
  try {
    const { reason } = req.body || {};
    const result = await maximusService.rejectProposal(reason);
    res.json(result);
  } catch (error) {
    console.error('Maximus reject error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/maximus/campaigns/:id/send-now
 * Force send a scheduled campaign immediately
 */
router.post('/campaigns/:id/send-now', authorize('admin'), async (req, res) => {
  try {
    const log = await MaximusCampaignLog.findById(req.params.id);
    if (!log) {
      return res.status(404).json({ error: 'Campaign log not found' });
    }

    const Campaign = require('../models/Campaign');
    const campaign = await Campaign.findById(log.campaign);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (campaign.status !== 'scheduled') {
      return res.status(400).json({ error: `Cannot send campaign with status: ${campaign.status}` });
    }

    // Set scheduledAt to now — schedulerJob picks it up within 1 minute
    campaign.scheduledAt = new Date();
    await campaign.save();

    console.log(`🏛️ Maximus: Campaign "${campaign.name}" set to send NOW`);
    res.json({ success: true, message: 'Campaign will send within 1 minute', campaignId: campaign._id });
  } catch (error) {
    console.error('Maximus send-now error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/maximus/campaigns/:id/cancel
 * Cancel a Maximus campaign (deletes Campaign + MaximusCampaignLog)
 */
router.post('/campaigns/:id/cancel', authorize('admin'), async (req, res) => {
  try {
    const log = await MaximusCampaignLog.findById(req.params.id);
    if (!log) {
      return res.status(404).json({ error: 'Campaign log not found' });
    }

    // Cancel the actual Campaign (prevent schedulerJob from sending)
    const Campaign = require('../models/Campaign');
    if (log.campaign) {
      const campaign = await Campaign.findById(log.campaign);
      if (campaign && ['draft', 'scheduled'].includes(campaign.status)) {
        campaign.status = 'failed';
        await campaign.save();
        console.log(`🏛️ Maximus: Campaign ${campaign._id} cancelled`);
      }
    }

    // Delete the log
    await MaximusCampaignLog.findByIdAndDelete(req.params.id);

    // Decrement stats
    const config = await MaximusConfig.getConfig();
    if (config.stats.totalCampaignsSent > 0) {
      config.stats.totalCampaignsSent -= 1;
      await config.save();
    }

    console.log(`🏛️ Maximus: Campaign log ${req.params.id} deleted`);
    res.json({ success: true, message: 'Campaign cancelled and log deleted' });
  } catch (error) {
    console.error('Maximus cancel error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/maximus/campaigns/:id/preview
 * Get the HTML content of a campaign for preview
 */
router.get('/campaigns/:id/preview', authorize('admin'), async (req, res) => {
  try {
    const log = await MaximusCampaignLog.findById(req.params.id).populate('campaign', 'htmlContent status');
    if (!log) {
      return res.status(404).json({ error: 'Campaign log not found' });
    }
    if (!log.campaign?.htmlContent) {
      return res.status(404).json({ error: 'No HTML content available' });
    }
    res.json({
      success: true,
      htmlContent: log.campaign.htmlContent,
      subjectLine: log.subjectLine,
      status: log.campaign.status
    });
  } catch (error) {
    console.error('Preview error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== MANUAL TRIGGER ====================

/**
 * POST /api/maximus/run
 * Manually trigger Maximus (for testing)
 */
router.post('/run', authorize('admin'), async (req, res) => {
  try {
    const maximusJob = require('../jobs/maximusJob');
    console.log('🏛️ Maximus: Manual trigger from API');

    // Run in background
    setImmediate(async () => {
      await maximusJob.runNow();
    });

    res.json({
      success: true,
      message: 'Maximus execution triggered. Check logs for results.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/maximus/update-metrics
 * Force update metrics for recent campaigns
 */
router.post('/update-metrics', authorize('admin'), async (req, res) => {
  try {
    const maximusJob = require('../jobs/maximusJob');
    await maximusJob.updateMetrics();

    res.json({ success: true, message: 'Metrics updated' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
