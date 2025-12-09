// backend/src/models/AIInsight.js
// 🧠 AI Insights Model - Almacena análisis calculados para consulta rápida
const mongoose = require('mongoose');

/**
 * AIInsight Model
 * 
 * Almacena los análisis de IA pre-calculados.
 * Se actualiza periódicamente via cron job (no en cada request).
 * Permite histórico para ver tendencias de los propios insights.
 */

const aiInsightSchema = new mongoose.Schema({
  // ==================== IDENTIFICACIÓN ====================
  
  // Tipo de análisis
  type: {
    type: String,
    enum: [
      'subject_analysis',      // Análisis de subject lines
      'send_timing',           // Mejores horarios
      'list_performance',      // Performance por lista
      'health_check',          // Estado de salud
      'comprehensive_report',  // Reporte completo
      'ai_generated_insights'  // 🆕 Insights generados por Claude
    ],
    required: true,
    index: true
  },
  
  // Período analizado (en días)
  periodDays: {
    type: Number,
    required: true,
    index: true
  },
  
  // Segmento específico (si aplica)
  segmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Segment',
    default: null,
    index: true
  },
  
  // ==================== DATOS DEL ANÁLISIS ====================
  
  // Resultado del análisis (schema flexible)
  data: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  
  // Resumen ejecutivo (para queries rápidas)
  summary: {
    primaryMetric: {
      name: String,
      value: mongoose.Schema.Types.Mixed,
      trend: String  // 'up', 'down', 'stable'
    },
    score: Number,
    status: {
      type: String,
      enum: ['healthy', 'warning', 'critical', 'insufficient_data']
    },
    insightsCount: Number,
    alertsCount: Number
  },
  
  // Top insights (para mostrar rápido)
  topInsights: [{
    category: String,
    priority: {
      type: String,
      enum: ['high', 'medium', 'low']
    },
    insight: String,
    action: String,
    metric: mongoose.Schema.Types.Mixed
  }],
  
  // Alertas activas
  alerts: [{
    type: { type: String },
    severity: {
      type: String,
      enum: ['critical', 'warning', 'info']
    },
    message: String,
    action: String,
    threshold: Number,
    currentValue: Number
  }],
  
  // ==================== METADATA ====================
  
  dataStats: {
    campaignsAnalyzed: { type: Number, default: 0 },
    emailsAnalyzed: { type: Number, default: 0 },
    segmentsAnalyzed: { type: Number, default: 0 },
    dateRangeStart: Date,
    dateRangeEnd: Date
  },
  
  calculationTime: {
    startedAt: Date,
    completedAt: Date,
    durationMs: Number
  },
  
  algorithmVersion: {
    type: String,
    default: '1.0.0'
  },
  
  // ==================== HISTÓRICO ====================
  
  previousPeriod: {
    calculatedAt: Date,
    primaryMetricValue: mongoose.Schema.Types.Mixed,
    score: Number
  },
  
  changes: {
    scoreChange: Number,
    primaryMetricChange: Number,
    trend: {
      type: String,
      enum: ['improving', 'declining', 'stable', 'unknown']
    }
  },
  
  // ==================== ESTADO ====================
  
  isStale: {
    type: Boolean,
    default: false,
    index: true
  },
  
  staleReason: String,
  
  nextCalculationAt: {
    type: Date,
    index: true
  },
  
  lastAccessedAt: {
    type: Date,
    default: Date.now
  },
  
  accessCount: {
    type: Number,
    default: 0
  }
  
}, {
  timestamps: true,
  collection: 'ai_insights'
});

// ==================== ÍNDICES ====================

aiInsightSchema.index(
  { type: 1, periodDays: 1, segmentId: 1, isStale: 1 },
  { name: 'type_period_segment_stale_lookup' }
);

aiInsightSchema.index(
  { nextCalculationAt: 1, isStale: 1 },
  { name: 'recalculation_queue_idx' }
);

// ==================== MÉTODOS ESTÁTICOS ====================

/**
 * Obtener el análisis más reciente de un tipo
 */
aiInsightSchema.statics.getLatest = async function(type, periodDays = 30, segmentId = null) {
  const query = {
    type,
    periodDays,
    isStale: false
  };
  
  if (segmentId) {
    query.segmentId = segmentId;
  } else {
    query.segmentId = null;
  }
  
  const insight = await this.findOne(query)
    .sort({ createdAt: -1 })
    .lean();
  
  if (insight) {
    // Actualizar acceso (fire and forget)
    this.updateOne(
      { _id: insight._id },
      { 
        $set: { lastAccessedAt: new Date() },
        $inc: { accessCount: 1 }
      }
    ).exec();
  }
  
  return insight;
};

/**
 * Guardar nuevo análisis
 */
