// backend/src/routes/analytics.js (CORREGIDO - Solo campañas enviadas)
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
// 🆕 HELPER: Obtener IDs de campañas COMPLETADAS en el período
// ============================================================
const getCompletedCampaignIds = async (start, end) => {
  const campaigns = await Campaign.find({
    status: 'sent',
    sentAt: { $gte: start, $lte: end }
  }).select('_id');
  
  return campaigns.map(c => c._id);
};

// ============================================================
// 1. DASHBOARD PRINCIPAL (CORREGIDO)
// ============================================================
router.get('/dashboard', auth, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const { start, end } = getDateRange(parseInt(days));
    
    console.log(`📊 Dashboard request: ${days} days (${start.toISOString()} to ${end.toISOString()})`);
    
    // ========== OBTENER CAMPAÑAS COMPLETADAS ==========
    const completedCampaigns = await Campaign.find({
      status: 'sent',
      sentAt: { $gte: start, $lte: end }
    }).select('_id name stats sentAt');
    
    const campaignIds = completedCampaigns.map(c => c._id);
    
    console.log(`   Found ${completedCampaigns.length} completed campaigns in period`);
    
    // ========== CUSTOMERS ==========
    const [totalCustomers, marketingAccepted, newCustomers] = await Promise.all([
      Customer.countDocuments(),
      Customer.countDocuments({ acceptsMarketing: true, emailStatus: 'active' }),
      Customer.countDocuments({ createdAt: { $gte: start } })
    ]);
    
    // ========== CAMPAIGNS COUNT BY STATUS ==========
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
    
    // ========== EMAIL STATS - SOLO DE CAMPAÑAS COMPLETADAS ==========
    // Opción 1: Agregar desde Campaign.stats (más preciso)
    const emailsFromCampaigns = completedCampaigns.reduce((acc, c) => {
      acc.sent += c.stats?.sent || 0;
      acc.delivered += c.stats?.delivered || 0;
      acc.opened += c.stats?.opened || 0;
      acc.clicked += c.stats?.clicked || 0;
      acc.bounced += c.stats?.bounced || 0;
      acc.unsubscribed += c.stats?.unsubscribed || 0;
      acc.totalRevenue += c.stats?.totalRevenue || 0;
      acc.purchased += c.stats?.purchased || 0;
      return acc;
    }, {
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      bounced: 0,
      unsubscribed: 0,
      totalRevenue: 0,
      purchased: 0
    });
    
    // Opción 2: Si prefieres contar UNIQUE opens/clicks desde EmailEvent
    // (descomenta si quieres unique counts en vez de total events)
    /*
    const uniqueStats = await EmailEvent.aggregate([
      {
        $match: {
          campaign: { $in: campaignIds },
          eventType: { $in: ['opened', 'clicked'] }
        }
      },
      {
        $group: {
          _id: {
            campaign: '$campaign',
            customer: '$customer',
            eventType: '$eventType'
          }
        }
      },
      {
        $group: {
          _id: '$_id.eventType',
          uniqueCount: { $sum: 1 }
        }
      }
    ]);
    
    uniqueStats.forEach(s => {
      if (s._id === 'opened') emailsFromCampaigns.uniqueOpened = s.uniqueCount;
      if (s._id === 'clicked') emailsFromCampaigns.uniqueClicked = s.uniqueCount;
    });
    */
    
    const emails = emailsFromCampaigns;
    
    // Calcular rates
    const openRate = emails.sent > 0 ? ((emails.opened / emails.sent) * 100).toFixed(2) : 0;
    const clickRate = emails.sent > 0 ? ((emails.clicked / emails.sent) * 100).toFixed(2) : 0;
    const bounceRate = emails.sent > 0 ? ((emails.bounced / emails.sent) * 100).toFixed(2) : 0;
    const ctr = emails.opened > 0 ? ((emails.clicked / emails.opened) * 100).toFixed(2) : 0;
    
    // ========== ORDERS & REVENUE (Total) ==========
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
    
    // ========== EMAIL REVENUE (Solo de campañas completadas) ==========
    const emailRevenue = await Order.aggregate([
      {
        $match: {
          orderDate: { $gte: start, $lte: end },
          'attribution.campaign': { $in: campaignIds }
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
    const prevRange = getDateRange(parseInt(days), start);
    
    const prevCampaigns = await Campaign.find({
      status: 'sent',
      sentAt: { $gte: prevRange.start, $lte: prevRange.end }
    }).select('stats');
    
    const prevEmails = prevCampaigns.reduce((acc, c) => {
      acc.sent += c.stats?.sent || 0;
      acc.opened += c.stats?.opened || 0;
      acc.clicked += c.stats?.clicked || 0;
      return acc;
    }, { sent: 0, opened: 0, clicked: 0 });
    
    const prevOpenRate = prevEmails.sent > 0 ? ((prevEmails.opened / prevEmails.sent) * 100) : 0;
    const prevClickRate = prevEmails.sent > 0 ? ((prevEmails.clicked / prevEmails.sent) * 100) : 0;
    
    // ========== RESPONSE ==========
    res.json({
      period: { start, end, days: parseInt(days) },
      campaignsInPeriod: completedCampaigns.length,
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
        emailRevenue: emailRevenueData.totalRevenue.toFixed(2),
        emailConversions: emailRevenueData.orderCount,
        avgEmailOrderValue: (emailRevenueData.avgOrderValue || 0).toFixed(2),
        revenuePerEmail: revenuePerEmail.toFixed(3)
      },
      campaigns,
      emails: {
        sent: emails.sent,
        delivered: emails.delivered,
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
      },
      // Debug info
      _debug: {
        completedCampaignsCount: completedCampaigns.length,
        campaignNames: completedCampaigns.map(c => c.name)
      }
    });
    
  } catch (error) {
    console.error('Error en analytics dashboard:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 2. FUNNEL DE CONVERSIÓN (CORREGIDO)
// ============================================================
router.get('/funnel', auth, async (req, res) => {
  try {
    const { days = 30, campaignId } = req.query;
    const { start, end } = getDateRange(parseInt(days));
    
    let campaignIds = [];
    
    if (campaignId) {
      // Campaña específica
      campaignIds = [new mongoose.Types.ObjectId(campaignId)];
    } else {
      // Solo campañas completadas en el período
      campaignIds = await getCompletedCampaignIds(start, end);
    }
    
    if (campaignIds.length === 0) {
      return res.json({
        period: { start, end, days: parseInt(days) },
        campaignId: campaignId || 'all',
        funnel: [],
        summary: {
          totalSent: 0,
          totalPurchased: 0,
          conversionRate: '0%',
          totalRevenue: '0.00',
          revenuePerEmail: '0.000'
        },
        message: 'No hay campañas completadas en este período'
      });
    }
    
    // Agregar stats desde las campañas (más preciso)
    const campaigns = await Campaign.find({ _id: { $in: campaignIds } });
    
    const totals = campaigns.reduce((acc, c) => {
      acc.sent += c.stats?.sent || 0;
      acc.delivered += c.stats?.delivered || c.stats?.sent || 0;
      acc.opened += c.stats?.opened || 0;
      acc.clicked += c.stats?.clicked || 0;
      acc.purchased += c.stats?.purchased || 0;
      acc.revenue += c.stats?.totalRevenue || 0;
      return acc;
    }, { sent: 0, delivered: 0, opened: 0, clicked: 0, purchased: 0, revenue: 0 });
    
    // Si queremos unique counts, usar EmailEvent con $group
    const uniqueCounts = await EmailEvent.aggregate([
      {
        $match: {
          campaign: { $in: campaignIds },
          eventType: { $in: ['sent', 'opened', 'clicked'] }
        }
      },
      {
        $group: {
          _id: {
            eventType: '$eventType',
            customer: '$customer'
          }
        }
      },
      {
        $group: {
          _id: '$_id.eventType',
          uniqueCount: { $sum: 1 }
        }
      }
    ]);
    
    const unique = { sent: 0, opened: 0, clicked: 0 };
    uniqueCounts.forEach(u => {
      unique[u._id] = u.uniqueCount;
    });
    
    const sent = totals.sent;
    const delivered = totals.delivered || sent;
    const opened = totals.opened;
    const clicked = totals.clicked;
    const purchased = totals.purchased;
    const revenue = totals.revenue;
    
    const funnel = [
      {
        stage: 'sent',
        label: 'Emails Enviados',
        count: sent,
        uniqueCount: unique.sent || sent,
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
        uniqueCount: unique.opened,
        rate: delivered > 0 ? ((opened / delivered) * 100).toFixed(2) + '%' : '0%',
        dropOff: delivered > 0 ? (((delivered - opened) / delivered) * 100).toFixed(2) : 0
      },
      {
        stage: 'clicked',
        label: 'Clicks',
        count: clicked,
        uniqueCount: unique.clicked,
        rate: opened > 0 ? ((clicked / opened) * 100).toFixed(2) + '%' : '0%',
        dropOff: opened > 0 ? (((opened - clicked) / opened) * 100).toFixed(2) : 0
      },
      {
        stage: 'purchased',
        label: 'Compraron',
        count: purchased,
        rate: clicked > 0 ? ((purchased / clicked) * 100).toFixed(2) + '%' : '0%',
        dropOff: clicked > 0 ? (((clicked - purchased) / clicked) * 100).toFixed(2) : 0,
        revenue: revenue.toFixed(2)
      }
    ];
    
    const overallConversion = sent > 0 ? ((purchased / sent) * 100).toFixed(3) : 0;
    
    res.json({
      period: { start, end, days: parseInt(days) },
      campaignId: campaignId || 'all',
      campaignsIncluded: campaignIds.length,
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
// 3. TENDENCIAS TEMPORALES (CORREGIDO)
// ============================================================
router.get('/trends', auth, async (req, res) => {
  try {
    const { days = 30, granularity = 'day' } = req.query;
    const { start, end } = getDateRange(parseInt(days));
    
    // Solo campañas completadas
    const campaignIds = await getCompletedCampaignIds(start, end);
    
    // Formato de fecha según granularidad
    let dateFormat = '%Y-%m-%d';
    if (granularity === 'hour') dateFormat = '%Y-%m-%d %H:00';
    if (granularity === 'week') dateFormat = '%Y-W%V';
    if (granularity === 'month') dateFormat = '%Y-%m';
    
    // Email events de campañas completadas solamente
    const emailTrends = await EmailEvent.aggregate([
      {
        $match: {
          campaign: { $in: campaignIds },
          eventDate: { $gte: start, $lte: end }
        }
      },
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
    
    // Revenue timeline (solo atribuido a campañas completadas)
    const revenueTrends = await Order.aggregate([
      {
        $match: {
          orderDate: { $gte: start, $lte: end },
          'attribution.campaign': { $in: campaignIds }
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
    
    // Total revenue timeline (para comparación)
    const totalRevenueTrends = await Order.aggregate([
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
    
    // Combinar datos por fecha
    const dateMap = new Map();
    
    // Inicializar todas las fechas
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
        dateMap.get(date)[item._id.type] = item.count;
      }
    });
    
    // Llenar con total revenue
    totalRevenueTrends.forEach(item => {
      if (dateMap.has(item._id)) {
        const data = dateMap.get(item._id);
        data.revenue = parseFloat(item.revenue.toFixed(2));
        data.orders = item.orders;
      }
    });
    
    // Llenar con email revenue
    revenueTrends.forEach(item => {
      if (dateMap.has(item._id)) {
        const data = dateMap.get(item._id);
        data.emailRevenue = parseFloat(item.emailRevenue.toFixed(2));
        data.emailOrders = item.emailOrders;
      }
    });
    
    // Calcular rates
    const trends = Array.from(dateMap.values()).map(day => ({
      ...day,
      openRate: day.sent > 0 ? parseFloat(((day.opened / day.sent) * 100).toFixed(2)) : 0,
      clickRate: day.sent > 0 ? parseFloat(((day.clicked / day.sent) * 100).toFixed(2)) : 0
    }));
    
    res.json({
      period: { start, end, days: parseInt(days), granularity },
      campaignsIncluded: campaignIds.length,
      trends
    });
    
  } catch (error) {
    console.error('Error en trends:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 4. TOP CAMPAIGNS POR REVENUE (sin cambios necesarios)
// ============================================================
router.get('/top-campaigns', auth, async (req, res) => {
  try {
    const { days = 90, limit = 10 } = req.query;
    const { start, end } = getDateRange(parseInt(days));
    
    // Ya filtra por status: 'sent'
    const campaigns = await Campaign.find({
      status: 'sent',
      sentAt: { $gte: start, $lte: end }
    })
    .select('name subject sentAt stats segment')
    .populate('segment', 'name')
    .sort({ 'stats.totalRevenue': -1 })
    .limit(parseInt(limit));
    
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
            openRate: campaign.stats.openRate || 
              (campaign.stats.sent > 0 ? ((campaign.stats.opened / campaign.stats.sent) * 100).toFixed(2) : 0) + '%',
            clickRate: campaign.stats.clickRate ||
              (campaign.stats.sent > 0 ? ((campaign.stats.clicked / campaign.stats.sent) * 100).toFixed(2) : 0) + '%'
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
// 5. BEST SEND TIMES (CORREGIDO)
// ============================================================
router.get('/best-times', auth, async (req, res) => {
  try {
    const { days = 90, metric = 'opened' } = req.query;
    const { start, end } = getDateRange(parseInt(days));
    
    // Solo de campañas completadas
    const campaignIds = await getCompletedCampaignIds(start, end);
    
    const events = await EmailEvent.aggregate([
      {
        $match: {
          campaign: { $in: campaignIds },
          eventDate: { $gte: start, $lte: end },
          eventType: { $in: ['sent', 'opened', 'clicked'] }
        }
      },
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
    
    // Crear matriz de heatmap
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
          day: day - 1,
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
    
    // Mejores horarios
    const sortedByMetric = [...heatmap]
      .filter(h => h.sent >= 10)
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
      campaignsIncluded: campaignIds.length,
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
// 6. SEGMENT PERFORMANCE (CORREGIDO)
// ============================================================
router.get('/segment-performance', auth, async (req, res) => {
  try {
    const { days = 90 } = req.query;
    const { start, end } = getDateRange(parseInt(days));
    
    // Solo campañas completadas con segmento
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
// 7. CAMPAIGN COMPARISON (sin cambios)
// ============================================================
router.get('/compare-campaigns', auth, async (req, res) => {
  try {
    const { ids } = req.query;
    
    if (!ids) {
      return res.status(400).json({ error: 'Provide campaign IDs as ?ids=id1,id2,id3' });
    }
    
    const campaignIds = ids.split(',').map(id => new mongoose.Types.ObjectId(id.trim()));
    
    const campaigns = await Campaign.find({ _id: { $in: campaignIds } })
      .select('name subject sentAt stats segment')
      .populate('segment', 'name');
    
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
// 8. DELIVERABILITY HEALTH (CORREGIDO)
// ============================================================
router.get('/deliverability', auth, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const { start, end } = getDateRange(parseInt(days));
    
    // Solo campañas completadas
    const campaignIds = await getCompletedCampaignIds(start, end);
    
    // Stats de bounce desde Customer
    const bounceStats = await Customer.getBounceStats();
    
    // Stats desde campañas completadas
    const campaigns = await Campaign.find({ _id: { $in: campaignIds } });
    
    const stats = campaigns.reduce((acc, c) => {
      acc.sent += c.stats?.sent || 0;
      acc.delivered += c.stats?.delivered || 0;
      acc.bounced += c.stats?.bounced || 0;
      acc.complained += c.stats?.complained || 0;
      acc.unsubscribed += c.stats?.unsubscribed || 0;
      return acc;
    }, { sent: 0, delivered: 0, bounced: 0, complained: 0, unsubscribed: 0 });
    
    // Trends
    const bounceTrend = await EmailEvent.aggregate([
      {
        $match: {
          campaign: { $in: campaignIds },
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
    
    const unsubscribeTrend = await EmailEvent.aggregate([
      {
        $match: {
          campaign: { $in: campaignIds },
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
    
    // Health score
    let healthScore = 100;
    const bounceRate = stats.sent > 0 ? (stats.bounced / stats.sent) * 100 : 0;
    const complaintRate = stats.sent > 0 ? (stats.complained / stats.sent) * 100 : 0;
    const unsubRate = stats.sent > 0 ? (stats.unsubscribed / stats.sent) * 100 : 0;
    
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
      campaignsIncluded: campaignIds.length,
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
// 9. TOP CUSTOMERS (sin cambios)
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
// 10. REVENUE TIMELINE (CORREGIDO)
// ============================================================
router.get('/revenue-timeline', auth, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const { start, end } = getDateRange(parseInt(days));
    
    // Solo campañas completadas
    const campaignIds = await getCompletedCampaignIds(start, end);
    
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
    
    // Revenue de email (solo de campañas completadas)
    const emailTimeline = await Order.aggregate([
      {
        $match: {
          orderDate: { $gte: start, $lte: end },
          'attribution.campaign': { $in: campaignIds }
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
      campaignsIncluded: campaignIds.length,
      timeline
    });
    
  } catch (error) {
    console.error('Error en revenue timeline:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 11. EMAIL TIMELINE (CORREGIDO)
// ============================================================
router.get('/email-timeline', auth, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const { start, end } = getDateRange(parseInt(days));
    
    // Solo campañas completadas
    const campaignIds = await getCompletedCampaignIds(start, end);
    
    const timeline = await EmailEvent.aggregate([
      {
        $match: {
          campaign: { $in: campaignIds },
          eventDate: { $gte: start, $lte: end }
        }
      },
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
      campaignsIncluded: campaignIds.length,
      timeline: Array.from(dateMap.values())
    });
    
  } catch (error) {
    console.error('Error en email timeline:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// 12. CAMPAIGN PERFORMANCE (sin cambios - ya filtra por sent)
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