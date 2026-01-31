// backend/src/services/smsAnalyticsService.js
// 📊 SMS Analytics Service - Agregaciones y métricas para dashboard

const SmsSubscriber = require('../models/SmsSubscriber');

class SmsAnalyticsService {
  constructor() {
    this.lastInsights = null;
    this.insightsGeneratedAt = null;
  }

  /**
   * Obtener estadísticas agregadas por estado (para mapa USA)
   * @param {number} days - Días hacia atrás (default 30)
   */
  async getSubscribersByState(days = 30) {
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const stateData = await SmsSubscriber.aggregate([
      {
        $match: {
          'location.countryCode': 'US',
          'location.region': { $exists: true, $ne: null },
          createdAt: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: '$location.region',
          subscribers: { $sum: 1 },
          converted: { $sum: { $cond: ['$converted', 1, 0] } },
          revenue: { $sum: { $ifNull: ['$conversionData.orderTotal', 0] } },
          firstConverted: {
            $sum: {
              $cond: [
                { $or: [
                  { $eq: ['$convertedWith', 'first'] },
                  { $and: [{ $eq: ['$converted', true] }, { $eq: ['$convertedWith', null] }] }
                ]},
                1, 0
              ]
            }
          },
          secondConverted: {
            $sum: { $cond: [{ $eq: ['$convertedWith', 'second'] }, 1, 0] }
          },
          cities: { $addToSet: '$location.city' },
          avgLat: { $avg: '$location.lat' },
          avgLng: { $avg: '$location.lng' }
        }
      },
      {
        $project: {
          _id: 0,
          state: '$_id',
          subscribers: 1,
          converted: 1,
          revenue: { $round: ['$revenue', 2] },
          firstConverted: 1,
          secondConverted: 1,
          conversionRate: {
            $cond: [
              { $gt: ['$subscribers', 0] },
              { $round: [{ $multiply: [{ $divide: ['$converted', '$subscribers'] }, 100] }, 1] },
              0
            ]
          },
          topCities: { $slice: [{ $filter: { input: '$cities', cond: { $ne: ['$$this', null] } } }, 5] },
          centroid: {
            lat: '$avgLat',
            lng: '$avgLng'
          }
        }
      },
      { $sort: { subscribers: -1 } }
    ]);

    // Agregar info adicional de los estados
    return stateData.map(state => ({
      ...state,
      stateName: this.getStateName(state.state),
      revenuePerSubscriber: state.subscribers > 0
        ? Math.round((state.revenue / state.subscribers) * 100) / 100
        : 0
    }));
  }

  /**
   * Obtener actividad reciente para feed en tiempo real
   * @param {number} limit - Número de actividades
   * @param {Date|string} since - Obtener actividades desde esta fecha
   */
  async getRecentActivity(limit = 20, since = null) {
    // Usar el método del modelo si está disponible
    if (typeof SmsSubscriber.getRecentActivity === 'function') {
      return SmsSubscriber.getRecentActivity(limit, since);
    }

    // Fallback: implementación manual
    const query = {};
    if (since) {
      query.createdAt = { $gt: new Date(since) };
    }

    const subscribers = await SmsSubscriber.find(query)
      .sort({ createdAt: -1 })
      .limit(limit * 2)
      .select('phone phoneFormatted status createdAt location converted convertedAt convertedWith welcomeSmsAt welcomeSmsStatus secondSmsAt secondSmsStatus conversionData.orderTotal discountCode secondDiscountCode')
      .lean();

    const activities = [];

    for (const sub of subscribers) {
      // Subscription event
      if (sub.createdAt) {
        activities.push({
          id: `sub-${sub._id}`,
          type: 'subscription',
          timestamp: sub.createdAt,
          phone: sub.phoneFormatted || `***${sub.phone?.slice(-4)}`,
          location: sub.location ? {
            city: sub.location.city,
            state: sub.location.region,
            stateName: sub.location.regionName
          } : null,
          data: { status: sub.status }
        });
      }

      // Conversion event
      if (sub.converted && sub.convertedAt) {
        activities.push({
          id: `conv-${sub._id}`,
          type: 'conversion',
          timestamp: sub.convertedAt,
          phone: sub.phoneFormatted || `***${sub.phone?.slice(-4)}`,
          location: sub.location ? {
            city: sub.location.city,
            state: sub.location.region
          } : null,
          data: {
            convertedWith: sub.convertedWith,
            orderTotal: sub.conversionData?.orderTotal,
            discountCode: sub.convertedWith === 'second' ? sub.secondDiscountCode : sub.discountCode
          }
        });
      }
    }

    return activities
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }

