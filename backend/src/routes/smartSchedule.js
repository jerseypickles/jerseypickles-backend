// backend/src/routes/smartSchedule.js
// 🧠 Smart Schedule Routes - AI-powered send time optimization

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// Auth middleware (optional - fallback if not available)
let auth;
try {
  const authMiddleware = require('../middleware/auth');
  auth = authMiddleware.auth || authMiddleware;
} catch (e) {
  auth = (req, res, next) => next();
}

let smartScheduleService;
try {
  smartScheduleService = require('../services/smartScheduleService');
} catch (e) {
  console.log('⚠️  SmartSchedule routes: service not available');
}

let compileTimeReportJob;
try {
  compileTimeReportJob = require('../jobs/compileTimeReportJob');
} catch (e) {
  console.log('⚠️  SmartSchedule routes: compile job not available');
}

// ==================== RECOMMENDATION ====================

/**
 * GET /api/sms/smart-schedule/recommendation
 * Get AI-powered send time recommendation
 */
router.get('/recommendation', auth, async (req, res) => {
  try {
    if (!smartScheduleService) {
      return res.status(503).json({ error: 'SmartSchedule service not available' });
    }

    const recommendation = await smartScheduleService.getRecommendation();
    res.json({ success: true, ...recommendation });
  } catch (error) {
    console.error('SmartSchedule recommendation error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== REPORTS ====================

/**
 * GET /api/sms/smart-schedule/reports
 * List all campaign time reports
 */
router.get('/reports', auth, async (req, res) => {
  try {
    if (!smartScheduleService) {
      return res.status(503).json({ error: 'SmartSchedule service not available' });
    }

    const { limit = 50, status } = req.query;
    const reports = await smartScheduleService.getReports({
      limit: parseInt(limit),
      status
    });

    res.json({ success: true, reports, total: reports.length });
  } catch (error) {
    console.error('SmartSchedule reports error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/sms/smart-schedule/reports/:id
 * Get single report detail
 */
router.get('/reports/:id', auth, async (req, res) => {
  try {
    if (!smartScheduleService) {
      return res.status(503).json({ error: 'SmartSchedule service not available' });
    }

    const report = await smartScheduleService.getReport(req.params.id);
    if (!report) {
      return res.status(404).json({ error: 'Report not found' });
    }

    res.json({ success: true, report });
  } catch (error) {
    console.error('SmartSchedule report detail error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== HEATMAP & ANALYTICS ====================

/**
 * GET /api/sms/smart-schedule/heatmap
 * Get hour x day performance heatmap data
 */
router.get('/heatmap', auth, async (req, res) => {
  try {
    const SmsCampaignTimeReport = mongoose.model('SmsCampaignTimeReport');

    const [heatmap, byHour, byDay, globalAvgs] = await Promise.all([
      SmsCampaignTimeReport.getHeatmapData(),
      SmsCampaignTimeReport.getPerformanceByHour(),
      SmsCampaignTimeReport.getPerformanceByDay(),
      SmsCampaignTimeReport.getGlobalAverages()
    ]);

    res.json({
      success: true,
      heatmap,
      byHour,
      byDay,
      globalAverages: globalAvgs
    });
  } catch (error) {
    console.error('SmartSchedule heatmap error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/sms/smart-schedule/speed-metrics
 * Get global response speed metrics
 */
router.get('/speed-metrics', auth, async (req, res) => {
  try {
    const SmsCampaignTimeReport = mongoose.model('SmsCampaignTimeReport');

    const result = await SmsCampaignTimeReport.aggregate([
      { $match: { status: { $in: ['compiled', 'analyzed'] } } },
      {
        $group: {
          _id: null,
          totalCampaigns: { $sum: 1 },
          avgMinutesToClick: { $avg: '$responseSpeed.avgMinutesToClick' },
          avgMinutesToConvert: { $avg: '$responseSpeed.avgMinutesToConvert' },
          avgClicksWithin30min: { $avg: '$responseSpeed.clicksWithin30min' },
          avgClicksWithin1hr: { $avg: '$responseSpeed.clicksWithin1hr' },
          avgConversionsWithin1hr: { $avg: '$responseSpeed.conversionsWithin1hr' },
          avgConversionsWithin24hr: { $avg: '$responseSpeed.conversionsWithin24hr' },
          totalClicks: { $sum: '$performance.totalClicks' },
          totalConversions: { $sum: '$performance.conversions' }
        }
      }
    ]);

    const metrics = result[0] || {};

    // Calculate percentages
    const totalClicks = metrics.totalClicks || 1;
    const totalConversions = metrics.totalConversions || 1;

    res.json({
      success: true,
      metrics: {
        avgMinutesToClick: Math.round(metrics.avgMinutesToClick || 0),
        avgMinutesToConvert: Math.round(metrics.avgMinutesToConvert || 0),
        pctClicksWithin30min: metrics.avgClicksWithin30min
          ? Math.round((metrics.avgClicksWithin30min / (totalClicks / (metrics.totalCampaigns || 1))) * 100)
          : 0,
        pctConversionsWithin24hr: metrics.avgConversionsWithin24hr
          ? Math.round((metrics.avgConversionsWithin24hr / (totalConversions / (metrics.totalCampaigns || 1))) * 100)
          : 0,
        totalCampaigns: metrics.totalCampaigns || 0
      }
    });
  } catch (error) {
    console.error('SmartSchedule speed metrics error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== MANUAL ACTIONS ====================

/**
 * POST /api/sms/smart-schedule/compile/:campaignId
 * Manually trigger compilation for a specific campaign
 */
router.post('/compile/:campaignId', auth, async (req, res) => {
  try {
    if (!compileTimeReportJob) {
      return res.status(503).json({ error: 'Compile job not available' });
    }

    const report = await compileTimeReportJob.compileForCampaign(req.params.campaignId);
    res.json({ success: true, report });
  } catch (error) {
    console.error('SmartSchedule compile error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/sms/smart-schedule/compile-all
 * Manually trigger compilation for all pending campaigns
 */
router.post('/compile-all', auth, async (req, res) => {
  try {
    if (!compileTimeReportJob) {
      return res.status(503).json({ error: 'Compile job not available' });
    }

    const result = await compileTimeReportJob.run();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('SmartSchedule compile-all error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/sms/smart-schedule/status
 * Get job status
 */
router.get('/status', auth, async (req, res) => {
  try {
    const jobStatus = compileTimeReportJob ? compileTimeReportJob.getStatus() : { initialized: false };
    const SmsCampaignTimeReport = mongoose.model('SmsCampaignTimeReport');

    const counts = await SmsCampaignTimeReport.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    const statusCounts = {};
    for (const c of counts) {
      statusCounts[c._id] = c.count;
    }

    res.json({
      success: true,
      job: jobStatus,
      reports: {
        pending: statusCounts.pending || 0,
        compiled: statusCounts.compiled || 0,
        analyzed: statusCounts.analyzed || 0,
        total: Object.values(statusCounts).reduce((s, v) => s + v, 0)
      }
    });
  } catch (error) {
    console.error('SmartSchedule status error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
