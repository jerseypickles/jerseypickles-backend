// backend/src/routes/analytics.js
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const Customer = require('../models/Customer');
const Campaign = require('../models/Campaign');
const Order = require('../models/Order');
const EmailEvent = require('../models/EmailEvent');

// Dashboard general con email stats
router.get('/dashboard', auth, async (req, res) => {
  try {
    // Customers stats
    const totalCustomers = await Customer.countDocuments();
    const marketingAccepted = await Customer.countDocuments({ acceptsMarketing: true });
    
    // Orders stats
    const totalOrders = await Order.countDocuments();
    const revenueData = await Order.aggregate([
      { $group: { _id: null, total: { $sum: '$totalPrice' } } }
    ]);
    
    // Campaigns stats
    const totalCampaigns = await Campaign.countDocuments();
    const sentCampaigns = await Campaign.countDocuments({ status: 'sent' });
    const draftCampaigns = await Campaign.countDocuments({ status: 'draft' });
    
    // Email stats desde EmailEvent
    const emailStats = await EmailEvent.aggregate([
      {
        $group: {
          _id: '$eventType',
          count: { $sum: 1 }
        }
      }
    ]);
    
    // Calcular rates de email
    const sentEmails = emailStats.find(s => s._id === 'sent')?.count || 0;
    const openedEmails = emailStats.find(s => s._id === 'opened')?.count || 0;
    const clickedEmails = emailStats.find(s => s._id === 'clicked')?.count || 0;
    const bouncedEmails = emailStats.find(s => s._id === 'bounced')?.count || 0;
    
    const openRate = sentEmails > 0 ? ((openedEmails / sentEmails) * 100).toFixed(2) : 0;
    const clickRate = sentEmails > 0 ? ((clickedEmails / sentEmails) * 100).toFixed(2) : 0;
    const bounceRate = sentEmails > 0 ? ((bouncedEmails / sentEmails) * 100).toFixed(2) : 0;
    
    res.json({
      customers: {
        total: totalCustomers,
        marketingAccepted,
        acceptanceRate: totalCustomers > 0 ? ((marketingAccepted / totalCustomers) * 100).toFixed(2) + '%' : '0%'
      },
      orders: {
        total: totalOrders,
        revenue: revenueData[0]?.total?.toFixed(2) || 0
      },
      campaigns: {
        total: totalCampaigns,
        sent: sentCampaigns,
        draft: draftCampaigns
      },
      emails: {
        sent: sentEmails,
        opened: openedEmails,
        clicked: clickedEmails,
        bounced: bouncedEmails,
        openRate: openRate + '%',
        clickRate: clickRate + '%',
        bounceRate: bounceRate + '%'
      }
    });
    
  } catch (error) {
    console.error('Error en analytics dashboard:', error);
    res.status(500).json({ error: error.message });
  }
});

// Top customers
router.get('/top-customers', auth, async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    
    const topCustomers = await Customer.find({ acceptsMarketing: true })
      .sort({ totalSpent: -1 })
      .limit(parseInt(limit))
      .select('email firstName lastName totalSpent ordersCount emailStats');
    
    res.json(topCustomers);
    
  } catch (error) {
    console.error('Error obteniendo top customers:', error);
    res.status(500).json({ error: error.message });
  }
});

// Revenue timeline
router.get('/revenue-timeline', auth, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    
    const timeline = await Order.aggregate([
      {
        $match: {
          orderDate: { $gte: startDate }
        }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$orderDate' }
          },
          revenue: { $sum: '$totalPrice' },
          orders: { $sum: 1 }
        }
      },
      {
        $sort: { _id: 1 }
      }
    ]);
    
    res.json(timeline);
    
  } catch (error) {
    console.error('Error en revenue timeline:', error);
    res.status(500).json({ error: error.message });
  }
});

// Campaign performance (últimas 10 campañas enviadas)
router.get('/campaign-performance', auth, async (req, res) => {
  try {
    const campaigns = await Campaign.find({ status: 'sent' })
      .sort({ sentAt: -1 })
      .limit(10)
      .select('name stats sentAt')
      .populate('segment', 'name');
    
    res.json(campaigns);
    
  } catch (error) {
    console.error('Error en campaign performance:', error);
    res.status(500).json({ error: error.message });
  }
});

// Email engagement timeline
router.get('/email-timeline', auth, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));
    
    const timeline = await EmailEvent.aggregate([
      {
        $match: {
          eventDate: { $gte: startDate }
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
      {
        $sort: { '_id.date': 1 }
      }
    ]);
    
    // Transformar para frontend
    const formattedTimeline = {};
    timeline.forEach(item => {
      const date = item._id.date;
      if (!formattedTimeline[date]) {
        formattedTimeline[date] = { date, sent: 0, opened: 0, clicked: 0, bounced: 0 };
      }
      formattedTimeline[date][item._id.type] = item.count;
    });
    
    res.json(Object.values(formattedTimeline));
    
  } catch (error) {
    console.error('Error en email timeline:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;