// backend/src/services/dailyBusinessSnapshot.js
// Daily Business Snapshot - Agrega datos de MongoDB + Shopify API para IA Business

const SmsSubscriber = require('../models/SmsSubscriber');
const Order = require('../models/Order');
const SmsCampaign = require('../models/SmsCampaign');
const Customer = require('../models/Customer');

let shopifyService = null;
try {
  shopifyService = require('./shopifyService');
} catch (e) {
  console.log('dailyBusinessSnapshot: shopifyService not available');
}

class DailyBusinessSnapshot {

  /**
   * Generar snapshot completo del negocio
   * Combina MongoDB (historico) + Shopify API (tiempo real)
   */
  async generateSnapshot() {
    console.log('Generating daily business snapshot...');
    const startTime = Date.now();

    const [
      mongoData,
      shopifyData
    ] = await Promise.all([
      this.getMongoData(),
      this.getShopifyData()
    ]);

    const snapshot = {
      generatedAt: new Date().toISOString(),
      period: 'daily',
      sources: ['mongodb', ...(shopifyData ? ['shopify'] : [])],
      business: {
        today: mongoData.todayMetrics,
        last7d: mongoData.last7dMetrics,
        last30d: mongoData.last30dMetrics,
        shopifyRealtime: shopifyData
      },
      sms: mongoData.sms,
      products: {
        topSelling: mongoData.topProducts,
        shopifyCatalog: shopifyData?.catalog || null,
        discountUsage: mongoData.discountUsage
      },
      customers: mongoData.customers
    };

    const duration = Date.now() - startTime;
    console.log(`Snapshot generated in ${duration}ms`);
    snapshot.generationDuration = duration;

    return snapshot;
  }

  // ==================== MONGODB DATA ====================

  async getMongoData() {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [
      todayMetrics,
      last7dMetrics,
      last30dMetrics,
      sms,
      topProducts,
      discountUsage,
      customers
    ] = await Promise.all([
      this.getOrderMetrics(todayStart, now),
      this.getOrderMetrics(last7d, now),
      this.getOrderMetrics(last30d, now),
      this.getSmsData(last30d, now),
      this.getTopProducts(last30d),
      this.getDiscountUsage(last30d),
      this.getCustomerData(last30d, todayStart)
    ]);

    return { todayMetrics, last7dMetrics, last30dMetrics, sms, topProducts, discountUsage, customers };
  }

  async getOrderMetrics(startDate, endDate) {
    try {
      const pipeline = [
        {
          $match: {
            createdAt: { $gte: startDate, $lte: endDate },
            financialStatus: { $in: ['paid', 'partially_refunded'] }
          }
        },
        {
          $group: {
            _id: null,
            totalOrders: { $sum: 1 },
            totalRevenue: { $sum: { $toDouble: '$totalPrice' } },
            avgOrderValue: { $avg: { $toDouble: '$totalPrice' } }
          }
        }
      ];

      const result = await Order.aggregate(pipeline);
      const data = result[0] || { totalOrders: 0, totalRevenue: 0, avgOrderValue: 0 };

      return {
        orders: data.totalOrders,
        revenue: Math.round(data.totalRevenue * 100) / 100,
        avgTicket: Math.round(data.avgOrderValue * 100) / 100
      };
    } catch (error) {
      console.error('Error getting order metrics:', error.message);
      return { orders: 0, revenue: 0, avgTicket: 0 };
    }
  }

  async getSmsData(startDate, endDate) {
    try {
      const [
        subscriberStats,
        funnelData,
        campaignData,
        unsubData,
        topStates
      ] = await Promise.all([
        this.getSubscriberStats(),
        this.getSmsFunnel(startDate, endDate),
        this.getCampaignStats(startDate),
        this.getUnsubscribeData(startDate),
        this.getTopStates()
      ]);

      return {
        subscribers: subscriberStats,
        funnel: funnelData,
        campaigns: campaignData,
        unsubscribes: unsubData,
        topStates
      };
    } catch (error) {
      console.error('Error getting SMS data:', error.message);
      return null;
    }
  }

  async getSubscriberStats() {
    const [total, active, converted, totalRevenue] = await Promise.all([
      SmsSubscriber.countDocuments(),
      SmsSubscriber.countDocuments({ status: 'active' }),
      SmsSubscriber.countDocuments({ converted: true }),
      SmsSubscriber.aggregate([
        { $match: { converted: true } },
        { $group: { _id: null, total: { $sum: '$conversionData.orderTotal' } } }
      ])
    ]);

    const revenue = totalRevenue[0]?.total || 0;
    const conversionRate = total > 0 ? Math.round((converted / total) * 1000) / 10 : 0;

    return {
      total,
      active,
      converted,
      conversionRate,
      totalRevenue: Math.round(revenue * 100) / 100,
      avgRevenuePerConversion: converted > 0 ? Math.round((revenue / converted) * 100) / 100 : 0
    };
  }

