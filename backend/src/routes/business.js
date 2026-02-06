// backend/src/routes/business.js
// IA Business Routes - Endpoints para dashboard IA Business

const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const AIInsight = require('../models/AIInsight');
const dailyBusinessSnapshot = require('../services/dailyBusinessSnapshot');
const claudeService = require('../services/claudeService');

// Aplicar autenticacion
router.use(auth);

// ==================== SNAPSHOT ====================

/**
 * GET /api/ai/business/snapshot
 * Ultimo snapshot generado
 */
router.get('/snapshot', authorize('admin', 'manager'), async (req, res) => {
  try {
    const insight = await AIInsight.getLatest('business_daily_snapshot', 1);

    if (!insight) {
      return res.json({
        success: false,
        message: 'No hay snapshot disponible. Se generara automaticamente.',
        status: 'pending'
      });
    }

    const ageHours = Math.round((Date.now() - new Date(insight.createdAt).getTime()) / (1000 * 60 * 60));

    res.json({
      success: true,
      snapshot: insight.data,
      generatedAt: insight.createdAt,
      ageHours,
      isStale: ageHours > 12
    });
  } catch (error) {
    console.error('Error getting snapshot:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== REPORT ====================

/**
 * GET /api/ai/business/report
 * Ultimo reporte IA
 */
router.get('/report', authorize('admin', 'manager'), async (req, res) => {
  try {
    const insight = await AIInsight.getLatest('business_daily_report', 1);

    if (!insight) {
      return res.json({
        success: false,
        message: 'No hay reporte IA disponible. Se generara automaticamente.',
        status: 'pending'
      });
    }

    const ageHours = Math.round((Date.now() - new Date(insight.createdAt).getTime()) / (1000 * 60 * 60));

    res.json({
      success: true,
      report: insight.data,
      generatedAt: insight.createdAt,
      ageHours,
      isStale: ageHours > 12
    });
  } catch (error) {
    console.error('Error getting report:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== OVERVIEW (combina snapshot + report) ====================

/**
 * GET /api/ai/business/overview
 * Todo lo necesario para la pagina IA Business
 */
router.get('/overview', authorize('admin', 'manager'), async (req, res) => {
  try {
    const [snapshotInsight, reportInsight] = await Promise.all([
      AIInsight.getLatest('business_daily_snapshot', 1),
      AIInsight.getLatest('business_daily_report', 1)
    ]);

    const snapshot = snapshotInsight?.data || null;
    const report = reportInsight?.data || null;

    const snapshotAge = snapshotInsight
      ? Math.round((Date.now() - new Date(snapshotInsight.createdAt).getTime()) / (1000 * 60 * 60))
      : null;

    res.json({
      success: true,
      snapshot,
      report,
      metadata: {
        snapshotGeneratedAt: snapshotInsight?.createdAt || null,
        reportGeneratedAt: reportInsight?.createdAt || null,
        snapshotAgeHours: snapshotAge,
        isStale: snapshotAge > 12,
        sources: snapshot?.sources || [],
        reportModel: report?.model || null,
        isFallback: report?.isFallback || false
      }
    });
  } catch (error) {
    console.error('Error getting overview:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== TRENDS ====================

/**
 * GET /api/ai/business/trends
 * Historico de snapshots para graficos
 */
router.get('/trends', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const cutoff = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);

    const snapshots = await AIInsight.find({
      type: 'business_daily_snapshot',
      createdAt: { $gte: cutoff }
    })
      .select('data.business.today data.business.last7d data.sms.subscribers createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const trends = snapshots.map(s => ({
      date: s.createdAt,
      revenue: s.data?.business?.today?.revenue || 0,
      orders: s.data?.business?.today?.orders || 0,
      avgTicket: s.data?.business?.today?.avgTicket || 0,
      smsSubscribers: s.data?.sms?.subscribers?.active || 0,
      smsConversionRate: s.data?.sms?.subscribers?.conversionRate || 0
    }));

    res.json({
      success: true,
      trends,
      period: { days: parseInt(days) }
    });
  } catch (error) {
    console.error('Error getting trends:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== GENERATE ====================

/**
 * POST /api/ai/business/generate
 * Forzar generacion de nuevo snapshot + reporte
 */
router.post('/generate', authorize('admin', 'manager'), async (req, res) => {
  try {
    console.log('Generating business snapshot on demand...');

    // 1. Generar snapshot
    const snapshot = await dailyBusinessSnapshot.generateSnapshot();

    await AIInsight.saveAnalysis('business_daily_snapshot', 1, snapshot, {
      recalculateHours: 6
    });

    // 2. Generar reporte IA
    claudeService.init();
    const report = await claudeService.generateDailyBusinessReport(snapshot);

    await AIInsight.saveAnalysis('business_daily_report', 1, report, {
      recalculateHours: 6
    });

    res.json({
      success: true,
      snapshot,
      report,
      generatedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error generating snapshot:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
