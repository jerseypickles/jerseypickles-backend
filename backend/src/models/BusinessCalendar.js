// backend/src/models/BusinessCalendar.js
// 📅 Business Calendar Model - Objetivos, promociones y eventos del negocio
const mongoose = require('mongoose');

const businessCalendarSchema = new mongoose.Schema({
  // ==================== TIPO DE ENTRADA ====================
  type: {
    type: String,
    enum: [
      'revenue_goal',      // Objetivo de revenue (mensual, semanal, etc.)
      'promotion',         // Promoción planificada
      'event',             // Evento especial (National Pickle Day, BBQ Season)
      'product_launch',    // Lanzamiento de producto
      'campaign_planned',  // Campaña de email planificada
      'blackout_period'    // Período sin envíos (post-holiday fatigue, etc.)
    ],
    required: true,
    index: true
  },
  
  name: {
    type: String,
    required: true
  },
  
  description: String,
  
  // ==================== FECHAS ====================
  startDate: {
    type: Date,
    required: true,
    index: true
  },
  
  endDate: {
    type: Date,
    required: true,
    index: true
  },
  
  // Para eventos de un solo día
  isAllDay: {
    type: Boolean,
    default: true
  },
  
  // ==================== PARA REVENUE GOALS ====================
  revenueGoal: {
    targetAmount: Number,
    currentAmount: { type: Number, default: 0 },
    currency: { type: String, default: 'USD' },
    period: {
      type: String,
      enum: ['daily', 'weekly', 'monthly', 'quarterly', 'custom']
    },
    // Tracking de progreso
    percentComplete: { type: Number, default: 0 },
    isAchieved: { type: Boolean, default: false },
    achievedAt: Date,
    // Desglose por día para tracking
    dailyProgress: [{
      date: Date,
      amount: Number,
      ordersCount: Number
    }]
  },
  
  // ==================== PARA PROMOTIONS ====================
  promotion: {
    discountCode: String,
    discountType: {
      type: String,
      enum: ['percentage', 'fixed_amount', 'free_shipping', 'bogo']
    },
    discountValue: Number,  // 25 para 25% o $25
    minimumPurchase: Number,
    // A quién aplica
    targetLists: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'List'
    }],
    targetAllCustomers: { type: Boolean, default: false },
    // Productos específicos (si aplica)
    targetProducts: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product'
    }],
    targetAllProducts: { type: Boolean, default: true },
    // Expectativas
    expectedRevenue: Number,
    expectedOrders: Number,
    // Resultados reales
    actualRevenue: { type: Number, default: 0 },
    actualOrders: { type: Number, default: 0 },
    redemptionCount: { type: Number, default: 0 }
  },
  
  // ==================== PARA EVENTS ====================
  event: {
    eventType: {
      type: String,
      enum: [
        'national_holiday',    // July 4th, Memorial Day
        'shopping_holiday',    // Black Friday, Cyber Monday
        'brand_event',         // National Pickle Day
        'seasonal',            // BBQ Season, Holiday Season
        'industry_event',      // Food expo, farmers market
        'custom'
      ]
    },
    // Productos relevantes para promocionar
    relatedProducts: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product'
    }],
    // Keywords para detectar en subjects
    keywords: [String],
    // Expectativa de performance
    expectedEngagementLift: Number,  // % esperado de mejora en open rate
    expectedRevenueLift: Number
  },
  
  // ==================== PARA PRODUCT LAUNCH ====================
  productLaunch: {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product'
    },
    shopifyProductId: String,
    productName: String,
    launchType: {
      type: String,
      enum: ['new_product', 'new_flavor', 'seasonal_return', 'limited_edition']
    },
    prelaunchEmailDate: Date,
    targetLists: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'List'
    }],
    expectedFirstWeekSales: Number,
    actualFirstWeekSales: { type: Number, default: 0 }
  },
  
  // ==================== PARA CAMPAIGN PLANNED ====================
  campaignPlanned: {
    campaignType: {
      type: String,
      enum: ['promotional', 'newsletter', 'announcement', 'reengagement', 'seasonal']
    },
    targetLists: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'List'
    }],
    subjectIdeas: [String],
    notes: String,
    // Si ya se creó la campaña
    linkedCampaign: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campaign'
    },
    isExecuted: { type: Boolean, default: false }
  },
  
  // ==================== ESTADO ====================
  status: {
    type: String,
    enum: ['planned', 'active', 'completed', 'cancelled'],
    default: 'planned',
    index: true
  },
  
  // ==================== PRIORIDAD ====================
  priority: {
    type: String,
    enum: ['high', 'medium', 'low'],
    default: 'medium'
  },
  
  // ==================== TAGS ====================
  tags: [String],
  
  // ==================== NOTAS ====================
  notes: String,
  
  // ==================== RECURRENCIA ====================
  isRecurring: {
    type: Boolean,
    default: false
  },
  
  recurrence: {
    frequency: {
      type: String,
      enum: ['daily', 'weekly', 'monthly', 'yearly']
    },
    interval: Number,  // Cada X días/semanas/meses
    endAfterOccurrences: Number,
    endByDate: Date
  },
  
  // ==================== METADATA ====================
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
  
}, {
  timestamps: true,
  collection: 'business_calendar'
});

