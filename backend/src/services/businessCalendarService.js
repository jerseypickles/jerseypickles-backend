// backend/src/services/businessCalendarService.js
// 📅 Business Calendar Service - Gestión de objetivos y contexto de negocio
// ✅ FIXED: sincroniza goals con órdenes
// ✅ FIXED: output compatible con formatBusinessContextForPrompt()

const BusinessCalendar = require("../models/BusinessCalendar");
const mongoose = require("mongoose");

// Helper para obtener modelo Order de forma segura
const getOrderModel = () => {
  try {
    return mongoose.model("Order");
  } catch (e) {
    return null;
  }
};

class BusinessCalendarService {
  // ==================== REVENUE GOALS ====================

  async setMonthlyGoal(targetAmount, month = null, year = null) {
    const goal = await BusinessCalendar.createMonthlyGoal(targetAmount, month, year);
    await this.syncGoalWithOrders();
    return goal;
  }

  async getCurrentGoalProgress() {
    await this.syncGoalWithOrders();

    const goal = await BusinessCalendar.getActiveRevenueGoal("monthly");

    if (!goal) {
      return {
        hasGoal: false,
        message: "No hay objetivo de revenue configurado para este mes",
      };
    }

    const now = new Date();
    const daysRemaining = Math.ceil((new Date(goal.endDate) - now) / (1000 * 60 * 60 * 24));
    const daysPassed = Math.ceil((now - new Date(goal.startDate)) / (1000 * 60 * 60 * 24));
    const totalDays = Math.ceil((new Date(goal.endDate) - new Date(goal.startDate)) / (1000 * 60 * 60 * 24));

    const remaining = goal.revenueGoal.targetAmount - goal.revenueGoal.currentAmount;
    const dailyNeeded = remaining > 0 ? remaining / Math.max(1, daysRemaining) : 0;

    const expectedProgress = (daysPassed / totalDays) * goal.revenueGoal.targetAmount;
    const isOnTrack = goal.revenueGoal.currentAmount >= expectedProgress * 0.9;

    return {
      hasGoal: true,
      name: goal.name,
      targetAmount: goal.revenueGoal.targetAmount,
      currentAmount: goal.revenueGoal.currentAmount,
      remaining: Math.max(0, remaining),
      percentComplete: parseFloat(goal.revenueGoal.percentComplete.toFixed(1)),
      daysRemaining: Math.max(0, daysRemaining),
      dailyNeeded: parseFloat(dailyNeeded.toFixed(2)),
      isOnTrack,
      isAchieved: goal.revenueGoal.isAchieved,
      status: this.getGoalStatus(goal.revenueGoal.percentComplete, daysPassed, totalDays),
      startDate: goal.startDate,
      endDate: goal.endDate,
    };
  }

  getGoalStatus(percentComplete, daysPassed, totalDays) {
    const expectedPercent = (daysPassed / totalDays) * 100;

    if (percentComplete >= 100) return "achieved";
    if (percentComplete >= expectedPercent * 0.95) return "on_track";
    if (percentComplete >= expectedPercent * 0.75) return "slightly_behind";
    if (percentComplete >= expectedPercent * 0.5) return "behind";
    return "critical";
  }

  async recordRevenue(amount, ordersCount = 1) {
    const goal = await BusinessCalendar.findOne({
      type: "revenue_goal",
      startDate: { $lte: new Date() },
      endDate: { $gte: new Date() },
      status: { $in: ["planned", "active"] },
    });

    if (goal) {
      if (goal.status === "planned") goal.status = "active";
      await goal.updateRevenueProgress(amount, ordersCount);
      console.log(`💰 Revenue recorded: $${amount} (Goal: ${goal.revenueGoal.percentComplete.toFixed(1)}%)`);
    }

    return goal;
  }

