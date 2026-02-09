// backend/src/services/smartScheduleService.js
// 🧠 Smart Schedule Service - AI-powered send time optimization

const mongoose = require('mongoose');
const Anthropic = require('@anthropic-ai/sdk');

let claudeService = null;
try {
  claudeService = require('./claudeService');
} catch (e) {
  console.log('⚠️  SmartSchedule: Claude service not available');
}

// Direct Anthropic client for smart schedule analysis
let anthropicClient = null;
try {
  if (process.env.ANTHROPIC_API_KEY) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
} catch (e) {
  // Will use fallback analysis
}

const DAYS_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_LABELS = {
  monday: 'Lunes', tuesday: 'Martes', wednesday: 'Miércoles',
  thursday: 'Jueves', friday: 'Viernes', saturday: 'Sábado', sunday: 'Domingo'
};

class SmartScheduleService {

  /**
   * Compile time report for a completed campaign
   * Called by the compileTimeReport job 48h after campaign completion
   */
  async compileCampaignReport(campaignId) {
    const SmsCampaign = mongoose.model('SmsCampaign');
    const SmsMessage = mongoose.model('SmsMessage');
    const SmsCampaignTimeReport = mongoose.model('SmsCampaignTimeReport');

    const campaign = await SmsCampaign.findById(campaignId);
    if (!campaign || !campaign.startedAt) {
      throw new Error(`Campaign ${campaignId} not found or never started`);
    }

    // Check if report already exists
    let report = await SmsCampaignTimeReport.findOne({ campaign: campaignId });

    // Get all messages for this campaign
    const messages = await SmsMessage.find({ campaign: campaignId }).lean();

    // Calculate send time info (in Eastern Time)
    const sentAt = campaign.startedAt;
    const etOptions = { timeZone: 'America/New_York' };
    const etDate = new Date(sentAt.toLocaleString('en-US', etOptions));
    const sentHour = parseInt(sentAt.toLocaleString('en-US', { ...etOptions, hour: 'numeric', hour12: false }));
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const sentDay = dayNames[new Date(sentAt.toLocaleString('en-US', etOptions)).getDay()];
    const dayOfWeek = new Date(sentAt.toLocaleString('en-US', etOptions)).getDay();

    // Calculate click timing data
    const clickTimings = [];
    const conversionTimings = [];

    for (const msg of messages) {
      if (msg.clicked && msg.clickedAt && msg.sentAt) {
        const minutesToClick = (new Date(msg.clickedAt) - new Date(msg.sentAt)) / 60000;
        if (minutesToClick >= 0 && minutesToClick < 10080) { // within 7 days
          clickTimings.push(minutesToClick);
        }
      }
      if (msg.converted && msg.convertedAt && msg.sentAt) {
        const minutesToConvert = (new Date(msg.convertedAt) - new Date(msg.sentAt)) / 60000;
        if (minutesToConvert >= 0 && minutesToConvert < 20160) { // within 14 days
          conversionTimings.push(minutesToConvert);
        }
      }
    }

    // Sort for median calculation
    clickTimings.sort((a, b) => a - b);
    conversionTimings.sort((a, b) => a - b);

    const median = (arr) => {
      if (arr.length === 0) return 0;
      const mid = Math.floor(arr.length / 2);
      return arr.length % 2 !== 0 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
    };

    const avg = (arr) => arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length;

    // Peak hours for clicks and conversions
    const clickHourBuckets = {};
    const convHourBuckets = {};

    for (const msg of messages) {
      if (msg.clicked && msg.clickedAt) {
        const h = parseInt(new Date(msg.clickedAt).toLocaleString('en-US', { ...etOptions, hour: 'numeric', hour12: false }));
        clickHourBuckets[h] = (clickHourBuckets[h] || 0) + 1;
      }
      if (msg.converted && msg.convertedAt) {
        const h = parseInt(new Date(msg.convertedAt).toLocaleString('en-US', { ...etOptions, hour: 'numeric', hour12: false }));
        convHourBuckets[h] = (convHourBuckets[h] || 0) + 1;
      }
    }

    const peakHour = (buckets) => {
      let max = 0, peak = -1;
      for (const [h, count] of Object.entries(buckets)) {
        if (count > max) { max = count; peak = parseInt(h); }
      }
      return peak;
    };

    // Season detection
    const month = sentAt.getMonth(); // 0-indexed
    let season = 'winter';
    if (month >= 2 && month <= 4) season = 'spring';
    else if (month >= 5 && month <= 7) season = 'summer';
    else if (month >= 8 && month <= 10) season = 'fall';

    // Build performance data
    const stats = campaign.stats || {};
    const delivered = stats.delivered || 0;
    const sent = stats.sent || 0;

    const reportData = {
      campaign: campaignId,
      campaignName: campaign.name,
      sentAt,
      sentAtHour: sentHour,
      sentAtDay: sentDay,
      sentAtDayOfWeek: dayOfWeek,
      isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
      audienceType: campaign.audienceType,
      audienceSize: stats.eligible || 0,
      targetCountry: campaign.targetCountry,
      performance: {
        delivered,
        deliveryRate: sent > 0 ? parseFloat(((delivered / sent) * 100).toFixed(1)) : 0,
        totalClicks: stats.clicked || 0,
        uniqueClicks: stats.clicked || 0,
        clickRate: delivered > 0 ? parseFloat(((stats.clicked || 0) / delivered * 100).toFixed(1)) : 0,
        conversions: stats.converted || 0,
        conversionRate: delivered > 0 ? parseFloat(((stats.converted || 0) / delivered * 100).toFixed(1)) : 0,
        revenue: stats.totalRevenue || 0,
        revenuePerSms: delivered > 0 ? parseFloat(((stats.totalRevenue || 0) / delivered).toFixed(2)) : 0,
        cost: stats.totalCost || 0,
        roi: stats.totalCost > 0 ? parseFloat((((stats.totalRevenue || 0) - stats.totalCost) / stats.totalCost * 100).toFixed(0)) : 0,
        unsubscribes: stats.unsubscribed || 0,
        unsubRate: delivered > 0 ? parseFloat(((stats.unsubscribed || 0) / delivered * 100).toFixed(2)) : 0
      },
      responseSpeed: {
        avgMinutesToClick: parseFloat(avg(clickTimings).toFixed(1)),
        medianMinutesToClick: parseFloat(median(clickTimings).toFixed(1)),
        avgMinutesToConvert: parseFloat(avg(conversionTimings).toFixed(1)),
        medianMinutesToConvert: parseFloat(median(conversionTimings).toFixed(1)),
        clicksWithin30min: clickTimings.filter(t => t <= 30).length,
        clicksWithin1hr: clickTimings.filter(t => t <= 60).length,
        clicksWithin3hr: clickTimings.filter(t => t <= 180).length,
        conversionsWithin1hr: conversionTimings.filter(t => t <= 60).length,
        conversionsWithin3hr: conversionTimings.filter(t => t <= 180).length,
        conversionsWithin24hr: conversionTimings.filter(t => t <= 1440).length,
        peakClickHour: peakHour(clickHourBuckets),
        peakConversionHour: peakHour(convHourBuckets)
      },
      context: {
        discountPercent: campaign.discountPercent || (campaign.dynamicDiscount?.enabled ? campaign.dynamicDiscount.min : null),
        dynamicDiscount: campaign.dynamicDiscount?.enabled || false,
        dynamicRange: campaign.dynamicDiscount?.enabled ? {
          min: campaign.dynamicDiscount.min,
          max: campaign.dynamicDiscount.max
        } : undefined,
        season,
        isHoliday: false,
        messageLength: campaign.messageLength,
        segments: campaign.segments
      },
      status: 'compiled',
      compiledAt: new Date()
    };

    if (report) {
      Object.assign(report, reportData);
      await report.save();
    } else {
      report = await SmsCampaignTimeReport.create(reportData);
    }

    return report;
  }

