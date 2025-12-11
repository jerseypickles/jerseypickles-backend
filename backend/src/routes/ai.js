// backend/src/routes/ai.js
// 🧠 AI Analytics Routes - Solo LEE de MongoDB, nunca calcula en request
// 🔧 UPDATED: Includes strategicContext + 15 days focus
const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const AIInsight = require('../models/AIInsight');
const aiCalculator = require('../services/aiCalculator');
const claudeService = require('../services/claudeService');
const aiAnalyticsJob = require('../jobs/aiAnalyticsJob');
const Campaign = require('../models/Campaign');

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
    const { days = 15 } = req.query;
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
    const insight = await AIInsight.getLatest('comprehensive_report', 15);
    
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

router.get('/claude', authorize('admin', 'manager'), async (req, res) => {
  try {
    // Primero buscar insights frescos
    let insight = await AIInsight.getLatest('ai_generated_insights', 15);
    
    // Si no hay frescos, buscar aunque estén stale
    if (!insight) {
      insight = await AIInsight.findOne({ 
        type: 'ai_generated_insights',
        'summary.status': { $ne: 'error' }
      }).sort({ createdAt: -1 });
      
      if (insight) {
        console.log('📦 Usando Claude insight (posiblemente stale):', insight.createdAt);
      }
    }
    
    if (!insight) {
      return res.json({
        success: false,
        message: 'No hay análisis de Claude disponible. El sistema lo generará automáticamente.',
        status: 'pending',
        data: null
      });
    }
    
    res.json({
      success: true,
      data: insight.data,
      _meta: {
        calculatedAt: insight.createdAt,
        ageHours: Math.round((Date.now() - new Date(insight.createdAt).getTime()) / (1000 * 60 * 60)),
        isStale: insight.isStale || false,
        source: 'claude-ai'
      }
    });
    
  } catch (error) {
    console.error('Error obteniendo Claude insights:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/claude/status', authorize('admin', 'manager'), async (req, res) => {
  try {
    claudeService.init();
    
    const latestInsight = await AIInsight.findOne({ 
      type: 'ai_generated_insights' 
    }).sort({ createdAt: -1 });
    
    res.json({
      available: claudeService.isAvailable(),
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
    const { days = 15 } = req.query;
    const daysInt = parseInt(days);
    
    // Obtener insight guardado
    let insight = await AIInsight.getLatest('subject_analysis', daysInt);
    
    if (!insight) {
      // Intentar con insight más antiguo
      insight = await AIInsight.findOne({ 
        type: 'subject_analysis'
      }).sort({ createdAt: -1 });
      
      if (!insight) {
        return res.json({
          success: false,
          message: 'Análisis de subjects pendiente',
          status: 'pending'
        });
      }
    }
    
    // 🔧 CALCULAR CONTEXTO ESTRATÉGICO EN TIEMPO REAL
    // Esto es rápido y garantiza datos frescos
    let strategicContext = insight.data?.strategicContext || null;
    
    if (!strategicContext) {
      try {
        // Obtener campañas recientes para calcular contexto
        const recentDate = new Date();
        recentDate.setDate(recentDate.getDate() - daysInt);
        
        const recentCampaigns = await Campaign.find({
          status: 'sent',
          sentAt: { $gte: recentDate },
          'stats.sent': { $gte: 50 }
        }).select('name subject stats sentAt').sort({ sentAt: -1 }).lean();
        
        if (recentCampaigns.length >= 3) {
          strategicContext = aiCalculator.analyzeStrategicContext(recentCampaigns);
          console.log('📊 Strategic context calculated:', strategicContext.strategicPhase);
        }
      } catch (ctxError) {
        console.error('Error calculando strategic context:', ctxError);
      }
    }
    
    res.json({
      success: true,
      ...insight.data,
      strategicContext, // 🔧 Siempre incluir
      _meta: {
        calculatedAt: insight.createdAt,
        ageHours: Math.round((Date.now() - new Date(insight.createdAt).getTime()) / (1000 * 60 * 60)),
        days: daysInt
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
    
    const analysis = await AIInsight.getLatest('subject_analysis', 15);
    
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
    
    if (subject.length > 50) {
      suggestions.push({
        subject: subject.substring(0, 45) + '...',
        reason: 'Los subjects cortos (<50 chars) tienen mejor performance',
        confidence: 'high'
      });
    }
    
    suggestions.unshift({
      subject,
      reason: 'Tu subject original',
      confidence: 'baseline'
    });
    
    res.json({
      success: true,
      original: subject,
      suggestions: suggestions.slice(0, 5),
      basedOn: {
        campaignsAnalyzed: analysis.data?.summary?.campaignsAnalyzed || 0,
        period: `${analysis.periodDays || 15} días`
      }
    });
    
  } catch (error) {
    console.error('Error generando sugerencias:', error);
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
    console.error('Error en health check:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SEND TIMING ====================

router.get('/timing/best', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { segmentId } = req.query;
    
    let insight = await AIInsight.getLatest('send_timing', 15, segmentId);
    
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
    console.error('Error en timing analysis:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== LIST PERFORMANCE ====================

router.get('/lists/performance', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { days = 15 } = req.query;
    let insight = await AIInsight.getLatest('list_performance', parseInt(days));
    
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
        ageHours: Math.round((Date.now() - new Date(insight.createdAt).getTime()) / (1000 * 60 * 60))
      }
    });
    
  } catch (error) {
    console.error('Error en list performance:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== CAMPAIGN PREDICTION ====================

router.post('/predict', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { subject, listId, sendHour, sendDay } = req.body;
    
    if (!subject || !listId) {
      return res.status(400).json({ 
        error: 'Se requiere subject y listId' 
      });
    }
    
    const [subjectInsight, timingInsight, listInsight] = await Promise.all([
      AIInsight.getLatest('subject_analysis', 15),
      AIInsight.getLatest('send_timing', 15),
      AIInsight.getLatest('list_performance', 15)
    ]);
    
    const historicalInsights = {
      subject_analysis: subjectInsight,
      send_timing: timingInsight,
      list_performance: listInsight
    };
    
    const prediction = await aiCalculator.predictCampaignPerformance(
      { subject, listId, sendHour, sendDay },
      historicalInsights
    );
    
    res.json(prediction);
    
  } catch (error) {
    console.error('Error en predicción:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADMIN / MANAGEMENT ====================

router.post('/recalculate', authorize('admin'), async (req, res) => {
  try {
    // Verificar si ya está corriendo
    if (aiAnalyticsJob.isRunning) {
      return res.json({
        success: false,
        message: 'Ya hay un cálculo en proceso. Por favor espera.',
        status: 'already_running'
      });
    }
    
    console.log('🔄 Recálculo manual iniciado por:', req.user?.email);
    
    // Ejecutar directamente (no con setImmediate para evitar race conditions)
    aiAnalyticsJob.forceRecalculate();
    
    res.json({
      success: true,
      message: 'Recálculo iniciado. Los resultados estarán disponibles en unos minutos.',
      status: 'started'
    });
    
  } catch (error) {
    console.error('Error iniciando recálculo:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/recalculate/:type', authorize('admin'), async (req, res) => {
  try {
    const { type } = req.params;
    
    const validTypes = [
      'health_check', 
      'subject_analysis', 
      'send_timing', 
      'list_performance', 
      'comprehensive_report',
      'ai_generated_insights'
    ];
    
    if (!validTypes.includes(type)) {
      return res.status(400).json({ 
        error: `Tipo inválido. Válidos: ${validTypes.join(', ')}` 
      });
    }
    
    console.log(`🔄 Recálculo de ${type} iniciado por:`, req.user?.email);
    
    const results = await aiAnalyticsJob.forceRecalculateType(type);
    
    res.json({
      success: true,
      message: `Recálculo de ${type} completado`,
      results
    });
    
  } catch (error) {
    console.error('Error en recálculo específico:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/status', authorize('admin', 'manager'), async (req, res) => {
  try {
    const types = [
      'health_check',
      'subject_analysis', 
      'send_timing',
      'list_performance',
      'comprehensive_report',
      'ai_generated_insights'
    ];
    
    const status = {};
    
    for (const type of types) {
      const latest = await AIInsight.findOne({ type }).sort({ createdAt: -1 });
      
      if (latest) {
        const ageMs = Date.now() - new Date(latest.createdAt).getTime();
        const ageHours = Math.round(ageMs / (1000 * 60 * 60));
        
        status[type] = {
          available: true,
          lastCalculated: latest.createdAt,
          ageHours,
          isStale: latest.isStale || false,
          status: ageHours < 12 ? 'fresh' : ageHours < 24 ? 'recent' : 'stale'
        };
      } else {
        status[type] = {
          available: false,
          lastCalculated: null,
          ageHours: null,
          status: 'pending'
        };
      }
    }
    
    // Agregar estado del job
    status._job = {
      isRunning: aiAnalyticsJob.isRunning || false,
      schedule: '0 */6 * * *',
      description: 'Cada 6 horas'
    };
    
    res.json(status);
    
  } catch (error) {
    console.error('Error obteniendo status:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== DEBUG ENDPOINTS ====================

router.get('/debug/data-for-claude', authorize('admin'), async (req, res) => {
  try {
    // Obtener todos los análisis actuales
    const [healthCheck, subjectAnalysis, sendTiming, listPerformance] = await Promise.all([
      AIInsight.getLatest('health_check', 7),
      AIInsight.getLatest('subject_analysis', 15),
      AIInsight.getLatest('send_timing', 15),
      AIInsight.getLatest('list_performance', 15)
    ]);
    
    // Preparar datos como se envían a Claude
    const analysisResults = {
      healthCheck: healthCheck?.data,
      subjectAnalysis: subjectAnalysis?.data,
      sendTiming: sendTiming?.data,
      listPerformance: listPerformance?.data
    };
    
    const dataForClaude = aiCalculator.prepareDataForClaude(analysisResults);
    
    res.json({
      success: true,
      dataForClaude,
      sources: {
        healthCheck: healthCheck ? { 
          age: Math.round((Date.now() - new Date(healthCheck.createdAt)) / 60000) + ' min',
          periodDays: healthCheck.periodDays 
        } : null,
        subjectAnalysis: subjectAnalysis ? {
          age: Math.round((Date.now() - new Date(subjectAnalysis.createdAt)) / 60000) + ' min',
          periodDays: subjectAnalysis.periodDays
        } : null,
        sendTiming: sendTiming ? {
          age: Math.round((Date.now() - new Date(sendTiming.createdAt)) / 60000) + ' min',
          periodDays: sendTiming.periodDays
        } : null,
        listPerformance: listPerformance ? {
          age: Math.round((Date.now() - new Date(listPerformance.createdAt)) / 60000) + ' min',
          periodDays: listPerformance.periodDays
        } : null
      }
    });
    
  } catch (error) {
    console.error('Error en debug endpoint:', error);
    res.status(500).json({ error: error.message });
  }
});

// 🆕 DEBUG: Ver contexto estratégico actual
router.get('/debug/strategic-context', authorize('admin'), async (req, res) => {
  try {
    const { days = 15 } = req.query;
    const daysInt = parseInt(days);
    
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - daysInt);
    
    const recentCampaigns = await Campaign.find({
      status: 'sent',
      sentAt: { $gte: recentDate },
      'stats.sent': { $gte: 50 }
    }).select('name subject stats sentAt').sort({ sentAt: -1 }).lean();
    
    if (recentCampaigns.length < 3) {
      return res.json({
        success: false,
        message: `Solo ${recentCampaigns.length} campañas en los últimos ${daysInt} días (mínimo 3)`,
        campaigns: recentCampaigns.map(c => ({
          name: c.name,
          subject: c.subject,
          sentAt: c.sentAt
        }))
      });
    }
    
    const strategicContext = aiCalculator.analyzeStrategicContext(recentCampaigns);
    
    res.json({
      success: true,
      period: `${daysInt} días`,
      currentDate: new Date().toISOString(),
      strategicContext,
      campaignsAnalyzed: recentCampaigns.length
    });
    
  } catch (error) {
    console.error('Error en debug strategic context:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;