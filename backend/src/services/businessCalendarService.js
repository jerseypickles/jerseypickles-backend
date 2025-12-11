// backend/src/services/businessCalendarService.js
// 📅 Business Calendar Service - Gestión de objetivos y contexto de negocio
// ✅ FIXED: getCurrentGoalProgress ahora sincroniza automáticamente con órdenes
const BusinessCalendar = require('../models/BusinessCalendar');
const mongoose = require('mongoose');

// Helper para obtener modelo Order de forma segura
const getOrderModel = () => {
  try {
    return mongoose.model('Order');
  } catch (e) {
    return null;
  }
};

class BusinessCalendarService {

  // ==================== REVENUE GOALS ====================

  /**
   * Crear o actualizar goal mensual
   */
  async setMonthlyGoal(targetAmount, month = null, year = null) {
    const goal = await BusinessCalendar.createMonthlyGoal(targetAmount, month, year);
    
    // Sincronizar inmediatamente con órdenes existentes
    await this.syncGoalWithOrders();
    
    return goal;
  }

  /**
   * Obtener goal actual y progreso
   * ✅ FIXED: Ahora sincroniza automáticamente con órdenes
   */
  async getCurrentGoalProgress() {
    // Primero sincronizar con órdenes reales
    await this.syncGoalWithOrders();
    
    const goal = await BusinessCalendar.getActiveRevenueGoal('monthly');
    
    if (!goal) {
      return {
        hasGoal: false,
        message: 'No hay objetivo de revenue configurado para este mes'
      };
    }
    
    const now = new Date();
    const daysRemaining = Math.ceil((new Date(goal.endDate) - now) / (1000 * 60 * 60 * 24));
    const daysPassed = Math.ceil((now - new Date(goal.startDate)) / (1000 * 60 * 60 * 24));
    const totalDays = Math.ceil((new Date(goal.endDate) - new Date(goal.startDate)) / (1000 * 60 * 60 * 24));
    
    const remaining = goal.revenueGoal.targetAmount - goal.revenueGoal.currentAmount;
    const dailyNeeded = remaining > 0 ? remaining / Math.max(1, daysRemaining) : 0;
    
    // Calcular si está on track
    const expectedProgress = (daysPassed / totalDays) * goal.revenueGoal.targetAmount;
    const isOnTrack = goal.revenueGoal.currentAmount >= expectedProgress * 0.9; // 90% del esperado
    
    return {
      hasGoal: true,
      name: goal.name,
      target: goal.revenueGoal.targetAmount,
      current: goal.revenueGoal.currentAmount,
      remaining: Math.max(0, remaining),
      percentComplete: parseFloat(goal.revenueGoal.percentComplete.toFixed(1)),
      daysRemaining: Math.max(0, daysRemaining),
      dailyNeeded: parseFloat(dailyNeeded.toFixed(2)),
      isOnTrack,
      isAchieved: goal.revenueGoal.isAchieved,
      status: this.getGoalStatus(goal.revenueGoal.percentComplete, daysPassed, totalDays)
    };
  }

  getGoalStatus(percentComplete, daysPassed, totalDays) {
    const expectedPercent = (daysPassed / totalDays) * 100;
    
    if (percentComplete >= 100) return 'achieved';
    if (percentComplete >= expectedPercent * 0.95) return 'on_track';
    if (percentComplete >= expectedPercent * 0.75) return 'slightly_behind';
    if (percentComplete >= expectedPercent * 0.5) return 'behind';
    return 'critical';
  }

  /**
   * Actualizar progreso del goal con nueva orden
   */
  async recordRevenue(amount, ordersCount = 1) {
    const goal = await BusinessCalendar.findOne({
      type: 'revenue_goal',
      startDate: { $lte: new Date() },
      endDate: { $gte: new Date() },
      status: { $in: ['planned', 'active'] }
    });
    
    if (goal) {
      // Marcar como activo si estaba planned
      if (goal.status === 'planned') {
        goal.status = 'active';
      }
      
      await goal.updateRevenueProgress(amount, ordersCount);
      console.log(`💰 Revenue recorded: $${amount} (Goal: ${goal.revenueGoal.percentComplete.toFixed(1)}%)`);
    }
    
    return goal;
  }

