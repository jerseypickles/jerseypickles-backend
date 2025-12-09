// backend/src/routes/analytics.js (VERSIÓN PROFESIONAL)
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { auth } = require('../middleware/auth');
const Customer = require('../models/Customer');
const Campaign = require('../models/Campaign');
const Order = require('../models/Order');
const EmailEvent = require('../models/EmailEvent');

// ============================================================
// HELPER: Obtener rango de fechas
// ============================================================
const getDateRange = (days, endDate = new Date()) => {
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);
  
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);
  
  return { start, end };
};

// ============================================================
// 1. DASHBOARD PRINCIPAL (MEJORADO)
// ============================================================
router.get('/dashboard', auth, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const { start, end } = getDateRange(parseInt(days));
    
    // ========== CUSTOMERS ==========
    const [totalCustomers, marketingAccepted, newCustomers] = await Promise.all([
      Customer.countDocuments(),
      Customer.countDocuments({ acceptsMarketing: true, emailStatus: 'active' }),
      Customer.countDocuments({ createdAt: { $gte: start } })
    ]);
    
    // ========== CAMPAIGNS ==========
    const campaignStats = await Campaign.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);
    
    const campaigns = {
      total: 0,
      sent: 0,
      draft: 0,
      sending: 0,
      scheduled: 0
    };
    campaignStats.forEach(s => {
      campaigns[s._id] = s.count;
      campaigns.total += s.count;
    });
    
    // ========== EMAIL STATS (período actual) ==========
    const emailStats = await EmailEvent.aggregate([
      { $match: { eventDate: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: '$eventType',
          count: { $sum: 1 }
        }
      }
    ]);
    
    const emails = {
      sent: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0
    };
    emailStats.forEach(s => {
      if (emails.hasOwnProperty(s._id)) {
        emails[s._id] = s.count;
      }
    });
    
    // Calcular rates
    const openRate = emails.sent > 0 ? ((emails.opened / emails.sent) * 100).toFixed(2) : 0;
    const clickRate = emails.sent > 0 ? ((emails.clicked / emails.sent) * 100).toFixed(2) : 0;
    const bounceRate = emails.sent > 0 ? ((emails.bounced / emails.sent) * 100).toFixed(2) : 0;
    const ctr = emails.opened > 0 ? ((emails.clicked / emails.opened) * 100).toFixed(2) : 0;
    
    // ========== ORDERS & REVENUE ==========
    const orderStats = await Order.aggregate([
      { $match: { orderDate: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          revenue: { $sum: '$totalPrice' },
          avgOrderValue: { $avg: '$totalPrice' }
        }
      }
    ]);
    
    // ========== EMAIL REVENUE (atribuido a campañas) ==========
    const emailRevenue = await Order.aggregate([
      {
        $match: {
          orderDate: { $gte: start, $lte: end },
          'attribution.campaign': { $exists: true, $ne: null }
        }
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$totalPrice' },
          orderCount: { $sum: 1 },
          avgOrderValue: { $avg: '$totalPrice' }
        }
      }
    ]);
    
    const emailRevenueData = emailRevenue[0] || { totalRevenue: 0, orderCount: 0, avgOrderValue: 0 };
    const revenuePerEmail = emails.sent > 0 ? (emailRevenueData.totalRevenue / emails.sent) : 0;
    
    // ========== PERÍODO ANTERIOR (para comparación) ==========
    const prevRange = getDateRange(parseInt(days) * 2, start);
    const prevEmailStats = await EmailEvent.aggregate([
      { $match: { eventDate: { $gte: prevRange.start, $lte: start } } },
      {
        $group: {
          _id: '$eventType',
          count: { $sum: 1 }
        }
      }
    ]);
    
    const prevEmails = { sent: 0, opened: 0, clicked: 0 };
    prevEmailStats.forEach(s => {
      if (prevEmails.hasOwnProperty(s._id)) {
        prevEmails[s._id] = s.count;
      }
    });
    
    const prevOpenRate = prevEmails.sent > 0 ? ((prevEmails.opened / prevEmails.sent) * 100) : 0;
    const prevClickRate = prevEmails.sent > 0 ? ((prevEmails.clicked / prevEmails.sent) * 100) : 0;
    
    // ========== RESPONSE ==========
    res.json({
      period: { start, end, days: parseInt(days) },
      customers: {
        total: totalCustomers,
        marketingAccepted,
        acceptanceRate: totalCustomers > 0 
          ? ((marketingAccepted / totalCustomers) * 100).toFixed(2) + '%' 
          : '0%',
        newThisPeriod: newCustomers
      },
      orders: {
        total: orderStats[0]?.total || 0,
        revenue: (orderStats[0]?.revenue || 0).toFixed(2),
        avgOrderValue: (orderStats[0]?.avgOrderValue || 0).toFixed(2),
        // Email attribution
        emailRevenue: emailRevenueData.totalRevenue.toFixed(2),
        emailConversions: emailRevenueData.orderCount,
        avgEmailOrderValue: (emailRevenueData.avgOrderValue || 0).toFixed(2),
        revenuePerEmail: revenuePerEmail.toFixed(3)
      },
      campaigns,
      emails: {
        sent: emails.sent,
        opened: emails.opened,
        clicked: emails.clicked,
        bounced: emails.bounced,
        unsubscribed: emails.unsubscribed,
        openRate: openRate + '%',
        clickRate: clickRate + '%',
        bounceRate: bounceRate + '%',
        clickToOpenRate: ctr + '%'
      },
      comparison: {
        openRateChange: (parseFloat(openRate) - prevOpenRate).toFixed(2),
        clickRateChange: (parseFloat(clickRate) - prevClickRate).toFixed(2),
        sentChange: emails.sent - prevEmails.sent
      }
    });
    
  } catch (error) {
    console.error('Error en analytics dashboard:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 2. FUNNEL DE CONVERSIÓN
// ============================================================
router.get('/funnel', auth, async (req, res) => {
  try {
    const { days = 30, campaignId } = req.query;
    const { start, end } = getDateRange(parseInt(days));
    
    const matchStage = { eventDate: { $gte: start, $lte: end } };
    if (campaignId) {
      matchStage.campaign = new mongoose.Types.ObjectId(campaignId);
    }
    
    // Obtener counts por tipo de evento
    const eventCounts = await EmailEvent.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: '$eventType',
          count: { $sum: 1 },
          uniqueCustomers: { $addToSet: '$customer' }
        }
      },
      {
        $project: {
          _id: 1,
          count: 1,
          uniqueCount: { $size: '$uniqueCustomers' }
        }
      }
    ]);
    
    // Obtener conversiones (purchases atribuidas)
    const purchaseMatch = {
      orderDate: { $gte: start, $lte: end },
      'attribution.campaign': { $exists: true, $ne: null }
    };
    if (campaignId) {
      purchaseMatch['attribution.campaign'] = new mongoose.Types.ObjectId(campaignId);
    }
    
    const purchases = await Order.aggregate([
      { $match: purchaseMatch },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          revenue: { $sum: '$totalPrice' },
          uniqueCustomers: { $addToSet: '$customer' }
        }
      }
    ]);
    
    // Construir funnel
    const getCount = (type) => eventCounts.find(e => e._id === type)?.count || 0;
    const getUnique = (type) => eventCounts.find(e => e._id === type)?.uniqueCount || 0;
    
    const sent = getCount('sent');
    const delivered = getCount('delivered') || sent; // fallback si no trackeas delivered
    const opened = getCount('opened');
    const clicked = getCount('clicked');
    const purchased = purchases[0]?.count || 0;
    const revenue = purchases[0]?.revenue || 0;
    
    const funnel = [
      {
        stage: 'sent',
        label: 'Emails Enviados',
        count: sent,
        uniqueCount: getUnique('sent'),
        rate: '100%',
        dropOff: 0
      },
      {
        stage: 'delivered',
        label: 'Entregados',
        count: delivered,
        rate: sent > 0 ? ((delivered / sent) * 100).toFixed(2) + '%' : '0%',
        dropOff: sent > 0 ? (((sent - delivered) / sent) * 100).toFixed(2) : 0
      },
      {
        stage: 'opened',
        label: 'Abiertos',
        count: opened,
        uniqueCount: getUnique('opened'),
        rate: delivered > 0 ? ((opened / delivered) * 100).toFixed(2) + '%' : '0%',
        dropOff: delivered > 0 ? (((delivered - opened) / delivered) * 100).toFixed(2) : 0
      },
      {
        stage: 'clicked',
        label: 'Clicks',
        count: clicked,
        uniqueCount: getUnique('clicked'),
        rate: opened > 0 ? ((clicked / opened) * 100).toFixed(2) + '%' : '0%',
        dropOff: opened > 0 ? (((opened - clicked) / opened) * 100).toFixed(2) : 0
      },
      {
        stage: 'purchased',
        label: 'Compraron',
        count: purchased,
        uniqueCount: purchases[0]?.uniqueCustomers?.length || 0,
        rate: clicked > 0 ? ((purchased / clicked) * 100).toFixed(2) + '%' : '0%',
        dropOff: clicked > 0 ? (((clicked - purchased) / clicked) * 100).toFixed(2) : 0,
        revenue: revenue.toFixed(2)
      }
    ];
    
    // Calcular overall conversion rate
    const overallConversion = sent > 0 ? ((purchased / sent) * 100).toFixed(3) : 0;
    
    res.json({
      period: { start, end, days: parseInt(days) },
      campaignId: campaignId || 'all',
      funnel,
      summary: {
        totalSent: sent,
        totalPurchased: purchased,
        conversionRate: overallConversion + '%',
        totalRevenue: revenue.toFixed(2),
        revenuePerEmail: sent > 0 ? (revenue / sent).toFixed(3) : '0.000'
      }
    });
    
  } catch (error) {
    console.error('Error en funnel:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 3. TENDENCIAS TEMPORALES (para gráficos)
// ============================================================
router.get('/trends', auth, async (req, res) => {
  try {
    const { days = 30, granularity = 'day' } = req.query;
    const { start, end } = getDateRange(parseInt(days));
    
    // Formato de fecha según granularidad
    let dateFormat;
    switch (granularity) {
      case 'hour':
        dateFormat = '%Y-%m-%d %H:00';
        break;
      case 'week':
        dateFormat = '%Y-W%V';
        break;
      case 'month':
        dateFormat = '%Y-%m';
        break;
      default:
        dateFormat = '%Y-%m-%d';
    }
    
    // Email events timeline
    const emailTrends = await EmailEvent.aggregate([
      { $match: { eventDate: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: dateFormat, date: '$eventDate' } },
            type: '$eventType'
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.date': 1 } }
    ]);
    
    // Revenue timeline
    const revenueTrends = await Order.aggregate([
      { $match: { orderDate: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: '$orderDate' } },
          revenue: { $sum: '$totalPrice' },
          orders: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    // Email revenue timeline
    const emailRevenueTrends = await Order.aggregate([
      {
        $match: {
          orderDate: { $gte: start, $lte: end },
          'attribution.campaign': { $exists: true, $ne: null }
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: '$orderDate' } },
          emailRevenue: { $sum: '$totalPrice' },
          emailOrders: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    // Combinar datos por fecha
    const dateMap = new Map();
    
    // Inicializar todas las fechas en el rango
    const currentDate = new Date(start);
    while (currentDate <= end) {
      const dateStr = currentDate.toISOString().split('T')[0];
      dateMap.set(dateStr, {
        date: dateStr,
        sent: 0,
        opened: 0,
        clicked: 0,
        bounced: 0,
        revenue: 0,
        orders: 0,
        emailRevenue: 0,
        emailOrders: 0,
        openRate: 0,
        clickRate: 0
      });
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    // Llenar con datos de emails
    emailTrends.forEach(item => {
      const date = item._id.date;
      if (dateMap.has(date)) {
        const data = dateMap.get(date);
        data[item._id.type] = item.count;
      }
    });
    
    // Llenar con datos de revenue
    revenueTrends.forEach(item => {
      if (dateMap.has(item._id)) {
        const data = dateMap.get(item._id);
        data.revenue = parseFloat(item.revenue.toFixed(2));
        data.orders = item.orders;
      }
    });
    
    // Llenar con email revenue
    emailRevenueTrends.forEach(item => {
      if (dateMap.has(item._id)) {
        const data = dateMap.get(item._id);
        data.emailRevenue = parseFloat(item.emailRevenue.toFixed(2));
        data.emailOrders = item.emailOrders;
      }
    });
    
    // Calcular rates por día
    const trends = Array.from(dateMap.values()).map(day => ({
      ...day,
      openRate: day.sent > 0 ? parseFloat(((day.opened / day.sent) * 100).toFixed(2)) : 0,
      clickRate: day.sent > 0 ? parseFloat(((day.clicked / day.sent) * 100).toFixed(2)) : 0
    }));
    
    res.json({
      period: { start, end, days: parseInt(days), granularity },
      trends
    });
    
  } catch (error) {
    console.error('Error en trends:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 4. TOP CAMPAIGNS POR REVENUE
// ============================================================
router.get('/top-campaigns', auth, async (req, res) => {
  try {
    const { days = 90, limit = 10 } = req.query;
    const { start, end } = getDateRange(parseInt(days));
    
    // Campañas con sus stats
    const campaigns = await Campaign.find({
      status: 'sent',
      sentAt: { $gte: start, $lte: end }
    })
    .select('name subject sentAt stats segment')
    .populate('segment', 'name')
    .sort({ 'stats.totalRevenue': -1 })
    .limit(parseInt(limit));
    
    // Enriquecer con datos de Orders
    const enrichedCampaigns = await Promise.all(
      campaigns.map(async (campaign) => {
        const orders = await Order.aggregate([
          { $match: { 'attribution.campaign': campaign._id } },
          {
            $group: {
              _id: null,
              revenue: { $sum: '$totalPrice' },
              orders: { $sum: 1 },
              avgOrderValue: { $avg: '$totalPrice' }
            }
          }
        ]);
        
        const orderData = orders[0] || { revenue: 0, orders: 0, avgOrderValue: 0 };
        
        return {
          _id: campaign._id,
          name: campaign.name,
          subject: campaign.subject,
          sentAt: campaign.sentAt,
          segment: campaign.segment?.name || 'N/A',
          stats: {
            sent: campaign.stats.sent,
            opened: campaign.stats.opened,
            clicked: campaign.stats.clicked,
            openRate: campaign.stats.openRate,
            clickRate: campaign.stats.clickRate
          },
          revenue: {
            total: orderData.revenue.toFixed(2),
            orders: orderData.orders,
            avgOrderValue: orderData.avgOrderValue.toFixed(2),
            revenuePerEmail: campaign.stats.sent > 0 
              ? (orderData.revenue / campaign.stats.sent).toFixed(3) 
              : '0.000'
          }
        };
      })
    );
    
    res.json({
      period: { start, end, days: parseInt(days) },
      campaigns: enrichedCampaigns
    });
    
  } catch (error) {
    console.error('Error en top campaigns:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 5. BEST SEND TIMES (HEATMAP DATA)
// ============================================================
router.get('/best-times', auth, async (req, res) => {
  try {
    const { days = 90, metric = 'opened' } = req.query;
    const { start, end } = getDateRange(parseInt(days));
    
    // Obtener eventos agrupados por día de semana y hora
    const events = await EmailEvent.aggregate([
      {
        $match: {
          eventDate: { $gte: start, $lte: end },
          eventType: { $in: ['sent', 'opened', 'clicked'] }
        }
      },
      {
        $group: {
          _id: {
            dayOfWeek: { $dayOfWeek: '$eventDate' }, // 1=Sunday, 7=Saturday
            hour: { $hour: '$eventDate' },
            type: '$eventType'
          },
          count: { $sum: 1 }
        }
      }
    ]);
    
    // Crear matriz de heatmap (7 días x 24 horas)
    const heatmap = [];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    
    for (let day = 1; day <= 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const sent = events.find(e => 
          e._id.dayOfWeek === day && e._id.hour === hour && e._id.type === 'sent'
        )?.count || 0;
        
        const opened = events.find(e => 
          e._id.dayOfWeek === day && e._id.hour === hour && e._id.type === 'opened'
        )?.count || 0;
        
        const clicked = events.find(e => 
          e._id.dayOfWeek === day && e._id.hour === hour && e._id.type === 'clicked'
        )?.count || 0;
        
        const openRate = sent > 0 ? (opened / sent) * 100 : 0;
        const clickRate = sent > 0 ? (clicked / sent) * 100 : 0;
        
        heatmap.push({
          day: day - 1, // 0-indexed para frontend
          dayName: dayNames[day - 1],
          hour,
          hourLabel: `${hour.toString().padStart(2, '0')}:00`,
          sent,
          opened,
          clicked,
          openRate: parseFloat(openRate.toFixed(2)),
          clickRate: parseFloat(clickRate.toFixed(2)),
          value: metric === 'clicked' ? clickRate : openRate
        });
      }
    }
    
    // Encontrar mejores horarios
    const sortedByMetric = [...heatmap]
      .filter(h => h.sent >= 10) // Mínimo de emails para ser significativo
      .sort((a, b) => b.value - a.value);
    
    const bestTimes = sortedByMetric.slice(0, 5).map(t => ({
      day: t.dayName,
      hour: t.hourLabel,
      rate: t.value.toFixed(2) + '%',
      sampleSize: t.sent
    }));
    
    res.json({
      period: { start, end, days: parseInt(days) },
      metric,
      heatmap,
      bestTimes,
      recommendation: bestTimes[0] 
        ? `Best time: ${bestTimes[0].day} at ${bestTimes[0].hour} (${bestTimes[0].rate} ${metric} rate)`
        : 'Not enough data for recommendation'
    });
    
  } catch (error) {
    console.error('Error en best times:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 6. SEGMENT PERFORMANCE
// ============================================================
router.get('/segment-performance', auth, async (req, res) => {
  try {
    const { days = 90 } = req.query;
    const { start, end } = getDateRange(parseInt(days));
    
    // Obtener campañas con sus segmentos
    const campaignsBySegment = await Campaign.aggregate([
      {
        $match: {
          status: 'sent',
          sentAt: { $gte: start, $lte: end },
          segment: { $exists: true, $ne: null }
        }
      },
      {
        $lookup: {
          from: 'segments',
          localField: 'segment',
          foreignField: '_id',
          as: 'segmentData'
        }
      },
      { $unwind: '$segmentData' },
      {
        $group: {
          _id: '$segment',
          segmentName: { $first: '$segmentData.name' },
          campaigns: { $sum: 1 },
          totalSent: { $sum: '$stats.sent' },
          totalOpened: { $sum: '$stats.opened' },
          totalClicked: { $sum: '$stats.clicked' },
          totalRevenue: { $sum: '$stats.totalRevenue' },
          totalPurchased: { $sum: '$stats.purchased' }
        }
      },
      { $sort: { totalRevenue: -1 } }
    ]);
    
    // Calcular rates
    const segments = campaignsBySegment.map(seg => ({
      segmentId: seg._id,
      name: seg.segmentName,
      campaigns: seg.campaigns,
      metrics: {
        sent: seg.totalSent,
        opened: seg.totalOpened,
        clicked: seg.totalClicked,
        purchased: seg.totalPurchased
      },
      rates: {
        openRate: seg.totalSent > 0 
          ? ((seg.totalOpened / seg.totalSent) * 100).toFixed(2) + '%'
          : '0%',
        clickRate: seg.totalSent > 0 
          ? ((seg.totalClicked / seg.totalSent) * 100).toFixed(2) + '%'
          : '0%',
        conversionRate: seg.totalSent > 0 
          ? ((seg.totalPurchased / seg.totalSent) * 100).toFixed(3) + '%'
          : '0%'
      },
      revenue: {
        total: seg.totalRevenue.toFixed(2),
        perEmail: seg.totalSent > 0 
          ? (seg.totalRevenue / seg.totalSent).toFixed(3)
          : '0.000'
      }
    }));
    
    res.json({
      period: { start, end, days: parseInt(days) },
      segments
    });
    
  } catch (error) {
    console.error('Error en segment performance:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 7. CAMPAIGN COMPARISON (A/B o múltiples)
// ============================================================
router.get('/compare-campaigns', auth, async (req, res) => {
  try {
    const { ids } = req.query; // comma-separated campaign IDs
    
    if (!ids) {
      return res.status(400).json({ error: 'Provide campaign IDs as ?ids=id1,id2,id3' });
    }
    
    const campaignIds = ids.split(',').map(id => new mongoose.Types.ObjectId(id.trim()));
    
    const campaigns = await Campaign.find({ _id: { $in: campaignIds } })
      .select('name subject sentAt stats segment')
      .populate('segment', 'name');
    
    // Enriquecer con revenue real
    const comparison = await Promise.all(
      campaigns.map(async (campaign) => {
        const revenue = await Order.getCampaignRevenue(campaign._id);
        
        return {
          _id: campaign._id,
          name: campaign.name,
          subject: campaign.subject,
          sentAt: campaign.sentAt,
          segment: campaign.segment?.name || 'N/A',
          metrics: {
            sent: campaign.stats.sent,
            opened: campaign.stats.opened,
            clicked: campaign.stats.clicked,
            bounced: campaign.stats.bounced,
            unsubscribed: campaign.stats.unsubscribed
          },
          rates: {
            openRate: campaign.stats.openRate,
            clickRate: campaign.stats.clickRate,
            bounceRate: campaign.stats.bounceRate,
            unsubscribeRate: campaign.stats.unsubscribeRate
          },
          revenue: {
            total: revenue.totalRevenue.toFixed(2),
            orders: revenue.orderCount,
            avgOrderValue: revenue.avgOrderValue.toFixed(2),
            revenuePerEmail: campaign.stats.sent > 0 
              ? (revenue.totalRevenue / campaign.stats.sent).toFixed(3)
              : '0.000'
          }
        };
      })
    );
    
    // Calcular winner (por revenue per email)
    const sorted = [...comparison].sort((a, b) => 
      parseFloat(b.revenue.revenuePerEmail) - parseFloat(a.revenue.revenuePerEmail)
    );
    
    res.json({
      campaigns: comparison,
      winner: sorted[0] ? {
        campaignId: sorted[0]._id,
        name: sorted[0].name,
        reason: `Highest revenue per email: $${sorted[0].revenue.revenuePerEmail}`
      } : null
    });
    
  } catch (error) {
    console.error('Error en compare campaigns:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 8. DELIVERABILITY HEALTH
// ============================================================
router.get('/deliverability', auth, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const { start, end } = getDateRange(parseInt(days));
    
    // Stats de bounce y complaints
    const bounceStats = await Customer.getBounceStats();
    
    // Unsubscribe trend
    const unsubscribeTrend = await EmailEvent.aggregate([
      {
        $match: {
          eventDate: { $gte: start, $lte: end },
          eventType: 'unsubscribed'
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$eventDate' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    // Bounce trend
    const bounceTrend = await EmailEvent.aggregate([
      {
        $match: {
          eventDate: { $gte: start, $lte: end },
          eventType: 'bounced'
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$eventDate' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    // Email stats del período
    const periodStats = await EmailEvent.aggregate([
      { $match: { eventDate: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: '$eventType',
          count: { $sum: 1 }
        }
      }
    ]);
    
    const stats = {
      sent: 0, delivered: 0, bounced: 0, complained: 0, unsubscribed: 0
    };
    periodStats.forEach(s => {
      if (stats.hasOwnProperty(s._id)) {
        stats[s._id] = s.count;
      }
    });
    
    // Calcular health score (0-100)
    let healthScore = 100;
    const bounceRate = stats.sent > 0 ? (stats.bounced / stats.sent) * 100 : 0;
    const complaintRate = stats.sent > 0 ? (stats.complained / stats.sent) * 100 : 0;
    const unsubRate = stats.sent > 0 ? (stats.unsubscribed / stats.sent) * 100 : 0;
    
    // Penalizaciones
    if (bounceRate > 5) healthScore -= 30;
    else if (bounceRate > 2) healthScore -= 15;
    else if (bounceRate > 1) healthScore -= 5;
    
    if (complaintRate > 0.1) healthScore -= 30;
    else if (complaintRate > 0.05) healthScore -= 15;
    
    if (unsubRate > 2) healthScore -= 20;
    else if (unsubRate > 1) healthScore -= 10;
    
    const healthStatus = healthScore >= 80 ? 'healthy' : 
                         healthScore >= 60 ? 'warning' : 'critical';
    
    res.json({
      period: { start, end, days: parseInt(days) },
      health: {
        score: Math.max(0, healthScore),
        status: healthStatus,
        message: healthScore >= 80 
          ? 'Your email health is good!'
          : healthScore >= 60
            ? 'Some issues detected, review bounce and complaint rates'
            : 'Critical issues - high bounce/complaint rates may affect deliverability'
      },
      metrics: {
        sent: stats.sent,
        delivered: stats.delivered || stats.sent - stats.bounced,
        bounced: stats.bounced,
        complained: stats.complained,
        unsubscribed: stats.unsubscribed
      },
      rates: {
        deliveryRate: stats.sent > 0 
          ? (((stats.sent - stats.bounced) / stats.sent) * 100).toFixed(2) + '%'
          : '0%',
        bounceRate: bounceRate.toFixed(2) + '%',
        complaintRate: complaintRate.toFixed(3) + '%',
        unsubscribeRate: unsubRate.toFixed(2) + '%'
      },
      bounceStats: {
        total: bounceStats.totalBounced,
        hard: bounceStats.hardBounces,
        soft: bounceStats.softBounces,
        recentBounces: bounceStats.recentBounces
      },
      trends: {
        bounces: bounceTrend,
        unsubscribes: unsubscribeTrend
      }
    });
    
  } catch (error) {
    console.error('Error en deliverability:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 9. TOP CUSTOMERS (mejorado)
// ============================================================
router.get('/top-customers', auth, async (req, res) => {
  try {
    const { limit = 10, sortBy = 'totalSpent' } = req.query;
    
    const sortOptions = {
      totalSpent: { totalSpent: -1 },
      ordersCount: { ordersCount: -1 },
      emailEngagement: { 'emailStats.clicked': -1 }
    };
    
    const topCustomers = await Customer.find({ 
      acceptsMarketing: true,
      emailStatus: 'active'
    })
    .sort(sortOptions[sortBy] || sortOptions.totalSpent)
    .limit(parseInt(limit))
    .select('email firstName lastName totalSpent ordersCount averageOrderValue emailStats lastOrderDate');
    
    res.json({
      sortedBy: sortBy,
      customers: topCustomers.map(c => ({
        _id: c._id,
        email: c.email,
        name: `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'N/A',
        totalSpent: c.totalSpent?.toFixed(2) || '0.00',
        ordersCount: c.ordersCount || 0,
        averageOrderValue: c.averageOrderValue?.toFixed(2) || '0.00',
        lastOrderDate: c.lastOrderDate,
        emailEngagement: {
          sent: c.emailStats?.sent || 0,
          opened: c.emailStats?.opened || 0,
          clicked: c.emailStats?.clicked || 0,
          openRate: c.emailStats?.sent > 0 
            ? ((c.emailStats.opened / c.emailStats.sent) * 100).toFixed(2) + '%'
            : '0%'
        }
      }))
    });
    
  } catch (error) {
    console.error('Error obteniendo top customers:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 10. REVENUE TIMELINE (original mejorado)
// ============================================================
router.get('/revenue-timeline', auth, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const { start, end } = getDateRange(parseInt(days));
    
    // Revenue total
    const totalTimeline = await Order.aggregate([
      { $match: { orderDate: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$orderDate' } },
          revenue: { $sum: '$totalPrice' },
          orders: { $sum: 1 },
          avgOrderValue: { $avg: '$totalPrice' }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    // Revenue de email
    const emailTimeline = await Order.aggregate([
      {
        $match: {
          orderDate: { $gte: start, $lte: end },
          'attribution.campaign': { $exists: true, $ne: null }
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$orderDate' } },
          emailRevenue: { $sum: '$totalPrice' },
          emailOrders: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    // Combinar
    const emailMap = new Map(emailTimeline.map(e => [e._id, e]));
    
    const timeline = totalTimeline.map(day => ({
      date: day._id,
      revenue: parseFloat(day.revenue.toFixed(2)),
      orders: day.orders,
      avgOrderValue: parseFloat(day.avgOrderValue.toFixed(2)),
      emailRevenue: parseFloat((emailMap.get(day._id)?.emailRevenue || 0).toFixed(2)),
      emailOrders: emailMap.get(day._id)?.emailOrders || 0,
      emailContribution: day.revenue > 0 
        ? parseFloat(((emailMap.get(day._id)?.emailRevenue || 0) / day.revenue * 100).toFixed(2))
        : 0
    }));
    
    res.json({
      period: { start, end, days: parseInt(days) },
      timeline
    });
    
  } catch (error) {
    console.error('Error en revenue timeline:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 11. EMAIL TIMELINE (original)
// ============================================================
router.get('/email-timeline', auth, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const { start, end } = getDateRange(parseInt(days));
    
    const timeline = await EmailEvent.aggregate([
      { $match: { eventDate: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$eventDate' } },
            type: '$eventType'
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.date': 1 } }
    ]);
    
    // Transformar
    const dateMap = new Map();
    timeline.forEach(item => {
      const date = item._id.date;
      if (!dateMap.has(date)) {
        dateMap.set(date, { date, sent: 0, opened: 0, clicked: 0, bounced: 0, unsubscribed: 0 });
      }
      dateMap.get(date)[item._id.type] = item.count;
    });
    
    res.json({
      period: { start, end, days: parseInt(days) },
      timeline: Array.from(dateMap.values())
    });
    
  } catch (error) {
    console.error('Error en email timeline:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 12. CAMPAIGN PERFORMANCE (original)
// ============================================================
router.get('/campaign-performance', auth, async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    
    const campaigns = await Campaign.find({ status: 'sent' })
      .sort({ sentAt: -1 })
      .limit(parseInt(limit))
      .select('name subject stats sentAt segment')
      .populate('segment', 'name');
    
    res.json(campaigns);
    
  } catch (error) {
    console.error('Error en campaign performance:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;