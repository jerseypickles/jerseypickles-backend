// backend/src/services/aiCalculator.js
// 🧠 AI Calculator - Lógica de cálculo de insights
// Este servicio SOLO calcula, no guarda. El Job se encarga de guardar.

const Campaign = require('../models/Campaign');
const Customer = require('../models/Customer');
const EmailEvent = require('../models/EmailEvent');
const Order = require('../models/Order');
const Segment = require('../models/Segment');
const mongoose = require('mongoose');

class AICalculator {

  // ==================== HELPERS ====================
  
  getDateRange(days, endDate = new Date()) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    
    const start = new Date(end);
    start.setDate(start.getDate() - days);
    start.setHours(0, 0, 0, 0);
    
    return { start, end };
  }

  // ==================== 1. HEALTH CHECK ====================

  async calculateHealthCheck(options = {}) {
    const { alertThresholds = {} } = options;
    
    const thresholds = {
      bounceRate: alertThresholds.bounceRate || 5,
      unsubRate: alertThresholds.unsubRate || 1,
      openRateMin: alertThresholds.openRateMin || 15,
      complaintRateMax: alertThresholds.complaintRateMax || 0.1
    };

    // Últimos 7 días
    const { start: currentStart } = this.getDateRange(7);
    
    // 7-14 días atrás (para comparación)
    const { start: prevStart, end: prevEnd } = this.getDateRange(14);

    // Stats actuales
    const currentStats = await EmailEvent.aggregate([
      { $match: { eventDate: { $gte: currentStart } } },
      { $group: { _id: '$eventType', count: { $sum: 1 } } }
    ]);

    // Stats anteriores
    const previousStats = await EmailEvent.aggregate([
      { $match: { eventDate: { $gte: prevStart, $lt: currentStart } } },
      { $group: { _id: '$eventType', count: { $sum: 1 } } }
    ]);

    const getCount = (stats, type) => stats.find(s => s._id === type)?.count || 0;

    const current = {
      sent: getCount(currentStats, 'sent'),
      delivered: getCount(currentStats, 'delivered'),
      opened: getCount(currentStats, 'opened'),
      clicked: getCount(currentStats, 'clicked'),
      bounced: getCount(currentStats, 'bounced'),
      complained: getCount(currentStats, 'complained'),
      unsubscribed: getCount(currentStats, 'unsubscribed')
    };

    const previous = {
      sent: getCount(previousStats, 'sent'),
      opened: getCount(previousStats, 'opened'),
      bounced: getCount(previousStats, 'bounced'),
      unsubscribed: getCount(previousStats, 'unsubscribed')
    };

    // Calcular rates
    const rates = {
      deliveryRate: current.sent > 0 ? ((current.delivered || current.sent - current.bounced) / current.sent) * 100 : 0,
      bounceRate: current.sent > 0 ? (current.bounced / current.sent) * 100 : 0,
      openRate: current.sent > 0 ? (current.opened / current.sent) * 100 : 0,
      clickRate: current.opened > 0 ? (current.clicked / current.opened) * 100 : 0,
      unsubRate: current.sent > 0 ? (current.unsubscribed / current.sent) * 100 : 0,
      complaintRate: current.sent > 0 ? (current.complained / current.sent) * 100 : 0
    };

    const prevRates = {
      bounceRate: previous.sent > 0 ? (previous.bounced / previous.sent) * 100 : 0,
      openRate: previous.sent > 0 ? (previous.opened / previous.sent) * 100 : 0,
      unsubRate: previous.sent > 0 ? (previous.unsubscribed / previous.sent) * 100 : 0
    };

    // Generar alertas
    const alerts = [];

    if (rates.bounceRate > thresholds.bounceRate) {
      alerts.push({
        type: 'bounce_rate',
        severity: rates.bounceRate > thresholds.bounceRate * 2 ? 'critical' : 'warning',
        message: `Bounce rate alto: ${rates.bounceRate.toFixed(2)}%`,
        action: 'Revisa la lista de bounces y limpia emails inválidos',
        threshold: thresholds.bounceRate,
        currentValue: rates.bounceRate
      });
    }

    if (rates.unsubRate > thresholds.unsubRate) {
      alerts.push({
        type: 'unsub_rate',
        severity: 'warning',
        message: `Unsubscribe rate elevado: ${rates.unsubRate.toFixed(2)}%`,
        action: 'Revisa frecuencia de envío y relevancia del contenido',
        threshold: thresholds.unsubRate,
        currentValue: rates.unsubRate
      });
    }

    if (rates.openRate < thresholds.openRateMin && current.sent > 100) {
      alerts.push({
        type: 'open_rate',
        severity: 'warning',
        message: `Open rate bajo: ${rates.openRate.toFixed(2)}%`,
        action: 'Mejora tus subject lines y revisa horarios de envío',
        threshold: thresholds.openRateMin,
        currentValue: rates.openRate
      });
    }

    if (rates.complaintRate > thresholds.complaintRateMax) {
      alerts.push({
        type: 'complaint_rate',
        severity: 'critical',
        message: `Complaint rate alto: ${rates.complaintRate.toFixed(3)}%`,
        action: 'URGENTE: Revisa tu proceso de opt-in y contenido',
        threshold: thresholds.complaintRateMax,
        currentValue: rates.complaintRate
      });
    }

    // Calcular health score
    let healthScore = 100;
    if (rates.bounceRate > thresholds.bounceRate) healthScore -= 20;
    if (rates.bounceRate > thresholds.bounceRate * 2) healthScore -= 15;
    if (rates.unsubRate > thresholds.unsubRate) healthScore -= 10;
    if (rates.unsubRate > thresholds.unsubRate * 2) healthScore -= 10;
    if (rates.openRate < thresholds.openRateMin) healthScore -= 15;
    if (rates.complaintRate > 0.05) healthScore -= 20;
    if (rates.complaintRate > 0.1) healthScore -= 20;
    healthScore = Math.max(0, healthScore);

    const status = healthScore >= 80 ? 'healthy' : healthScore >= 60 ? 'warning' : 'critical';

    // Bounce stats
    const bounceStats = await Customer.getBounceStats();

    return {
      success: true,
      period: { days: 7, start: currentStart, end: new Date() },
      health: {
        score: healthScore,
        status,
        message: status === 'healthy' ? '✅ Tu email marketing está saludable' :
                 status === 'warning' ? '⚠️ Hay métricas que requieren atención' :
                 '🚨 Problemas críticos detectados'
      },
      summary: {
        score: healthScore,
        status,
        primaryMetric: { name: 'healthScore', value: healthScore },
        alertsCount: alerts.length
      },
      metrics: {
        current,
        rates: {
          deliveryRate: rates.deliveryRate.toFixed(2),
          bounceRate: rates.bounceRate.toFixed(2),
          openRate: rates.openRate.toFixed(2),
          clickRate: rates.clickRate.toFixed(2),
          unsubRate: rates.unsubRate.toFixed(2),
          complaintRate: rates.complaintRate.toFixed(3)
        },
        changes: {
          openRateChange: (rates.openRate - prevRates.openRate).toFixed(2),
          bounceRateChange: (rates.bounceRate - prevRates.bounceRate).toFixed(2)
        }
      },
      bounceBreakdown: bounceStats,
      alerts,
      thresholds
    };
  }

  // ==================== 2. SUBJECT LINE ANALYSIS ====================

  async calculateSubjectAnalysis(options = {}) {
    const { days = 90, minSent = 100 } = options;
    
    const { start } = this.getDateRange(days);

    const campaigns = await Campaign.find({
      status: 'sent',
      sentAt: { $gte: start },
      'stats.sent': { $gte: minSent }
    }).select('name subject stats sentAt').lean();

    if (campaigns.length < 5) {
      return {
        success: false,
        message: 'Necesitas al menos 5 campañas con +100 envíos para análisis',
        summary: { status: 'insufficient_data', campaignsAnalyzed: campaigns.length }
      };
    }

    // Patterns a analizar
    const urgencyWords = ['hoy', 'ahora', 'último', 'última', 'urgente', 'limitado', 
                          'today', 'now', 'last', 'urgent', 'limited', 'ends', 'flash'];
    
    const patterns = {
      length: { short: [], medium: [], long: [] },
      hasEmoji: { yes: [], no: [] },
      hasNumber: { yes: [], no: [] },
      hasUrgency: { yes: [], no: [] },
      hasQuestion: { yes: [], no: [] }
    };

    campaigns.forEach(campaign => {
      const subject = campaign.subject || '';
      const openRate = campaign.stats?.openRate || 0;
      const data = { subject, openRate, sent: campaign.stats?.sent || 0 };

      // Length
      if (subject.length <= 30) patterns.length.short.push(data);
      else if (subject.length <= 50) patterns.length.medium.push(data);
      else patterns.length.long.push(data);

      // Emoji
      const hasEmoji = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/u.test(subject);
      patterns.hasEmoji[hasEmoji ? 'yes' : 'no'].push(data);

      // Number
      const hasNumber = /\d+%?/.test(subject);
      patterns.hasNumber[hasNumber ? 'yes' : 'no'].push(data);

      // Urgency
      const hasUrgency = urgencyWords.some(w => subject.toLowerCase().includes(w));
      patterns.hasUrgency[hasUrgency ? 'yes' : 'no'].push(data);

      // Question
      patterns.hasQuestion[subject.includes('?') ? 'yes' : 'no'].push(data);
    });

    // Calcular promedios
    const calcAvg = (arr) => arr.length > 0 
      ? arr.reduce((sum, i) => sum + i.openRate, 0) / arr.length 
      : 0;

    const insights = {};

    // Length insights
    insights.length = {
      short: { count: patterns.length.short.length, avgOpenRate: calcAvg(patterns.length.short) },
      medium: { count: patterns.length.medium.length, avgOpenRate: calcAvg(patterns.length.medium) },
      long: { count: patterns.length.long.length, avgOpenRate: calcAvg(patterns.length.long) }
    };

    // Boolean patterns
    ['hasEmoji', 'hasNumber', 'hasUrgency', 'hasQuestion'].forEach(pattern => {
      const withRate = calcAvg(patterns[pattern].yes);
      const withoutRate = calcAvg(patterns[pattern].no);
      const lift = withoutRate > 0 ? ((withRate - withoutRate) / withoutRate * 100) : 0;

      insights[pattern] = {
        withPattern: { count: patterns[pattern].yes.length, avgOpenRate: withRate },
        withoutPattern: { count: patterns[pattern].no.length, avgOpenRate: withoutRate },
        lift: lift.toFixed(1)
      };
    });

    // Top/Low performers
    const sorted = [...campaigns].sort((a, b) => (b.stats?.openRate || 0) - (a.stats?.openRate || 0));
    const topPerformers = sorted.slice(0, 5).map(c => ({
      subject: c.subject,
      openRate: c.stats?.openRate || 0,
      sent: c.stats?.sent || 0
    }));
    const lowPerformers = sorted.slice(-5).reverse().map(c => ({
      subject: c.subject,
      openRate: c.stats?.openRate || 0,
      sent: c.stats?.sent || 0
    }));

    const avgOpenRate = calcAvg(campaigns.map(c => ({ openRate: c.stats?.openRate || 0 })));

    // Generar recomendaciones
    const recommendations = [];
    const patternLabels = {
      hasEmoji: 'emojis',
      hasNumber: 'números/porcentajes',
      hasUrgency: 'palabras de urgencia',
      hasQuestion: 'preguntas'
    };

    ['hasEmoji', 'hasNumber', 'hasUrgency', 'hasQuestion'].forEach(pattern => {
      const lift = parseFloat(insights[pattern].lift);
      if (Math.abs(lift) > 10 && insights[pattern].withPattern.count >= 3) {
        recommendations.push({
          type: pattern,
          priority: lift > 20 ? 'high' : lift > 0 ? 'medium' : 'low',
          insight: lift > 0 
            ? `Usar ${patternLabels[pattern]} aumenta open rate en +${lift.toFixed(0)}%`
            : `Los ${patternLabels[pattern]} reducen open rate en ${lift.toFixed(0)}%`,
          action: lift > 0 
            ? `Incluye ${patternLabels[pattern]} en tus subjects`
            : `Evita ${patternLabels[pattern]} en tus subjects`
        });
      }
    });

    // Best length recommendation
    const bestLength = Object.entries(insights.length)
      .filter(([_, v]) => v.count >= 3)
      .sort((a, b) => b[1].avgOpenRate - a[1].avgOpenRate)[0];
    
    if (bestLength) {
      const labels = { short: '≤30 chars', medium: '31-50 chars', long: '>50 chars' };
      recommendations.unshift({
        type: 'length',
        priority: 'high',
        insight: `Subjects ${labels[bestLength[0]]} tienen ${bestLength[1].avgOpenRate.toFixed(1)}% open rate`,
        action: `Mantén tus subjects en el rango ${labels[bestLength[0]]}`
      });
    }

    recommendations.sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return order[a.priority] - order[b.priority];
    });

    return {
      success: true,
      period: { days, start, end: new Date() },
      summary: {
        campaignsAnalyzed: campaigns.length,
        avgOpenRate: avgOpenRate.toFixed(2),
        bestOpenRate: topPerformers[0]?.openRate?.toFixed(2) || 0,
        worstOpenRate: lowPerformers[0]?.openRate?.toFixed(2) || 0,
        score: Math.round(avgOpenRate * 3), // Score simple basado en open rate
        status: avgOpenRate > 25 ? 'healthy' : avgOpenRate > 15 ? 'warning' : 'critical',
        primaryMetric: { name: 'avgOpenRate', value: avgOpenRate }
      },
      insights,
      topPerformers,
      lowPerformers,
      topInsights: recommendations.slice(0, 5),
      rawPatternCounts: {
        withEmoji: patterns.hasEmoji.yes.length,
        withNumber: patterns.hasNumber.yes.length,
        withUrgency: patterns.hasUrgency.yes.length,
        withQuestion: patterns.hasQuestion.yes.length
      }
    };
  }

  // ==================== 3. SEND TIMING ====================

  async calculateSendTiming(options = {}) {
    const { days = 90, segmentId = null, metric = 'opened' } = options;
    
    const { start } = this.getDateRange(days);

    const matchStage = {
      eventDate: { $gte: start },
      eventType: { $in: ['sent', 'opened', 'clicked'] }
    };

    if (segmentId) {
      const segmentCampaigns = await Campaign.find({ segment: segmentId }).select('_id');
      matchStage.campaign = { $in: segmentCampaigns.map(c => c._id) };
    }

    const events = await EmailEvent.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: {
            dayOfWeek: { $dayOfWeek: '$eventDate' },
            hour: { $hour: '$eventDate' },
            type: '$eventType'
          },
          count: { $sum: 1 }
        }
      }
    ]);

    const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const heatmap = [];

    for (let day = 1; day <= 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const sent = events.find(e => e._id.dayOfWeek === day && e._id.hour === hour && e._id.type === 'sent')?.count || 0;
        const opened = events.find(e => e._id.dayOfWeek === day && e._id.hour === hour && e._id.type === 'opened')?.count || 0;
        const clicked = events.find(e => e._id.dayOfWeek === day && e._id.hour === hour && e._id.type === 'clicked')?.count || 0;

        const openRate = sent > 0 ? (opened / sent) * 100 : 0;
        const clickRate = sent > 0 ? (clicked / sent) * 100 : 0;

        heatmap.push({
          day: day - 1,
          dayName: dayNames[day - 1],
          hour,
          hourLabel: `${hour.toString().padStart(2, '0')}:00`,
          sent,
          opened,
          clicked,
          openRate: parseFloat(openRate.toFixed(2)),
          clickRate: parseFloat(clickRate.toFixed(2)),
          score: metric === 'clicked' ? clickRate : openRate
        });
      }
    }

    // Best times (mínimo 50 envíos)
    const significant = heatmap.filter(h => h.sent >= 50);
    const sorted = [...significant].sort((a, b) => b.score - a.score);

    const bestTimes = sorted.slice(0, 5).map(t => ({
      day: t.dayName,
      hour: t.hourLabel,
      score: t.score.toFixed(2) + '%',
      sampleSize: t.sent,
      opens: t.opened,
      clicks: t.clicked
    }));

    const worstTimes = sorted.slice(-3).reverse().map(t => ({
      day: t.dayName,
      hour: t.hourLabel,
      score: t.score.toFixed(2) + '%',
      sampleSize: t.sent
    }));

    // Day averages
    const dayAverages = dayNames.map((name, idx) => {
      const daySlots = heatmap.filter(h => h.day === idx && h.sent >= 10);
      const avgScore = daySlots.length > 0 
        ? daySlots.reduce((sum, s) => sum + s.score, 0) / daySlots.length 
        : 0;
      const totalSent = daySlots.reduce((sum, s) => sum + s.sent, 0);
      const bestSlot = daySlots.sort((a, b) => b.score - a.score)[0];
      
      return {
        day: name,
        avgScore: avgScore.toFixed(2),
        totalSent,
        bestHour: bestSlot?.hourLabel || 'N/A'
      };
    });

    const recommendation = bestTimes.length > 0
      ? `Mejor momento: ${bestTimes[0].day} a las ${bestTimes[0].hour} (${bestTimes[0].score} ${metric} rate)`
      : 'No hay suficientes datos para una recomendación';

    return {
      success: true,
      period: { days, start, end: new Date() },
      metric,
      segmentId: segmentId || 'all',
      summary: {
        score: bestTimes.length > 0 ? Math.round(parseFloat(bestTimes[0].score)) : 0,
        status: bestTimes.length >= 3 ? 'healthy' : 'insufficient_data',
        primaryMetric: { name: 'bestOpenRate', value: bestTimes[0]?.score || '0%' }
      },
      recommendation,
      bestTimes,
      worstTimes,
      dayAverages,
      heatmap,
      totalEventsAnalyzed: events.reduce((sum, e) => sum + e.count, 0),
      topInsights: bestTimes.length > 0 ? [{
        category: 'Send Timing',
        priority: 'high',
        insight: recommendation,
        action: 'Programa tus campañas importantes para este horario'
      }] : []
    };
  }

  // ==================== 4. LIST PERFORMANCE ====================

  async calculateListPerformance(options = {}) {
    const { days = 90 } = options;
    
    const { start } = this.getDateRange(days);

    const campaignData = await Campaign.aggregate([
      {
        $match: {
          status: 'sent',
          sentAt: { $gte: start },
          targetType: 'list',
          list: { $exists: true, $ne: null }
        }
      },
      {
        $lookup: {
          from: 'lists',
          localField: 'list',
          foreignField: '_id',
          as: 'listData'
        }
      },
      { $unwind: '$listData' },
      {
        $group: {
          _id: '$list',
          listName: { $first: '$listData.name' },
          listMemberCount: { $first: '$listData.memberCount' },
          campaigns: { $sum: 1 },
          totalSent: { $sum: '$stats.sent' },
          totalOpened: { $sum: '$stats.opened' },
          totalClicked: { $sum: '$stats.clicked' },
          totalBounced: { $sum: '$stats.bounced' },
          totalUnsubscribed: { $sum: '$stats.unsubscribed' },
          totalRevenue: { $sum: '$stats.totalRevenue' },
          totalPurchased: { $sum: '$stats.purchased' }
        }
      },
      { $sort: { totalRevenue: -1 } }
    ]);

    if (campaignData.length === 0) {
      return {
        success: false,
        message: 'No hay suficientes datos de campañas por lista',
        summary: { status: 'insufficient_data' }
      };
    }

    const lists = campaignData.map(list => {
      const openRate = list.totalSent > 0 ? (list.totalOpened / list.totalSent) * 100 : 0;
      const clickRate = list.totalSent > 0 ? (list.totalClicked / list.totalSent) * 100 : 0;
      const conversionRate = list.totalSent > 0 ? (list.totalPurchased / list.totalSent) * 100 : 0;
      const revenuePerEmail = list.totalSent > 0 ? list.totalRevenue / list.totalSent : 0;
      const bounceRate = list.totalSent > 0 ? (list.totalBounced / list.totalSent) * 100 : 0;
      const unsubRate = list.totalSent > 0 ? (list.totalUnsubscribed / list.totalSent) * 100 : 0;

      return {
        listId: list._id,
        name: list.listName,
        memberCount: list.listMemberCount,
        campaigns: list.campaigns,
        metrics: {
          sent: list.totalSent,
          opened: list.totalOpened,
          clicked: list.totalClicked,
          purchased: list.totalPurchased,
          bounced: list.totalBounced,
          unsubscribed: list.totalUnsubscribed
        },
        rates: {
          openRate: parseFloat(openRate.toFixed(2)),
          clickRate: parseFloat(clickRate.toFixed(2)),
          conversionRate: parseFloat(conversionRate.toFixed(3)),
          bounceRate: parseFloat(bounceRate.toFixed(2)),
          unsubRate: parseFloat(unsubRate.toFixed(2))
        },
        revenue: {
          total: parseFloat((list.totalRevenue || 0).toFixed(2)),
          perEmail: parseFloat(revenuePerEmail.toFixed(3)),
          avgOrderValue: list.totalPurchased > 0 
            ? parseFloat((list.totalRevenue / list.totalPurchased).toFixed(2))
            : 0
        },
        score: parseFloat((openRate * 0.3 + clickRate * 0.3 + conversionRate * 10 + revenuePerEmail * 2).toFixed(2))
      };
    });

    lists.sort((a, b) => b.score - a.score);

    const avgOpenRate = lists.reduce((sum, l) => sum + l.rates.openRate, 0) / lists.length;
    const avgClickRate = lists.reduce((sum, l) => sum + l.rates.clickRate, 0) / lists.length;
    const avgRevenue = lists.reduce((sum, l) => sum + l.revenue.perEmail, 0) / lists.length;
    const totalRevenue = lists.reduce((sum, l) => sum + l.revenue.total, 0);

    // Generar insights
    const topInsights = [];

    if (lists[0]) {
      topInsights.push({
        category: 'Lists',
        priority: 'high',
        list: lists[0].name,
        insight: `"${lists[0].name}" es tu lista más valiosa con $${lists[0].revenue.perEmail.toFixed(3)}/email`,
        action: 'Prioriza esta lista para campañas importantes'
      });
    }

    // High engagement, low conversion
    const opportunity = lists.find(l => 
      l.rates.openRate > avgOpenRate * 1.2 && l.rates.conversionRate < 0.1
    );
    if (opportunity) {
      topInsights.push({
        category: 'Lists',
        priority: 'high',
        list: opportunity.name,
        insight: `"${opportunity.name}" tiene alto engagement (${opportunity.rates.openRate}%) pero baja conversión`,
        action: 'Prueba ofertas más agresivas para esta lista'
      });
    }

    // High unsub
    const highUnsub = lists.find(l => l.rates.unsubRate > 1);
    if (highUnsub) {
      topInsights.push({
        category: 'Lists',
        priority: 'medium',
        list: highUnsub.name,
        insight: `"${highUnsub.name}" tiene ${highUnsub.rates.unsubRate}% unsubscribe rate`,
        action: 'Reduce frecuencia de envío para esta lista'
      });
    }

    return {
      success: true,
      period: { days, start, end: new Date() },
      summary: {
        totalLists: lists.length,
        avgOpenRate: parseFloat(avgOpenRate.toFixed(2)),
        avgClickRate: parseFloat(avgClickRate.toFixed(2)),
        avgRevenuePerEmail: parseFloat(avgRevenue.toFixed(3)),
        totalRevenue: totalRevenue.toFixed(2),
        score: Math.round(avgOpenRate * 2 + avgRevenue * 100),
        status: lists.length >= 2 ? 'healthy' : 'warning',
        primaryMetric: { name: 'totalRevenue', value: totalRevenue }
      },
      lists,
      topInsights,
      rankings: {
        byRevenue: lists.slice(0, 5).map(l => ({ name: l.name, value: l.revenue.total })),
        byOpenRate: [...lists].sort((a, b) => b.rates.openRate - a.rates.openRate).slice(0, 5).map(l => ({ name: l.name, value: l.rates.openRate })),
        byConversion: [...lists].sort((a, b) => b.rates.conversionRate - a.rates.conversionRate).slice(0, 5).map(l => ({ name: l.name, value: l.rates.conversionRate }))
      }
    };
  }

  // ==================== 5. COMPREHENSIVE REPORT ====================

  async calculateComprehensiveReport(options = {}) {
    const { days = 30 } = options;

    const [healthCheck, subjectAnalysis, sendTiming, listPerf] = await Promise.all([
      this.calculateHealthCheck(),
      this.calculateSubjectAnalysis({ days }),
      this.calculateSendTiming({ days: 90 }), // Timing siempre con más data
      this.calculateListPerformance({ days })
    ]);

    // Consolidar top insights
    const allInsights = [];

    if (subjectAnalysis.success && subjectAnalysis.topInsights) {
      subjectAnalysis.topInsights.slice(0, 2).forEach(i => {
        allInsights.push({ ...i, category: 'Subject Lines' });
      });
    }

    if (sendTiming.success && sendTiming.topInsights) {
      sendTiming.topInsights.slice(0, 1).forEach(i => {
        allInsights.push({ ...i, category: 'Send Timing' });
      });
    }

    if (listPerf.success && listPerf.topInsights) {
      listPerf.topInsights.slice(0, 2).forEach(i => {
        allInsights.push({ ...i, category: 'Lists' });
      });
    }

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

    // Sort by priority
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    allInsights.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    return {
      success: true,
      generatedAt: new Date().toISOString(),
      period: { days },
      summary: {
        healthScore: healthCheck.health?.score || 0,
        healthStatus: healthCheck.health?.status || 'unknown',
        campaignsAnalyzed: subjectAnalysis.summary?.campaignsAnalyzed || 0,
        listsAnalyzed: listPerf.summary?.totalLists || 0,
        topInsightsCount: allInsights.length,
        score: healthCheck.health?.score || 0,
        status: healthCheck.health?.status || 'unknown',
        primaryMetric: { name: 'healthScore', value: healthCheck.health?.score || 0 }
      },
      topInsights: allInsights.slice(0, 8),
      alerts: healthCheck.alerts || [],
      details: {
        subjectAnalysis: {
          avgOpenRate: subjectAnalysis.summary?.avgOpenRate,
          topPerformers: subjectAnalysis.topPerformers?.slice(0, 3),
          keyPatterns: subjectAnalysis.topInsights?.slice(0, 3)
        },
        sendTiming: {
          bestTime: sendTiming.bestTimes?.[0],
          recommendation: sendTiming.recommendation
        },
        lists: {
          topByRevenue: listPerf.rankings?.byRevenue?.slice(0, 3),
          topByOpenRate: listPerf.rankings?.byOpenRate?.slice(0, 3)
        },
        health: {
          score: healthCheck.health?.score,
          status: healthCheck.health?.status,
          alerts: healthCheck.alerts?.length || 0
        }
      }
    };
  }

  // ==================== 6. CAMPAIGN PREDICTION ====================

  async predictCampaignPerformance(campaignData, historicalInsights) {
    const { subject, listId, sendHour, sendDay } = campaignData;

    if (!subject || !listId) {
      return {
        success: false,
        message: 'Se requiere subject y listId para predicción'
      };
    }

    // Buscar datos de la lista en los insights
    const listPerf = historicalInsights.list_performance;
    const subjectAnalysis = historicalInsights.subject_analysis;
    const timingAnalysis = historicalInsights.send_timing;

    if (!listPerf?.data?.lists) {
      return {
        success: false,
        message: 'No hay datos históricos suficientes para predicción'
      };
    }

    const list = listPerf.data.lists.find(l => 
      l.listId.toString() === listId.toString()
    );

    if (!list) {
      return {
        success: false,
        message: 'Lista no encontrada en datos históricos'
      };
    }

    // Base prediction
    let predictedOpenRate = list.rates.openRate;
    let predictedClickRate = list.rates.clickRate;
    let predictedConversionRate = list.rates.conversionRate;

    // Ajustes por subject patterns
    const hasEmoji = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/u.test(subject);
    const hasNumber = /\d+%?/.test(subject);
    const subjectLength = subject.length;

    const insights = subjectAnalysis?.data?.insights || {};

    if (hasEmoji && insights.hasEmoji) {
      const lift = parseFloat(insights.hasEmoji.lift) || 0;
      predictedOpenRate *= (1 + lift / 100);
    }

    if (hasNumber && insights.hasNumber) {
      const lift = parseFloat(insights.hasNumber.lift) || 0;
      predictedOpenRate *= (1 + lift / 100);
    }

    // Calcular revenue estimado
    const listSize = list.metrics.sent / list.campaigns;
    const predictedRevenue = (predictedConversionRate / 100) * listSize * list.revenue.avgOrderValue;

    // Confidence
    let confidence = 'low';
    if (list.campaigns >= 5 && list.metrics.sent >= 1000) confidence = 'high';
    else if (list.campaigns >= 3 && list.metrics.sent >= 500) confidence = 'medium';

    // Recommendations
    const recommendations = [];

    if (!hasEmoji && parseFloat(insights.hasEmoji?.lift || 0) > 10) {
      recommendations.push({
        type: 'subject',
        suggestion: 'Considera agregar un emoji al subject',
        potentialLift: `+${insights.hasEmoji.lift}% opens`
      });
    }

    if (timingAnalysis?.data?.bestTimes?.[0] && sendHour !== undefined) {
      const bestHour = parseInt(timingAnalysis.data.bestTimes[0].hour);
      if (Math.abs(sendHour - bestHour) > 2) {
        recommendations.push({
          type: 'timing',
          suggestion: `Mejor horario: ${timingAnalysis.data.bestTimes[0].day} ${timingAnalysis.data.bestTimes[0].hour}`,
          potentialLift: 'Mejor engagement'
        });
      }
    }

    return {
      success: true,
      prediction: {
        openRate: {
          predicted: parseFloat(predictedOpenRate.toFixed(2)),
          listAvg: list.rates.openRate,
          range: {
            low: parseFloat((predictedOpenRate * 0.8).toFixed(2)),
            high: parseFloat((predictedOpenRate * 1.2).toFixed(2))
          }
        },
        clickRate: {
          predicted: parseFloat(predictedClickRate.toFixed(2)),
          listAvg: list.rates.clickRate
        },
        conversionRate: {
          predicted: parseFloat(predictedConversionRate.toFixed(3)),
          listAvg: list.rates.conversionRate
        },
        estimatedRevenue: {
          predicted: parseFloat(predictedRevenue.toFixed(2)),
          perEmail: parseFloat((predictedRevenue / listSize).toFixed(3))
        }
      },
      confidence,
      basedOn: {
        listCampaigns: list.campaigns,
        listEmails: list.metrics.sent
      },
      subjectAnalysis: {
        length: subjectLength,
        hasEmoji,
        hasNumber
      },
      recommendations
    };
  }

  // ==================== 7. PREPARE DATA FOR CLAUDE ====================

  /**
   * Prepara un resumen compacto de todas las métricas para enviar a Claude
   * Esto minimiza tokens mientras mantiene la información relevante
   */
  prepareDataForClaude(analysisResults) {
    const { healthCheck, subjectAnalysis, sendTiming, listPerformance } = analysisResults;

    // === HEALTH ===
    const health = {
      openRate: healthCheck?.metrics?.rates?.openRate || 0,
      clickRate: healthCheck?.metrics?.rates?.clickRate || 0,
      bounceRate: healthCheck?.metrics?.rates?.bounceRate || 0,
      unsubRate: healthCheck?.metrics?.rates?.unsubRate || 0,
      deliveryRate: healthCheck?.metrics?.rates?.deliveryRate || 0,
      campaignsSent: healthCheck?.metrics?.campaigns?.sent || 0,
      totalSent: healthCheck?.metrics?.totals?.sent || 0,
      healthScore: healthCheck?.health?.score || 0,
      status: healthCheck?.health?.status || 'unknown'
    };

    // === SUBJECTS ===
    const subjects = {
      top: subjectAnalysis?.topPerformers?.[0] ? {
        subject: subjectAnalysis.topPerformers[0].subject,
        openRate: subjectAnalysis.topPerformers[0].openRate
      } : null,
      bottom: subjectAnalysis?.lowPerformers?.[0] ? {
        subject: subjectAnalysis.lowPerformers[0].subject,
        openRate: subjectAnalysis.lowPerformers[0].openRate
      } : null,
      patterns: {}
    };

    // Extraer patrones de subjects
    if (subjectAnalysis?.insights) {
      const ins = subjectAnalysis.insights;
      if (ins.hasEmoji) subjects.patterns.emoji = `${ins.hasEmoji.lift}% lift`;
      if (ins.hasNumber) subjects.patterns.numbers = `${ins.hasNumber.lift}% lift`;
      if (ins.hasUrgency) subjects.patterns.urgency = `${ins.hasUrgency.lift}% lift`;
      if (ins.hasQuestion) subjects.patterns.questions = `${ins.hasQuestion.lift}% lift`;
    }

    // === LISTS ===
    const lists = (listPerformance?.lists || []).slice(0, 5).map(list => ({
      name: list.name,
      openRate: list.rates?.openRate || 0,
      clickRate: list.rates?.clickRate || 0,
      revenue: list.revenue?.total || 0,
      unsubRate: list.rates?.unsubRate || 0,
      campaigns: list.campaigns || 0
    }));

    // === TIMING ===
    const timing = {
      best: sendTiming?.bestTimes?.[0] ? 
        `${sendTiming.bestTimes[0].day} ${sendTiming.bestTimes[0].hour}` : null,
      worst: sendTiming?.bestTimes?.length > 4 ?
        `${sendTiming.bestTimes[4].day} ${sendTiming.bestTimes[4].hour}` : null,
      topHours: (sendTiming?.bestTimes || []).slice(0, 3).map(t => ({
        day: t.day,
        hour: t.hour,
        score: t.score
      }))
    };

    // === REVENUE ===
    const revenue = {
      total: listPerformance?.summary?.totalRevenue || 0,
      perEmail: listPerformance?.summary?.avgRevenuePerEmail || 0,
      orders: 0 // Se puede calcular si hay datos
    };

    // Calcular órdenes totales de las listas
    if (listPerformance?.lists) {
      revenue.orders = listPerformance.lists.reduce((sum, l) => 
        sum + (l.metrics?.purchased || 0), 0
      );
    }

    // === ALERTAS ===
    const alerts = (healthCheck?.alerts || []).map(a => ({
      severity: a.severity,
      message: a.message
    }));

    return {
      period: `últimos ${subjectAnalysis?.period?.days || 30} días`,
      generatedAt: new Date().toISOString(),
      health,
      subjects,
      lists,
      timing,
      revenue,
      alerts
    };
  }
}

module.exports = new AICalculator();