// backend/src/routes/ai.js
// 🧠 AI Analytics Routes - Solo LEE de MongoDB, nunca calcula en request
// 🔧 UPDATED: New response structure for Claude insights
const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const AIInsight = require('../models/AIInsight');
const aiCalculator = require('../services/aiCalculator');

router.use(auth);

// ==================== DASHBOARD / OVERVIEW ====================

router.get('/dashboard', authorize('admin', 'manager'), async (req, res) => {
  try {
    const summary = await AIInsight.getDashboardSummary();
    res.json(summary);
  } catch (error) {
    console.error('Error en AI dashboard:', error);
    res.status(500).json({ error: error.message });
  }
});

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

// ==================== 🆕 CLAUDE AI INSIGHTS (UPDATED) ====================

/**
 * GET /api/ai/claude
 * Obtener insights generados por Claude (nuevo formato)
 */
router.get('/claude', authorize('admin', 'manager'), async (req, res) => {
  try {
    const insight = await AIInsight.getLatest('ai_generated_insights', 30);
    
    if (!insight) {
      return res.json({
        success: false,
        message: 'Insights de Claude pendientes. El sistema los generará automáticamente.',
        status: 'pending',
        // Estructura vacía para el frontend
        executiveSummary: '',
        deepAnalysis: {},
        actionPlan: [],
        quickWins: [],
        warnings: [],
        opportunities: [],
        nextCampaignSuggestion: null
      });
    }
    
    // Extraer datos del insight guardado
    const data = insight.data || {};
    
    res.json({
      success: data.success !== false,
      // Nuevo formato
      executiveSummary: data.executiveSummary || '',
      deepAnalysis: data.deepAnalysis || {},
      actionPlan: data.actionPlan || [],
      quickWins: data.quickWins || [],
      warnings: data.warnings || [],
      opportunities: data.opportunities || [],
      nextCampaignSuggestion: data.nextCampaignSuggestion || null,
      // Compatibilidad con formato anterior (por si acaso)
      insights: data.insights || data.actionPlan || [],
      summary: data.summary || data.executiveSummary || '',
      recommendations: data.recommendations || data.quickWins || [],
      // Metadata
      model: data.model || 'unknown',
      tokensUsed: data.tokensUsed || { input: 0, output: 0 },
      isFallback: data.isFallback || false,
      parseError: data.parseError || false,
      _meta: {
        generatedAt: data.generatedAt || insight.createdAt,
        calculatedAt: insight.createdAt,
        ageHours: Math.round((Date.now() - new Date(insight.createdAt).getTime()) / (1000 * 60 * 60)),
        nextCalculation: insight.nextCalculationAt,
        inputDataSize: data.inputDataSize,
        duration: data.duration
      }
    });
    
  } catch (error) {
    console.error('Error obteniendo Claude insights:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/claude/status', authorize('admin', 'manager'), async (req, res) => {
  try {
    const claudeService = require('../services/claudeService');
    const latestInsight = await AIInsight.getLatest('ai_generated_insights', 30);
    
    res.json({
      enabled: claudeService.isAvailable(),
      model: claudeService.model,
      lastGenerated: latestInsight?.createdAt || null,
      lastTokensUsed: latestInsight?.data?.tokensUsed || null,
      hasExecutiveSummary: !!latestInsight?.data?.executiveSummary,
      actionPlanCount: latestInsight?.data?.actionPlan?.length || 0,
      isFallback: latestInsight?.data?.isFallback || false,
      parseError: latestInsight?.data?.parseError || false
    });
    
  } catch (error) {
    console.error('Error obteniendo estado de Claude:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SUBJECT LINE ANALYSIS ====================

router.get('/subjects/analyze', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { days = 30 } = req.query;
    let insight = await AIInsight.getLatest('subject_analysis', parseInt(days));
    
    if (!insight) {
      insight = await AIInsight.getLatest('subject_analysis', 90);
      
      if (insight) {
        return res.json({
          success: true,
          ...insight.data,
          _meta: {
            requestedDays: parseInt(days),
            actualDays: 90,
            calculatedAt: insight.createdAt
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

router.post('/subjects/suggest', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { subject } = req.body;
    
    if (!subject || subject.trim().length < 3) {
      return res.status(400).json({ 
        error: 'Se requiere un subject de al menos 3 caracteres' 
      });
    }
    
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
    
    const hasEmoji = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/u.test(subject);
    const hasNumber = /\d+%?/.test(subject);
    
    if (!hasEmoji && parseFloat(insights.hasEmoji?.lift || 0) > 10) {
      const emojis = ['🥒', '✨', '🎉', '💚', '🔥', '⚡'];
      const emoji = emojis[Math.floor(Math.random() * emojis.length)];
      suggestions.push({
        subject: `${emoji} ${subject}`,
        reason: `Agregar emoji puede aumentar opens en +${insights.hasEmoji.lift}%`,
        confidence: 'medium'
      });
    }
    
    if (!hasNumber && parseFloat(insights.hasNumber?.lift || 0) > 10) {
      suggestions.push({
        subject: subject.replace(/descuento|off|ahorra/gi, '15% OFF'),
        reason: `Los números aumentan opens en +${insights.hasNumber.lift}%`,
        confidence: 'medium'
      });
    }
    
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

router.post('/campaigns/predict', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { subject, listId, sendHour, sendDay } = req.body;
    
    if (!subject || !listId) {
      return res.status(400).json({
        error: 'Se requiere subject y listId'
      });
    }
    
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