// backend/src/services/buildYourBoxService.js
// Service para analizar demanda de productos en Build Your Box

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
  }

  /**
   * Parsear notas de Build Your Box
   * Formato: *** Build Your Boxes ***  Box #1 (Jar: QUART) • Product (qty) • Product (qty)
   */
  parseBoxNote(note) {
    if (!note || !note.includes('Build Your Box')) return null;

    const boxes = [];

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

      if (products.length > 0) {
        boxes.push({
          boxNumber,
          jarSize,
          products
        });
      }
    }

    return boxes.length > 0 ? boxes : null;
  }

  /**
   * Obtener estadísticas de demanda
   * @param {number} days - Días hacia atrás (0 = desde hoy en adelante, null = todos)
   */
  async getDemandStats(days = 30) {
    const query = {};

    if (days > 0) {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      query.orderDate = { $gte: startDate };
    }

    // Buscar órdenes con notas de Build Your Box
    const orders = await Order.find({
      ...query,
      'shopifyData.note': { $regex: /Build Your Box/i }
    }).select('shopifyData.note orderDate totalPrice orderNumber').lean();

    // Agregados
    const productStats = {};
    const sizeStats = {};
    let totalBoxes = 0;
    let totalProducts = 0;
    const dailyData = {};

    for (const order of orders) {
      const note = order.shopifyData?.note;
      if (!note) continue;

      const boxes = this.parseBoxNote(note);
      if (!boxes) continue;

      // Fecha para tendencias
      const dateKey = new Date(order.orderDate).toISOString().split('T')[0];
      if (!dailyData[dateKey]) {
        dailyData[dateKey] = { boxes: 0, products: 0, orders: 0 };
      }
      dailyData[dateKey].orders++;

      for (const box of boxes) {
        totalBoxes++;
        dailyData[dateKey].boxes++;

        // Stats por tamaño
        if (!sizeStats[box.jarSize]) {
          sizeStats[box.jarSize] = { count: 0, products: 0 };
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

    // Tendencias diarias (últimos 14 días)
    const trends = Object.entries(dailyData)
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(-14);

    return {
      summary: {
        totalOrders: orders.length,
        totalBoxes,
        totalProducts,
        avgProductsPerBox: totalBoxes > 0 ? Math.round((totalProducts / totalBoxes) * 10) / 10 : 0,
        period: { days }
      },
      topProducts: topProducts.slice(0, 20),
      sizeDistribution,
      trends
    };
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
      const boxes = this.parseBoxNote(order.shopifyData?.note);
      if (!boxes) continue;

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
   * Obtener overview completo para dashboard
   */
  async getOverview(days = 30) {
    const [stats, combos] = await Promise.all([
      this.getDemandStats(days),
      this.getFrequentCombos(days)
    ]);

    return {
      ...stats,
      frequentCombos: combos
    };
  }
}

module.exports = new BuildYourBoxService();
