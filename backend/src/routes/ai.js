// backend/src/routes/ai.js
// 📱 SMS AI Analytics Routes - Enfocado en SMS Marketing
// Lee de MongoDB, nunca calcula en request

const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const AIInsight = require('../models/AIInsight');
const smsCalculator = require('../services/smsCalculator');

// Aplicar autenticación
router.use(auth);

// ==================== DASHBOARD / OVERVIEW ====================

/**
 * GET /api/ai/dashboard
 * Resumen rápido de todos los análisis SMS
 */
router.get('/dashboard', authorize('admin', 'manager'), async (req, res) => {
  try {
    const summary = await AIInsight.getDashboardSummary();
    res.json(summary);
  } catch (error) {
    console.error('Error en AI dashboard:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai/insights
 * Reporte completo de insights SMS (lee de MongoDB)
 */
router.get('/insights', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { days = 30 } = req.query;

    const insight = await AIInsight.getLatest('sms_comprehensive_report', parseInt(days));

    if (!insight) {
      return res.json({
        success: false,
        message: 'No hay análisis SMS disponible. El sistema calculará automáticamente.',
        status: 'pending'
      });
    }

    res.json({
      success: true,
      ...insight.data,
      _meta: {
        calculatedAt: insight.createdAt,
        ageHours: Math.round((Date.now() - new Date(insight.createdAt).getTime()) / (1000 * 60 * 60)),
        nextCalculation: insight.nextCalculationAt,
        focusMode: 'sms'
      }
    });

  } catch (error) {
    console.error('Error obteniendo insights:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai/insights/quick
 * Top 5 insights rápidos de SMS
 */
router.get('/insights/quick', authorize('admin', 'manager'), async (req, res) => {
  try {
    const insight = await AIInsight.getLatest('sms_comprehensive_report', 30);

    if (!insight) {
      return res.json({
        success: false,
        message: 'Análisis pendiente',
        topInsights: []
      });
    }

    res.json({
      success: true,
      healthScore: insight.summary?.score || 0,
      healthStatus: insight.summary?.status || 'unknown',
      topInsights: insight.topInsights?.slice(0, 5) || [],
      calculatedAt: insight.createdAt,
      focusMode: 'sms'
    });

  } catch (error) {
    console.error('Error obteniendo quick insights:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== CLAUDE AI INSIGHTS (SMS) ====================

/**
 * GET /api/ai/claude
 * Obtener insights SMS generados por Claude
 */
router.get('/claude', authorize('admin', 'manager'), async (req, res) => {
  try {
    const insight = await AIInsight.getLatest('sms_ai_insights', 30);

    if (!insight) {
      return res.json({
        success: false,
        message: 'Insights de Claude pendientes. El sistema los generará automáticamente.',
        status: 'pending',
        data: null
      });
    }

    const claudeData = insight.data || {};

    // Verificar si los datos están desactualizados (más de 12 horas)
    const ageHours = Math.round((Date.now() - new Date(insight.createdAt).getTime()) / (1000 * 60 * 60));
    const isOutdated = ageHours > 12;

    let recalculationStarted = false;

    if (isOutdated) {
      const aiAnalyticsJob = require('../jobs/aiAnalyticsJob');
      if (!aiAnalyticsJob.isRunning) {
        recalculationStarted = true;
        setImmediate(async () => {
          try {
            await aiAnalyticsJob.forceRecalculateType('sms_ai_insights');
          } catch (e) {
            console.error('Error en recálculo automático:', e.message);
          }
        });
      }
    }

    res.json({
      success: true,
      data: claudeData,
      _meta: {
        generatedAt: claudeData.generatedAt || insight.createdAt,
        calculatedAt: insight.createdAt,
        ageHours,
        nextCalculation: insight.nextCalculationAt,
        model: claudeData.model || 'unknown',
        tokensUsed: claudeData.tokensUsed || { input: 0, output: 0 },
        hasBusinessContext: claudeData.hasBusinessContext || false,
        isFallback: claudeData.isFallback || false,
        isOutdated,
        recalculationStarted,
        analysisType: 'sms'
      }
    });

  } catch (error) {
    console.error('Error obteniendo Claude insights:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai/claude/status
 * Estado del servicio de Claude
 */
router.get('/claude/status', authorize('admin', 'manager'), async (req, res) => {
  try {
    const claudeService = require('../services/claudeService');

    const latestInsight = await AIInsight.getLatest('sms_ai_insights', 30);

    res.json({
      enabled: claudeService.isAvailable(),
      model: claudeService.model,
      lastGenerated: latestInsight?.createdAt || null,
      lastTokensUsed: latestInsight?.data?.tokensUsed || null,
      hasData: !!latestInsight?.data?.executiveSummary,
      isFallback: latestInsight?.data?.isFallback || false,
      dataAge: latestInsight
        ? Math.round((Date.now() - new Date(latestInsight.createdAt).getTime()) / (1000 * 60 * 60))
        : null,
      analysisType: 'sms'
    });

  } catch (error) {
    console.error('Error obteniendo estado de Claude:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SMS HEALTH CHECK ====================

/**
 * GET /api/ai/health
 * Estado de salud del SMS marketing
 */
router.get('/health', authorize('admin', 'manager'), async (req, res) => {
  try {
    const insight = await AIInsight.getLatest('sms_health_check', 7);

    if (!insight) {
      return res.json({
        success: false,
        message: 'Health check pendiente',
        health: { score: 0, status: 'unknown' }
      });
    }

    res.json({
      success: true,
      ...insight.data,
      _meta: {
        calculatedAt: insight.createdAt,
        ageHours: Math.round((Date.now() - new Date(insight.createdAt).getTime()) / (1000 * 60 * 60)),
        analysisType: 'sms'
      }
    });

  } catch (error) {
    console.error('Error en health check:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai/health/alerts
 * Solo alertas activas de SMS
 */
router.get('/health/alerts', authorize('admin', 'manager'), async (req, res) => {
  try {
    const insight = await AIInsight.getLatest('sms_health_check', 7);

    res.json({
      success: true,
      healthScore: insight?.summary?.score || 0,
      status: insight?.summary?.status || 'unknown',
      alerts: insight?.alerts || [],
      alertCount: {
        critical: insight?.alerts?.filter(a => a.severity === 'critical').length || 0,
        warning: insight?.alerts?.filter(a => a.severity === 'warning').length || 0
      },
      calculatedAt: insight?.createdAt,
      analysisType: 'sms'
    });

  } catch (error) {
    console.error('Error obteniendo alertas:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== CONVERSION FUNNEL ====================

/**
 * GET /api/ai/funnel
 * Funnel de conversión SMS
 */
router.get('/funnel', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { days = 30 } = req.query;

    const insight = await AIInsight.getLatest('sms_conversion_funnel', parseInt(days));

    if (!insight) {
      return res.json({
        success: false,
        message: 'Análisis de funnel pendiente',
        status: 'pending'
      });
    }

    res.json({
      success: true,
      ...insight.data,
      _meta: {
        calculatedAt: insight.createdAt,
        ageHours: Math.round((Date.now() - new Date(insight.createdAt).getTime()) / (1000 * 60 * 60))
      }
    });

  } catch (error) {
    console.error('Error en análisis de funnel:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SECOND CHANCE SMS ====================

/**
 * GET /api/ai/second-chance
 * Performance del Second Chance SMS
 */
router.get('/second-chance', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { days = 30 } = req.query;

    const insight = await AIInsight.getLatest('sms_second_chance', parseInt(days));

    if (!insight) {
      return res.json({
        success: false,
        message: 'Análisis de Second Chance pendiente',
        status: 'pending'
      });
    }

    res.json({
      success: true,
      ...insight.data,
      _meta: {
        calculatedAt: insight.createdAt,
        ageHours: Math.round((Date.now() - new Date(insight.createdAt).getTime()) / (1000 * 60 * 60))
      }
    });

  } catch (error) {
    console.error('Error en análisis de Second Chance:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai/second-chance/opportunity
 * Oportunidades perdidas de Second Chance
 */
router.get('/second-chance/opportunity', authorize('admin', 'manager'), async (req, res) => {
  try {
    const insight = await AIInsight.getLatest('sms_second_chance', 30);

    if (!insight) {
      return res.json({
        success: false,
        message: 'Datos pendientes'
      });
    }

    res.json({
      success: true,
      opportunity: insight.data?.opportunity || {},
      financial: insight.data?.financial || {},
      topInsights: insight.data?.topInsights?.filter(i => i.type === 'warning') || [],
      calculatedAt: insight.createdAt
    });

  } catch (error) {
    console.error('Error obteniendo oportunidades:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== TIME TO CONVERT ====================

/**
 * GET /api/ai/timing
 * Análisis de tiempo hasta conversión
 */
router.get('/timing', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { days = 30 } = req.query;

    const insight = await AIInsight.getLatest('sms_time_to_convert', parseInt(days));

    if (!insight) {
      return res.json({
        success: false,
        message: 'Análisis de timing pendiente',
        status: 'pending'
      });
    }

    res.json({
      success: true,
      ...insight.data,
      _meta: {
        calculatedAt: insight.createdAt,
        ageHours: Math.round((Date.now() - new Date(insight.createdAt).getTime()) / (1000 * 60 * 60))
      }
    });

  } catch (error) {
    console.error('Error en análisis de timing:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai/timing/distribution
 * Distribución de tiempo hasta conversión
 */
router.get('/timing/distribution', authorize('admin', 'manager'), async (req, res) => {
  try {
    const insight = await AIInsight.getLatest('sms_time_to_convert', 30);

    if (!insight) {
      return res.json({
        success: false,
        message: 'Datos de distribución pendientes',
        distribution: []
      });
    }

    res.json({
      success: true,
      avgTimeToConvert: insight.data?.summary?.avgTimeToConvert,
      distribution: insight.data?.distribution || [],
      byConversionType: insight.data?.byConversionType || [],
      calculatedAt: insight.createdAt
    });

  } catch (error) {
    console.error('Error obteniendo distribución:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== CAMPAIGN PERFORMANCE ====================

/**
 * GET /api/ai/campaigns
 * Performance de campañas SMS
 */
router.get('/campaigns', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { days = 30 } = req.query;

    const insight = await AIInsight.getLatest('sms_campaign_performance', parseInt(days));

    if (!insight) {
      return res.json({
        success: false,
        message: 'Análisis de campañas pendiente',
        status: 'pending'
      });
    }

    res.json({
      success: true,
      ...insight.data,
      _meta: {
        calculatedAt: insight.createdAt,
        ageHours: Math.round((Date.now() - new Date(insight.createdAt).getTime()) / (1000 * 60 * 60))
      }
    });

  } catch (error) {
    console.error('Error en análisis de campañas:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai/campaigns/top
 * Top campañas por revenue y conversión
 */
router.get('/campaigns/top', authorize('admin', 'manager'), async (req, res) => {
  try {
    const insight = await AIInsight.getLatest('sms_campaign_performance', 30);

    if (!insight) {
      return res.json({
        success: false,
        message: 'Datos de campañas pendientes',
        rankings: {}
      });
    }

    res.json({
      success: true,
      rankings: insight.data?.rankings || {},
      summary: insight.data?.summary || {},
      calculatedAt: insight.createdAt
    });

  } catch (error) {
    console.error('Error obteniendo top campañas:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== LIVE CALCULATIONS (Para datos en tiempo real) ====================

/**
 * GET /api/ai/live/health
 * Cálculo en tiempo real de health (para testing/debugging)
 */
router.get('/live/health', authorize('admin'), async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const result = await smsCalculator.calculateSmsHealthCheck({ days: parseInt(days) });
    res.json(result);
  } catch (error) {
    console.error('Error en live health:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai/live/funnel
 * Cálculo en tiempo real de funnel
 */
router.get('/live/funnel', authorize('admin'), async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const result = await smsCalculator.calculateConversionFunnel({ days: parseInt(days) });
    res.json(result);
  } catch (error) {
    console.error('Error en live funnel:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai/live/second-chance
 * Cálculo en tiempo real de Second Chance
 */
router.get('/live/second-chance', authorize('admin'), async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const result = await smsCalculator.calculateSecondChancePerformance({ days: parseInt(days) });
    res.json(result);
  } catch (error) {
    console.error('Error en live second-chance:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADMIN / MANAGEMENT ====================

/**
 * POST /api/ai/recalculate
 * Forzar recálculo de análisis SMS
 */
router.post('/recalculate', authorize('admin'), async (req, res) => {
  try {
    const { type } = req.body;

    const aiAnalyticsJob = require('../jobs/aiAnalyticsJob');

    if (type) {
      console.log(`🔄 Forzando recálculo de: ${type}`);
      const results = await aiAnalyticsJob.forceRecalculateType(type);
      res.json({
        success: true,
        message: `Recálculo de ${type} completado`,
        results
      });
    } else {
      console.log('🔄 Forzando recálculo de todos los análisis SMS...');

      // Ejecutar en background
      setImmediate(async () => {
        await aiAnalyticsJob.forceRecalculate();
      });

      res.json({
        success: true,
        message: 'Recálculo SMS iniciado en background',
        note: 'Los resultados estarán disponibles en unos minutos'
      });
    }

  } catch (error) {
    console.error('Error forzando recálculo:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/ai/invalidate
 * Invalidar análisis (marcar como stale)
 */
router.post('/invalidate', authorize('admin'), async (req, res) => {
  try {
    const { type } = req.body;

    const count = await AIInsight.invalidate(type || null);

    res.json({
      success: true,
      message: `${count} análisis invalidados`,
      invalidated: count
    });

  } catch (error) {
    console.error('Error invalidando análisis:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai/status
 * Estado del sistema de AI Analytics
 */
router.get('/status', authorize('admin', 'manager'), async (req, res) => {
  try {
    const aiAnalyticsJob = require('../jobs/aiAnalyticsJob');

    const summary = await AIInsight.getDashboardSummary();
    const jobStatus = aiAnalyticsJob.getStatus();

    res.json({
      success: true,
      job: jobStatus,
      analyses: summary.analyses,
      globalScore: summary.globalScore,
      totalAlerts: summary.totalAlerts,
      focusMode: summary.focusMode,
      timestamp: new Date()
    });

  } catch (error) {
    console.error('Error obteniendo status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai/history/:type
 * Historial de scores de un tipo de análisis
 */
router.get('/history/:type', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { type } = req.params;
    const { days = 30, limit = 30 } = req.query;

    const history = await AIInsight.getScoreHistory(type, parseInt(days), parseInt(limit));

    res.json({
      success: true,
      type,
      periodDays: parseInt(days),
      history: history.map(h => ({
        date: h.createdAt,
        score: h.summary?.score,
        status: h.summary?.status,
        trend: h.changes?.trend
      }))
    });

  } catch (error) {
    console.error('Error obteniendo historial:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/ai/cleanup
 * Limpiar análisis antiguos
 */
router.delete('/cleanup', authorize('admin'), async (req, res) => {
  try {
    const { daysToKeep = 90 } = req.body;

    const deleted = await AIInsight.cleanup(parseInt(daysToKeep));

    res.json({
      success: true,
      message: `${deleted} análisis antiguos eliminados`,
      deleted
    });

  } catch (error) {
    console.error('Error en cleanup:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== LEGACY EMAIL ENDPOINTS (deprecated) ====================

/**
 * GET /api/ai/subjects/analyze
 * @deprecated - Ya no aplica, el enfoque es SMS
 */
router.get('/subjects/analyze', authorize('admin', 'manager'), async (req, res) => {
  res.json({
    success: false,
    message: 'Este endpoint está deprecado. El enfoque ahora es SMS marketing.',
    redirect: '/api/ai/health'
  });
});

/**
 * GET /api/ai/timing/best
 * @deprecated - Usar /api/ai/timing para SMS
 */
router.get('/timing/best', authorize('admin', 'manager'), async (req, res) => {
  res.json({
    success: false,
    message: 'Este endpoint está deprecado. Usar /api/ai/timing para análisis de SMS.',
    redirect: '/api/ai/timing'
  });
});

/**
 * GET /api/ai/lists/performance
 * @deprecated - Ya no aplica, el enfoque es SMS
 */
router.get('/lists/performance', authorize('admin', 'manager'), async (req, res) => {
  res.json({
    success: false,
    message: 'Este endpoint está deprecado. El enfoque ahora es SMS marketing.',
    redirect: '/api/ai/funnel'
  });
});

module.exports = router;