  async getSmsFunnel(startDate, endDate) {
    try {
      const [welcomeSent, welcomeConverted, secondChanceSent, secondChanceConverted] = await Promise.all([
        // Welcome SMS sent = subscribers with welcomeSmsSent=true in date range
        SmsSubscriber.countDocuments({
          welcomeSmsSent: true,
          createdAt: { $gte: startDate, $lte: endDate }
        }),
        // Converted via welcome (first) discount
        SmsSubscriber.countDocuments({
          converted: true,
          $or: [
            { convertedWith: 'first' },
            { convertedWith: { $exists: false } },
            { convertedWith: null }
          ],
          createdAt: { $gte: startDate, $lte: endDate }
        }),
        // Second chance SMS sent
        SmsSubscriber.countDocuments({
          secondSmsSent: true,
          secondSmsAt: { $gte: startDate, $lte: endDate }
        }),
        // Converted via second chance
        SmsSubscriber.countDocuments({
          converted: true,
          convertedWith: 'second',
          createdAt: { $gte: startDate, $lte: endDate }
        })
      ]);

      return {
        welcomeSent,
        welcomeConverted,
        welcomeRate: welcomeSent > 0 ? Math.round((welcomeConverted / welcomeSent) * 1000) / 10 : 0,
        secondChanceSent,
        secondChanceConverted,
        secondChanceRate: secondChanceSent > 0 ? Math.round((secondChanceConverted / secondChanceSent) * 1000) / 10 : 0
      };
    } catch (error) {
      console.error('Error getting SMS funnel:', error.message);
      return null;
    }
  }

  async getCampaignStats(startDate) {
    try {
      const campaigns = await SmsCampaign.find({
        createdAt: { $gte: startDate }
      }).sort({ createdAt: -1 }).lean();

      return {
        total: campaigns.length,
        campaigns: campaigns.map(c => ({
          name: c.name,
          status: c.status,
          sent: c.stats?.sent || 0,
          delivered: c.stats?.delivered || 0,
          converted: c.stats?.converted || 0,
          revenue: c.stats?.revenue || 0,
          createdAt: c.createdAt
        }))
      };
    } catch (error) {
      console.error('Error getting campaign stats:', error.message);
      return { total: 0, campaigns: [] };
    }
  }

  async getUnsubscribeData(startDate) {
    try {
      const [total, recent] = await Promise.all([
        SmsSubscriber.countDocuments({ status: 'unsubscribed' }),
        SmsSubscriber.countDocuments({
          status: 'unsubscribed',
          unsubscribedAt: { $gte: startDate }
        })
      ]);

      const totalActive = await SmsSubscriber.countDocuments({ status: 'active' });
      const rate = (totalActive + total) > 0
        ? Math.round((total / (totalActive + total)) * 1000) / 10
        : 0;

      return { total, recentUnsubscribes: recent, rate };
    } catch (error) {
      console.error('Error getting unsub data:', error.message);
      return { total: 0, recentUnsubscribes: 0, rate: 0 };
    }
  }

  async getTopStates() {
    try {
      const states = await SmsSubscriber.aggregate([
        { $match: { 'location.regionName': { $exists: true, $ne: null } } },
        {
          $group: {
            _id: '$location.regionName',
            count: { $sum: 1 },
            converted: { $sum: { $cond: ['$converted', 1, 0] } }
          }
        },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]);

      return states.map(s => ({
        state: s._id,
        subscribers: s.count,
        converted: s.converted,
        conversionRate: s.count > 0 ? Math.round((s.converted / s.count) * 1000) / 10 : 0
      }));
    } catch (error) {
      console.error('Error getting top states:', error.message);
      return [];
    }
  }

  async getTopProducts(startDate) {
    try {
      const topProducts = await Order.aggregate([
        {
          $match: {
            createdAt: { $gte: startDate },
            financialStatus: { $in: ['paid', 'partially_refunded'] }
          }
        },
        { $unwind: '$lineItems' },
        {
          $group: {
            _id: '$lineItems.title',
            totalRevenue: { $sum: { $multiply: [{ $toDouble: '$lineItems.price' }, '$lineItems.quantity'] } },
            totalUnits: { $sum: '$lineItems.quantity' },
            orderCount: { $sum: 1 }
          }
        },
        { $sort: { totalRevenue: -1 } },
        { $limit: 10 }
      ]);

      return topProducts.map(p => ({
        name: p._id,
        revenue: Math.round(p.totalRevenue * 100) / 100,
        unitsSold: p.totalUnits,
        orders: p.orderCount
      }));
    } catch (error) {
      console.error('Error getting top products:', error.message);
      return [];
    }
  }

