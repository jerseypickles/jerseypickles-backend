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