// ==================== ÍNDICES ====================
businessCalendarSchema.index({ type: 1, status: 1 });
businessCalendarSchema.index({ startDate: 1, endDate: 1 });
businessCalendarSchema.index({ 'revenueGoal.isAchieved': 1 });
businessCalendarSchema.index({ 'promotion.discountCode': 1 });

// ==================== MÉTODOS DE INSTANCIA ====================

/**
 * Verificar si está activo ahora
 */
businessCalendarSchema.methods.isActiveNow = function() {
  const now = new Date();
  return now >= this.startDate && now <= this.endDate && this.status === 'active';
};

/**
 * Calcular días restantes
 */
businessCalendarSchema.methods.getDaysRemaining = function() {
  const now = new Date();
  if (now > this.endDate) return 0;
  return Math.ceil((this.endDate - now) / (1000 * 60 * 60 * 24));
};

/**
 * Actualizar progreso de revenue goal
 */
businessCalendarSchema.methods.updateRevenueProgress = async function(amount, ordersCount = 1) {
  if (this.type !== 'revenue_goal') return this;
  
  this.revenueGoal.currentAmount += amount;
  
  // Agregar al progreso diario
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const todayEntry = this.revenueGoal.dailyProgress.find(
    dp => dp.date.getTime() === today.getTime()
  );
  
  if (todayEntry) {
    todayEntry.amount += amount;
    todayEntry.ordersCount += ordersCount;
  } else {
    this.revenueGoal.dailyProgress.push({
      date: today,
      amount,
      ordersCount
    });
  }
  
  // Calcular porcentaje
  if (this.revenueGoal.targetAmount > 0) {
    this.revenueGoal.percentComplete = Math.min(
      (this.revenueGoal.currentAmount / this.revenueGoal.targetAmount) * 100,
      100
    );
  }
  
  // Verificar si se logró
  if (this.revenueGoal.currentAmount >= this.revenueGoal.targetAmount && !this.revenueGoal.isAchieved) {
    this.revenueGoal.isAchieved = true;
    this.revenueGoal.achievedAt = new Date();
    this.status = 'completed';
  }
  
  return this.save();
};

// ==================== MÉTODOS ESTÁTICOS ====================

/**
 * Obtener el goal de revenue activo para un período
 */
businessCalendarSchema.statics.getActiveRevenueGoal = async function(period = 'monthly') {
  const now = new Date();
  
  return this.findOne({
    type: 'revenue_goal',
    'revenueGoal.period': period,
    startDate: { $lte: now },
    endDate: { $gte: now },
    status: { $in: ['planned', 'active'] }
  }).lean();
};

/**
 * Obtener promociones activas
 */
businessCalendarSchema.statics.getActivePromotions = async function() {
  const now = new Date();
  
  return this.find({
    type: 'promotion',
    startDate: { $lte: now },
    endDate: { $gte: now },
    status: 'active'
  })
  .populate('promotion.targetLists', 'name memberCount')
  .lean();
};

/**
 * Obtener eventos próximos (próximos N días)
 */
businessCalendarSchema.statics.getUpcomingEvents = async function(days = 30) {
  const now = new Date();
  const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  
  return this.find({
    type: 'event',
    startDate: { $gte: now, $lte: future },
    status: { $in: ['planned', 'active'] }
  })
  .sort({ startDate: 1 })
  .lean();
};

/**
 * Obtener todo lo activo ahora (para contexto de AI)
 */
businessCalendarSchema.statics.getCurrentContext = async function() {
  const now = new Date();
  
  const [revenueGoal, promotions, events, productLaunches] = await Promise.all([
    // Revenue goal activo
    this.findOne({
      type: 'revenue_goal',
      startDate: { $lte: now },
      endDate: { $gte: now },
      status: { $in: ['planned', 'active'] }
    }).lean(),
    
    // Promociones activas
    this.find({
      type: 'promotion',
      startDate: { $lte: now },
      endDate: { $gte: now },
      status: 'active'
    }).lean(),
    
    // Eventos activos o próximos (7 días)
    this.find({
      type: 'event',
      startDate: { $lte: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) },
      endDate: { $gte: now },
      status: { $in: ['planned', 'active'] }
    }).lean(),
    
    // Lanzamientos de producto activos
    this.find({
      type: 'product_launch',
      startDate: { $lte: now },
      endDate: { $gte: now },
      status: 'active'
    }).lean()
  ]);
  
  return {
    revenueGoal,
    activePromotions: promotions,
    currentEvents: events,
    productLaunches,
    hasActivePromotion: promotions.length > 0,
    hasUpcomingEvent: events.length > 0
  };
};

