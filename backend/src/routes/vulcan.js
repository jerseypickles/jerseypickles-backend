// backend/src/routes/vulcan.js
// 🔨 VULCAN - Segmentation Agent API Routes

const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const VulcanConfig = require('../models/VulcanConfig');
const vulcanService = require('../services/vulcanService');

router.use(auth);

/**
 * GET /api/vulcan/status
 * Full agent status with all segments and stats
 */
router.get('/status', authorize('admin'), async (req, res) => {
  try {
    vulcanService.init();
    const status = await vulcanService.getStatus();
    res.json({ success: true, ...status });
  } catch (error) {
    console.error('Vulcan status error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/vulcan/run
 * Manually trigger segmentation
 */
router.post('/run', authorize('admin'), async (req, res) => {
  try {
    const vulcanJob = require('../jobs/vulcanJob');
    console.log('🔨 Vulcan: Manual trigger from API');

    // Respond immediately, run in background
    setImmediate(async () => {
      await vulcanJob.runNow();
    });

    res.json({
      success: true,
      message: 'Vulcan segmentation triggered. Check back in ~30 seconds.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/vulcan/config
 * Update agent configuration (active state, segment toggles)
 */
router.put('/config', authorize('admin'), async (req, res) => {
  try {
    const config = await VulcanConfig.getConfig();
    const { active, segments } = req.body;

    if (typeof active === 'boolean') config.active = active;

    if (Array.isArray(segments)) {
      for (const update of segments) {
        const idx = config.segments.findIndex(s => s.key === update.key);
        if (idx >= 0 && typeof update.active === 'boolean') {
          config.segments[idx].active = update.active;
        }
      }
    }

    await config.save();
    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/vulcan/segments
 * Just the segments list (shortcut)
 */
router.get('/segments', authorize('admin'), async (req, res) => {
  try {
    const config = await VulcanConfig.getConfig();
    res.json({ success: true, segments: config.segments });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