aiInsightSchema.statics.saveAnalysis = async function(type, periodDays, analysisResult, options = {}) {
  const {
    segmentId = null,
    algorithmVersion = '1.0.0',
    calculationStartTime = new Date(),
    recalculateHours = 6
  } = options;
  
  // Buscar análisis anterior para comparación
  const previousAnalysis = await this.getLatest(type, periodDays, segmentId);
  
  // Preparar datos históricos
  let previousPeriod = null;
  let changes = null;
  
  if (previousAnalysis) {
    previousPeriod = {
      calculatedAt: previousAnalysis.createdAt,
      primaryMetricValue: previousAnalysis.summary?.primaryMetric?.value,
      score: previousAnalysis.summary?.score
    };
    
    const currentScore = analysisResult.summary?.score || analysisResult.health?.score || 0;
    const prevScore = previousAnalysis.summary?.score || 0;
    const scoreChange = currentScore - prevScore;
    
    let trend = 'stable';
    if (scoreChange > 5) trend = 'improving';
    else if (scoreChange < -5) trend = 'declining';
    
    changes = { scoreChange, trend };
  }
  
  // Preparar summary
  const summary = analysisResult.summary || {
    score: analysisResult.health?.score || 0,
    status: analysisResult.success === false ? 'insufficient_data' : 
            (analysisResult.health?.status || 'healthy'),
    insightsCount: analysisResult.topInsights?.length || 0,
    alertsCount: analysisResult.alerts?.length || 0
  };
  
  // Marcar anteriores como stale
  await this.updateMany(
    { type, periodDays, segmentId: segmentId || null, isStale: false },
    { $set: { isStale: true, staleReason: 'Superseded by newer analysis' } }
  );
  
  // Crear nuevo
  const newInsight = await this.create({
    type,
    periodDays,
    segmentId,
    data: analysisResult,
    summary,
    topInsights: analysisResult.topInsights || [],
    alerts: analysisResult.alerts || [],
    dataStats: {
      campaignsAnalyzed: analysisResult.summary?.campaignsAnalyzed || 0,
      emailsAnalyzed: analysisResult.totalEventsAnalyzed || 0,
      dateRangeStart: analysisResult.period?.startDate || analysisResult.period?.start,
      dateRangeEnd: analysisResult.period?.endDate || analysisResult.period?.end
    },
    calculationTime: {
      startedAt: calculationStartTime,
      completedAt: new Date(),
      durationMs: Date.now() - calculationStartTime.getTime()
    },
    algorithmVersion,
    previousPeriod,
    changes,
    isStale: false,
    nextCalculationAt: new Date(Date.now() + recalculateHours * 60 * 60 * 1000)
  });
  
  console.log(`✅ AI Insight saved: ${type} (${periodDays}d) - Score: ${summary.score}`);
  return newInsight;
};

/**
 * Obtener análisis que necesitan recálculo
 */
aiInsightSchema.statics.getDueForRecalculation = async function() {
  return this.find({
    $or: [
      { isStale: true },
      { nextCalculationAt: { $lte: new Date() } }
    ]
  })
  .select('type periodDays segmentId')
  .lean();
};

/**
 * Marcar como stale (forzar recálculo)
 */
aiInsightSchema.statics.invalidate = async function(type = null) {
  const query = type ? { type } : {};
  
  const result = await this.updateMany(
    query,
    { $set: { isStale: true, staleReason: 'Manual invalidation' } }
  );
  
  console.log(`🔄 Invalidated ${result.modifiedCount} AI insights`);
  return result.modifiedCount;
};

/**
 * Obtener historial de scores
 */
aiInsightSchema.statics.getScoreHistory = async function(type, periodDays = 30, limit = 30) {
  return this.find({ type, periodDays, segmentId: null })
    .select('createdAt summary.score summary.status changes.trend')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

/**
 * Dashboard summary
 */
aiInsightSchema.statics.getDashboardSummary = async function() {
  const types = [
    'subject_analysis',
    'send_timing', 
    'list_performance',
    'health_check',
    'ai_generated_insights'  // 🆕 Incluir insights de Claude
  ];
  
  const summary = {};
  
  for (const type of types) {
    const latest = await this.getLatest(type, 30);
    summary[type] = latest ? {
      score: latest.summary?.score,
      status: latest.summary?.status,
      alertsCount: latest.alerts?.length || 0,
      lastCalculated: latest.createdAt,
      trend: latest.changes?.trend,
      ageHours: Math.round((Date.now() - new Date(latest.createdAt).getTime()) / (1000 * 60 * 60))
    } : null;
  }
  
  const scores = Object.values(summary)
    .filter(s => s?.score !== undefined)
    .map(s => s.score);
  
  return {
    globalScore: scores.length > 0 
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) 
      : 0,
    totalAlerts: Object.values(summary).reduce((sum, s) => sum + (s?.alertsCount || 0), 0),
    analyses: summary,
    lastUpdated: new Date()
  };
};

/**
 * Limpiar análisis antiguos
 */
aiInsightSchema.statics.cleanup = async function(daysToKeep = 90) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
  
  // Obtener IDs de los más recientes de cada tipo
  const latestByType = await this.aggregate([
    { $match: { isStale: false } },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: { type: '$type', periodDays: '$periodDays', segmentId: '$segmentId' },
        latestId: { $first: '$_id' }
      }
    }
  ]);
  
  const keepIds = latestByType.map(item => item.latestId);
  
  const result = await this.deleteMany({
    _id: { $nin: keepIds },
    createdAt: { $lt: cutoffDate }
  });
  
  if (result.deletedCount > 0) {
    console.log(`🧹 Cleaned up ${result.deletedCount} old AI insights`);
  }
  
  return result.deletedCount;
};

module.exports = mongoose.model('AIInsight', aiInsightSchema);