  /**
   * Obtener métricas de resumen para dashboard
   * @param {number} days - Período de análisis
   */
  async getDashboardMetrics(days = 30) {
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const previousStartDate = new Date(Date.now() - days * 2 * 24 * 60 * 60 * 1000);

    // Métricas del período actual
    const [currentMetrics] = await SmsSubscriber.aggregate([
      { $match: { createdAt: { $gte: startDate } } },
      {
        $group: {
          _id: null,
          totalSubscribers: { $sum: 1 },
          activeSubscribers: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          totalConverted: { $sum: { $cond: ['$converted', 1, 0] } },
          firstConverted: {
            $sum: {
              $cond: [
                { $or: [
                  { $eq: ['$convertedWith', 'first'] },
                  { $and: [{ $eq: ['$converted', true] }, { $eq: ['$convertedWith', null] }] }
                ]},
                1, 0
              ]
            }
          },
          secondConverted: { $sum: { $cond: [{ $eq: ['$convertedWith', 'second'] }, 1, 0] } },
          totalRevenue: { $sum: { $ifNull: ['$conversionData.orderTotal', 0] } },
          avgOrderValue: { $avg: { $cond: [{ $gt: ['$conversionData.orderTotal', 0] }, '$conversionData.orderTotal', null] } },
          secondSmsSent: { $sum: { $cond: ['$secondSmsSent', 1, 0] } },
          unsubscribed: { $sum: { $cond: [{ $eq: ['$status', 'unsubscribed'] }, 1, 0] } }
        }
      }
    ]);

    // Métricas del período anterior para comparación
    const [previousMetrics] = await SmsSubscriber.aggregate([
      {
        $match: {
          createdAt: { $gte: previousStartDate, $lt: startDate }
        }
      },
      {
        $group: {
          _id: null,
          totalSubscribers: { $sum: 1 },
          totalConverted: { $sum: { $cond: ['$converted', 1, 0] } },
          totalRevenue: { $sum: { $ifNull: ['$conversionData.orderTotal', 0] } }
        }
      }
    ]);

    const current = currentMetrics || {
      totalSubscribers: 0,
      activeSubscribers: 0,
      totalConverted: 0,
      firstConverted: 0,
      secondConverted: 0,
      totalRevenue: 0,
      avgOrderValue: 0,
      secondSmsSent: 0,
      unsubscribed: 0
    };

    const previous = previousMetrics || {
      totalSubscribers: 0,
      totalConverted: 0,
      totalRevenue: 0
    };

    // Calcular cambios porcentuales
    const calcChange = (current, previous) => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return Math.round(((current - previous) / previous) * 100);
    };

