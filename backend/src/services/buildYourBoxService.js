// backend/src/services/buildYourBoxService.js
// Service para analizar demanda de productos en Build Your Box
// Enhanced with Opportunity Dashboard metrics

const Order = require('../models/Order');

class BuildYourBoxService {
  constructor() {
    // Tamaños de jar válidos
    this.jarSizes = ['16OZ', '16 OZ', 'QUART', 'QUART (32oz)', 'HALF_GALLON', 'HALF GALLON'];

    // Normalizar tamaños
    this.normalizeSize = (size) => {
      if (!size) return 'UNKNOWN';
      const upper = size.toUpperCase().trim();
      if (upper.includes('16')) return '16OZ';
      if (upper.includes('QUART')) return 'QUART';
      if (upper.includes('HALF') || upper.includes('GALLON')) return 'HALF_GALLON';
      return upper;
    };

    // Box size configurations (from Shopify BYB code)
    this.boxConfigs = {
      QUART: {
        sizes: [4, 6, 8, 12],
        prices: { 4: 50, 6: 72, 8: 92, 12: 132 },
        extraOlivePrice: 4.99,
        freeShippingAt: [8, 12]
      },
      HALF_GALLON: {
        sizes: [2, 4, 6],
        prices: { 2: 45, 4: 85, 6: 120 },
        extraOlivePrice: 0, // Not available for half gallon
        freeShippingAt: [6]
      }
    };
  }

