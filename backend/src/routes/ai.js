// backend/src/routes/ai.js
// 🧠 AI Analytics Routes - Solo LEE de MongoDB, nunca calcula en request
const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const AIInsight = require('../models/AIInsight');
const aiCalculator = require('../services/aiCalculator');

// Aplicar autenticación
router.use(auth);

// ==================== DASHBOARD / OVERVIEW ====================

/**
 * GET /api/ai/dashboard
 * Resumen rápido de todos los análisis
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
 * Reporte completo de insights (lee de MongoDB)
 */
router.get('/insights', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { days = 30 } = req.query;
    
    const insight = await AIInsight.getLatest('comprehensive_report', parseInt(days));
    
    if (!insight) {
      return res.json({
        success: false,
        message: 'No hay análisis disponible. El sistema calculará automáticamente.',
        status: 'pending'
      });
    }
    
    res.json({
      success: true,
      ...insight.data,
      _meta: {
        calculatedAt: insight.createdAt,
        ageHours: Math.round((Date.now() - new Date(insight.createdAt).getTime()) / (1000 * 60 * 60)),
        nextCalculation: insight.nextCalculationAt
      }
    });
    
  } catch (error) {
    console.error('Error obteniendo insights:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai/insights/quick
 * Top 5 insights rápidos
 */
router.get('/insights/quick', authorize('admin', 'manager'), async (req, res) => {
  try {
    const insight = await AIInsight.getLatest('comprehensive_report', 30);
    
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
      calculatedAt: insight.createdAt
    });
    
  } catch (error) {
    console.error('Error obteniendo quick insights:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SUBJECT LINE ANALYSIS ====================

/**
 * GET /api/ai/subjects/analyze
 * Análisis de patterns en subject lines (lee de MongoDB)
 */
router.get('/subjects/analyze', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { days = 30 } = req.query;
    
    const insight = await AIInsight.getLatest('subject_analysis', parseInt(days));
    
    if (!insight) {
      // Intentar con 90 días si no hay de 30
      const insight90 = await AIInsight.getLatest('subject_analysis', 90);
      
      if (insight90) {
        return res.json({
          success: true,
          ...insight90.data,
          _meta: {
            requestedDays: parseInt(days),
            actualDays: 90,
            calculatedAt: insight90.createdAt
          }
        });
      }
      
      return res.json({
        success: false,
        message: 'Análisis de subjects pendiente',
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
    console.error('Error en análisis de subjects:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/ai/subjects/suggest
 * Genera sugerencias para un subject (esto SÍ calcula en tiempo real, es rápido)
 */
router.post('/subjects/suggest', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { subject } = req.body;
    
    if (!subject || subject.trim().length < 3) {
      return res.status(400).json({ 
        error: 'Se requiere un subject de al menos 3 caracteres' 
      });
    }
    
    // Obtener análisis guardado para basarse en él
    const analysis = await AIInsight.getLatest('subject_analysis', 90);
    
    if (!analysis) {
      return res.json({
        success: false,
        message: 'No hay datos históricos para generar sugerencias',
        suggestions: [{ subject, reason: 'Original', confidence: 'baseline' }]
      });
    }
    
    const insights = analysis.data?.insights || {};
    const suggestions = [];
    
    // Analizar subject actual
    const hasEmoji = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/u.test(subject);
    const hasNumber = /\d+%?/.test(subject);
    const length = subject.length;
    
    // Sugerir emoji si ayuda
    if (!hasEmoji && parseFloat(insights.hasEmoji?.lift || 0) > 10) {
      const emojis = ['🥒', '✨', '🎉', '💚', '🔥', '⚡'];
      const emoji = emojis[Math.floor(Math.random() * emojis.length)];
      suggestions.push({
        subject: `${emoji} ${subject}`,
        reason: `Agregar emoji puede aumentar opens en +${insights.hasEmoji.lift}%`,
        confidence: 'medium'
      });
    }
    
    // Sugerir número si ayuda
    if (!hasNumber && parseFloat(insights.hasNumber?.lift || 0) > 10) {
      suggestions.push({
        subject: subject.replace(/descuento|off|ahorra/gi, '15% OFF'),
        reason: `Los números aumentan opens en +${insights.hasNumber.lift}%`,
        confidence: 'medium'
      });
    }
    
    // Original siempre primero
    suggestions.unshift({
      subject,
      reason: 'Subject original',
      confidence: 'baseline'
    });
    
    res.json({
      success: true,
      original: subject,
      suggestions: suggestions.slice(0, 5),
      basedOn: {
        campaignsAnalyzed: analysis.data?.summary?.campaignsAnalyzed || 0,
        avgOpenRate: analysis.data?.summary?.avgOpenRate
      }
    });
    
  } catch (error) {
    console.error('Error generando sugerencias:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SEND TIMING ====================

/**
 * GET /api/ai/timing/best
 * Mejores horarios de envío (lee de MongoDB)
 */
router.get('/timing/best', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { segmentId } = req.query;
    
    const insight = await AIInsight.getLatest('send_timing', 90, segmentId || null);
    
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
        segmentId: segmentId || 'all'
      }
    });
    
  } catch (error) {
    console.error('Error en análisis de timing:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai/timing/heatmap
 * Heatmap de engagement (lee de MongoDB)
 */
router.get('/timing/heatmap', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { segmentId } = req.query;
    
    const insight = await AIInsight.getLatest('send_timing', 90, segmentId || null);
    
    if (!insight) {
      return res.json({
        success: false,
        message: 'Datos de heatmap pendientes',
        heatmap: []
      });
    }
    
    res.json({
      success: true,
      heatmap: insight.data?.heatmap || [],
      bestTimes: insight.data?.bestTimes || [],
      dayAverages: insight.data?.dayAverages || [],
      calculatedAt: insight.createdAt
    });
    
  } catch (error) {
    console.error('Error obteniendo heatmap:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== LIST PERFORMANCE ====================

/**
 * GET /api/ai/lists/performance
 * Performance por lista (lee de MongoDB)
 */
router.get('/lists/performance', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { days = 30 } = req.query;
    
    let insight = await AIInsight.getLatest('list_performance', parseInt(days));
    
    if (!insight) {
      insight = await AIInsight.getLatest('list_performance', 90);
    }
    
    if (!insight) {
      return res.json({
        success: false,
        message: 'Análisis de listas pendiente',
        status: 'pending'
      });
    }
    
    res.json({
      success: true,
      ...insight.data,
      _meta: {
        calculatedAt: insight.createdAt,
        requestedDays: parseInt(days)
      }
    });
    
  } catch (error) {
    console.error('Error en análisis de listas:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== HEALTH CHECK ====================

/**
 * GET /api/ai/health
 * Estado de salud del email marketing (lee de MongoDB)
 */
router.get('/health', authorize('admin', 'manager'), async (req, res) => {
  try {
    const insight = await AIInsight.getLatest('health_check', 7);
    
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
        ageHours: Math.round((Date.now() - new Date(insight.createdAt).getTime()) / (1000 * 60 * 60))
      }
    });
    
  } catch (error) {
    console.error('Error en health check:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/ai/health/alerts
 * Solo alertas activas
 */
router.get('/health/alerts', authorize('admin', 'manager'), async (req, res) => {
  try {
    const insight = await AIInsight.getLatest('health_check', 7);
    
    res.json({
      success: true,
      healthScore: insight?.summary?.score || 0,
      status: insight?.summary?.status || 'unknown',
      alerts: insight?.alerts || [],
      alertCount: {
        critical: insight?.alerts?.filter(a => a.severity === 'critical').length || 0,
        warning: insight?.alerts?.filter(a => a.severity === 'warning').length || 0
      },
      calculatedAt: insight?.createdAt
    });
    
  } catch (error) {
    console.error('Error obteniendo alertas:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== CAMPAIGN PREDICTION ====================

/**
 * POST /api/ai/campaigns/predict
 * Predecir performance de una campaña (usa datos históricos de MongoDB)
 */
router.post('/campaigns/predict', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { subject, listId, sendHour, sendDay } = req.body;
    
    if (!subject || !listId) {
      return res.status(400).json({
        error: 'Se requiere subject y listId'
      });
    }
    
    // Obtener insights históricos de MongoDB
    const [listInsight, subjectInsight, timingInsight] = await Promise.all([
      AIInsight.getLatest('list_performance', 90),
      AIInsight.getLatest('subject_analysis', 90),
      AIInsight.getLatest('send_timing', 90)
    ]);
    
    if (!listInsight) {
      return res.json({
        success: false,
        message: 'No hay datos históricos suficientes para predicción'
      });
    }
    
    // Usar el calculator con los datos históricos
    const prediction = await aiCalculator.predictCampaignPerformance(
      { subject, listId, sendHour, sendDay },
      {
        list_performance: listInsight,
        subject_analysis: subjectInsight,
        send_timing: timingInsight
      }
    );
    
    res.json(prediction);
    
  } catch (error) {
    console.error('Error en predicción:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== HISTORY / TRENDS ====================

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

// ==================== ADMIN / MANAGEMENT ====================

/**
 * POST /api/ai/recalculate
 * Forzar recálculo de todos los análisis
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
      console.log('🔄 Forzando recálculo de todos los análisis...');
      
      // Ejecutar en background
      setImmediate(async () => {
        await aiAnalyticsJob.forceRecalculate();
      });
      
      res.json({
        success: true,
        message: 'Recálculo iniciado en background',
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
    const dueForRecalc = await AIInsight.getDueForRecalculation();
    const jobStatus = aiAnalyticsJob.getStatus();
    
    res.json({
      success: true,
      job: jobStatus,
      analyses: summary.analyses,
      globalScore: summary.globalScore,
      totalAlerts: summary.totalAlerts,
      pendingRecalculations: dueForRecalc.length,
      timestamp: new Date()
    });
    
  } catch (error) {
    console.error('Error obteniendo status:', error);
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

module.exports = router;