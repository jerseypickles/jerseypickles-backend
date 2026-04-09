// backend/src/services/dailyBusinessSnapshot.js
// Daily Business Snapshot - Shopify API (source of truth) + MongoDB (SMS data)

const SmsSubscriber = require('../models/SmsSubscriber');
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
   * Shopify API = source of truth para metricas de negocio (ordenes, revenue, productos, descuentos)
   * MongoDB = datos de SMS (subscribers, funnel, campaigns, unsubs) + customers
   */
  async generateSnapshot() {
    console.log('Generating daily business snapshot...');
    const startTime = Date.now();

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Fetch Shopify orders (30d) and MongoDB SMS data in parallel
    const [
      shopifyOrders,
      smsData,
      customerData,
      unfulfilled
    ] = await Promise.all([
      this.fetchShopifyOrders30d(last30d),
      this.getSmsData(last30d, now),
      this.getCustomerData(last30d, todayStart),
      this.getShopifyUnfulfilled()
    ]);

    // Compute business metrics from Shopify orders (in-memory filtering)
    const todayMetrics = this.computeOrderMetrics(shopifyOrders, todayStart, now);
    const last7dMetrics = this.computeOrderMetrics(shopifyOrders, last7d, now);
    const last30dMetrics = this.computeOrderMetrics(shopifyOrders, last30d, now);
    const topProducts = this.computeTopProducts(shopifyOrders, last30d);
    const discountUsage = this.computeDiscountUsage(shopifyOrders, last30d);

    const snapshot = {
      generatedAt: new Date().toISOString(),
      period: 'daily',
      sources: shopifyOrders ? ['shopify'] : ['shopify_failed'],
      business: {
        today: todayMetrics,
        last7d: last7dMetrics,
        last30d: last30dMetrics,
        shopifyRealtime: {
          unfulfilled,
          catalog: null
        }
      },
      sms: smsData,
      products: {
        topSelling: topProducts,
        shopifyCatalog: null,
        discountUsage
      },
      customers: customerData
    };

    const duration = Date.now() - startTime;
    console.log(`Snapshot generated in ${duration}ms (${shopifyOrders ? shopifyOrders.length : 0} Shopify orders fetched)`);
    snapshot.generationDuration = duration;

    return snapshot;
  }

  // ==================== SHOPIFY ORDERS (SOURCE OF TRUTH) ====================

  /**
   * Fetch all paid orders from last 30 days from Shopify API
   * Single paginated call, then filter in-memory for different periods
   */
  async fetchShopifyOrders30d(since30d) {
    if (!shopifyService) {
      console.error('Shopify service not available - business metrics will be empty');
      return null;
    }

    try {
      console.log('Fetching 30d orders from Shopify API...');
      const orders = await shopifyService.getAllOrders({
        created_at_min: since30d.toISOString(),
        financial_status: 'paid',
        status: 'any'
      });

      console.log(`Fetched ${orders.length} paid orders from Shopify (last 30d)`);
      return orders;
    } catch (error) {
      console.error('Error fetching Shopify orders:', error.message);
      return null;
    }
  }

  /**
   * Compute order metrics (revenue, count, avgTicket) from Shopify orders array
   * Filters by date range in-memory
   */
  computeOrderMetrics(orders, startDate, endDate) {
    if (!orders) return { orders: 0, revenue: 0, avgTicket: 0 };

    const filtered = orders.filter(o => {
      const created = new Date(o.created_at);
      return created >= startDate && created <= endDate;
    });

    const totalRevenue = filtered.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);

    return {
      orders: filtered.length,
      revenue: Math.round(totalRevenue * 100) / 100,
      avgTicket: filtered.length > 0
        ? Math.round((totalRevenue / filtered.length) * 100) / 100
        : 0
    };
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
          revenue: c.stats?.totalRevenue || 0,
          unsubscribed: c.stats?.unsubscribed || 0,
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

  /**
   * Compute top selling products from Shopify orders (in-memory)
   * Shopify line_items: { title, price, quantity, ... }
   */
  computeTopProducts(orders, since) {
    if (!orders) return [];

    const filtered = orders.filter(o => new Date(o.created_at) >= since);
    const products = {};

    for (const order of filtered) {
      for (const item of (order.line_items || [])) {
        const title = item.title || 'Unknown';
        if (!products[title]) {
          products[title] = { revenue: 0, units: 0, orders: 0 };
        }
        products[title].revenue += parseFloat(item.price || 0) * (item.quantity || 1);
        products[title].units += item.quantity || 1;
        products[title].orders += 1;
      }
    }

    return Object.entries(products)
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .slice(0, 10)
      .map(([name, data]) => ({
        name,
        revenue: Math.round(data.revenue * 100) / 100,
        unitsSold: data.units,
        orders: data.orders
      }));
  }

  /**
   * Compute discount usage from Shopify orders (in-memory)
   * Shopify discount_codes: [{ code, amount, type }]
   */
  computeDiscountUsage(orders, since) {
    if (!orders) return { welcome: 0, secondChance: 0, dynamic: 0, other: 0, totalRedeemed: 0 };

    const filtered = orders.filter(o => new Date(o.created_at) >= since);
    const result = { welcome: 0, secondChance: 0, dynamic: 0, other: 0, totalRedeemed: 0 };

    for (const order of filtered) {
      for (const dc of (order.discount_codes || [])) {
        const code = (dc.code || '').toUpperCase();
        result.totalRedeemed += 1;

        if (code.startsWith('JPC')) {
          result.dynamic += 1;
        } else if (code.startsWith('JP')) {
          result.welcome += 1;
        } else if (code.startsWith('SC')) {
          result.secondChance += 1;
        } else {
          result.other += 1;
        }
      }
    }

    return result;
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

  // ==================== SHOPIFY UNFULFILLED ====================

  async getShopifyUnfulfilled() {
    if (!shopifyService) return { count: 0, oldestHours: 0 };

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
