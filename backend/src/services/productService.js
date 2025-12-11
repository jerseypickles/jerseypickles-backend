// backend/src/services/productService.js
// 🛒 Product Service - Sync desde Shopify y análisis de productos
const Product = require('../models/Product');
const Order = require('../models/Order');

class ProductService {
  
  constructor() {
    this.shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
    this.accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  }

  // ==================== SHOPIFY API ====================

  /**
   * Llamada genérica a Shopify API
   */
  async shopifyRequest(endpoint, method = 'GET', body = null) {
    if (!this.shopifyDomain || !this.accessToken) {
      throw new Error('Shopify credentials not configured');
    }

    const url = `https://${this.shopifyDomain}/admin/api/2024-01/${endpoint}`;
    
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': this.accessToken
      }
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Shopify API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  }

  // ==================== SYNC PRODUCTOS ====================

  /**
   * Sincronizar todos los productos desde Shopify
   */
  async syncAllProducts() {
    console.log('🔄 Starting full product sync from Shopify...');
    
    let products = [];
    let pageInfo = null;
    let hasNextPage = true;
    
    while (hasNextPage) {
      const endpoint = pageInfo 
        ? `products.json?limit=250&page_info=${pageInfo}`
        : 'products.json?limit=250';
      
      const response = await this.shopifyRequest(endpoint);
      products = products.concat(response.products || []);
      
      // Pagination handling
      const linkHeader = response.headers?.get?.('link') || '';
      hasNextPage = linkHeader.includes('rel="next"');
      
      if (hasNextPage) {
        const match = linkHeader.match(/page_info=([^>&]*)/);
        pageInfo = match ? match[1] : null;
      }
      
      // Simple pagination fallback
      if (!hasNextPage && response.products?.length === 250) {
        // Puede haber más, pero Shopify no dio link header
        // Por ahora, asumir que no hay más
        hasNextPage = false;
      }
    }
    
    console.log(`📦 Found ${products.length} products in Shopify`);
    
    // Upsert each product
    let synced = 0;
    let errors = 0;
    
    for (const shopifyProduct of products) {
      try {
        await Product.upsertFromShopify(shopifyProduct);
        synced++;
      } catch (error) {
        console.error(`❌ Error syncing product ${shopifyProduct.id}:`, error.message);
        errors++;
      }
    }
    
    console.log(`✅ Product sync complete: ${synced} synced, ${errors} errors`);
    
    return { synced, errors, total: products.length };
  }

  /**
   * Sincronizar un producto específico por Shopify ID
   */
  async syncProduct(shopifyProductId) {
    try {
      const response = await this.shopifyRequest(`products/${shopifyProductId}.json`);
      
      if (response.product) {
        return Product.upsertFromShopify(response.product);
      }
      
      return null;
    } catch (error) {
      console.error(`Error syncing product ${shopifyProductId}:`, error.message);
      throw error;
    }
  }

  /**
   * Manejar webhook de producto
   */
  async handleProductWebhook(topic, payload) {
    console.log(`📦 Product webhook received: ${topic}`);
    
    switch (topic) {
      case 'products/create':
      case 'products/update':
        return this.handleProductCreateOrUpdate(payload);
        
      case 'products/delete':
        return this.handleProductDelete(payload);
        
      default:
        console.log(`⚠️ Unknown product webhook topic: ${topic}`);
        return null;
    }
  }

  async handleProductCreateOrUpdate(shopifyProduct) {
    try {
      const product = await Product.upsertFromShopify(shopifyProduct);
      console.log(`✅ Product ${product.title} synced from webhook`);
      return product;
    } catch (error) {
      console.error('Error handling product webhook:', error);
      throw error;
    }
  }

  async handleProductDelete(payload) {
    try {
      const shopifyId = payload.id?.toString();
      
      if (!shopifyId) {
        console.log('⚠️ No product ID in delete webhook');
        return null;
      }
      
      const result = await Product.findOneAndUpdate(
        { shopifyId },
        { status: 'archived' },
        { new: true }
      );
      
      if (result) {
        console.log(`🗑️ Product ${result.title} archived`);
      }
      
      return result;
    } catch (error) {
      console.error('Error handling product delete:', error);
      throw error;
    }
  }

  // ==================== ANÁLISIS DE PRODUCTOS ====================

  /**
   * Calcular productos más vendidos desde Orders
   */
  async calculateTopSellingFromOrders(days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    const pipeline = [
      {
        $match: {
          orderDate: { $gte: startDate },
          financialStatus: { $in: ['paid', 'partially_refunded'] }
        }
      },
      { $unwind: '$lineItems' },
      {
        $group: {
          _id: '$lineItems.productId',
          title: { $first: '$lineItems.title' },
          totalQuantity: { $sum: '$lineItems.quantity' },
          totalRevenue: { $sum: { $multiply: ['$lineItems.price', '$lineItems.quantity'] } },
          ordersCount: { $sum: 1 }
        }
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: 20 }
    ];
    
    const topProducts = await Order.aggregate(pipeline);
    
    // Enriquecer con datos de Product
    const enriched = await Promise.all(topProducts.map(async (item) => {
      const product = await Product.findOne({ shopifyId: item._id }).lean();
      
      return {
        shopifyId: item._id,
        title: item.title,
        totalQuantity: item.totalQuantity,
        totalRevenue: parseFloat(item.totalRevenue.toFixed(2)),
        ordersCount: item.ordersCount,
        avgOrderQuantity: parseFloat((item.totalQuantity / item.ordersCount).toFixed(2)),
        // Datos de Product si existe
        inventory: product?.totalInventory || 'unknown',
        isLowStock: product?.isLowStock || false,
        isOutOfStock: product?.isOutOfStock || false,
        featuredImage: product?.featuredImage || null,
        priceRange: product?.priceRange || null
      };
    }));
    
    return enriched;
  }

  /**
   * Calcular productos comprados juntos frecuentemente
   */
  async calculateFrequentlyBoughtTogether(days = 90, minCoOccurrences = 3) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    // Obtener órdenes con múltiples productos
    const orders = await Order.find({
      orderDate: { $gte: startDate },
      'lineItems.1': { $exists: true },  // Al menos 2 items
      financialStatus: { $in: ['paid', 'partially_refunded'] }
    }).select('lineItems').lean();
    
    // Contar co-ocurrencias
    const coOccurrences = new Map();
    
    for (const order of orders) {
      const productIds = order.lineItems.map(item => item.productId).filter(Boolean);
      
      // Generar pares únicos
      for (let i = 0; i < productIds.length; i++) {
        for (let j = i + 1; j < productIds.length; j++) {
          const pair = [productIds[i], productIds[j]].sort().join('|');
          coOccurrences.set(pair, (coOccurrences.get(pair) || 0) + 1);
        }
      }
    }
    
    // Filtrar y formatear
    const pairs = [];
    for (const [pair, count] of coOccurrences) {
      if (count >= minCoOccurrences) {
        const [id1, id2] = pair.split('|');
        pairs.push({ productIds: [id1, id2], count });
      }
    }
    
    // Ordenar por frecuencia
    pairs.sort((a, b) => b.count - a.count);
    
    // Enriquecer con títulos
    const enriched = await Promise.all(pairs.slice(0, 20).map(async (pair) => {
      const [p1, p2] = await Promise.all([
        Product.findOne({ shopifyId: pair.productIds[0] }).select('title').lean(),
        Product.findOne({ shopifyId: pair.productIds[1] }).select('title').lean()
      ]);
      
      return {
        products: [
          { id: pair.productIds[0], title: p1?.title || 'Unknown' },
          { id: pair.productIds[1], title: p2?.title || 'Unknown' }
        ],
        coOccurrences: pair.count
      };
    }));
    
    return enriched;
  }

  /**
   * Obtener productos con bajo stock que se están vendiendo
   */
  async getCriticalInventory() {
    const lowStockProducts = await Product.find({
      status: 'active',
      totalInventory: { $gt: 0, $lte: 15 },
      'salesStats.last7Days.unitsSold': { $gt: 0 }
    })
    .sort({ 'salesStats.last7Days.unitsSold': -1 })
    .select('title totalInventory salesStats.last7Days priceRange')
    .lean();
    
    return lowStockProducts.map(p => ({
      title: p.title,
      currentStock: p.totalInventory,
      soldLast7Days: p.salesStats?.last7Days?.unitsSold || 0,
      estimatedDaysUntilStockout: p.salesStats?.last7Days?.unitsSold > 0
        ? Math.ceil(p.totalInventory / (p.salesStats.last7Days.unitsSold / 7))
        : null,
      potentialLostRevenue: p.salesStats?.last7Days?.unitsSold > 0
        ? parseFloat(((p.salesStats.last7Days.unitsSold / 7) * 14 * (p.priceRange?.min || 0)).toFixed(2))
        : 0
    }));
  }

  /**
   * Actualizar stats de venta desde una orden procesada
   */
  async recordOrderSales(order, listId = null, listName = null) {
    if (!order.lineItems || order.lineItems.length === 0) {
      return;
    }
    
    for (const item of order.lineItems) {
      if (item.productId) {
        await Product.recordSale(
          item.productId,
          item.quantity,
          item.price * item.quantity,
          listId,
          listName
        );
      }
    }
    
    // Actualizar frequently bought together si hay múltiples productos
    if (order.lineItems.length >= 2) {
      await this.updateFrequentlyBoughtTogether(order.lineItems);
    }
  }

  /**
   * Actualizar productos comprados juntos
   */
  async updateFrequentlyBoughtTogether(lineItems) {
    const productIds = lineItems.map(item => item.productId).filter(Boolean);
    
    for (let i = 0; i < productIds.length; i++) {
      for (let j = i + 1; j < productIds.length; j++) {
        const product = await Product.findOne({ shopifyId: productIds[i] });
        
        if (product) {
          const existing = product.frequentlyBoughtWith.find(
            fbt => fbt.shopifyId === productIds[j]
          );
          
          if (existing) {
            existing.coOccurrences += 1;
            existing.lastUpdated = new Date();
          } else {
            const relatedProduct = await Product.findOne({ shopifyId: productIds[j] }).lean();
            product.frequentlyBoughtWith.push({
              shopifyId: productIds[j],
              title: relatedProduct?.title || 'Unknown',
              coOccurrences: 1,
              lastUpdated: new Date()
            });
          }
          
          await product.save();
        }
      }
    }
  }

  // ==================== DATOS PARA CLAUDE ====================

  /**
   * Preparar datos de productos para análisis de Claude
   */
  async prepareProductDataForClaude() {
    const [
      topSelling,
      lowStock,
      outOfStock,
      giftSets,
      inventorySummary,
      frequentlyBought
    ] = await Promise.all([
      this.calculateTopSellingFromOrders(30),
      Product.getLowStock(10),
      Product.getOutOfStock(),
      Product.getGiftSets(),
      Product.getInventorySummary(),
      this.calculateFrequentlyBoughtTogether(90, 3)
    ]);
    
    return {
      // Top 10 productos más vendidos (30 días)
      topSellingProducts: topSelling.slice(0, 10).map(p => ({
        title: p.title,
        revenue: `$${p.totalRevenue}`,
        unitsSold: p.totalQuantity,
        orders: p.ordersCount,
        inventory: p.inventory,
        isLowStock: p.isLowStock,
        isOutOfStock: p.isOutOfStock
      })),
      
      // Productos con bajo stock que se venden
      lowStockAlert: lowStock.slice(0, 5).map(p => ({
        title: p.title,
        currentStock: p.totalInventory,
        recentSales: p.salesStats?.last30Days?.unitsSold || 0
      })),
      
      // Productos agotados con ventas previas
      outOfStockProducts: outOfStock.slice(0, 5).map(p => ({
        title: p.title,
        previousRevenue: p.salesStats?.last30Days?.revenue || 0
      })),
      
      // Gift sets disponibles (importantes para holidays)
      giftSetsAvailable: giftSets.slice(0, 5).map(p => ({
        title: p.title,
        inventory: p.totalInventory,
        price: p.priceRange?.min || 0
      })),
      
      // Resumen de inventario
      inventorySummary: {
        totalProducts: inventorySummary.totalProducts,
        totalUnits: inventorySummary.totalInventory,
        estimatedValue: `$${inventorySummary.totalValue.toFixed(0)}`,
        lowStockCount: inventorySummary.lowStockCount,
        outOfStockCount: inventorySummary.outOfStockCount
      },
      
      // Top bundles naturales
      frequentlyBoughtTogether: frequentlyBought.slice(0, 5).map(pair => ({
        products: pair.products.map(p => p.title),
        timesBoughtTogether: pair.coOccurrences
      }))
    };
  }
}

module.exports = new ProductService();