  /**
   * Sincronizar progreso del goal con órdenes reales
   * ✅ FIXED: Usa getOrderModel() para evitar errores de modelo
   */
  async syncGoalWithOrders() {
    const goal = await BusinessCalendar.findOne({
      type: 'revenue_goal',
      startDate: { $lte: new Date() },
      endDate: { $gte: new Date() }
    });
    
    if (!goal) {
      return null;
    }
    
    const Order = getOrderModel();
    if (!Order) {
      console.log('⚠️ Order model not available for sync');
      return goal;
    }
    
    try {
      // Obtener total de órdenes en el período del goal
      const orders = await Order.aggregate([
        {
          $match: {
            orderDate: { $gte: goal.startDate, $lte: goal.endDate },
            financialStatus: { $in: ['paid', 'partially_paid', 'partially_refunded'] }
          }
        },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: '$totalPrice' },
            ordersCount: { $sum: 1 }
          }
        }
      ]);
      
      const totals = orders[0] || { totalRevenue: 0, ordersCount: 0 };
      
      // Actualizar goal
      goal.revenueGoal.currentAmount = totals.totalRevenue;
      goal.revenueGoal.percentComplete = goal.revenueGoal.targetAmount > 0
        ? (totals.totalRevenue / goal.revenueGoal.targetAmount) * 100
        : 0;
      
      if (goal.revenueGoal.currentAmount >= goal.revenueGoal.targetAmount && !goal.revenueGoal.isAchieved) {
        goal.revenueGoal.isAchieved = true;
        goal.revenueGoal.achievedAt = new Date();
      }
      
      goal.status = 'active';
      await goal.save();
      
      console.log(`✅ Goal synced: $${totals.totalRevenue.toFixed(2)} / $${goal.revenueGoal.targetAmount} (${goal.revenueGoal.percentComplete.toFixed(1)}%)`);
      
    } catch (error) {
      console.error('Error syncing goal with orders:', error.message);
    }
    
    return goal;
  }

  // ==================== PROMOTIONS ====================

  /**
   * Crear nueva promoción
   */
  async createPromotion(data) {
    const {
      name,
      startDate,
      endDate,
      discountCode,
      discountType,
      discountValue,
      targetLists = [],
      expectedRevenue = 0
    } = data;
    
    return BusinessCalendar.create({
      type: 'promotion',
      name,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      status: new Date() >= new Date(startDate) ? 'active' : 'planned',
      promotion: {
        discountCode,
        discountType,
        discountValue,
        targetLists,
        expectedRevenue,
        actualRevenue: 0,
        redemptionCount: 0
      }
    });
  }

  /**
   * Registrar uso de código de descuento
   */
  async recordPromoRedemption(discountCode, orderAmount) {
    const promo = await BusinessCalendar.findOne({
      type: 'promotion',
      'promotion.discountCode': discountCode,
      status: 'active'
    });
    
    if (promo) {
      promo.promotion.redemptionCount += 1;
      promo.promotion.actualRevenue += orderAmount;
      await promo.save();
      
      console.log(`🎟️ Promo ${discountCode} redeemed: $${orderAmount}`);
    }
    
    return promo;
  }

  /**
   * Obtener promociones activas
   */
  async getActivePromotions() {
    return BusinessCalendar.getActivePromotions();
  }

  // ==================== EVENTS ====================

  /**
   * Crear evento
   */
  async createEvent(data) {
    return BusinessCalendar.createEvent(data);
  }

  /**
   * Obtener eventos próximos
   */
  async getUpcomingEvents(days = 30) {
    return BusinessCalendar.getUpcomingEvents(days);
  }

  /**
   * Inicializar eventos comunes del año
   */
  async initializeCommonEvents(year = new Date().getFullYear()) {
    const events = [
      {
        name: 'National Pickle Day',
        startDate: `${year}-11-14`,
        endDate: `${year}-11-14`,
        eventType: 'brand_event',
        keywords: ['pickle day', 'national pickle', 'celebrate']
      },
      {
        name: 'Black Friday',
        startDate: this.getNthDayOfMonth(year, 10, 5, 4), // 4th Friday of November
        endDate: this.getNthDayOfMonth(year, 10, 5, 4),
        eventType: 'shopping_holiday',
        keywords: ['black friday', 'bfcm', 'biggest sale']
      },
      {
        name: 'Cyber Monday',
        startDate: this.addDays(this.getNthDayOfMonth(year, 10, 5, 4), 3),
        endDate: this.addDays(this.getNthDayOfMonth(year, 10, 5, 4), 3),
        eventType: 'shopping_holiday',
        keywords: ['cyber monday', 'online deals']
      },
      {
        name: 'Holiday Season',
        startDate: `${year}-12-01`,
        endDate: `${year}-12-25`,
        eventType: 'seasonal',
        keywords: ['holiday', 'christmas', 'gift', 'navidad', 'festive']
      },
      {
        name: 'BBQ Season',
        startDate: `${year}-05-01`,
        endDate: `${year}-09-15`,
        eventType: 'seasonal',
        keywords: ['bbq', 'grill', 'summer', 'cookout', 'picnic']
      },
      {
        name: 'July 4th',
        startDate: `${year}-07-04`,
        endDate: `${year}-07-04`,
        eventType: 'national_holiday',
        keywords: ['july 4', '4th of july', 'independence', 'fourth']
      },
      {
        name: 'Memorial Day',
        startDate: this.getLastDayOfMonth(year, 4, 1), // Last Monday of May
        endDate: this.getLastDayOfMonth(year, 4, 1),
        eventType: 'national_holiday',
        keywords: ['memorial day', 'memorial weekend']
      },
      {
        name: 'Labor Day',
        startDate: this.getNthDayOfMonth(year, 8, 1, 1), // 1st Monday of September
        endDate: this.getNthDayOfMonth(year, 8, 1, 1),
        eventType: 'national_holiday',
        keywords: ['labor day', 'labour day']
      }
    ];
    
    const created = [];
    for (const eventData of events) {
      try {
        // Check if already exists
        const existing = await BusinessCalendar.findOne({
          type: 'event',
          name: eventData.name,
          startDate: new Date(eventData.startDate)
        });
        
        if (!existing) {
          const event = await this.createEvent(eventData);
          created.push(event.name);
        }
      } catch (error) {
        console.log(`⚠️ Error creating event ${eventData.name}:`, error.message);
      }
    }
    
    console.log(`📅 Initialized ${created.length} events for ${year}`);
    return created;
  }

  // Helper: Get Nth weekday of month
  getNthDayOfMonth(year, month, dayOfWeek, n) {
    const date = new Date(year, month, 1);
    let count = 0;
    
    while (count < n) {
      if (date.getDay() === dayOfWeek) count++;
      if (count < n) date.setDate(date.getDate() + 1);
    }
    
    return date.toISOString().split('T')[0];
  }

  // Helper: Get last weekday of month
  getLastDayOfMonth(year, month, dayOfWeek) {
    const date = new Date(year, month + 1, 0); // Last day of month
    
    while (date.getDay() !== dayOfWeek) {
      date.setDate(date.getDate() - 1);
    }
    
    return date.toISOString().split('T')[0];
  }

  // Helper: Add days to date
  addDays(dateStr, days) {
    const date = new Date(dateStr);
    date.setDate(date.getDate() + days);
    return date.toISOString().split('T')[0];
  }

  // ==================== CONTEXTO PARA CLAUDE ====================

  /**
   * Obtener todo el contexto de negocio para Claude
   */
  async getBusinessContextForClaude() {
    const [
      goalProgress,
      activePromotions,
      upcomingEvents,
      dashboardSummary
    ] = await Promise.all([
      this.getCurrentGoalProgress(),
      this.getActivePromotions(),
      this.getUpcomingEvents(14), // Próximos 14 días
      BusinessCalendar.getDashboardSummary()
    ]);
    
    return {
      // Objetivo de revenue
      revenueGoal: goalProgress.hasGoal ? {
        target: `$${goalProgress.target}`,
        current: `$${goalProgress.current}`,
        percentComplete: `${goalProgress.percentComplete}%`,
        remaining: `$${goalProgress.remaining}`,
        daysRemaining: goalProgress.daysRemaining,
        dailyNeeded: `$${goalProgress.dailyNeeded}`,
        status: goalProgress.status,
        isOnTrack: goalProgress.isOnTrack
      } : null,
      
      // Promociones activas
      activePromotions: activePromotions.map(p => ({
        name: p.name,
        code: p.promotion?.discountCode,
        discount: `${p.promotion?.discountValue}${p.promotion?.discountType === 'percentage' ? '%' : ' USD'}`,
        endsIn: `${Math.ceil((new Date(p.endDate) - new Date()) / (1000 * 60 * 60 * 24))} días`,
        redemptions: p.promotion?.redemptionCount || 0,
        revenue: `$${p.promotion?.actualRevenue || 0}`
      })),
      
      // Eventos próximos
      upcomingEvents: upcomingEvents.map(e => ({
        name: e.name,
        date: new Date(e.startDate).toLocaleDateString('es-ES'),
        daysUntil: Math.ceil((new Date(e.startDate) - new Date()) / (1000 * 60 * 60 * 24)),
        type: e.event?.eventType,
        keywords: e.event?.keywords || []
      })),
      
      // Resumen rápido
      summary: {
        hasActiveGoal: goalProgress.hasGoal,
        goalStatus: goalProgress.status,
        activePromotionsCount: activePromotions.length,
        upcomingEventsCount: upcomingEvents.length,
        nextEvent: upcomingEvents[0]?.name || null
      }
    };
  }
}

module.exports = new BusinessCalendarService();