  /**
   * Parsear notas de Build Your Box
   * Formato: *** Build Your Boxes ***  Box #1 (Jar: QUART) • Product (qty) • Product (qty)
   * Also detects Extra Olive upsell
   */
  parseBoxNote(note) {
    if (!note || !note.includes('Build Your Box')) return null;

    const boxes = [];
    let hasExtraOlive = false;

    // Detect Extra Olive upsell
    if (note.toLowerCase().includes('extra olive') || note.toLowerCase().includes('+$4.99')) {
      hasExtraOlive = true;
    }

    // Regex para encontrar cada box
    // Ejemplo: Box #1 (Jar: QUART (32oz)) • Hot Pickled Green Tomatoes (1) • Sour Pickled (2)
    const boxRegex = /Box\s*#?(\d+)\s*\(Jar:\s*([^)]+)\)\s*((?:•\s*[^•]+)+)/gi;

    let match;
    while ((match = boxRegex.exec(note)) !== null) {
      const boxNumber = parseInt(match[1]);
      const jarSize = this.normalizeSize(match[2]);
      const productsStr = match[3];

      // Parsear productos
      const products = [];
      const productRegex = /•\s*([^(•]+)\s*\((\d+)\)/g;
      let productMatch;

      while ((productMatch = productRegex.exec(productsStr)) !== null) {
        const productName = productMatch[1].trim();
        const quantity = parseInt(productMatch[2]);

        if (productName && quantity > 0) {
          products.push({
            name: productName,
            quantity: quantity
          });
        }
      }

      // Calculate total jars in this box
      const totalJars = products.reduce((sum, p) => sum + p.quantity, 0);

      if (products.length > 0) {
        boxes.push({
          boxNumber,
          jarSize,
          products,
          totalJars,
          hasExtraOlive: hasExtraOlive && jarSize === 'QUART' // Extra olive only for Quart
        });
      }
    }

    return boxes.length > 0 ? { boxes, hasExtraOlive } : null;
  }

  /**
   * Obtener estadísticas de demanda (enhanced with revenue metrics)
   * @param {number} days - Días hacia atrás (0 = desde hoy en adelante, null = todos)
   */
  async getDemandStats(days = 30) {
    const query = {
      'shopifyData.note': { $regex: /Build Your Box/i }
    };

    if (days > 0) {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      startDate.setHours(0, 0, 0, 0); // Inicio del día
      query.orderDate = { $gte: startDate };
    }

    console.log(`📦 BYB Query: days=${days}, startDate=${query.orderDate?.$gte?.toISOString() || 'all'}`);

    // Buscar órdenes con notas de Build Your Box
    const orders = await Order.find(query)
      .select('shopifyData.note orderDate totalPrice orderNumber shippingAddress')
      .sort({ orderDate: -1 })
      .lean();

    console.log(`📦 BYB Found ${orders.length} orders with Build Your Box notes`);

    // Agregados
    const productStats = {};
    const sizeStats = {};
    let totalBoxes = 0;
    let totalProducts = 0;
    let totalRevenue = 0;
    let extraOliveCount = 0;
    let extraOliveEligible = 0; // Quart boxes (can get extra olive)
    const dailyData = {};
    const boxSizeByJarType = {}; // Track box sizes (4, 6, 8, 12 jars)
    const stateStats = {}; // Geographic data

    for (const order of orders) {
      const note = order.shopifyData?.note;
      if (!note) continue;

      const parsed = this.parseBoxNote(note);
      if (!parsed) continue;

      const { boxes, hasExtraOlive } = parsed;

      // Track revenue
      const orderTotal = parseFloat(order.totalPrice) || 0;
      totalRevenue += orderTotal;

      // Track Extra Olive
      if (hasExtraOlive) {
        extraOliveCount++;
      }

      // Geographic tracking
      const state = order.shippingAddress?.province || order.shippingAddress?.provinceCode || 'Unknown';
      if (!stateStats[state]) {
        stateStats[state] = { orders: 0, revenue: 0, boxes: 0 };
      }
      stateStats[state].orders++;
      stateStats[state].revenue += orderTotal;

      // Fecha para tendencias
      const dateKey = new Date(order.orderDate).toISOString().split('T')[0];
      if (!dailyData[dateKey]) {
        dailyData[dateKey] = { boxes: 0, products: 0, orders: 0, revenue: 0 };
      }
      dailyData[dateKey].orders++;
      dailyData[dateKey].revenue += orderTotal;

      for (const box of boxes) {
        totalBoxes++;
        dailyData[dateKey].boxes++;
        stateStats[state].boxes++;

        // Track if eligible for extra olive (Quart jars)
        if (box.jarSize === 'QUART') {
          extraOliveEligible++;
        }

        // Track box sizes (how many jars per box)
        const boxSizeKey = `${box.jarSize}_${box.totalJars}`;
        if (!boxSizeByJarType[boxSizeKey]) {
          boxSizeByJarType[boxSizeKey] = {
            jarType: box.jarSize,
            jarCount: box.totalJars,
            count: 0,
            estimatedPrice: this.getBoxPrice(box.jarSize, box.totalJars)
          };
        }
        boxSizeByJarType[boxSizeKey].count++;

        // Stats por tamaño
        if (!sizeStats[box.jarSize]) {
          sizeStats[box.jarSize] = { count: 0, products: 0, revenue: 0 };
        }
        sizeStats[box.jarSize].count++;

        for (const product of box.products) {
          totalProducts += product.quantity;
          dailyData[dateKey].products += product.quantity;
          sizeStats[box.jarSize].products += product.quantity;

          // Stats por producto
          if (!productStats[product.name]) {
            productStats[product.name] = {
              name: product.name,
              totalQuantity: 0,
              orderCount: 0,
              bySizes: {}
            };
          }
          productStats[product.name].totalQuantity += product.quantity;
          productStats[product.name].orderCount++;

          // Por tamaño de jar
          if (!productStats[product.name].bySizes[box.jarSize]) {
            productStats[product.name].bySizes[box.jarSize] = 0;
          }
          productStats[product.name].bySizes[box.jarSize] += product.quantity;
        }
      }
    }

    // Convertir a arrays ordenados
    const topProducts = Object.values(productStats)
      .sort((a, b) => b.totalQuantity - a.totalQuantity);

    const sizeDistribution = Object.entries(sizeStats)
      .map(([size, data]) => ({
        size,
        count: data.count,
        products: data.products,
        percentage: totalBoxes > 0 ? Math.round((data.count / totalBoxes) * 100) : 0
      }))
      .sort((a, b) => b.count - a.count);

    // Box size distribution (4, 6, 8, 12 jars)
    const boxSizeDistribution = Object.values(boxSizeByJarType)
      .sort((a, b) => b.count - a.count);

    // Tendencias diarias (últimos 14 días)
    const trends = Object.entries(dailyData)
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(-14);

    // Geographic distribution (top states)
    const geoDistribution = Object.entries(stateStats)
      .map(([state, data]) => ({
        state,
        ...data,
        avgTicket: data.orders > 0 ? Math.round(data.revenue / data.orders * 100) / 100 : 0
      }))
      .sort((a, b) => b.orders - a.orders)
      .slice(0, 15);

    // Calculate average ticket
    const avgTicket = orders.length > 0 ? totalRevenue / orders.length : 0;

    // Extra Olive metrics
    const extraOliveRate = extraOliveEligible > 0
      ? Math.round((extraOliveCount / extraOliveEligible) * 100 * 10) / 10
      : 0;
    const extraOliveRevenue = extraOliveCount * 4.99;
    const extraOliveMissedRevenue = (extraOliveEligible - extraOliveCount) * 4.99;

    return {
      summary: {
        totalOrders: orders.length,
        totalBoxes,
        totalProducts,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        avgTicket: Math.round(avgTicket * 100) / 100,
        avgProductsPerBox: totalBoxes > 0 ? Math.round((totalProducts / totalBoxes) * 10) / 10 : 0,
        avgBoxesPerOrder: orders.length > 0 ? Math.round((totalBoxes / orders.length) * 10) / 10 : 0,
        period: { days }
      },
      upsellMetrics: {
        extraOlive: {
          accepted: extraOliveCount,
          eligible: extraOliveEligible,
          rate: extraOliveRate,
          revenue: Math.round(extraOliveRevenue * 100) / 100,
          missedRevenue: Math.round(extraOliveMissedRevenue * 100) / 100,
          opportunity: `$${Math.round(extraOliveMissedRevenue)} potential if all Quart boxes accepted Extra Olive`
        }
      },
      topProducts: topProducts.slice(0, 20),
      sizeDistribution,
      boxSizeDistribution,
      geoDistribution,
      trends
    };
  }

  /**
   * Get estimated box price based on jar type and count
   */
  getBoxPrice(jarType, jarCount) {
    const config = this.boxConfigs[jarType];
    if (!config) return null;
    return config.prices[jarCount] || null;
  }

  /**
   * Obtener productos más populares
   */
  async getTopProducts(days = 30, limit = 20) {
    const stats = await this.getDemandStats(days);
    return stats.topProducts.slice(0, limit);
  }

  /**
   * Obtener distribución de tamaños
   */
  async getSizeDistribution(days = 30) {
    const stats = await this.getDemandStats(days);
    return stats.sizeDistribution;
  }

  /**
   * Obtener tendencias diarias
   */
  async getDailyTrends(days = 30) {
    const stats = await this.getDemandStats(days);
    return stats.trends;
  }

  /**
   * Obtener combos frecuentes (productos que se piden juntos)
   */
  async getFrequentCombos(days = 30, minSupport = 3) {
    const query = {};

    if (days > 0) {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      query.orderDate = { $gte: startDate };
    }

    const orders = await Order.find({
      ...query,
      'shopifyData.note': { $regex: /Build Your Box/i }
    }).select('shopifyData.note').lean();

    // Contar pares de productos
    const pairCounts = {};

    for (const order of orders) {
      const parsed = this.parseBoxNote(order.shopifyData?.note);
      if (!parsed) continue;

      const { boxes } = parsed;
      for (const box of boxes) {
        const productNames = box.products.map(p => p.name).sort();

        // Generar pares
        for (let i = 0; i < productNames.length; i++) {
          for (let j = i + 1; j < productNames.length; j++) {
            const pairKey = `${productNames[i]}|||${productNames[j]}`;
            pairCounts[pairKey] = (pairCounts[pairKey] || 0) + 1;
          }
        }
      }
    }

    // Filtrar y ordenar
    const combos = Object.entries(pairCounts)
      .filter(([, count]) => count >= minSupport)
      .map(([key, count]) => {
        const [product1, product2] = key.split('|||');
        return { product1, product2, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return combos;
  }

  /**
   * Get trending products with week-over-week comparison
   */
  async getTrendingProducts(days = 14) {
    // Get current period data
    const currentPeriodEnd = new Date();
    const currentPeriodStart = new Date();
    currentPeriodStart.setDate(currentPeriodStart.getDate() - days);

    // Get previous period data (same length, immediately before)
    const previousPeriodStart = new Date(currentPeriodStart);
    previousPeriodStart.setDate(previousPeriodStart.getDate() - days);
    const previousPeriodEnd = new Date(currentPeriodStart);
    previousPeriodEnd.setMilliseconds(previousPeriodEnd.getMilliseconds() - 1);

    const [currentOrders, previousOrders] = await Promise.all([
      Order.find({
        'shopifyData.note': { $regex: /Build Your Box/i },
        orderDate: { $gte: currentPeriodStart, $lte: currentPeriodEnd }
      }).select('shopifyData.note').lean(),
      Order.find({
        'shopifyData.note': { $regex: /Build Your Box/i },
        orderDate: { $gte: previousPeriodStart, $lte: previousPeriodEnd }
      }).select('shopifyData.note').lean()
    ]);

    // Count products for each period
    const countProducts = (orders) => {
      const counts = {};
      for (const order of orders) {
        const parsed = this.parseBoxNote(order.shopifyData?.note);
        if (!parsed) continue;

        for (const box of parsed.boxes) {
          for (const product of box.products) {
            counts[product.name] = (counts[product.name] || 0) + product.quantity;
          }
        }
      }
      return counts;
    };

    const currentCounts = countProducts(currentOrders);
    const previousCounts = countProducts(previousOrders);

    // Calculate trends
    const allProducts = new Set([
      ...Object.keys(currentCounts),
      ...Object.keys(previousCounts)
    ]);

    const trending = [];
    for (const product of allProducts) {
      const current = currentCounts[product] || 0;
      const previous = previousCounts[product] || 0;

      let changePercent = 0;
      let trend = 'stable';

      if (previous === 0 && current > 0) {
        changePercent = 100;
        trend = 'new';
      } else if (previous > 0) {
        changePercent = Math.round(((current - previous) / previous) * 100);
        if (changePercent > 20) trend = 'rising';
        else if (changePercent < -20) trend = 'falling';
      }

      trending.push({
        name: product,
        currentPeriod: current,
        previousPeriod: previous,
        change: current - previous,
        changePercent,
        trend
      });
    }

    // Sort by absolute change to find most significant movements
    trending.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    return {
      trending: trending.slice(0, 20),
      rising: trending.filter(p => p.trend === 'rising').slice(0, 5),
      falling: trending.filter(p => p.trend === 'falling').slice(0, 5),
      newProducts: trending.filter(p => p.trend === 'new'),
      period: {
        current: { start: currentPeriodStart.toISOString(), end: currentPeriodEnd.toISOString() },
        previous: { start: previousPeriodStart.toISOString(), end: previousPeriodEnd.toISOString() },
        days
      }
    };
  }

  /**
   * Get ticket analysis by box size
   */
  async getTicketAnalysis(days = 30) {
    const query = {
      'shopifyData.note': { $regex: /Build Your Box/i }
    };

    if (days > 0) {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      query.orderDate = { $gte: startDate };
    }

    const orders = await Order.find(query)
      .select('shopifyData.note totalPrice')
      .lean();

    // Analyze by box configuration
    const ticketByConfig = {};
    const allTickets = [];

    for (const order of orders) {
      const parsed = this.parseBoxNote(order.shopifyData?.note);
      if (!parsed) continue;

      const orderTotal = parseFloat(order.totalPrice) || 0;
      allTickets.push(orderTotal);

      // Group by primary box type (largest box in order)
      let primaryBox = null;
      for (const box of parsed.boxes) {
        if (!primaryBox || box.totalJars > primaryBox.totalJars) {
          primaryBox = box;
        }
      }

      if (primaryBox) {
        const configKey = `${primaryBox.jarSize}_${primaryBox.totalJars}`;
        if (!ticketByConfig[configKey]) {
          ticketByConfig[configKey] = {
            jarType: primaryBox.jarSize,
            jarCount: primaryBox.totalJars,
            orders: [],
            basePrice: this.getBoxPrice(primaryBox.jarSize, primaryBox.totalJars)
          };
        }
        ticketByConfig[configKey].orders.push(orderTotal);
      }
    }

    // Calculate statistics for each config
    const ticketStats = Object.values(ticketByConfig).map(config => {
      const tickets = config.orders;
      const count = tickets.length;
      const sum = tickets.reduce((a, b) => a + b, 0);
      const avg = count > 0 ? sum / count : 0;
      const sorted = [...tickets].sort((a, b) => a - b);
      const median = count > 0 ? sorted[Math.floor(count / 2)] : 0;
      const min = count > 0 ? sorted[0] : 0;
      const max = count > 0 ? sorted[count - 1] : 0;

      return {
        jarType: config.jarType,
        jarCount: config.jarCount,
        label: `${config.jarType} x${config.jarCount}`,
        basePrice: config.basePrice,
        orderCount: count,
        avgTicket: Math.round(avg * 100) / 100,
        medianTicket: Math.round(median * 100) / 100,
        minTicket: Math.round(min * 100) / 100,
        maxTicket: Math.round(max * 100) / 100,
        totalRevenue: Math.round(sum * 100) / 100,
        // Opportunity: difference between base price and actual average
        avgOverBase: config.basePrice ? Math.round((avg - config.basePrice) * 100) / 100 : null
      };
    });

    // Sort by order count
    ticketStats.sort((a, b) => b.orderCount - a.orderCount);

    // Overall stats
    const totalOrders = allTickets.length;
    const totalSum = allTickets.reduce((a, b) => a + b, 0);
    const overallAvg = totalOrders > 0 ? totalSum / totalOrders : 0;
    const sortedAll = [...allTickets].sort((a, b) => a - b);
    const overallMedian = totalOrders > 0 ? sortedAll[Math.floor(totalOrders / 2)] : 0;

    // Find opportunity gaps
    const opportunities = [];
    for (const stat of ticketStats) {
      // Check if smaller box sizes could upgrade
      if (stat.jarType === 'QUART' && stat.jarCount < 12) {
        const nextSize = stat.jarCount === 4 ? 6 : (stat.jarCount === 6 ? 8 : 12);
        const currentPrice = this.boxConfigs.QUART.prices[stat.jarCount];
        const nextPrice = this.boxConfigs.QUART.prices[nextSize];
        const priceDiff = nextPrice - currentPrice;
        const potentialRevenue = stat.orderCount * priceDiff;

        opportunities.push({
          from: `QUART x${stat.jarCount}`,
          to: `QUART x${nextSize}`,
          ordersEligible: stat.orderCount,
          priceIncrease: priceDiff,
          potentialRevenue: Math.round(potentialRevenue * 100) / 100,
          freeShipping: this.boxConfigs.QUART.freeShippingAt.includes(nextSize),
          message: `Upgrade ${stat.orderCount} orders from ${stat.jarCount} to ${nextSize} jars (+$${priceDiff})`
        });
      }
    }

    return {
      overall: {
        totalOrders,
        totalRevenue: Math.round(totalSum * 100) / 100,
        avgTicket: Math.round(overallAvg * 100) / 100,
        medianTicket: Math.round(overallMedian * 100) / 100
      },
      byBoxConfig: ticketStats,
      opportunities: opportunities.sort((a, b) => b.potentialRevenue - a.potentialRevenue),
      period: { days }
    };
  }

  /**
   * Get week-over-week comparison
   */
  async getWeekOverWeek() {
    const now = new Date();
    const thisWeekStart = new Date(now);
    thisWeekStart.setDate(now.getDate() - now.getDay()); // Start of this week (Sunday)
    thisWeekStart.setHours(0, 0, 0, 0);

    const lastWeekStart = new Date(thisWeekStart);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);

    const lastWeekEnd = new Date(thisWeekStart);
    lastWeekEnd.setMilliseconds(lastWeekEnd.getMilliseconds() - 1);

    const [thisWeekOrders, lastWeekOrders] = await Promise.all([
      Order.find({
        'shopifyData.note': { $regex: /Build Your Box/i },
        orderDate: { $gte: thisWeekStart }
      }).select('shopifyData.note totalPrice orderDate').lean(),
      Order.find({
        'shopifyData.note': { $regex: /Build Your Box/i },
        orderDate: { $gte: lastWeekStart, $lte: lastWeekEnd }
      }).select('shopifyData.note totalPrice orderDate').lean()
    ]);

    const calcStats = (orders) => {
      let boxes = 0;
      let products = 0;
      let extraOlive = 0;
      let revenue = 0;

      for (const order of orders) {
        const parsed = this.parseBoxNote(order.shopifyData?.note);
        if (!parsed) continue;

        revenue += parseFloat(order.totalPrice) || 0;
        if (parsed.hasExtraOlive) extraOlive++;

        for (const box of parsed.boxes) {
          boxes++;
          products += box.products.reduce((sum, p) => sum + p.quantity, 0);
        }
      }

      return {
        orders: orders.length,
        boxes,
        products,
        extraOlive,
        revenue: Math.round(revenue * 100) / 100,
        avgTicket: orders.length > 0 ? Math.round((revenue / orders.length) * 100) / 100 : 0
      };
    };

    const thisWeek = calcStats(thisWeekOrders);
    const lastWeek = calcStats(lastWeekOrders);

    const calcChange = (current, previous) => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return Math.round(((current - previous) / previous) * 100);
    };

    return {
      thisWeek,
      lastWeek,
      changes: {
        orders: calcChange(thisWeek.orders, lastWeek.orders),
        boxes: calcChange(thisWeek.boxes, lastWeek.boxes),
        products: calcChange(thisWeek.products, lastWeek.products),
        revenue: calcChange(thisWeek.revenue, lastWeek.revenue),
        avgTicket: calcChange(thisWeek.avgTicket, lastWeek.avgTicket),
        extraOlive: calcChange(thisWeek.extraOlive, lastWeek.extraOlive)
      },
      period: {
        thisWeek: { start: thisWeekStart.toISOString(), end: now.toISOString() },
        lastWeek: { start: lastWeekStart.toISOString(), end: lastWeekEnd.toISOString() }
      }
    };
  }

  /**
   * Obtener overview completo para dashboard
   */
  async getOverview(days = 30) {
    const [stats, combos, weekOverWeek] = await Promise.all([
      this.getDemandStats(days),
      this.getFrequentCombos(days),
      this.getWeekOverWeek()
    ]);

    return {
      ...stats,
      frequentCombos: combos,
      weekOverWeek
    };
  }

  /**
   * Get comprehensive Opportunity Dashboard data
   * This is the main endpoint for the enhanced BYB dashboard
   */
  async getOpportunityDashboard(days = 30) {
    console.log(`📊 Building BYB Opportunity Dashboard for ${days} days...`);

    const [
      stats,
      combos,
      trending,
      ticketAnalysis,
      weekOverWeek
    ] = await Promise.all([
      this.getDemandStats(days),
      this.getFrequentCombos(days),
      this.getTrendingProducts(Math.min(days, 14)), // Max 14 days for trending
      this.getTicketAnalysis(days),
      this.getWeekOverWeek()
    ]);

    // Calculate total opportunity value
    const opportunities = {
      extraOlive: stats.upsellMetrics?.extraOlive?.missedRevenue || 0,
      boxUpgrades: ticketAnalysis.opportunities.reduce((sum, o) => sum + o.potentialRevenue, 0)
    };
    opportunities.total = opportunities.extraOlive + opportunities.boxUpgrades;

    // Generate actionable insights
    const insights = [];

    // Insight 1: Extra Olive opportunity
    if (stats.upsellMetrics?.extraOlive?.rate < 50) {
      insights.push({
        type: 'upsell',
        priority: 'high',
        title: 'Extra Olive Upsell Opportunity',
        metric: `${stats.upsellMetrics.extraOlive.rate}%`,
        description: `Only ${stats.upsellMetrics.extraOlive.rate}% of eligible Quart boxes include Extra Olive. Potential revenue: $${stats.upsellMetrics.extraOlive.missedRevenue}`,
        action: 'Make Extra Olive more visible or offer bundle discount'
      });
    }

    // Insight 2: Box size upgrade opportunity
    const smallBoxes = ticketAnalysis.byBoxConfig.filter(
      c => c.jarType === 'QUART' && c.jarCount <= 6
    );
    if (smallBoxes.length > 0) {
      const smallBoxCount = smallBoxes.reduce((sum, c) => sum + c.orderCount, 0);
      const totalOrders = ticketAnalysis.overall.totalOrders;
      const smallBoxPercent = Math.round((smallBoxCount / totalOrders) * 100);

      if (smallBoxPercent > 40) {
        insights.push({
          type: 'upgrade',
          priority: 'high',
          title: 'Box Size Upgrade Opportunity',
          metric: `${smallBoxPercent}%`,
          description: `${smallBoxPercent}% of orders are 4-6 jar boxes. Promote 8 & 12 jar boxes (free shipping!)`,
          action: 'Highlight free shipping on 8+ jar boxes during checkout'
        });
      }
    }

    // Insight 3: Trending products
    if (trending.rising.length > 0) {
      const topRising = trending.rising[0];
      insights.push({
        type: 'trend',
        priority: 'medium',
        title: 'Product Gaining Popularity',
        metric: `+${topRising.changePercent}%`,
        description: `"${topRising.name}" is up ${topRising.changePercent}% week-over-week (${topRising.previousPeriod} → ${topRising.currentPeriod} units)`,
        action: 'Consider featuring this product prominently'
      });
    }

    // Insight 4: Falling products (if any significant drops)
    if (trending.falling.length > 0) {
      const topFalling = trending.falling[0];
      if (topFalling.changePercent < -30) {
        insights.push({
          type: 'warning',
          priority: 'medium',
          title: 'Product Declining',
          metric: `${topFalling.changePercent}%`,
          description: `"${topFalling.name}" is down ${Math.abs(topFalling.changePercent)}% week-over-week`,
          action: 'Review product placement or consider promotion'
        });
      }
    }

    // Insight 5: Geographic opportunity
    if (stats.geoDistribution.length > 0) {
      const topState = stats.geoDistribution[0];
      const topStatePercent = Math.round((topState.orders / stats.summary.totalOrders) * 100);
      if (topStatePercent > 30) {
        insights.push({
          type: 'geo',
          priority: 'low',
          title: 'Geographic Concentration',
          metric: `${topStatePercent}%`,
          description: `${topStatePercent}% of orders come from ${topState.state}. Consider targeted marketing in other states.`,
          action: 'Launch geo-targeted SMS/email campaign'
        });
      }
    }

    // Week over week summary
    const wowSummary = {
      trend: weekOverWeek.changes.revenue > 0 ? 'up' : (weekOverWeek.changes.revenue < 0 ? 'down' : 'stable'),
      revenueChange: weekOverWeek.changes.revenue,
      ordersChange: weekOverWeek.changes.orders,
      message: weekOverWeek.changes.revenue > 0
        ? `Revenue up ${weekOverWeek.changes.revenue}% vs last week`
        : (weekOverWeek.changes.revenue < 0
          ? `Revenue down ${Math.abs(weekOverWeek.changes.revenue)}% vs last week`
          : 'Revenue stable vs last week')
    };

    return {
      summary: stats.summary,
      weekOverWeek: {
        ...weekOverWeek,
        summary: wowSummary
      },
      upsellMetrics: stats.upsellMetrics,
      ticketAnalysis: {
        overall: ticketAnalysis.overall,
        byBoxConfig: ticketAnalysis.byBoxConfig,
        upgradeOpportunities: ticketAnalysis.opportunities
      },
      trending: {
        rising: trending.rising,
        falling: trending.falling,
        newProducts: trending.newProducts
      },
      topProducts: stats.topProducts.slice(0, 10),
      frequentCombos: combos,
      geoDistribution: stats.geoDistribution,
      sizeDistribution: stats.sizeDistribution,
      boxSizeDistribution: stats.boxSizeDistribution,
      opportunities: {
        ...opportunities,
        items: [
          {
            type: 'Extra Olive Upsell',
            value: opportunities.extraOlive,
            action: 'Improve visibility of Extra Olive option'
          },
          {
            type: 'Box Size Upgrades',
            value: opportunities.boxUpgrades,
            action: 'Promote 8 & 12 jar boxes with free shipping'
          }
        ]
      },
      insights: insights.sort((a, b) => {
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      }),
      trends: stats.trends,
      period: { days },
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * Generar AI Insights para escalar Build Your Box
   * Usa Claude para analizar patrones y dar recomendaciones
   */
  async generateAiInsights(days = 30) {
    // Obtener datos para análisis
    const [stats, combos] = await Promise.all([
      this.getDemandStats(days),
      this.getFrequentCombos(days, 2)
    ]);

    // Preparar datos para Claude
    const analysisData = {
      summary: stats.summary,
      topProducts: stats.topProducts.slice(0, 15),
      sizeDistribution: stats.sizeDistribution,
      frequentCombos: combos,
      trends: stats.trends
    };

    // Intentar usar Claude si está disponible
    let claudeService = null;
    try {
      claudeService = require('./claudeService');
      if (!claudeService.isAvailable()) {
        claudeService = null;
      }
    } catch (e) {
      console.log('⚠️ Claude service not available for BYB insights');
    }

    if (claudeService) {
      return this.generateClaudeInsights(claudeService, analysisData);
    }

    // Fallback sin Claude
    return this.generateFallbackInsights(analysisData);
  }

  /**
   * Generar insights usando Claude AI
   */
  async generateClaudeInsights(claudeService, data) {
    const prompt = `Eres un experto en desarrollo de productos para Jersey Pickles, una empresa artesanal de pickles y olives gourmet de New Jersey.

CONTEXTO DEL NEGOCIO:
- Jersey Pickles vende pickles artesanales (pepinos, tomates, etc.) y olives gourmet
- El "Build Your Box" permite a clientes elegir: Tipo de jar (Quart 32oz o Half Gallon) → Tamaño de box (4, 6, 8, 12 jars) → Productos individuales
- Los clientes mezclan pickles y olives según su gusto
- Es un negocio familiar artesanal, no industrial

DATOS DE DEMANDA DE LOS ÚLTIMOS ${data.summary.period?.days || 30} DÍAS:

📊 RESUMEN:
• Boxes vendidos: ${data.summary.totalBoxes}
• Pedidos: ${data.summary.totalOrders}
• Productos elegidos: ${data.summary.totalProducts} unidades
• Promedio por box: ${data.summary.avgProductsPerBox} productos

🏆 TOP PRODUCTOS MÁS ELEGIDOS:
${data.topProducts.map((p, i) => `${i + 1}. ${p.name}: ${p.totalQuantity} unidades (${p.orderCount} pedidos)`).join('\n')}

📦 TAMAÑOS DE JAR:
${data.sizeDistribution.map(s => `• ${s.size}: ${s.count} boxes (${s.percentage}%)`).join('\n')}

🤝 PRODUCTOS QUE SE PIDEN JUNTOS:
${data.frequentCombos.length > 0 ? data.frequentCombos.map((c, i) => `${i + 1}. "${c.product1}" + "${c.product2}" → ${c.count} veces`).join('\n') : 'Sin datos suficientes'}

═══════════════════════════════════════════════════════════
🎯 GENERA RECOMENDACIONES EN ESTAS CATEGORÍAS:
═══════════════════════════════════════════════════════════

1. **IDEAS DE NUEVOS PRODUCTOS** (newProductIdeas)
   - Basándote en los productos populares, sugiere RECETAS ESPECÍFICAS de nuevos productos
   - Ejemplo: Si "Garlic Dill Pickles" es popular → "Roasted Garlic & Black Pepper Pickles"
   - Ejemplo: Si "Hot Green Tomatoes" es popular → "Sweet Heat Green Tomatoes con miel y habanero"
   - Piensa en: variaciones de sabor (más dulce, más picante, sabores únicos), productos de temporada, fusiones de sabores
   - Incluye descripción del perfil de sabor

2. **MEJORAS AL BUILD YOUR BOX** (bybImprovements)
   - Ideas para mejorar la experiencia de Build Your Box
   - Ejemplo: "Agregar tamaño 16oz Sampler para clientes nuevos"
   - Ejemplo: "Opción 'Mystery Jar' donde Jersey Pickles elige una sorpresa"
   - Ejemplo: "Categoría 'Staff Picks' con los favoritos del equipo"
   - Ejemplo: "Auto-sugerir productos complementarios basado en selección"

3. **ESTRATEGIAS DE ESCALADO** (scalingStrategies)
   - Cómo aumentar ventas del Build Your Box
   - Basado en los datos: qué tamaños promover, qué productos destacar
   - Ideas de upsell dentro del flujo de Build Your Box

4. **IDEAS DE MARKETING** (marketingIdeas)
   - Campañas SMS/Email específicas usando los productos más populares
   - Ejemplo: "Campaña 'Garlic Lovers Week' destacando todos los productos con ajo"

5. **QUICK WINS** (quickWins)
   - 3-5 acciones que se pueden implementar esta semana

Responde SOLO con JSON válido (sin markdown, sin backticks):
{
  "executiveSummary": "2-3 oraciones: insight principal y oportunidad más grande basada en los datos",
  "newProductIdeas": [
    {
      "name": "Nombre comercial del producto (ej: Honey Habanero Green Tomatoes)",
      "description": "Descripción del producto y perfil de sabor",
      "whyItWorks": "Por qué funcionaría basado en los datos de demanda",
      "basedOn": ["Producto existente que inspira esta idea"],
      "category": "pickle o olive",
      "flavorProfile": "dulce/picante/ácido/savory/etc"
    }
  ],
  "bybImprovements": [
    {
      "idea": "Título de la mejora",
      "description": "Descripción detallada de la implementación",
      "benefit": "Beneficio esperado para el negocio",
      "effort": "low/medium/high"
    }
  ],
  "scalingStrategies": [
    {
      "title": "Título de la estrategia",
      "description": "Descripción detallada",
      "expectedImpact": "Impacto esperado (ej: +15% ticket promedio)",
      "effort": "low/medium/high"
    }
  ],
  "marketingIdeas": [
    {
      "channel": "SMS o Email",
      "campaignName": "Nombre de la campaña",
      "message": "Ejemplo del mensaje o subject line",
      "targetProduct": "Producto a destacar",
      "timing": "Cuándo enviar"
    }
  ],
  "quickWins": ["Acción inmediata 1", "Acción inmediata 2", "Acción inmediata 3"],
  "dataInsights": {
    "surprising": "Algo interesante o inesperado en los datos",
    "opportunity": "Oportunidad no obvia que detectas"
  }
}`;

    try {
      console.log('🧠 Generating BYB AI insights with Claude...');
      const startTime = Date.now();

      const response = await claudeService.client.messages.create({
        model: claudeService.model,
        max_tokens: 2500,
        messages: [{ role: 'user', content: prompt }]
      });

      const duration = Date.now() - startTime;
      console.log(`✅ Claude responded in ${duration}ms`);

      const content = response.content[0]?.text;
      if (!content) {
        console.error('❌ Claude returned empty response');
        return this.generateFallbackInsights(data);
      }

      // Parse JSON response
      let parsed;
      try {
        let jsonStr = content.trim();
        if (jsonStr.includes('```')) {
          const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (match) jsonStr = match[1];
        }
        if (!jsonStr.startsWith('{')) {
          const start = jsonStr.indexOf('{');
          if (start !== -1) jsonStr = jsonStr.substring(start);
        }
        if (!jsonStr.endsWith('}')) {
          const end = jsonStr.lastIndexOf('}');
          if (end !== -1) jsonStr = jsonStr.substring(0, end + 1);
        }
        parsed = JSON.parse(jsonStr);

        // Log para debug - ver qué retorna Claude
        console.log('📦 Claude BYB parsed response keys:', Object.keys(parsed));
        if (parsed.newProductIdeas?.length > 0) {
          console.log('📦 Sample newProductIdea:', JSON.stringify(parsed.newProductIdeas[0]));
        }
        if (parsed.marketingIdeas?.length > 0) {
          console.log('📦 Sample marketingIdea:', JSON.stringify(parsed.marketingIdeas[0]));
        }
      } catch (parseError) {
        console.error('❌ Error parsing Claude response:', parseError.message);
        return this.generateFallbackInsights(data);
      }

      return {
        success: true,
        ...parsed,
        generatedAt: new Date().toISOString(),
        model: claudeService.model,
        tokensUsed: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0
        },
        duration,
        dataSnapshot: {
          totalBoxes: data.summary.totalBoxes,
          topProduct: data.topProducts[0]?.name,
          period: data.summary.period
        }
      };

    } catch (error) {
      console.error('❌ Error calling Claude for BYB insights:', error.message);
      return this.generateFallbackInsights(data);
    }
  }

  /**
   * Fallback insights cuando Claude no está disponible
   */
  generateFallbackInsights(data) {
    const topProducts = data.topProducts || [];
    const combos = data.frequentCombos || [];
    const sizes = data.sizeDistribution || [];

    // Análisis básico
    const topProduct = topProducts[0];
    const dominantSize = sizes[0];

    const scalingStrategies = [];
    const quickWins = [];

    // Estrategia 1: Aumentar ticket con upgrades
    if (sizes.length > 1) {
      const smallestSize = sizes[sizes.length - 1];
      if (smallestSize && smallestSize.percentage > 20) {
        scalingStrategies.push({
          title: 'Incentivar upgrades de tamaño',
          description: `${smallestSize.percentage}% de clientes eligen ${smallestSize.size}. Ofrece un descuento para upgrade al tamaño siguiente.`,
          expectedImpact: '+10-15% ticket promedio',
          effort: 'low',
          priority: 1
        });
      }
    }

    // Estrategia 2: Bundles pre-armados
    if (combos.length > 0) {
      scalingStrategies.push({
        title: 'Crear bundles pre-armados',
        description: `Basado en los combos frecuentes, crea opciones "ready to buy" para reducir fricción.`,
        expectedImpact: '+20% conversión en página de producto',
        effort: 'medium',
        priority: 2
      });
    }

    // Quick wins
    if (topProduct) {
      quickWins.push(`Destacar "${topProduct.name}" en la página principal del Build Your Box`);
    }
    quickWins.push('Agregar fotos de boxes armados por otros clientes (social proof)');
    quickWins.push('Mostrar "Más popular" badge en los top 3 productos');

    // Bundle suggestions basados en combos
    const bundleSuggestions = combos.slice(0, 2).map((combo, i) => ({
      name: i === 0 ? 'The Classics Duo' : 'Fan Favorites Pack',
      products: [combo.product1, combo.product2],
      size: 'QUART',
      rationale: `Estos productos se piden juntos ${combo.count} veces`,
      suggestedPrice: '$35-45'
    }));

    return {
      success: true,
      executiveSummary: topProduct
        ? `"${topProduct.name}" es tu producto estrella con ${topProduct.totalQuantity} unidades vendidas. ${combos.length > 0 ? `Los clientes frecuentemente lo combinan con "${combos[0]?.product2}".` : ''} Oportunidad: crear bundles pre-armados basados en estos patrones.`
        : 'Necesitas más datos para generar insights significativos. Sigue vendiendo Build Your Boxes para acumular información.',
      scalingStrategies,
      newProductIdeas: topProducts.length > 3 ? [
        {
          product: `${topProducts[0]?.name?.split(' ')[0]} Extra Spicy`,
          rationale: 'Variante más picante del producto más popular',
          basedOn: [topProducts[0]?.name]
        }
      ] : [],
      bundleSuggestions,
      sizeOptimization: {
        analysis: dominantSize
          ? `${dominantSize.size} es el tamaño más popular (${dominantSize.percentage}%)`
          : 'Sin datos suficientes de tamaños',
        recommendation: 'Considera ofrecer un descuento por elegir el tamaño más grande'
      },
      marketingIdeas: topProduct ? [
        {
          channel: 'SMS',
          idea: `"${topProduct.name}" is flying off shelves! Build your box before it's gone 🥒`,
          targetProduct: topProduct.name,
          timing: 'Viernes por la mañana'
        }
      ] : [],
      quickWins,
      dataInsights: {
        surprising: topProducts.length > 5
          ? `Hay ${topProducts.length} productos diferentes siendo elegidos - buena variedad`
          : 'Pocos productos dominan las elecciones',
        concern: data.summary.avgProductsPerBox < 3
          ? 'Los clientes eligen pocos productos por box - considera incentivos para agregar más'
          : null,
        opportunity: combos.length > 0
          ? 'Los patrones de combo sugieren oportunidades de bundles pre-armados'
          : 'Necesitas más datos para identificar patrones'
      },
      generatedAt: new Date().toISOString(),
      model: 'fallback-analysis',
      isFallback: true,
      dataSnapshot: {
        totalBoxes: data.summary.totalBoxes,
        topProduct: topProduct?.name,
        period: data.summary.period
      }
    };
  }
}

module.exports = new BuildYourBoxService();