    return {
      period: { days, startDate, endDate: new Date() },

      subscribers: {
        total: current.totalSubscribers,
        active: current.activeSubscribers,
        unsubscribed: current.unsubscribed,
        change: calcChange(current.totalSubscribers, previous.totalSubscribers)
      },

      conversions: {
        total: current.totalConverted,
        first: current.firstConverted,
        second: current.secondConverted,
        rate: current.totalSubscribers > 0
          ? Math.round((current.totalConverted / current.totalSubscribers) * 1000) / 10
          : 0,
        change: calcChange(current.totalConverted, previous.totalConverted)
      },

      revenue: {
        total: Math.round(current.totalRevenue * 100) / 100,
        first: 0, // TODO: calcular por separado
        second: 0,
        avgOrderValue: Math.round((current.avgOrderValue || 0) * 100) / 100,
        change: calcChange(current.totalRevenue, previous.totalRevenue)
      },

      secondChance: {
        sent: current.secondSmsSent,
        converted: current.secondConverted,
        recoveryRate: current.secondSmsSent > 0
          ? Math.round((current.secondConverted / current.secondSmsSent) * 1000) / 10
          : 0
      }
    };
  }

  /**
   * Obtener tendencias diarias para gráficos
   * @param {number} days - Número de días
   */
  async getDailyTrends(days = 30) {
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const trends = await SmsSubscriber.aggregate([
      { $match: { createdAt: { $gte: startDate } } },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' }
          },
          subscriptions: { $sum: 1 },
          conversions: { $sum: { $cond: ['$converted', 1, 0] } },
          revenue: { $sum: { $ifNull: ['$conversionData.orderTotal', 0] } },
          firstConversions: {
            $sum: {
              $cond: [
                { $or: [
                  { $eq: ['$convertedWith', 'first'] },
                  { $and: [{ $eq: ['$converted', true] }, { $eq: ['$convertedWith', null] }] }
                ]},
                1, 0
              ]
            }
          },
          secondConversions: { $sum: { $cond: [{ $eq: ['$convertedWith', 'second'] }, 1, 0] } }
        }
      },
      {
        $project: {
          _id: 0,
          date: {
            $dateFromParts: {
              year: '$_id.year',
              month: '$_id.month',
              day: '$_id.day'
            }
          },
          subscriptions: 1,
          conversions: 1,
          revenue: { $round: ['$revenue', 2] },
          firstConversions: 1,
          secondConversions: 1
        }
      },
      { $sort: { date: 1 } }
    ]);

    return trends;
  }

  /**
   * Obtener top estados por diferentes métricas
   * @param {string} metric - 'subscribers', 'conversions', 'revenue'
   * @param {number} limit - Número de resultados
   */
  async getTopStates(metric = 'subscribers', limit = 10) {
    const stateData = await this.getSubscribersByState(30);

    const sortKey = {
      'subscribers': 'subscribers',
      'conversions': 'converted',
      'revenue': 'revenue',
      'conversionRate': 'conversionRate'
    }[metric] || 'subscribers';

    return stateData
      .sort((a, b) => b[sortKey] - a[sortKey])
      .slice(0, limit);
  }

  /**
   * Obtener métricas para un estado específico
   * @param {string} stateCode - Código del estado (ej: 'NJ')
   */
  async getStateDetails(stateCode) {
    const [stateMetrics] = await SmsSubscriber.aggregate([
      {
        $match: {
          'location.region': stateCode.toUpperCase()
        }
      },
      {
        $group: {
          _id: null,
          totalSubscribers: { $sum: 1 },
          converted: { $sum: { $cond: ['$converted', 1, 0] } },
          revenue: { $sum: { $ifNull: ['$conversionData.orderTotal', 0] } },
          cities: { $addToSet: '$location.city' },
          avgTimeToConvert: { $avg: '$timeToConvert' },
          firstConverted: {
            $sum: {
              $cond: [
                { $or: [
                  { $eq: ['$convertedWith', 'first'] },
                  { $and: [{ $eq: ['$converted', true] }, { $eq: ['$convertedWith', null] }] }
                ]},
                1, 0
              ]
            }
          },
          secondConverted: { $sum: { $cond: [{ $eq: ['$convertedWith', 'second'] }, 1, 0] } }
        }
      }
    ]);

    if (!stateMetrics) {
      return null;
    }

    // Recent subscribers from this state
    const recentSubscribers = await SmsSubscriber.find({
      'location.region': stateCode.toUpperCase()
    })
      .sort({ createdAt: -1 })
      .limit(10)
      .select('phoneFormatted location.city createdAt converted convertedWith conversionData.orderTotal')
      .lean();

    return {
      state: stateCode.toUpperCase(),
      stateName: this.getStateName(stateCode),
      ...stateMetrics,
      conversionRate: stateMetrics.totalSubscribers > 0
        ? Math.round((stateMetrics.converted / stateMetrics.totalSubscribers) * 1000) / 10
        : 0,
      topCities: stateMetrics.cities.filter(c => c).slice(0, 10),
      recentSubscribers
    };
  }

  /**
   * Obtener datos para preparar insights de IA
   */
  async prepareAiInsightsData() {
    const [metrics, stateData, trends] = await Promise.all([
      this.getDashboardMetrics(30),
      this.getSubscribersByState(30),
      this.getDailyTrends(14)
    ]);

    // Calcular métricas adicionales para IA
    const topStates = stateData.slice(0, 5);
    const lowPerformingStates = stateData
      .filter(s => s.subscribers >= 5 && s.conversionRate < 5)
      .slice(0, 3);

    // Tendencia de los últimos 7 días vs 7 anteriores
    const last7 = trends.slice(-7);
    const previous7 = trends.slice(-14, -7);

    const weeklySubscriptions = last7.reduce((sum, d) => sum + d.subscriptions, 0);
    const prevWeekSubscriptions = previous7.reduce((sum, d) => sum + d.subscriptions, 0);

    return {
      health: {
        score: this.calculateHealthScore(metrics),
        deliveryRate: 95, // TODO: calcular de webhooks
        conversionRate: metrics.conversions.rate,
        unsubRate: metrics.subscribers.total > 0
          ? Math.round((metrics.subscribers.unsubscribed / metrics.subscribers.total) * 1000) / 10
          : 0,
        totalSubscribers: metrics.subscribers.total,
        totalConverted: metrics.conversions.total,
        totalRevenue: metrics.revenue.total
      },

      funnel: {
        overallConversionRate: `${metrics.conversions.rate}%`,
        firstConversions: metrics.conversions.first,
        firstRevenue: 0, // TODO
        secondConversions: metrics.conversions.second,
        secondRevenue: 0, // TODO
        secondRecoveryRate: `${metrics.secondChance.recoveryRate}%`
      },

      secondChance: {
        sent: metrics.secondChance.sent,
        delivered: metrics.secondChance.sent, // TODO: delivery tracking
        converted: metrics.secondChance.converted,
        revenue: 0, // TODO
        conversionRate: `${metrics.secondChance.recoveryRate}%`,
        roi: '0%', // TODO
        bestHour: '10:00 AM', // TODO: calcular de datos
        eligibleNotSent: 0, // TODO
        potentialRevenue: 0 // TODO
      },

      timing: {
        avgTimeToConvert: 'N/A', // TODO
        fastestConversion: 'N/A',
        distribution: []
      },

      geographic: {
        topStates,
        lowPerformingStates,
        totalStates: stateData.length
      },

      trends: {
        weeklySubscriptions,
        weeklyChange: prevWeekSubscriptions > 0
          ? Math.round(((weeklySubscriptions - prevWeekSubscriptions) / prevWeekSubscriptions) * 100)
          : 0,
        dailyAverage: Math.round(weeklySubscriptions / 7)
      },

      alerts: this.generateAlerts(metrics, stateData)
    };
  }

  /**
   * Calcular health score del SMS marketing
   */
  calculateHealthScore(metrics) {
    let score = 50; // Base

    // Conversion rate (max 25 points)
    if (metrics.conversions.rate >= 15) score += 25;
    else if (metrics.conversions.rate >= 10) score += 20;
    else if (metrics.conversions.rate >= 5) score += 10;

    // Growth (max 15 points)
    if (metrics.subscribers.change > 20) score += 15;
    else if (metrics.subscribers.change > 0) score += 10;
    else if (metrics.subscribers.change > -10) score += 5;

    // Second chance effectiveness (max 10 points)
    if (metrics.secondChance.recoveryRate >= 20) score += 10;
    else if (metrics.secondChance.recoveryRate >= 10) score += 5;

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Generar alertas automáticas
   */
  generateAlerts(metrics, stateData) {
    const alerts = [];

    // Alert: Low conversion rate
    if (metrics.conversions.rate < 5) {
      alerts.push({
        severity: 'warning',
        message: `Conversion rate bajo (${metrics.conversions.rate}%). Considera revisar el copy del SMS o aumentar el descuento.`
      });
    }

    // Alert: Declining subscribers
    if (metrics.subscribers.change < -10) {
      alerts.push({
        severity: 'warning',
        message: `Suscripciones en descenso (${metrics.subscribers.change}% vs período anterior).`
      });
    }

    // Alert: Low second chance recovery
    if (metrics.secondChance.sent > 10 && metrics.secondChance.recoveryRate < 5) {
      alerts.push({
        severity: 'warning',
        message: `Recovery rate bajo (${metrics.secondChance.recoveryRate}%). El Second Chance SMS necesita optimización.`
      });
    }

    return alerts;
  }

  /**
   * Guardar insights generados por IA
   */
  saveAiInsights(insights) {
    this.lastInsights = insights;
    this.insightsGeneratedAt = new Date();
  }

  /**
   * Obtener últimos insights de IA
   */
  getLastAiInsights() {
    return {
      insights: this.lastInsights,
      generatedAt: this.insightsGeneratedAt,
      isStale: this.insightsGeneratedAt
        ? (Date.now() - this.insightsGeneratedAt.getTime()) > 24 * 60 * 60 * 1000
        : true
    };
  }

  /**
   * Helper: Obtener nombre completo del estado
   */
  getStateName(code) {
    const states = {
      'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas',
      'CA': 'California', 'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware',
      'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii', 'ID': 'Idaho',
      'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa', 'KS': 'Kansas',
      'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine', 'MD': 'Maryland',
      'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota', 'MS': 'Mississippi',
      'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada',
      'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico', 'NY': 'New York',
      'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio', 'OK': 'Oklahoma',
      'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island', 'SC': 'South Carolina',
      'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah',
      'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington', 'WV': 'West Virginia',
      'WI': 'Wisconsin', 'WY': 'Wyoming', 'DC': 'District of Columbia'
    };
    return states[code?.toUpperCase()] || code;
  }
}

const smsAnalyticsService = new SmsAnalyticsService();
module.exports = smsAnalyticsService;
