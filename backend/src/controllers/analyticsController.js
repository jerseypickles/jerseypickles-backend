// backend/src/controllers/analyticsController.js
const Customer = require('../models/Customer');
const Campaign = require('../models/Campaign');
const Order = require('../models/Order');
const EmailEvent = require('../models/EmailEvent');

class AnalyticsController {
  
  // Dashboard general
  async dashboard(req, res) {
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
      
      // Email stats
      const emailStats = await EmailEvent.aggregate([
        {
          $group: {
            _id: '$eventType',
            count: { $sum: 1 }
          }
        }
      ]);
      
      // Calcular rates
      const sentEmails = emailStats.find(s => s._id === 'sent')?.count || 0;
      const openedEmails = emailStats.find(s => s._id === 'opened')?.count || 0;
      const clickedEmails = emailStats.find(s => s._id === 'clicked')?.count || 0;
      
      const openRate = sentEmails > 0 ? ((openedEmails / sentEmails) * 100).toFixed(2) : 0;
      const clickRate = sentEmails > 0 ? ((clickedEmails / sentEmails) * 100).toFixed(2) : 0;
      
      res.json({
        customers: {
          total: totalCustomers,
          marketingAccepted,
          acceptanceRate: totalCustomers > 0 ? ((marketingAccepted / totalCustomers) * 100).toFixed(2) + '%' : '0%'
        },
        orders: {
          total: totalOrders,
          revenue: revenueData[0]?.total || 0
        },
        campaigns: {
          total: totalCampaigns,
          sent: sentCampaigns,
          draft: await Campaign.countDocuments({ status: 'draft' })
        },
        emails: {
          sent: sentEmails,
          opened: openedEmails,
          clicked: clickedEmails,
          openRate: openRate + '%',
          clickRate: clickRate + '%'
        }
      });
      
    } catch (error) {
      console.error('Error en analytics dashboard:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Top customers
  async topCustomers(req, res) {
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
  }

  // Revenue timeline
  async revenueTimeline(req, res) {
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
  }

  // Campaign performance
  async campaignPerformance(req, res) {
    try {
      const campaigns = await Campaign.find({ status: 'sent' })
        .sort({ sentAt: -1 })
        .limit(10)
        .select('name stats sentAt');
      
      res.json(campaigns);
      
    } catch (error) {
      console.error('Error en campaign performance:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = new AnalyticsController();