/**
 * Crear goal mensual de revenue
 */
businessCalendarSchema.statics.createMonthlyGoal = async function(targetAmount, month = null, year = null) {
  const now = new Date();
  const targetMonth = month !== null ? month : now.getMonth();
  const targetYear = year !== null ? year : now.getFullYear();
  
  const startDate = new Date(targetYear, targetMonth, 1);
  const endDate = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59);
  
  const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
                      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  
  // Verificar si ya existe
  const existing = await this.findOne({
    type: 'revenue_goal',
    'revenueGoal.period': 'monthly',
    startDate: { $gte: startDate },
    endDate: { $lte: endDate }
  });
  
  if (existing) {
    // Actualizar el existente
    existing.revenueGoal.targetAmount = targetAmount;
    return existing.save();
  }
  
  // Crear nuevo
  return this.create({
    type: 'revenue_goal',
    name: `Revenue Goal ${monthNames[targetMonth]} ${targetYear}`,
    description: `Objetivo de revenue para ${monthNames[targetMonth]} ${targetYear}`,
    startDate,
    endDate,
    status: now >= startDate && now <= endDate ? 'active' : 'planned',
    revenueGoal: {
      targetAmount,
      currentAmount: 0,
      period: 'monthly',
      percentComplete: 0,
      isAchieved: false,
      dailyProgress: []
    },
    priority: 'high'
  });
};

/**
 * Crear evento especial
 */
businessCalendarSchema.statics.createEvent = async function(data) {
  const { name, startDate, endDate, eventType, keywords = [], relatedProducts = [] } = data;
  
  return this.create({
    type: 'event',
    name,
    startDate: new Date(startDate),
    endDate: new Date(endDate),
    status: 'planned',
    event: {
      eventType,
      keywords,
      relatedProducts
    }
  });
};

/**
 * Obtener resumen para dashboard
 */
businessCalendarSchema.statics.getDashboardSummary = async function() {
  const now = new Date();
  
  // Goal mensual actual
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  
  const monthlyGoal = await this.findOne({
    type: 'revenue_goal',
    'revenueGoal.period': 'monthly',
    startDate: { $lte: now },
    endDate: { $gte: now }
  }).lean();
  
  // Eventos próximos
  const upcomingEvents = await this.find({
    type: 'event',
    startDate: { $gte: now },
    status: { $in: ['planned', 'active'] }
  })
  .sort({ startDate: 1 })
  .limit(5)
  .lean();
  
  // Promociones activas
  const activePromotions = await this.find({
    type: 'promotion',
    startDate: { $lte: now },
    endDate: { $gte: now },
    status: 'active'
  }).lean();
  
  return {
    monthlyGoal: monthlyGoal ? {
      target: monthlyGoal.revenueGoal.targetAmount,
      current: monthlyGoal.revenueGoal.currentAmount,
      percentComplete: monthlyGoal.revenueGoal.percentComplete,
      daysRemaining: Math.ceil((monthEnd - now) / (1000 * 60 * 60 * 24)),
      dailyNeeded: monthlyGoal.revenueGoal.targetAmount - monthlyGoal.revenueGoal.currentAmount > 0
        ? ((monthlyGoal.revenueGoal.targetAmount - monthlyGoal.revenueGoal.currentAmount) / 
           Math.max(1, Math.ceil((monthEnd - now) / (1000 * 60 * 60 * 24)))).toFixed(2)
        : 0
    } : null,
    upcomingEvents: upcomingEvents.map(e => ({
      name: e.name,
      date: e.startDate,
      type: e.event?.eventType,
      daysUntil: Math.ceil((new Date(e.startDate) - now) / (1000 * 60 * 60 * 24))
    })),
    activePromotions: activePromotions.map(p => ({
      name: p.name,
      code: p.promotion?.discountCode,
      endsIn: Math.ceil((new Date(p.endDate) - now) / (1000 * 60 * 60 * 24)),
      redemptions: p.promotion?.redemptionCount || 0
    }))
  };
};

module.exports = mongoose.model('BusinessCalendar', businessCalendarSchema);