// backend/src/services/smsCalculator.js
// 📱 SMS Calculator - Lógica de cálculo de insights para SMS Marketing
// Reemplaza aiCalculator para el nuevo enfoque 100% SMS

const SmsSubscriber = require('../models/SmsSubscriber');
const SmsCampaign = require('../models/SmsCampaign');
const mongoose = require('mongoose');

class SmsCalculator {

  // ==================== HELPERS ====================

  getDateRange(days, endDate = new Date()) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const start = new Date(end);
    start.setDate(start.getDate() - days);
    start.setHours(0, 0, 0, 0);

    return { start, end };
  }

  /**
   * Obtener contexto temporal actual (temporadas importantes para pickles)
   */
  getCurrentSeasonalContext() {
    const now = new Date();
    const month = now.getMonth();
    const day = now.getDate();

    const contexts = [];

    // BBQ Season (Mayo-Sept) - MUY importante para pickles
    if (month >= 4 && month <= 8) {
      contexts.push({ event: 'BBQ Season', type: 'peak_season', priority: 1 });
    }

    // Holiday Season (Nov-Dic)
    if (month === 10 || month === 11) {
      contexts.push({ event: 'Holiday Season', type: 'gift_season', priority: 1 });
    }

    // National Pickle Day (14 de noviembre)
    if (month === 10 && day >= 10 && day <= 18) {
      contexts.push({ event: 'National Pickle Day', type: 'brand_event', priority: 1 });
    }

    // Super Bowl (febrero)
    if (month === 1 && day <= 15) {
      contexts.push({ event: 'Super Bowl', type: 'event', priority: 2 });
    }

    // July 4th
    if (month === 6 && day <= 7) {
      contexts.push({ event: 'July 4th', type: 'holiday', priority: 1 });
    }

    // Memorial Day / Labor Day
    if ((month === 4 && day >= 25) || (month === 8 && day <= 7)) {
      contexts.push({ event: 'Holiday Weekend', type: 'holiday', priority: 2 });
    }

    return contexts.sort((a, b) => a.priority - b.priority);
  }

  // ==================== 1. SMS HEALTH CHECK ====================

  async calculateSmsHealthCheck(options = {}) {
    const { days = 7 } = options;
    const { start: currentStart } = this.getDateRange(days);
    const { start: prevStart } = this.getDateRange(days * 2);

    // Stats actuales
    const currentStats = await SmsSubscriber.aggregate([
      { $match: { createdAt: { $gte: currentStart } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          unsubscribed: { $sum: { $cond: [{ $eq: ['$status', 'unsubscribed'] }, 1, 0] } },
          bounced: { $sum: { $cond: [{ $eq: ['$status', 'bounced'] }, 1, 0] } },

          // Welcome SMS
          welcomeSent: { $sum: { $cond: ['$welcomeSmsSent', 1, 0] } },
          welcomeDelivered: { $sum: { $cond: [{ $eq: ['$welcomeSmsStatus', 'delivered'] }, 1, 0] } },
          welcomeFailed: { $sum: { $cond: [{ $eq: ['$welcomeSmsStatus', 'failed'] }, 1, 0] } },

          // Second SMS
          secondSent: { $sum: { $cond: ['$secondSmsSent', 1, 0] } },
          secondDelivered: { $sum: { $cond: [{ $eq: ['$secondSmsStatus', 'delivered'] }, 1, 0] } },

          // Conversions
          converted: { $sum: { $cond: ['$converted', 1, 0] } },
          convertedFirst: {
            $sum: {
              $cond: [
                { $or: [
                  { $eq: ['$convertedWith', 'first'] },
                  { $and: ['$converted', { $eq: ['$convertedWith', null] }] }
                ]}, 1, 0
              ]
            }
          },
          convertedSecond: { $sum: { $cond: [{ $eq: ['$convertedWith', 'second'] }, 1, 0] } },

          // Revenue
          totalRevenue: { $sum: '$conversionData.orderTotal' }
        }
      }
    ]);

    // Stats período anterior (para comparación)
    const previousStats = await SmsSubscriber.aggregate([
      { $match: { createdAt: { $gte: prevStart, $lt: currentStart } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          converted: { $sum: { $cond: ['$converted', 1, 0] } },
          totalRevenue: { $sum: '$conversionData.orderTotal' }
        }
      }
    ]);

    const current = currentStats[0] || {
      total: 0, active: 0, unsubscribed: 0, bounced: 0,
      welcomeSent: 0, welcomeDelivered: 0, welcomeFailed: 0,
      secondSent: 0, secondDelivered: 0,
      converted: 0, convertedFirst: 0, convertedSecond: 0,
      totalRevenue: 0
    };

    const previous = previousStats[0] || { total: 0, converted: 0, totalRevenue: 0 };

    // Calcular rates
    const rates = {
      deliveryRate: current.welcomeSent > 0
        ? ((current.welcomeDelivered / current.welcomeSent) * 100) : 0,
      failRate: current.welcomeSent > 0
        ? ((current.welcomeFailed / current.welcomeSent) * 100) : 0,
      conversionRate: current.welcomeDelivered > 0
        ? ((current.converted / current.welcomeDelivered) * 100) : 0,
      firstConversionRate: current.welcomeDelivered > 0
        ? ((current.convertedFirst / current.welcomeDelivered) * 100) : 0,
      secondConversionRate: current.secondDelivered > 0
        ? ((current.convertedSecond / current.secondDelivered) * 100) : 0,
      unsubRate: current.total > 0
        ? ((current.unsubscribed / current.total) * 100) : 0,
      revenuePerSubscriber: current.total > 0
        ? (current.totalRevenue / current.total) : 0
    };

    // Comparación con período anterior
    const prevConversionRate = previous.total > 0
      ? ((previous.converted / previous.total) * 100) : 0;

    // Generar alertas
    const alerts = [];

    if (rates.deliveryRate < 90 && current.welcomeSent > 10) {
      alerts.push({
        type: 'delivery_rate',
        severity: rates.deliveryRate < 80 ? 'critical' : 'warning',
        message: `Delivery rate bajo: ${rates.deliveryRate.toFixed(1)}%`,
        action: 'Revisa la calidad de números de teléfono y configuración de Telnyx',
        threshold: 90,
        currentValue: rates.deliveryRate
      });
    }

    if (rates.conversionRate < 5 && current.welcomeDelivered > 20) {
      alerts.push({
        type: 'conversion_rate',
        severity: rates.conversionRate < 3 ? 'critical' : 'warning',
        message: `Conversion rate bajo: ${rates.conversionRate.toFixed(1)}%`,
        action: 'Revisa el copy del SMS y el porcentaje de descuento',
        threshold: 5,
        currentValue: rates.conversionRate
      });
    }

    if (rates.unsubRate > 5) {
      alerts.push({
        type: 'unsub_rate',
        severity: rates.unsubRate > 10 ? 'critical' : 'warning',
        message: `Unsubscribe rate alto: ${rates.unsubRate.toFixed(1)}%`,
        action: 'Reduce la frecuencia de SMS o mejora la relevancia',
        threshold: 5,
        currentValue: rates.unsubRate
      });
    }

    // Calcular health score
    let healthScore = 100;
    if (rates.deliveryRate < 95) healthScore -= 10;
    if (rates.deliveryRate < 90) healthScore -= 15;
    if (rates.conversionRate < 10) healthScore -= 10;
    if (rates.conversionRate < 5) healthScore -= 15;
    if (rates.unsubRate > 3) healthScore -= 10;
    if (rates.unsubRate > 5) healthScore -= 15;
    if (rates.failRate > 5) healthScore -= 10;
    healthScore = Math.max(0, healthScore);

    const status = healthScore >= 80 ? 'healthy' : healthScore >= 60 ? 'warning' : 'critical';

    // Pending second SMS count
    const pendingSecondSms = await SmsSubscriber.countDocuments({
      status: 'active',
      converted: false,
      secondSmsSent: { $ne: true },
      welcomeSmsStatus: 'delivered'
    });

    return {
      success: true,
      period: { days, start: currentStart, end: new Date() },
      health: {
        score: healthScore,
        status,
        message: status === 'healthy' ? '✅ Tu SMS marketing está saludable' :
                 status === 'warning' ? '⚠️ Hay métricas que requieren atención' :
                 '🚨 Problemas críticos detectados'
      },
      summary: {
        score: healthScore,
        status,
        primaryMetric: { name: 'conversionRate', value: rates.conversionRate.toFixed(1) + '%' },
        alertsCount: alerts.length
      },
      metrics: {
        current: {
          subscribers: current.total,
          active: current.active,
          converted: current.converted,
          revenue: current.totalRevenue
        },
        rates: {
          deliveryRate: rates.deliveryRate.toFixed(1),
          conversionRate: rates.conversionRate.toFixed(1),
          firstConversionRate: rates.firstConversionRate.toFixed(1),
          secondConversionRate: rates.secondConversionRate.toFixed(1),
          unsubRate: rates.unsubRate.toFixed(1),
          failRate: rates.failRate.toFixed(1)
        },
        revenue: {
          total: current.totalRevenue.toFixed(2),
          perSubscriber: rates.revenuePerSubscriber.toFixed(2)
        },
        changes: {
          conversionRateChange: (rates.conversionRate - prevConversionRate).toFixed(1),
          revenueChange: previous.totalRevenue > 0
            ? (((current.totalRevenue - previous.totalRevenue) / previous.totalRevenue) * 100).toFixed(1)
            : 'N/A'
        }
      },
      secondChance: {
        sent: current.secondSent,
        delivered: current.secondDelivered,
        converted: current.convertedSecond,
        pending: pendingSecondSms,
        recoveryRate: current.secondDelivered > 0
          ? ((current.convertedSecond / current.secondDelivered) * 100).toFixed(1) + '%'
          : '0%'
      },
      alerts,
      seasonalContext: this.getCurrentSeasonalContext()[0] || null
    };
  }

  // ==================== 2. CONVERSION FUNNEL ANALYSIS ====================

  async calculateConversionFunnel(options = {}) {
    const { days = 30 } = options;
    const { start } = this.getDateRange(days);

    // Funnel completo
    const funnelData = await SmsSubscriber.aggregate([
      { $match: { createdAt: { $gte: start } } },
      {
        $group: {
          _id: null,
          // Stage 1: Suscripciones
          totalSubscribed: { $sum: 1 },

          // Stage 2: Welcome SMS
          welcomeSent: { $sum: { $cond: ['$welcomeSmsSent', 1, 0] } },
          welcomeDelivered: { $sum: { $cond: [{ $eq: ['$welcomeSmsStatus', 'delivered'] }, 1, 0] } },

          // Stage 3: First conversion (15%)
          convertedFirst: {
            $sum: {
              $cond: [
                { $or: [
                  { $eq: ['$convertedWith', 'first'] },
                  { $and: ['$converted', { $not: '$convertedWith' }] }
                ]}, 1, 0
              ]
            }
          },
          revenueFirst: {
            $sum: {
              $cond: [
                { $or: [
                  { $eq: ['$convertedWith', 'first'] },
                  { $and: ['$converted', { $not: '$convertedWith' }] }
                ]},
                '$conversionData.orderTotal', 0
              ]
            }
          },

          // Stage 4: Second SMS sent (to non-converters)
          secondSent: { $sum: { $cond: ['$secondSmsSent', 1, 0] } },
          secondDelivered: { $sum: { $cond: [{ $eq: ['$secondSmsStatus', 'delivered'] }, 1, 0] } },

          // Stage 5: Second conversion (20%)
          convertedSecond: { $sum: { $cond: [{ $eq: ['$convertedWith', 'second'] }, 1, 0] } },
          revenueSecond: {
            $sum: {
              $cond: [{ $eq: ['$convertedWith', 'second'] }, '$conversionData.orderTotal', 0]
            }
          },

          // Totals
          totalConverted: { $sum: { $cond: ['$converted', 1, 0] } },
          totalRevenue: { $sum: '$conversionData.orderTotal' },

          // Time to convert (average)
          avgTimeToConvert: { $avg: '$timeToConvert' }
        }
      }
    ]);

    const data = funnelData[0] || {
      totalSubscribed: 0, welcomeSent: 0, welcomeDelivered: 0,
      convertedFirst: 0, revenueFirst: 0,
      secondSent: 0, secondDelivered: 0,
      convertedSecond: 0, revenueSecond: 0,
      totalConverted: 0, totalRevenue: 0,
      avgTimeToConvert: 0
    };

    // Calcular rates de cada stage
    const funnel = [
      {
        stage: 1,
        name: 'Suscripciones',
        count: data.totalSubscribed,
        rate: 100,
        dropoff: 0
      },
      {
        stage: 2,
        name: 'Welcome SMS Delivered',
        count: data.welcomeDelivered,
        rate: data.totalSubscribed > 0
          ? ((data.welcomeDelivered / data.totalSubscribed) * 100) : 0,
        dropoff: data.totalSubscribed - data.welcomeDelivered
      },
      {
        stage: 3,
        name: 'Conversión 15% OFF',
        count: data.convertedFirst,
        rate: data.welcomeDelivered > 0
          ? ((data.convertedFirst / data.welcomeDelivered) * 100) : 0,
        revenue: data.revenueFirst,
        dropoff: data.welcomeDelivered - data.convertedFirst
      },
      {
        stage: 4,
        name: 'Second Chance Delivered',
        count: data.secondDelivered,
        rate: (data.welcomeDelivered - data.convertedFirst) > 0
          ? ((data.secondDelivered / (data.welcomeDelivered - data.convertedFirst)) * 100) : 0,
        dropoff: (data.welcomeDelivered - data.convertedFirst) - data.secondDelivered
      },
      {
        stage: 5,
        name: 'Recuperación 20% OFF',
        count: data.convertedSecond,
        rate: data.secondDelivered > 0
          ? ((data.convertedSecond / data.secondDelivered) * 100) : 0,
        revenue: data.revenueSecond,
        dropoff: data.secondDelivered - data.convertedSecond
      }
    ];

    // Insights del funnel
    const insights = [];

    // Delivery insight
    if (funnel[1].rate < 95) {
      insights.push({
        priority: 'high',
        insight: `Solo ${funnel[1].rate.toFixed(1)}% de SMS se entregan - hay problemas de delivery`,
        action: 'Verifica la configuración de Telnyx y calidad de números'
      });
    }

    // First conversion insight
    if (funnel[2].rate > 0) {
      insights.push({
        priority: 'medium',
        insight: `El 15% OFF convierte al ${funnel[2].rate.toFixed(1)}% de suscriptores`,
        action: funnel[2].rate < 10 ? 'Considera aumentar el descuento inicial' : 'Buen rate de conversión inicial'
      });
    }

    // Second chance insight
    if (data.secondDelivered > 0 && data.convertedSecond > 0) {
      const recoveryValue = data.revenueSecond;
      const wouldBeLost = data.secondDelivered - data.convertedSecond;
      insights.push({
        priority: 'high',
        insight: `Second Chance SMS recuperó ${data.convertedSecond} clientes y $${recoveryValue.toFixed(0)} en revenue`,
        action: `Sin Second Chance, habrías perdido ${wouldBeLost} oportunidades de venta`
      });
    }

    // Overall conversion
    const overallConversion = data.totalSubscribed > 0
      ? ((data.totalConverted / data.totalSubscribed) * 100) : 0;

    return {
      success: true,
      period: { days, start, end: new Date() },
      summary: {
        totalSubscribers: data.totalSubscribed,
        totalConverted: data.totalConverted,
        totalRevenue: data.totalRevenue,
        overallConversionRate: overallConversion.toFixed(1) + '%',
        avgTimeToConvert: Math.round(data.avgTimeToConvert || 0) + ' minutes',
        score: Math.round(overallConversion * 5),
        status: overallConversion >= 15 ? 'healthy' : overallConversion >= 8 ? 'warning' : 'critical',
        primaryMetric: { name: 'overallConversionRate', value: overallConversion }
      },
      funnel,
      breakdown: {
        first: {
          conversions: data.convertedFirst,
          revenue: data.revenueFirst,
          avgOrderValue: data.convertedFirst > 0
            ? (data.revenueFirst / data.convertedFirst) : 0,
          percentOfTotal: data.totalConverted > 0
            ? ((data.convertedFirst / data.totalConverted) * 100).toFixed(1) + '%' : '0%'
        },
        second: {
          conversions: data.convertedSecond,
          revenue: data.revenueSecond,
          avgOrderValue: data.convertedSecond > 0
            ? (data.revenueSecond / data.convertedSecond) : 0,
          percentOfTotal: data.totalConverted > 0
            ? ((data.convertedSecond / data.totalConverted) * 100).toFixed(1) + '%' : '0%',
          recoveryRate: data.secondDelivered > 0
            ? ((data.convertedSecond / data.secondDelivered) * 100).toFixed(1) + '%' : '0%'
        }
      },
      topInsights: insights
    };
  }

  // ==================== 3. SECOND CHANCE PERFORMANCE ====================

  async calculateSecondChancePerformance(options = {}) {
    const { days = 30 } = options;
    const { start } = this.getDateRange(days);

    // Análisis detallado de Second Chance
    const secondChanceData = await SmsSubscriber.aggregate([
      {
        $match: {
          createdAt: { $gte: start },
          secondSmsSent: true
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          delivered: { $sum: { $cond: [{ $eq: ['$secondSmsStatus', 'delivered'] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ['$secondSmsStatus', 'failed'] }, 1, 0] } },
          converted: { $sum: { $cond: [{ $eq: ['$convertedWith', 'second'] }, 1, 0] } },
          revenue: { $sum: {
            $cond: [{ $eq: ['$convertedWith', 'second'] }, '$conversionData.orderTotal', 0]
          }},
          avgTimeToConvert: {
            $avg: {
              $cond: [{ $eq: ['$convertedWith', 'second'] }, '$timeToConvert', null]
            }
          }
        }
      }
    ]);

    // Análisis por hora del día (cuándo se envía el second SMS)
    const byHour = await SmsSubscriber.aggregate([
      {
        $match: {
          createdAt: { $gte: start },
          secondSmsSent: true,
          secondSmsAt: { $exists: true }
        }
      },
      {
        $group: {
          _id: { $hour: '$secondSmsAt' },
          sent: { $sum: 1 },
          converted: { $sum: { $cond: [{ $eq: ['$convertedWith', 'second'] }, 1, 0] } }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Potencial no capturado (elegibles que no recibieron second SMS)
    const eligibleNotSent = await SmsSubscriber.countDocuments({
      createdAt: { $gte: start },
      status: 'active',
      converted: false,
      secondSmsSent: { $ne: true },
      welcomeSmsStatus: 'delivered',
      welcomeSmsAt: { $lte: new Date(Date.now() - 8 * 60 * 60 * 1000) }
    });

    const data = secondChanceData[0] || {
      total: 0, delivered: 0, failed: 0, converted: 0, revenue: 0, avgTimeToConvert: 0
    };

    const conversionRate = data.delivered > 0
      ? ((data.converted / data.delivered) * 100) : 0;
    const deliveryRate = data.total > 0
      ? ((data.delivered / data.total) * 100) : 0;

    // Encontrar mejor hora para enviar
    const bestHour = byHour.reduce((best, curr) => {
      const rate = curr.sent > 0 ? (curr.converted / curr.sent) : 0;
      const bestRate = best.sent > 0 ? (best.converted / best.sent) : 0;
      return rate > bestRate ? curr : best;
    }, { _id: 0, sent: 0, converted: 0 });

    // ROI estimation (asumiendo ~$0.015 por SMS)
    const smsCost = data.total * 0.015;
    const roi = smsCost > 0 ? (((data.revenue - smsCost) / smsCost) * 100) : 0;

    // Valor potencial perdido
    const avgOrderValue = data.converted > 0 ? (data.revenue / data.converted) : 45; // Default $45
    const potentialLostRevenue = eligibleNotSent * (conversionRate / 100) * avgOrderValue;

    const insights = [];

    if (conversionRate > 15) {
      insights.push({
        priority: 'high',
        type: 'success',
        insight: `¡Excelente! Second Chance está recuperando ${conversionRate.toFixed(1)}% de clientes perdidos`,
        action: 'Mantén esta estrategia funcionando'
      });
    }

    if (eligibleNotSent > 10) {
      insights.push({
        priority: 'critical',
        type: 'warning',
        insight: `Hay ${eligibleNotSent} suscriptores elegibles que NO han recibido Second Chance SMS`,
        action: 'Verifica que el job de Second Chance esté corriendo correctamente',
        potentialRevenue: potentialLostRevenue.toFixed(0)
      });
    }

    if (bestHour._id && bestHour.sent >= 5) {
      insights.push({
        priority: 'medium',
        type: 'optimization',
        insight: `La mejor hora para enviar Second Chance es a las ${bestHour._id}:00`,
        action: 'Considera ajustar el timing del job'
      });
    }

    if (roi > 500) {
      insights.push({
        priority: 'high',
        type: 'success',
        insight: `ROI de Second Chance: ${roi.toFixed(0)}% - Cada $1 en SMS genera $${(roi/100).toFixed(0)}`,
        action: 'Esta estrategia es muy rentable'
      });
    }

    return {
      success: true,
      period: { days, start, end: new Date() },
      summary: {
        sent: data.total,
        delivered: data.delivered,
        converted: data.converted,
        revenue: data.revenue,
        conversionRate: conversionRate.toFixed(1) + '%',
        roi: roi.toFixed(0) + '%',
        score: Math.min(100, Math.round(conversionRate * 4 + (roi > 0 ? 20 : 0))),
        status: conversionRate >= 15 ? 'healthy' : conversionRate >= 8 ? 'warning' : 'critical',
        primaryMetric: { name: 'recoveryRate', value: conversionRate }
      },
      metrics: {
        deliveryRate: deliveryRate.toFixed(1) + '%',
        conversionRate: conversionRate.toFixed(1) + '%',
        avgTimeToConvert: Math.round(data.avgTimeToConvert || 0) + ' minutes',
        avgOrderValue: data.converted > 0 ? (data.revenue / data.converted).toFixed(2) : '0',
        costPerConversion: data.converted > 0 ? (smsCost / data.converted).toFixed(2) : '0',
        revenuePerSms: data.total > 0 ? (data.revenue / data.total).toFixed(2) : '0'
      },
      timing: {
        bestHour: bestHour._id ? `${bestHour._id}:00` : 'Sin datos suficientes',
        bestHourConversionRate: bestHour.sent > 0
          ? ((bestHour.converted / bestHour.sent) * 100).toFixed(1) + '%' : '0%',
        byHour: byHour.map(h => ({
          hour: `${h._id}:00`,
          sent: h.sent,
          converted: h.converted,
          rate: h.sent > 0 ? ((h.converted / h.sent) * 100).toFixed(1) + '%' : '0%'
        }))
      },
      opportunity: {
        eligibleNotSent,
        potentialConversions: Math.round(eligibleNotSent * (conversionRate / 100)),
        potentialRevenue: potentialLostRevenue.toFixed(0)
      },
      financial: {
        totalRevenue: data.revenue.toFixed(2),
        estimatedCost: smsCost.toFixed(2),
        netProfit: (data.revenue - smsCost).toFixed(2),
        roi: roi.toFixed(0) + '%'
      },
      topInsights: insights
    };
  }

  // ==================== 4. TIME TO CONVERT ANALYSIS ====================

  async calculateTimeToConvert(options = {}) {
    const { days = 30 } = options;
    const { start } = this.getDateRange(days);

    // Distribución de tiempo hasta conversión
    const timeData = await SmsSubscriber.aggregate([
      {
        $match: {
          createdAt: { $gte: start },
          converted: true,
          timeToConvert: { $exists: true, $gt: 0 }
        }
      },
      {
        $bucket: {
          groupBy: '$timeToConvert',
          boundaries: [0, 30, 60, 120, 240, 480, 1440, 2880, 10080], // minutos
          default: 'more_than_week',
          output: {
            count: { $sum: 1 },
            revenue: { $sum: '$conversionData.orderTotal' },
            avgOrderValue: { $avg: '$conversionData.orderTotal' }
          }
        }
      }
    ]);

    // Mapear buckets a labels
    const bucketLabels = {
      0: '0-30 min',
      30: '30-60 min',
      60: '1-2 hours',
      120: '2-4 hours',
      240: '4-8 hours',
      480: '8-24 hours',
      1440: '1-2 days',
      2880: '2-7 days',
      'more_than_week': '7+ days'
    };

    const distribution = timeData.map(d => ({
      range: bucketLabels[d._id] || d._id,
      count: d.count,
      revenue: d.revenue,
      avgOrderValue: d.avgOrderValue?.toFixed(2) || 0
    }));

    // Stats generales
    const generalStats = await SmsSubscriber.aggregate([
      {
        $match: {
          createdAt: { $gte: start },
          converted: true,
          timeToConvert: { $exists: true, $gt: 0 }
        }
      },
      {
        $group: {
          _id: null,
          avgTime: { $avg: '$timeToConvert' },
          medianTime: { $avg: '$timeToConvert' }, // Simplificado, idealmente sería mediana real
          minTime: { $min: '$timeToConvert' },
          maxTime: { $max: '$timeToConvert' },
          count: { $sum: 1 }
        }
      }
    ]);

    // Por tipo de conversión (first vs second)
    const byType = await SmsSubscriber.aggregate([
      {
        $match: {
          createdAt: { $gte: start },
          converted: true,
          timeToConvert: { $exists: true, $gt: 0 }
        }
      },
      {
        $group: {
          _id: '$convertedWith',
          avgTime: { $avg: '$timeToConvert' },
          count: { $sum: 1 }
        }
      }
    ]);

    const stats = generalStats[0] || { avgTime: 0, minTime: 0, maxTime: 0, count: 0 };

    // Formatear tiempo
    const formatMinutes = (mins) => {
      if (!mins) return '0 min';
      if (mins < 60) return `${Math.round(mins)} min`;
      if (mins < 1440) return `${(mins / 60).toFixed(1)} hours`;
      return `${(mins / 1440).toFixed(1)} days`;
    };

    const insights = [];

    // Insight de ventana óptima
    const quickConverters = distribution.filter(d =>
      ['0-30 min', '30-60 min', '1-2 hours'].includes(d.range)
    ).reduce((sum, d) => sum + d.count, 0);

    const totalConverters = distribution.reduce((sum, d) => sum + d.count, 0);

    if (totalConverters > 0) {
      const quickPercent = (quickConverters / totalConverters) * 100;
      insights.push({
        priority: 'high',
        insight: `${quickPercent.toFixed(0)}% de las conversiones ocurren en las primeras 2 horas`,
        action: quickPercent > 50
          ? 'La urgencia funciona - mantén mensajes con tiempo limitado'
          : 'Considera agregar más urgencia al mensaje inicial'
      });
    }

    // Insight de Second Chance timing
    const firstAvg = byType.find(t => t._id === 'first' || t._id === null)?.avgTime;
    const secondAvg = byType.find(t => t._id === 'second')?.avgTime;

    if (firstAvg && secondAvg) {
      insights.push({
        priority: 'medium',
        insight: `First SMS convierte en ~${formatMinutes(firstAvg)}, Second SMS en ~${formatMinutes(secondAvg)}`,
        action: 'El Second Chance captura a los que necesitan más tiempo para decidir'
      });
    }

    return {
      success: true,
      period: { days, start, end: new Date() },
      summary: {
        avgTimeToConvert: formatMinutes(stats.avgTime),
        avgTimeMinutes: Math.round(stats.avgTime || 0),
        fastestConversion: formatMinutes(stats.minTime),
        slowestConversion: formatMinutes(stats.maxTime),
        totalConversions: stats.count,
        score: stats.avgTime && stats.avgTime < 240 ? 80 : stats.avgTime < 480 ? 60 : 40,
        status: stats.avgTime < 240 ? 'healthy' : stats.avgTime < 480 ? 'warning' : 'critical',
        primaryMetric: { name: 'avgTimeToConvert', value: stats.avgTime }
      },
      distribution,
      byConversionType: byType.map(t => ({
        type: t._id || 'first (legacy)',
        avgTime: formatMinutes(t.avgTime),
        count: t.count
      })),
      topInsights: insights
    };
  }

  // ==================== 5. SMS CAMPAIGNS PERFORMANCE ====================

  async calculateCampaignPerformance(options = {}) {
    const { days = 30 } = options;
    const { start } = this.getDateRange(days);

    const campaigns = await SmsCampaign.find({
      status: 'sent',
      completedAt: { $gte: start }
    }).sort({ completedAt: -1 }).lean();

    if (campaigns.length === 0) {
      return {
        success: true,
        message: 'No hay campañas SMS enviadas en este período',
        summary: {
          status: 'no_data',
          totalCampaigns: 0,
          score: 0,
          primaryMetric: { name: 'campaigns', value: 0 }
        },
        campaigns: [],
        topInsights: []
      };
    }

    // Calcular stats agregados
    const totals = campaigns.reduce((acc, c) => {
      acc.sent += c.stats?.sent || 0;
      acc.delivered += c.stats?.delivered || 0;
      acc.clicked += c.stats?.clicked || 0;
      acc.converted += c.stats?.converted || 0;
      acc.revenue += c.stats?.totalRevenue || 0;
      acc.cost += c.stats?.totalCost || 0;
      return acc;
    }, { sent: 0, delivered: 0, clicked: 0, converted: 0, revenue: 0, cost: 0 });

    const avgDeliveryRate = totals.sent > 0 ? (totals.delivered / totals.sent) * 100 : 0;
    const avgConversionRate = totals.delivered > 0 ? (totals.converted / totals.delivered) * 100 : 0;
    const overallROI = totals.cost > 0 ? ((totals.revenue - totals.cost) / totals.cost) * 100 : 0;

    // Top campaigns by revenue
    const topByRevenue = [...campaigns]
      .sort((a, b) => (b.stats?.totalRevenue || 0) - (a.stats?.totalRevenue || 0))
      .slice(0, 5)
      .map(c => ({
        name: c.name,
        revenue: c.stats?.totalRevenue || 0,
        conversions: c.stats?.converted || 0,
        conversionRate: c.stats?.delivered > 0
          ? ((c.stats.converted / c.stats.delivered) * 100).toFixed(1) + '%' : '0%'
      }));

    // Top by conversion rate
    const topByConversion = [...campaigns]
      .filter(c => c.stats?.delivered >= 10) // Al menos 10 delivered para ser significativo
      .sort((a, b) => {
        const rateA = a.stats?.delivered > 0 ? a.stats.converted / a.stats.delivered : 0;
        const rateB = b.stats?.delivered > 0 ? b.stats.converted / b.stats.delivered : 0;
        return rateB - rateA;
      })
      .slice(0, 5)
      .map(c => ({
        name: c.name,
        conversionRate: c.stats?.delivered > 0
          ? ((c.stats.converted / c.stats.delivered) * 100).toFixed(1) + '%' : '0%',
        conversions: c.stats?.converted || 0,
        delivered: c.stats?.delivered || 0
      }));

    const insights = [];

    if (topByRevenue[0]) {
      insights.push({
        priority: 'high',
        insight: `"${topByRevenue[0].name}" fue la campaña más rentable con $${topByRevenue[0].revenue.toFixed(0)}`,
        action: 'Analiza qué hizo diferente esta campaña para replicar'
      });
    }

    if (avgConversionRate > 5) {
      insights.push({
        priority: 'medium',
        insight: `Tus campañas SMS tienen ${avgConversionRate.toFixed(1)}% de conversión promedio`,
        action: 'Buen performance - sigue experimentando con copy y timing'
      });
    }

    return {
      success: true,
      period: { days, start, end: new Date() },
      summary: {
        totalCampaigns: campaigns.length,
        totalSent: totals.sent,
        totalDelivered: totals.delivered,
        totalConverted: totals.converted,
        totalRevenue: totals.revenue.toFixed(2),
        avgDeliveryRate: avgDeliveryRate.toFixed(1) + '%',
        avgConversionRate: avgConversionRate.toFixed(1) + '%',
        overallROI: overallROI.toFixed(0) + '%',
        score: Math.min(100, Math.round(avgConversionRate * 10 + (overallROI > 0 ? 20 : 0))),
        status: avgConversionRate >= 5 ? 'healthy' : avgConversionRate >= 2 ? 'warning' : 'critical',
        primaryMetric: { name: 'avgConversionRate', value: avgConversionRate }
      },
      rankings: {
        byRevenue: topByRevenue,
        byConversionRate: topByConversion
      },
      recentCampaigns: campaigns.slice(0, 10).map(c => ({
        name: c.name,
        sentAt: c.completedAt,
        audienceType: c.audienceType,
        stats: {
          sent: c.stats?.sent || 0,
          delivered: c.stats?.delivered || 0,
          converted: c.stats?.converted || 0,
          revenue: c.stats?.totalRevenue || 0
        }
      })),
      topInsights: insights
    };
  }

  // ==================== 6. PREPARE DATA FOR CLAUDE ====================

  async prepareDataForClaude(analysisResults) {
    const {
      healthCheck,
      conversionFunnel,
      secondChancePerformance,
      timeToConvert,
      campaignPerformance
    } = analysisResults;

    const seasonalContext = this.getCurrentSeasonalContext();

    return {
      period: 'últimos 30 días',
      generatedAt: new Date().toISOString(),
      seasonalContext: seasonalContext[0] || null,

      // Health metrics
      health: {
        score: healthCheck?.health?.score || 0,
        status: healthCheck?.health?.status || 'unknown',
        deliveryRate: healthCheck?.metrics?.rates?.deliveryRate || '0',
        conversionRate: healthCheck?.metrics?.rates?.conversionRate || '0',
        unsubRate: healthCheck?.metrics?.rates?.unsubRate || '0',
        totalSubscribers: healthCheck?.metrics?.current?.subscribers || 0,
        totalConverted: healthCheck?.metrics?.current?.converted || 0,
        totalRevenue: healthCheck?.metrics?.current?.revenue || 0
      },

      // Funnel data
      funnel: {
        overallConversionRate: conversionFunnel?.summary?.overallConversionRate || '0%',
        firstConversions: conversionFunnel?.breakdown?.first?.conversions || 0,
        firstRevenue: conversionFunnel?.breakdown?.first?.revenue || 0,
        secondConversions: conversionFunnel?.breakdown?.second?.conversions || 0,
        secondRevenue: conversionFunnel?.breakdown?.second?.revenue || 0,
        secondRecoveryRate: conversionFunnel?.breakdown?.second?.recoveryRate || '0%'
      },

      // Second Chance specific
      secondChance: {
        sent: secondChancePerformance?.summary?.sent || 0,
        delivered: secondChancePerformance?.summary?.delivered || 0,
        converted: secondChancePerformance?.summary?.converted || 0,
        revenue: secondChancePerformance?.summary?.revenue || 0,
        conversionRate: secondChancePerformance?.summary?.conversionRate || '0%',
        roi: secondChancePerformance?.summary?.roi || '0%',
        eligibleNotSent: secondChancePerformance?.opportunity?.eligibleNotSent || 0,
        potentialRevenue: secondChancePerformance?.opportunity?.potentialRevenue || '0',
        bestHour: secondChancePerformance?.timing?.bestHour || 'N/A'
      },

      // Time to convert
      timing: {
        avgTimeToConvert: timeToConvert?.summary?.avgTimeToConvert || 'N/A',
        fastestConversion: timeToConvert?.summary?.fastestConversion || 'N/A',
        distribution: timeToConvert?.distribution?.slice(0, 5) || []
      },

      // Campaigns (if any)
      campaigns: {
        total: campaignPerformance?.summary?.totalCampaigns || 0,
        avgConversionRate: campaignPerformance?.summary?.avgConversionRate || '0%',
        totalRevenue: campaignPerformance?.summary?.totalRevenue || '0',
        topCampaign: campaignPerformance?.rankings?.byRevenue?.[0] || null
      },

      // Alerts
      alerts: healthCheck?.alerts || []
    };
  }

  // ==================== 7. COMPREHENSIVE SMS REPORT ====================

  async calculateComprehensiveReport(options = {}) {
    const { days = 30 } = options;

    const [healthCheck, conversionFunnel, secondChancePerformance, timeToConvert, campaignPerformance] =
      await Promise.all([
        this.calculateSmsHealthCheck({ days: 7 }),
        this.calculateConversionFunnel({ days }),
        this.calculateSecondChancePerformance({ days }),
        this.calculateTimeToConvert({ days }),
        this.calculateCampaignPerformance({ days })
      ]);

    // Consolidar top insights
    const allInsights = [];

    if (healthCheck.alerts) {
      healthCheck.alerts.slice(0, 2).forEach(alert => {
        allInsights.push({
          category: 'Health',
          priority: alert.severity === 'critical' ? 'high' : 'medium',
          insight: alert.message,
          action: alert.action
        });
      });
    }

    if (secondChancePerformance.topInsights) {
      secondChancePerformance.topInsights.slice(0, 2).forEach(i => {
        allInsights.push({ ...i, category: 'Second Chance' });
      });
    }

    if (conversionFunnel.topInsights) {
      conversionFunnel.topInsights.slice(0, 2).forEach(i => {
        allInsights.push({ ...i, category: 'Funnel' });
      });
    }

    if (timeToConvert.topInsights) {
      timeToConvert.topInsights.slice(0, 1).forEach(i => {
        allInsights.push({ ...i, category: 'Timing' });
      });
    }

    // Sort by priority
    const priorityOrder = { high: 0, critical: 0, medium: 1, low: 2 };
    allInsights.sort((a, b) => (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2));

    return {
      success: true,
      generatedAt: new Date().toISOString(),
      period: { days },
      seasonalContext: this.getCurrentSeasonalContext()[0] || null,
      summary: {
        healthScore: healthCheck.health?.score || 0,
        healthStatus: healthCheck.health?.status || 'unknown',
        totalSubscribers: healthCheck.metrics?.current?.subscribers || 0,
        totalConverted: healthCheck.metrics?.current?.converted || 0,
        totalRevenue: healthCheck.metrics?.current?.revenue || 0,
        overallConversionRate: conversionFunnel.summary?.overallConversionRate || '0%',
        secondChanceROI: secondChancePerformance.summary?.roi || '0%',
        topInsightsCount: allInsights.length,
        score: healthCheck.health?.score || 0,
        status: healthCheck.health?.status || 'unknown',
        primaryMetric: { name: 'conversionRate', value: conversionFunnel.summary?.overallConversionRate }
      },
      topInsights: allInsights.slice(0, 8),
      alerts: healthCheck.alerts || [],
      details: {
        health: {
          score: healthCheck.health?.score,
          status: healthCheck.health?.status,
          deliveryRate: healthCheck.metrics?.rates?.deliveryRate,
          conversionRate: healthCheck.metrics?.rates?.conversionRate
        },
        secondChance: {
          conversionRate: secondChancePerformance.summary?.conversionRate,
          roi: secondChancePerformance.summary?.roi,
          pendingOpportunities: secondChancePerformance.opportunity?.eligibleNotSent
        },
        timing: {
          avgTimeToConvert: timeToConvert.summary?.avgTimeToConvert,
          bestHour: secondChancePerformance.timing?.bestHour
        },
        campaigns: {
          total: campaignPerformance.summary?.totalCampaigns,
          topByRevenue: campaignPerformance.rankings?.byRevenue?.slice(0, 3)
        }
      }
    };
  }

  // ==================== 8. ENGAGEMENT HEATMAP ====================

  async calculateEngagementHeatmap(options = {}) {
    const { days = 30, metric = 'clicks' } = options;
    const { start } = this.getDateRange(days);

    // Obtener datos de SmsMessage para campañas
    const SmsMessage = require('../models/SmsMessage');

    // Aggregar por hora y día de la semana
    const heatmapData = await SmsMessage.aggregate([
      {
        $match: {
          sentAt: { $gte: start },
          status: 'delivered'
        }
      },
      {
        $project: {
          hour: { $hour: '$sentAt' },
          dayOfWeek: { $dayOfWeek: '$sentAt' }, // 1=Sunday, 7=Saturday
          clicked: { $cond: ['$clicked', 1, 0] },
          converted: { $cond: ['$converted', 1, 0] }
        }
      },
      {
        $group: {
          _id: { hour: '$hour', day: '$dayOfWeek' },
          total: { $sum: 1 },
          clicks: { $sum: '$clicked' },
          conversions: { $sum: '$converted' }
        }
      },
      { $sort: { '_id.day': 1, '_id.hour': 1 } }
    ]);

    // También analizar datos de conversión de Welcome SMS por hora
    const welcomeHeatmap = await SmsSubscriber.aggregate([
      {
        $match: {
          createdAt: { $gte: start },
          welcomeSmsAt: { $exists: true },
          converted: true
        }
      },
      {
        $project: {
          hour: { $hour: '$welcomeSmsAt' },
          dayOfWeek: { $dayOfWeek: '$welcomeSmsAt' }
        }
      },
      {
        $group: {
          _id: { hour: '$hour', day: '$dayOfWeek' },
          conversions: { $sum: 1 }
        }
      }
    ]);

    // Crear matriz 7x24 (días x horas)
    const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const matrix = [];

    for (let day = 1; day <= 7; day++) {
      const dayData = {
        day: dayNames[day - 1],
        dayIndex: day,
        hours: []
      };

      for (let hour = 0; hour < 24; hour++) {
        const campaignData = heatmapData.find(d => d._id.day === day && d._id.hour === hour);
        const welcomeData = welcomeHeatmap.find(d => d._id.day === day && d._id.hour === hour);

        const total = (campaignData?.total || 0);
        const clicks = (campaignData?.clicks || 0);
        const conversions = (campaignData?.conversions || 0) + (welcomeData?.conversions || 0);

        // Calcular engagement rate basado en métrica seleccionada
        let rate = 0;
        if (metric === 'clicks' && total > 0) {
          rate = (clicks / total) * 100;
        } else if (metric === 'conversions' && total > 0) {
          rate = (conversions / total) * 100;
        }

        dayData.hours.push({
          hour,
          hourLabel: `${hour}:00`,
          total,
          clicks,
          conversions,
          rate: rate.toFixed(1),
          intensity: this.getIntensityLevel(rate)
        });
      }

      matrix.push(dayData);
    }

    // Encontrar top 5 mejores horarios
    const allSlots = [];
    matrix.forEach(day => {
      day.hours.forEach(h => {
        if (h.total >= 5) { // Mínimo 5 mensajes para ser significativo
          allSlots.push({
            day: day.day,
            hour: h.hourLabel,
            rate: parseFloat(h.rate),
            total: h.total,
            clicks: h.clicks,
            conversions: h.conversions
          });
        }
      });
    });

    allSlots.sort((a, b) => b.rate - a.rate);
    const top5 = allSlots.slice(0, 5);

    // Generar recomendación
    let recommendation = 'Sin datos suficientes para recomendación.';
    if (top5.length > 0) {
      const best = top5[0];
      recommendation = `Mejor momento para enviar SMS: ${best.day} a las ${best.hour} con ${best.rate}% de ${metric === 'clicks' ? 'clicks' : 'conversiones'}.`;
    }

    // Encontrar peor horario
    const bottom5 = allSlots.filter(s => s.total >= 5).sort((a, b) => a.rate - b.rate).slice(0, 5);

    return {
      success: true,
      period: { days, start, end: new Date() },
      metric,
      summary: {
        totalMessages: allSlots.reduce((sum, s) => sum + s.total, 0),
        totalClicks: allSlots.reduce((sum, s) => sum + s.clicks, 0),
        totalConversions: allSlots.reduce((sum, s) => sum + s.conversions, 0),
        avgRate: allSlots.length > 0
          ? (allSlots.reduce((sum, s) => sum + s.rate, 0) / allSlots.length).toFixed(1) + '%'
          : '0%'
      },
      heatmap: matrix,
      topHours: top5,
      worstHours: bottom5,
      recommendation,
      insights: this.generateHeatmapInsights(top5, bottom5, metric)
    };
  }

  getIntensityLevel(rate) {
    if (rate >= 15) return 'very_high';
    if (rate >= 10) return 'high';
    if (rate >= 5) return 'medium';
    if (rate >= 2) return 'low';
    return 'very_low';
  }

  generateHeatmapInsights(top5, bottom5, metric) {
    const insights = [];

    if (top5.length > 0) {
      // Patrón de días
      const topDays = [...new Set(top5.map(t => t.day))];
      if (topDays.length <= 2) {
        insights.push({
          priority: 'high',
          insight: `Los mejores días para enviar son: ${topDays.join(' y ')}`,
          action: 'Concentra tus campañas en estos días'
        });
      }

      // Patrón de horas
      const topHours = top5.map(t => parseInt(t.hour.split(':')[0]));
      const avgHour = Math.round(topHours.reduce((a, b) => a + b, 0) / topHours.length);
      if (avgHour >= 9 && avgHour <= 11) {
        insights.push({
          priority: 'medium',
          insight: 'Las mañanas (9-11 AM) tienen mejor engagement',
          action: 'Programa tus SMS para las mañanas'
        });
      } else if (avgHour >= 12 && avgHour <= 14) {
        insights.push({
          priority: 'medium',
          insight: 'El horario de almuerzo tiene buen engagement',
          action: 'Aprovecha el horario de almuerzo (12-2 PM)'
        });
      }
    }

    if (bottom5.length > 0) {
      const worstHours = bottom5.map(t => parseInt(t.hour.split(':')[0]));
      if (worstHours.some(h => h >= 22 || h <= 6)) {
        insights.push({
          priority: 'warning',
          insight: 'Las horas nocturnas (10PM-6AM) tienen bajo engagement',
          action: 'Evita enviar SMS en horario nocturno'
        });
      }
    }

    return insights;
  }

  // ==================== 9. ANALYZE SMS MESSAGES ====================

  async analyzeSmsMessages(options = {}) {
    const { days = 30 } = options;
    const { start } = this.getDateRange(days);

    // Obtener campañas SMS enviadas
    const campaigns = await SmsCampaign.find({
      status: 'sent',
      completedAt: { $gte: start }
    }).sort({ completedAt: -1 }).lean();

    if (campaigns.length === 0) {
      return {
        success: true,
        message: 'No hay campañas SMS enviadas en este período',
        analyses: [],
        insights: []
      };
    }

    // Analizar cada mensaje
    const analyses = campaigns.map(campaign => {
      const message = campaign.message || '';
      const stats = campaign.stats || {};

      // Características del mensaje
      const hasEmoji = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/u.test(message);
      const hasDiscount = /\d+%|off|descuento|ahorra/i.test(message);
      const hasUrgency = /hoy|ahora|última|expira|limitado|solo|quick/i.test(message);
      const hasCTA = /shop|compra|visita|click|usa|código/i.test(message);
      const hasPersonalization = /\{name\}|\{first_name\}/i.test(message);
      const charCount = message.length;
      const segments = campaign.segments || Math.ceil(charCount / 160);

      // Calcular click rate
      const clickRate = stats.delivered > 0
        ? ((stats.clicked || 0) / stats.delivered) * 100
        : 0;
      const conversionRate = stats.delivered > 0
        ? ((stats.converted || 0) / stats.delivered) * 100
        : 0;

      return {
        campaignId: campaign._id,
        name: campaign.name,
        message: message.substring(0, 100) + (message.length > 100 ? '...' : ''),
        fullMessage: message,
        sentAt: campaign.completedAt,
        characteristics: {
          charCount,
          segments,
          hasEmoji,
          hasDiscount,
          hasUrgency,
          hasCTA,
          hasPersonalization
        },
        performance: {
          sent: stats.sent || 0,
          delivered: stats.delivered || 0,
          clicked: stats.clicked || 0,
          converted: stats.converted || 0,
          clickRate: clickRate.toFixed(2),
          conversionRate: conversionRate.toFixed(2),
          revenue: stats.totalRevenue || 0
        },
        score: this.calculateMessageScore({
          charCount, hasEmoji, hasDiscount, hasUrgency, hasCTA, clickRate
        })
      };
    });

    // Ordenar por click rate
    analyses.sort((a, b) => parseFloat(b.performance.clickRate) - parseFloat(a.performance.clickRate));

    // Generar insights generales
    const insights = this.generateMessageInsights(analyses);

    // Estadísticas agregadas
    const withEmoji = analyses.filter(a => a.characteristics.hasEmoji);
    const withoutEmoji = analyses.filter(a => !a.characteristics.hasEmoji);
    const withUrgency = analyses.filter(a => a.characteristics.hasUrgency);
    const withDiscount = analyses.filter(a => a.characteristics.hasDiscount);

    const avgClickRate = (arr) => arr.length > 0
      ? arr.reduce((sum, a) => sum + parseFloat(a.performance.clickRate), 0) / arr.length
      : 0;

    const patterns = {
      emoji: {
        withEmoji: {
          count: withEmoji.length,
          avgClickRate: avgClickRate(withEmoji).toFixed(2) + '%'
        },
        withoutEmoji: {
          count: withoutEmoji.length,
          avgClickRate: avgClickRate(withoutEmoji).toFixed(2) + '%'
        },
        recommendation: avgClickRate(withEmoji) > avgClickRate(withoutEmoji)
          ? 'Los emojis mejoran el click rate'
          : 'Los emojis no muestran mejora significativa'
      },
      urgency: {
        withUrgency: {
          count: withUrgency.length,
          avgClickRate: avgClickRate(withUrgency).toFixed(2) + '%'
        },
        recommendation: avgClickRate(withUrgency) > avgClickRate(analyses) * 1.1
          ? 'La urgencia aumenta clicks significativamente'
          : 'La urgencia no muestra mejora significativa'
      },
      discount: {
        withDiscount: {
          count: withDiscount.length,
          avgClickRate: avgClickRate(withDiscount).toFixed(2) + '%'
        }
      },
      length: {
        short: analyses.filter(a => a.characteristics.charCount <= 100).length,
        medium: analyses.filter(a => a.characteristics.charCount > 100 && a.characteristics.charCount <= 160).length,
        long: analyses.filter(a => a.characteristics.charCount > 160).length,
        recommendation: 'Mantén los mensajes bajo 160 caracteres para evitar segmentación'
      }
    };

    return {
      success: true,
      period: { days, start, end: new Date() },
      summary: {
        totalCampaigns: analyses.length,
        avgClickRate: avgClickRate(analyses).toFixed(2) + '%',
        avgConversionRate: (analyses.reduce((sum, a) => sum + parseFloat(a.performance.conversionRate), 0) / analyses.length).toFixed(2) + '%',
        totalRevenue: analyses.reduce((sum, a) => sum + a.performance.revenue, 0).toFixed(2),
        topPerformer: analyses[0]?.name || 'N/A'
      },
      analyses: analyses.slice(0, 20), // Top 20
      patterns,
      insights
    };
  }

  calculateMessageScore(data) {
    let score = 50; // Base score

    // Longitud óptima
    if (data.charCount <= 160) score += 10;
    else if (data.charCount <= 306) score += 5;
    else score -= 5;

    // Características positivas
    if (data.hasEmoji) score += 8;
    if (data.hasDiscount) score += 12;
    if (data.hasUrgency) score += 10;
    if (data.hasCTA) score += 10;

    // Ajustar por performance real si está disponible
    if (data.clickRate > 10) score += 15;
    else if (data.clickRate > 5) score += 8;
    else if (data.clickRate < 2) score -= 10;

    return Math.min(100, Math.max(0, score));
  }

  generateMessageInsights(analyses) {
    const insights = [];

    if (analyses.length === 0) return insights;

    // Top performer
    const top = analyses[0];
    if (top) {
      const traits = [];
      if (top.characteristics.hasEmoji) traits.push('emoji');
      if (top.characteristics.hasUrgency) traits.push('urgencia');
      if (top.characteristics.hasDiscount) traits.push('descuento');

      insights.push({
        priority: 'high',
        category: 'top_performer',
        insight: `"${top.name}" tuvo el mejor click rate (${top.performance.clickRate}%)`,
        action: traits.length > 0
          ? `Usa estos elementos: ${traits.join(', ')}`
          : 'Analiza qué hizo diferente este mensaje'
      });
    }

    // Worst performer
    const worst = analyses[analyses.length - 1];
    if (worst && parseFloat(worst.performance.clickRate) < 2) {
      insights.push({
        priority: 'warning',
        category: 'worst_performer',
        insight: `"${worst.name}" tuvo bajo click rate (${worst.performance.clickRate}%)`,
        action: 'Evita mensajes similares en el futuro'
      });
    }

    // Longitud
    const longMessages = analyses.filter(a => a.characteristics.charCount > 160);
    if (longMessages.length > analyses.length * 0.3) {
      insights.push({
        priority: 'medium',
        category: 'length',
        insight: `${longMessages.length} de ${analyses.length} mensajes exceden 160 caracteres`,
        action: 'Los mensajes cortos tienen mejor engagement'
      });
    }

    return insights;
  }

  // ==================== 10. PREDICT CAMPAIGN PERFORMANCE ====================

  async predictCampaignPerformance(campaignData, options = {}) {
    const { useAI = false } = options;
    const message = campaignData.message || '';

    // Análisis del mensaje
    const characteristics = {
      charCount: message.length,
      segments: Math.ceil(message.length / 160),
      hasEmoji: /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/u.test(message),
      hasDiscount: /\d+%|off|descuento/i.test(message),
      hasUrgency: /hoy|ahora|última|expira|limitado/i.test(message),
      hasCTA: /shop|compra|visita|click|usa/i.test(message),
      hasLink: /http|www|\.com/i.test(message)
    };

    // Obtener stats históricos
    const historicalStats = await this.getHistoricalCampaignStats();

    // Calcular score del mensaje
    let messageScore = 50;

    // Longitud (≤160 chars = +5%)
    if (characteristics.charCount <= 160) messageScore += 10;
    else if (characteristics.charCount > 306) messageScore -= 5;

    // Emojis (+3%)
    if (characteristics.hasEmoji) messageScore += 6;

    // Ofertas/descuentos (+8%)
    if (characteristics.hasDiscount) messageScore += 16;

    // Urgencia (+5%)
    if (characteristics.hasUrgency) messageScore += 10;

    // Call-to-action (+4%)
    if (characteristics.hasCTA) messageScore += 8;

    messageScore = Math.min(100, Math.max(0, messageScore));

    // Predecir tasas basadas en score y datos históricos
    const baseDeliveryRate = historicalStats.avgDeliveryRate || 95;
    const baseClickRate = historicalStats.avgClickRate || 5;
    const baseConversionRate = historicalStats.avgConversionRate || 8;

    // Ajustar predicciones basadas en score
    const scoreFactor = messageScore / 70; // 70 es el score "promedio"

    const predictions = {
      deliveryRate: {
        min: Math.max(85, baseDeliveryRate - 3),
        max: Math.min(99, baseDeliveryRate + 2),
        expected: baseDeliveryRate.toFixed(1)
      },
      clickRate: {
        min: Math.max(1, (baseClickRate * scoreFactor * 0.7)).toFixed(1),
        max: Math.min(20, (baseClickRate * scoreFactor * 1.4)).toFixed(1),
        expected: (baseClickRate * scoreFactor).toFixed(1)
      },
      conversionRate: {
        min: Math.max(2, (baseConversionRate * scoreFactor * 0.7)).toFixed(1),
        max: Math.min(25, (baseConversionRate * scoreFactor * 1.5)).toFixed(1),
        expected: (baseConversionRate * scoreFactor).toFixed(1)
      }
    };

    // Estimar revenue si hay audiencia
    const estimatedAudience = campaignData.estimatedAudience || 100;
    const avgOrderValue = historicalStats.avgOrderValue || 45;
    const expectedConversions = Math.round(estimatedAudience * (parseFloat(predictions.conversionRate.expected) / 100));

    predictions.estimatedRevenue = {
      min: Math.round(expectedConversions * avgOrderValue * 0.7),
      max: Math.round(expectedConversions * avgOrderValue * 1.3),
      expected: Math.round(expectedConversions * avgOrderValue)
    };

    // Generar recomendaciones
    const recommendations = [];
    const strengths = [];
    const weaknesses = [];

    if (characteristics.charCount <= 160) {
      strengths.push('Longitud óptima (1 segmento)');
    } else {
      weaknesses.push('Mensaje largo - considera acortarlo');
      recommendations.push('Reduce el mensaje a menos de 160 caracteres');
    }

    if (characteristics.hasEmoji) {
      strengths.push('Incluye emoji para engagement');
    } else {
      recommendations.push('Añade un emoji relevante (🥒🫒)');
    }

    if (characteristics.hasDiscount) {
      strengths.push('Incluye oferta/descuento');
    }

    if (characteristics.hasUrgency) {
      strengths.push('Tiene urgencia que motiva acción');
    } else {
      recommendations.push('Añade urgencia (ej: "Solo hoy", "Expira en 2h")');
    }

    if (characteristics.hasCTA) {
      strengths.push('Tiene call-to-action claro');
    } else {
      weaknesses.push('Falta call-to-action');
      recommendations.push('Añade un CTA claro (ej: "Shop now", "Usa código X")');
    }

    // Determinar comparación con promedio
    let comparisonToAverage = 'average';
    if (messageScore >= 75) comparisonToAverage = 'above_average';
    else if (messageScore < 50) comparisonToAverage = 'below_average';

    return {
      success: true,
      messageScore,
      characteristics,
      predictions,
      strengths,
      weaknesses,
      recommendations,
      comparisonToAverage,
      confidence: historicalStats.campaignCount >= 10 ? 'high' :
                  historicalStats.campaignCount >= 5 ? 'medium' : 'low',
      historicalBenchmarks: {
        avgClickRate: historicalStats.avgClickRate?.toFixed(1) + '%',
        avgConversionRate: historicalStats.avgConversionRate?.toFixed(1) + '%',
        topCampaignClickRate: historicalStats.topCampaign?.clickRate?.toFixed(1) + '%',
        campaignsAnalyzed: historicalStats.campaignCount
      }
    };
  }

  async getHistoricalCampaignStats() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const campaigns = await SmsCampaign.find({
      status: 'sent',
      completedAt: { $gte: thirtyDaysAgo }
    }).lean();

    if (campaigns.length === 0) {
      return {
        campaignCount: 0,
        avgDeliveryRate: 95,
        avgClickRate: 5,
        avgConversionRate: 8,
        avgOrderValue: 45,
        topCampaign: null
      };
    }

    let totalDeliveryRate = 0;
    let totalClickRate = 0;
    let totalConversionRate = 0;
    let validCampaigns = 0;
    let topCampaign = null;
    let topClickRate = 0;

    campaigns.forEach(c => {
      const stats = c.stats || {};
      if (stats.sent > 0) {
        validCampaigns++;
        const deliveryRate = stats.delivered / stats.sent * 100;
        totalDeliveryRate += deliveryRate;

        if (stats.delivered > 0) {
          const clickRate = (stats.clicked || 0) / stats.delivered * 100;
          const conversionRate = (stats.converted || 0) / stats.delivered * 100;
          totalClickRate += clickRate;
          totalConversionRate += conversionRate;

          if (clickRate > topClickRate) {
            topClickRate = clickRate;
            topCampaign = { name: c.name, clickRate, conversionRate };
          }
        }
      }
    });

    return {
      campaignCount: validCampaigns,
      avgDeliveryRate: validCampaigns > 0 ? totalDeliveryRate / validCampaigns : 95,
      avgClickRate: validCampaigns > 0 ? totalClickRate / validCampaigns : 5,
      avgConversionRate: validCampaigns > 0 ? totalConversionRate / validCampaigns : 8,
      avgOrderValue: 45, // Default, idealmente calcular de conversiones reales
      topCampaign
    };
  }
}

module.exports = new SmsCalculator();