  /**
   * Analyze a compiled report with Claude AI
   */
  async analyzeWithAI(reportId) {
    const SmsCampaignTimeReport = mongoose.model('SmsCampaignTimeReport');

    const report = await SmsCampaignTimeReport.findById(reportId);
    if (!report) throw new Error('Report not found');

    const globalAvgs = await SmsCampaignTimeReport.getGlobalAverages();

    // Calculate comparison
    const clickDiff = globalAvgs.avgClickRate > 0
      ? (((report.performance.clickRate - globalAvgs.avgClickRate) / globalAvgs.avgClickRate) * 100).toFixed(0)
      : '0';
    const convDiff = globalAvgs.avgConversionRate > 0
      ? (((report.performance.conversionRate - globalAvgs.avgConversionRate) / globalAvgs.avgConversionRate) * 100).toFixed(0)
      : '0';
    const revDiff = globalAvgs.avgRevenue > 0
      ? (report.performance.revenue - globalAvgs.avgRevenue).toFixed(0)
      : '0';

    if (anthropicClient) {
      try {
        const prompt = this._buildAnalysisPrompt(report, globalAvgs);
        const response = await anthropicClient.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }]
        });

        const content = response.content?.[0]?.text || '';
        const parsed = this._parseAIResponse(content);
        report.aiAnalysis = {
          ...parsed,
          comparedToAvg: {
            clickRateVsAvg: `${clickDiff > 0 ? '+' : ''}${clickDiff}%`,
            conversionRateVsAvg: `${convDiff > 0 ? '+' : ''}${convDiff}%`,
            revenueVsAvg: `${revDiff > 0 ? '+$' : '-$'}${Math.abs(revDiff)}`
          }
        };
      } catch (err) {
        console.error('SmartSchedule AI analysis error:', err.message);
        report.aiAnalysis = this._buildFallbackAnalysis(report, globalAvgs, clickDiff, convDiff, revDiff);
      }
    } else {
      report.aiAnalysis = this._buildFallbackAnalysis(report, globalAvgs, clickDiff, convDiff, revDiff);
    }

    report.status = 'analyzed';
    report.analyzedAt = new Date();
    await report.save();

    return report;
  }

  /**
   * Get optimal send time recommendation
   */
  async getRecommendation() {
    const SmsCampaignTimeReport = mongoose.model('SmsCampaignTimeReport');

    const [byHour, byDay, heatmap, globalAvgs] = await Promise.all([
      SmsCampaignTimeReport.getPerformanceByHour(),
      SmsCampaignTimeReport.getPerformanceByDay(),
      SmsCampaignTimeReport.getHeatmapData(),
      SmsCampaignTimeReport.getGlobalAverages()
    ]);

    const totalCampaigns = globalAvgs.totalCampaigns || 0;

    // Determine confidence level
    let confidence = 0;
    if (totalCampaigns >= 20) confidence = 95;
    else if (totalCampaigns >= 10) confidence = 80;
    else if (totalCampaigns >= 5) confidence = 60;
    else if (totalCampaigns >= 3) confidence = 40;
    else if (totalCampaigns >= 1) confidence = 20;

    // Find best hour by conversion rate (weighted by campaign count)
    let bestHour = null;
    let bestHourScore = 0;

    for (const h of byHour) {
      const weight = Math.min(h.campaigns / totalCampaigns, 0.5); // cap weight
      const score = (h.avgConversionRate * 0.5) + (h.avgClickRate * 0.3) + (h.avgRevenuePerSms * 20 * 0.2);
      const weighted = score * (0.5 + weight);
      if (weighted > bestHourScore) {
        bestHourScore = weighted;
        bestHour = h;
      }
    }

    // Find best day
    let bestDay = null;
    let bestDayScore = 0;

    for (const d of byDay) {
      const score = (d.avgConversionRate * 0.5) + (d.avgClickRate * 0.3) + ((d.avgRevenue / 100) * 0.2);
      if (score > bestDayScore) {
        bestDayScore = score;
        bestDay = d;
      }
    }

    // Build alternatives (top 3 slots excluding the best)
    const slots = [];
    for (const item of heatmap) {
      slots.push({
        hour: item._id.hour,
        day: item._id.day,
        conversionRate: item.avgConversionRate,
        clickRate: item.avgClickRate,
        revenue: item.avgRevenue,
        campaigns: item.campaigns,
        score: (item.avgConversionRate * 0.5) + (item.avgClickRate * 0.3) + ((item.avgRevenue / 100) * 0.2)
      });
    }
    slots.sort((a, b) => b.score - a.score);

    const primarySlot = slots[0] || null;
    const alternatives = slots.slice(1, 4);

    // AI recommendation text
    let aiRecommendation = null;
    if (anthropicClient && totalCampaigns >= 3) {
      try {
        const prompt = this._buildRecommendationPrompt(byHour, byDay, heatmap, globalAvgs);
        const response = await anthropicClient.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }]
        });
        aiRecommendation = response.content?.[0]?.text || null;
      } catch (err) {
        console.error('SmartSchedule recommendation error:', err.message);
      }
    }

    // Fallback text
    if (!aiRecommendation && primarySlot) {
      const dayLabel = DAY_LABELS[primarySlot.day] || primarySlot.day;
      const hourLabel = this._formatHour(primarySlot.hour);
      aiRecommendation = `Basado en ${totalCampaigns} campañas analizadas, tu mejor ventana de envío es ${dayLabel} a las ${hourLabel} ET. Conversión promedio: ${primarySlot.conversionRate?.toFixed(1)}%.`;
    }

    return {
      totalCampaigns,
      confidence,
      recommendation: aiRecommendation,
      bestSlot: primarySlot ? {
        hour: primarySlot.hour,
        hourLabel: this._formatHour(primarySlot.hour),
        day: primarySlot.day,
        dayLabel: DAY_LABELS[primarySlot.day] || primarySlot.day,
        expectedConversionRate: primarySlot.conversionRate?.toFixed(1),
        expectedClickRate: primarySlot.clickRate?.toFixed(1),
        campaigns: primarySlot.campaigns
      } : null,
      alternatives: alternatives.map(s => ({
        hour: s.hour,
        hourLabel: this._formatHour(s.hour),
        day: s.day,
        dayLabel: DAY_LABELS[s.day] || s.day,
        expectedConversionRate: s.conversionRate?.toFixed(1),
        expectedClickRate: s.clickRate?.toFixed(1),
        campaigns: s.campaigns
      })),
      globalAverages: {
        clickRate: globalAvgs.avgClickRate?.toFixed(1),
        conversionRate: globalAvgs.avgConversionRate?.toFixed(1),
        revenue: globalAvgs.avgRevenue?.toFixed(0),
        revenuePerSms: globalAvgs.avgRevenuePerSms?.toFixed(2),
        avgMinutesToClick: globalAvgs.avgMinutesToClick?.toFixed(0),
        avgMinutesToConvert: globalAvgs.avgMinutesToConvert?.toFixed(0)
      },
      byHour,
      byDay,
      heatmap
    };
  }

  /**
   * Get all time reports sorted by date
   */
  async getReports(options = {}) {
    const SmsCampaignTimeReport = mongoose.model('SmsCampaignTimeReport');
    const { limit = 50, status } = options;

    const query = {};
    if (status) query.status = status;

    return SmsCampaignTimeReport.find(query)
      .sort({ sentAt: -1 })
      .limit(limit)
      .lean();
  }

  /**
   * Get single report detail
   */
  async getReport(reportId) {
    const SmsCampaignTimeReport = mongoose.model('SmsCampaignTimeReport');
    return SmsCampaignTimeReport.findById(reportId).populate('campaign').lean();
  }

  /**
   * Create a pending report when a campaign starts sending
   */
  async createPendingReport(campaignId) {
    const SmsCampaign = mongoose.model('SmsCampaign');
    const SmsCampaignTimeReport = mongoose.model('SmsCampaignTimeReport');

    const campaign = await SmsCampaign.findById(campaignId);
    if (!campaign) return null;

    const existing = await SmsCampaignTimeReport.findOne({ campaign: campaignId });
    if (existing) return existing;

    const sentAt = campaign.startedAt || new Date();
    const etOptions = { timeZone: 'America/New_York' };
    const sentHour = parseInt(sentAt.toLocaleString('en-US', { ...etOptions, hour: 'numeric', hour12: false }));
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const sentDay = dayNames[new Date(sentAt.toLocaleString('en-US', etOptions)).getDay()];
    const dayOfWeek = new Date(sentAt.toLocaleString('en-US', etOptions)).getDay();

    return SmsCampaignTimeReport.create({
      campaign: campaignId,
      campaignName: campaign.name,
      sentAt,
      sentAtHour: sentHour,
      sentAtDay: sentDay,
      sentAtDayOfWeek: dayOfWeek,
      isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
      audienceType: campaign.audienceType,
      audienceSize: campaign.stats?.eligible || 0,
      targetCountry: campaign.targetCountry,
      status: 'pending'
    });
  }

  // ==================== PRIVATE HELPERS ====================

  _formatHour(hour) {
    if (hour === 0) return '12:00 AM';
    if (hour === 12) return '12:00 PM';
    return hour > 12 ? `${hour - 12}:00 PM` : `${hour}:00 AM`;
  }

  _buildAnalysisPrompt(report, globalAvgs) {
    return {
      system: `Eres un analista experto de SMS marketing para Jersey Pickles (tienda de pickles artesanales).
Analiza el rendimiento de esta campaña SMS en relación a la hora de envío.
Responde SIEMPRE en formato JSON con esta estructura exacta:
{
  "overallScore": <number 1-10>,
  "timingScore": <number 1-10>,
  "engagementScore": <number 1-10>,
  "summary": "<2-3 sentences en español>",
  "recommendation": "<1-2 sentences en español sobre el timing>"
}`,
      user: `Campaña: "${report.campaignName}"
Enviada: ${report.sentAtDay} ${this._formatHour(report.sentAtHour)} ET
Weekend: ${report.isWeekend ? 'Sí' : 'No'}

Rendimiento:
- Delivery: ${report.performance.deliveryRate}%
- Clicks: ${report.performance.totalClicks} (${report.performance.clickRate}% CTR)
- Conversiones: ${report.performance.conversions} (${report.performance.conversionRate}%)
- Revenue: $${report.performance.revenue}
- Revenue/SMS: $${report.performance.revenuePerSms}
- Unsubs: ${report.performance.unsubscribes} (${report.performance.unsubRate}%)

Velocidad:
- Avg click: ${report.responseSpeed.avgMinutesToClick} min
- 75% clicks en < 30 min: ${report.responseSpeed.clicksWithin30min}
- Avg conversión: ${report.responseSpeed.avgMinutesToConvert} min
- Conv < 1hr: ${report.responseSpeed.conversionsWithin1hr}
- Conv < 24hr: ${report.responseSpeed.conversionsWithin24hr}

Promedios globales (${globalAvgs.totalCampaigns} campañas):
- CTR promedio: ${globalAvgs.avgClickRate?.toFixed(1)}%
- Conv promedio: ${globalAvgs.avgConversionRate?.toFixed(1)}%
- Revenue promedio: $${globalAvgs.avgRevenue?.toFixed(0)}

Contexto: ${report.context.season}, descuento ${report.context.discountPercent || 'N/A'}%`
    };
  }

  _buildRecommendationPrompt(byHour, byDay, heatmap, globalAvgs) {
    const topHours = [...byHour].sort((a, b) => b.avgConversionRate - a.avgConversionRate).slice(0, 5);
    const topSlots = heatmap
      .map(h => ({ ...h, score: (h.avgConversionRate * 0.5) + (h.avgClickRate * 0.3) + ((h.avgRevenue / 100) * 0.2) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    return {
      system: `Eres un estratega de SMS marketing para Jersey Pickles. Genera una recomendación concisa (2-3 frases en español) sobre la mejor hora y día para enviar la próxima campaña SMS. Sé específico con horas y días.`,
      user: `Datos de ${globalAvgs.totalCampaigns} campañas:

Top horas por conversión:
${topHours.map(h => `  ${this._formatHour(h._id)}: ${h.avgConversionRate?.toFixed(1)}% conv, ${h.avgClickRate?.toFixed(1)}% CTR, $${h.avgRevenue?.toFixed(0)} rev (${h.campaigns} camp)`).join('\n')}

Top slots (hora+día):
${topSlots.map(s => `  ${DAY_LABELS[s._id.day] || s._id.day} ${this._formatHour(s._id.hour)}: ${s.avgConversionRate?.toFixed(1)}% conv, ${s.avgClickRate?.toFixed(1)}% CTR`).join('\n')}

Promedios globales: CTR ${globalAvgs.avgClickRate?.toFixed(1)}%, Conv ${globalAvgs.avgConversionRate?.toFixed(1)}%, Rev $${globalAvgs.avgRevenue?.toFixed(0)}`
    };
  }

  _parseAIResponse(content) {
    try {
      // Try to extract JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          overallScore: Math.min(10, Math.max(0, Number(parsed.overallScore) || 5)),
          timingScore: Math.min(10, Math.max(0, Number(parsed.timingScore) || 5)),
          engagementScore: Math.min(10, Math.max(0, Number(parsed.engagementScore) || 5)),
          summary: parsed.summary || '',
          recommendation: parsed.recommendation || ''
        };
      }
    } catch (e) {
      // Parsing failed
    }

    return {
      overallScore: 5,
      timingScore: 5,
      engagementScore: 5,
      summary: content.substring(0, 300),
      recommendation: ''
    };
  }

  _buildFallbackAnalysis(report, globalAvgs, clickDiff, convDiff, revDiff) {
    const perf = report.performance;
    const overallScore = Math.min(10, Math.max(1,
      (perf.conversionRate / Math.max(globalAvgs.avgConversionRate, 0.1)) * 5 +
      (perf.clickRate / Math.max(globalAvgs.avgClickRate, 0.1)) * 3 +
      (perf.revenue / Math.max(globalAvgs.avgRevenue, 1)) * 2
    ));

    const dayLabel = DAY_LABELS[report.sentAtDay] || report.sentAtDay;
    const hourLabel = this._formatHour(report.sentAtHour);
    const isAboveAvg = perf.conversionRate > globalAvgs.avgConversionRate;

    return {
      overallScore: parseFloat(overallScore.toFixed(1)),
      timingScore: parseFloat((overallScore * 0.9).toFixed(1)),
      engagementScore: parseFloat((overallScore * 1.1 > 10 ? 10 : overallScore * 1.1).toFixed(1)),
      summary: `Campaña enviada ${dayLabel} ${hourLabel} ET. ${isAboveAvg ? 'Rendimiento superior al promedio' : 'Rendimiento por debajo del promedio'} con ${perf.conversionRate}% conversión vs ${globalAvgs.avgConversionRate?.toFixed(1)}% promedio.`,
      recommendation: isAboveAvg
        ? `${dayLabel} a las ${hourLabel} es un buen horario. Conversiones ${convDiff > 0 ? '+' : ''}${convDiff}% vs promedio.`
        : `Considerar otros horarios. Este slot tuvo ${convDiff}% vs promedio en conversiones.`,
      comparedToAvg: {
        clickRateVsAvg: `${clickDiff > 0 ? '+' : ''}${clickDiff}%`,
        conversionRateVsAvg: `${convDiff > 0 ? '+' : ''}${convDiff}%`,
        revenueVsAvg: `${revDiff > 0 ? '+$' : '-$'}${Math.abs(revDiff)}`
      }
    };
  }
}

module.exports = new SmartScheduleService();