  async getDiscountUsage(startDate) {
    try {
      const discounts = await Order.aggregate([
        {
          $match: {
            createdAt: { $gte: startDate },
            'discountCodes.0': { $exists: true }
          }
        },
        { $unwind: '$discountCodes' },
        {
          $group: {
            _id: {
              $cond: [
                { $regexMatch: { input: '$discountCodes.code', regex: /^JP/i } },
                'welcome',
                {
                  $cond: [
                    { $regexMatch: { input: '$discountCodes.code', regex: /^SC/i } },
                    'secondChance',
                    {
                      $cond: [
                        { $regexMatch: { input: '$discountCodes.code', regex: /^JPC/i } },
                        'dynamic',
                        'other'
                      ]
                    }
                  ]
                }
              ]
            },
            count: { $sum: 1 },
            totalDiscount: { $sum: { $toDouble: '$discountCodes.amount' } }
          }
        }
      ]);

      const result = { welcome: 0, secondChance: 0, dynamic: 0, other: 0, totalRedeemed: 0 };
      for (const d of discounts) {
        result[d._id] = d.count;
        result.totalRedeemed += d.count;
      }

      return result;
    } catch (error) {
      console.error('Error getting discount usage:', error.message);
      return { welcome: 0, secondChance: 0, dynamic: 0, other: 0, totalRedeemed: 0 };
    }
  }

  async getCustomerData(last30d, todayStart) {
    try {
      const [total, newToday, newMonth, fromSms] = await Promise.all([
        Customer.countDocuments(),
        Customer.countDocuments({ createdAt: { $gte: todayStart } }),
        Customer.countDocuments({ createdAt: { $gte: last30d } }),
        SmsSubscriber.countDocuments({ converted: true })
      ]);

      return {
        total,
        newToday,
        newThisMonth: newMonth,
        fromSms
      };
    } catch (error) {
      console.error('Error getting customer data:', error.message);
      return { total: 0, newToday: 0, newThisMonth: 0, fromSms: 0 };
    }
  }

  // ==================== SHOPIFY API DATA ====================

  async getShopifyData() {
    if (!shopifyService) {
      console.log('Shopify service not available for snapshot');
      return null;
    }

    try {
      const [recentOrders, unfulfilled] = await Promise.all([
        this.getShopifyRecentOrders(),
        this.getShopifyUnfulfilled()
      ]);

      return {
        recentOrders,
        unfulfilled,
        catalog: null // Se puede expandir si es necesario
      };
    } catch (error) {
      console.error('Error getting Shopify data:', error.message);
      return null;
    }
  }

  async getShopifyRecentOrders() {
    try {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);

      const orders = await shopifyService.getAllOrders({
        created_at_min: yesterday.toISOString(),
        status: 'any',
        financial_status: 'paid'
      }, 1); // Solo 1 pagina (max 250 orders)

      const revenue = orders.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
      const products = {};

      for (const order of orders) {
        for (const item of (order.line_items || [])) {
          if (!products[item.title]) {
            products[item.title] = { units: 0, revenue: 0 };
          }
          products[item.title].units += item.quantity;
          products[item.title].revenue += parseFloat(item.price) * item.quantity;
        }
      }

      const topToday = Object.entries(products)
        .sort((a, b) => b[1].revenue - a[1].revenue)
        .slice(0, 5)
        .map(([name, data]) => ({ name, ...data }));

      return {
        count: orders.length,
        revenue: Math.round(revenue * 100) / 100,
        topProducts: topToday
      };
    } catch (error) {
      console.error('Error getting Shopify recent orders:', error.message);
      return null;
    }
  }

  async getShopifyUnfulfilled() {
    try {
      const orders = await shopifyService.getUnfulfilledOrders(24, 50);
      return {
        count: orders.length,
        oldestHours: orders.length > 0
          ? Math.round((Date.now() - new Date(orders[orders.length - 1].created_at).getTime()) / (1000 * 60 * 60))
          : 0
      };
    } catch (error) {
      console.error('Error getting unfulfilled orders:', error.message);
      return { count: 0, oldestHours: 0 };
    }
  }
}

module.exports = new DailyBusinessSnapshot();