  async syncGoalWithOrders() {
    const goal = await BusinessCalendar.findOne({
      type: "revenue_goal",
      startDate: { $lte: new Date() },
      endDate: { $gte: new Date() },
    });

    if (!goal) return null;

    const Order = getOrderModel();
    if (!Order) {
      console.log("⚠️ Order model not available for sync");
      return goal;
    }

    try {
      const orders = await Order.aggregate([
        {
          $match: {
            orderDate: { $gte: goal.startDate, $lte: goal.endDate },
            financialStatus: { $in: ["paid", "partially_paid", "partially_refunded"] },
          },
        },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: "$totalPrice" },
            ordersCount: { $sum: 1 },
          },
        },
      ]);

      const totals = orders[0] || { totalRevenue: 0, ordersCount: 0 };

      goal.revenueGoal.currentAmount = totals.totalRevenue;
      goal.revenueGoal.percentComplete =
        goal.revenueGoal.targetAmount > 0 ? (totals.totalRevenue / goal.revenueGoal.targetAmount) * 100 : 0;

      if (goal.revenueGoal.currentAmount >= goal.revenueGoal.targetAmount && !goal.revenueGoal.isAchieved) {
        goal.revenueGoal.isAchieved = true;
        goal.revenueGoal.achievedAt = new Date();
      }

      goal.status = "active";
      await goal.save();

      console.log(
        `✅ Goal synced: $${totals.totalRevenue.toFixed(2)} / $${goal.revenueGoal.targetAmount} (${goal.revenueGoal.percentComplete.toFixed(1)}%)`
      );
    } catch (error) {
      console.error("Error syncing goal with orders:", error.message);
    }

    return goal;
  }

  // ==================== PROMOTIONS ====================

  async createPromotion(data) {
    const {
      name,
      startDate,
      endDate,
      discountCode,
      discountType,
      discountValue,
      targetLists = [],
      expectedRevenue = 0,
    } = data;

    return BusinessCalendar.create({
      type: "promotion",
      name,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      status: new Date() >= new Date(startDate) ? "active" : "planned",
      promotion: {
        discountCode,
        discountType,
        discountValue,
        targetLists,
        expectedRevenue,
        actualRevenue: 0,
        redemptionCount: 0,
      },
    });
  }

  async recordPromoRedemption(discountCode, orderAmount) {
    const promo = await BusinessCalendar.findOne({
      type: "promotion",
      "promotion.discountCode": discountCode,
      status: "active",
    });

    if (promo) {
      promo.promotion.redemptionCount += 1;
      promo.promotion.actualRevenue += orderAmount;
      await promo.save();

      console.log(`🎟️ Promo ${discountCode} redeemed: $${orderAmount}`);
    }

    return promo;
  }

  async getActivePromotions() {
    return BusinessCalendar.getActivePromotions();
  }

  // ==================== EVENTS ====================

  async createEvent(data) {
    return BusinessCalendar.createEvent(data);
  }

  async getUpcomingEvents(days = 30) {
    return BusinessCalendar.getUpcomingEvents(days);
  }

  async initializeCommonEvents(year = new Date().getFullYear()) {
    const events = [
      {
        name: "National Pickle Day",
        startDate: `${year}-11-14`,
        endDate: `${year}-11-14`,
        eventType: "brand_event",
        keywords: ["pickle day", "national pickle", "celebrate"],
      },
      {
        name: "Black Friday",
        startDate: this.getNthDayOfMonth(year, 10, 5, 4), // 4th Friday of November (Friday=5)
        endDate: this.getNthDayOfMonth(year, 10, 5, 4),
        eventType: "shopping_holiday",
        keywords: ["black friday", "bfcm", "biggest sale"],
      },
      {
        name: "Cyber Monday",
        startDate: this.addDays(this.getNthDayOfMonth(year, 10, 5, 4), 3),
        endDate: this.addDays(this.getNthDayOfMonth(year, 10, 5, 4), 3),
        eventType: "shopping_holiday",
        keywords: ["cyber monday", "online deals"],
      },
      {
        name: "Holiday Season",
        startDate: `${year}-12-01`,
        endDate: `${year}-12-25`,
        eventType: "seasonal",
        keywords: ["holiday", "christmas", "gift", "navidad", "festive"],
      },
      {
        name: "BBQ Season",
        startDate: `${year}-05-01`,
        endDate: `${year}-09-15`,
        eventType: "seasonal",
        keywords: ["bbq", "grill", "summer", "cookout", "picnic"],
      },
      {
        name: "July 4th",
        startDate: `${year}-07-04`,
        endDate: `${year}-07-04`,
        eventType: "national_holiday",
        keywords: ["july 4", "4th of july", "independence", "fourth"],
      },
      {
        name: "Memorial Day",
        startDate: this.getLastDayOfMonth(year, 4, 1), // Last Monday of May (Monday=1)
        endDate: this.getLastDayOfMonth(year, 4, 1),
        eventType: "national_holiday",
        keywords: ["memorial day", "memorial weekend"],
      },
      {
        name: "Labor Day",
        startDate: this.getNthDayOfMonth(year, 8, 1, 1), // 1st Monday of September (Monday=1)
        endDate: this.getNthDayOfMonth(year, 8, 1, 1),
        eventType: "national_holiday",
        keywords: ["labor day", "labour day"],
      },
    ];

    const created = [];
    for (const eventData of events) {
      try {
        const existing = await BusinessCalendar.findOne({
          type: "event",
          name: eventData.name,
          startDate: new Date(eventData.startDate),
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

  getNthDayOfMonth(year, month, dayOfWeek, n) {
    const date = new Date(year, month, 1);
    let count = 0;

    while (count < n) {
      if (date.getDay() === dayOfWeek) count++;
      if (count < n) date.setDate(date.getDate() + 1);
    }
    return date.toISOString().split("T")[0];
  }

  getLastDayOfMonth(year, month, dayOfWeek) {
    const date = new Date(year, month + 1, 0);
    while (date.getDay() !== dayOfWeek) date.setDate(date.getDate() - 1);
    return date.toISOString().split("T")[0];
  }

  addDays(dateStr, days) {
    const date = new Date(dateStr);
    date.setDate(date.getDate() + days);
    return date.toISOString().split("T")[0];
  }

  // ==================== CONTEXTO PARA LLM ====================

  /**
   * ✅ Nuevo: contexto estándar para cualquier LLM (GPT/Claude)
   * Devuelve keys compatibles con formatBusinessContextForPrompt()
   */
  async getBusinessContextForLLM() {
    const [goalProgress, activePromotions, upcomingEvents, dashboardSummary] = await Promise.all([
      this.getCurrentGoalProgress(),
      this.getActivePromotions(),
      this.getUpcomingEvents(14),
      BusinessCalendar.getDashboardSummary?.().catch(() => null),
    ]);

    const now = new Date();

    return {
      // Formato compatible con tu formatter (businessContextService)
      revenueGoal: goalProgress?.hasGoal
        ? {
            hasGoal: true,
            targetAmount: goalProgress.targetAmount,
            currentAmount: goalProgress.currentAmount,
            percentComplete: goalProgress.percentComplete,
            remaining: goalProgress.remaining,
            daysRemaining: goalProgress.daysRemaining,
            dailyNeeded: goalProgress.dailyNeeded,
            status: goalProgress.status,
            isOnTrack: goalProgress.isOnTrack,
          }
        : { hasGoal: false },

      activePromotions: (activePromotions || []).map((p) => {
        const daysRemaining = Math.ceil((new Date(p.endDate) - now) / (1000 * 60 * 60 * 24));
        return {
          name: p.name,
          discountCode: p.promotion?.discountCode,
          discountType: p.promotion?.discountType,
          discountValue: p.promotion?.discountValue,
          daysRemaining: Math.max(0, daysRemaining),
          redemptionCount: p.promotion?.redemptionCount || 0,
          revenueGenerated: p.promotion?.actualRevenue || 0,
          targetLists: p.promotion?.targetLists || [],
        };
      }),

      upcomingEvents: (upcomingEvents || []).map((e) => {
        const daysUntil = Math.ceil((new Date(e.startDate) - now) / (1000 * 60 * 60 * 24));
        return {
          name: e.name,
          date: new Date(e.startDate).toISOString().split("T")[0], // YYYY-MM-DD (mejor para AI)
          daysUntil,
          eventType: e.event?.eventType,
          keywords: e.event?.keywords || [],
        };
      }),

      summary: {
        hasActiveGoal: !!goalProgress?.hasGoal,
        goalStatus: goalProgress?.status || null,
        activePromotionsCount: (activePromotions || []).length,
        upcomingEventsCount: (upcomingEvents || []).length,
        nextEvent: upcomingEvents?.[0]?.name || null,
        dashboardSummary: dashboardSummary || null,
      },
    };
  }

  /**
   * ✅ Alias para no romper tu código actual
   * (si algo sigue llamando getBusinessContextForClaude)
   */
  async getBusinessContextForClaude() {
    return this.getBusinessContextForLLM();
  }
}

module.exports = new BusinessCalendarService();
