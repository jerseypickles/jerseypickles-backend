// backend/src/services/productService.js
// 🛒 Product Service - Sync desde Shopify y análisis de productos
// ✅ FIXED: Usa SHOPIFY_STORE_URL (no SHOPIFY_STORE_DOMAIN)
const mongoose = require('mongoose');

// Obtener modelo de forma segura
const getProductModel = () => {
  try {
    return mongoose.model('Product');
  } catch (e) {
    console.warn('Product model not available');
    return null;
  }
};

const getOrderModel = () => {
  try {
    return mongoose.model('Order');
  } catch (e) {
    console.warn('Order model not available');
    return null;
  }
};

class ProductService {
  
  constructor() {
    // ✅ FIXED: Usa SHOPIFY_STORE_URL (tu variable) con fallback a SHOPIFY_STORE_DOMAIN
    this.shopifyDomain = process.env.SHOPIFY_STORE_URL || process.env.SHOPIFY_STORE_DOMAIN;
    this.accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
    
    // Log para debug
    console.log(`📦 ProductService initialized - Domain: ${this.shopifyDomain ? '✅ Set' : '❌ Missing'}, Token: ${this.accessToken ? '✅ Set' : '❌ Missing'}`);
  }

  // ==================== SHOPIFY API ====================

  async shopifyRequest(endpoint, method = 'GET', body = null) {
    if (!this.shopifyDomain || !this.accessToken) {
      console.error('❌ Shopify config missing:', {
        domain: this.shopifyDomain ? 'set' : 'MISSING',
        token: this.accessToken ? 'set' : 'MISSING'
      });
      throw new Error('Shopify credentials not configured');
    }

    const url = `https://${this.shopifyDomain}/admin/api/2024-01/${endpoint}`;
    
    console.log(`🔗 Shopify API: ${method} ${endpoint}`);
    
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
      console.error(`❌ Shopify API error: ${response.status}`, errorText.substring(0, 200));
      throw new Error(`Shopify API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  }

  // ==================== SYNC PRODUCTOS ====================

  async syncAllProducts() {
    const Product = getProductModel();
    if (!Product) {
      throw new Error('Product model not available');
    }
    
    console.log('🔄 Syncing products from Shopify...');
    console.log(`   Domain: ${this.shopifyDomain}`);
    
    let synced = 0;
    let pageInfo = null;
    
    do {
      const endpoint = pageInfo 
        ? `products.json?limit=250&page_info=${pageInfo}`
        : 'products.json?limit=250&status=active';
        
      const data = await this.shopifyRequest(endpoint);
      
      for (const shopifyProduct of data.products) {
        await this.upsertProduct(shopifyProduct);
        synced++;
      }
      
      // Paginación cursor-based de Shopify
      pageInfo = this.extractPageInfo(data);
      
      console.log(`   📦 Synced ${synced} products...`);
      
    } while (pageInfo);
    
    console.log(`✅ Product sync complete: ${synced} products`);
    
    return { synced, timestamp: new Date() };
  }

  async upsertProduct(shopifyProduct) {
    const Product = getProductModel();
    if (!Product) return null;
    
    const productData = {
      shopifyId: shopifyProduct.id.toString(),
      title: shopifyProduct.title,
      handle: shopifyProduct.handle,
      productType: shopifyProduct.product_type,
      vendor: shopifyProduct.vendor,
      tags: shopifyProduct.tags ? shopifyProduct.tags.split(',').map(t => t.trim()) : [],
      status: shopifyProduct.status || 'active',
      variants: (shopifyProduct.variants || []).map(v => ({
        shopifyVariantId: v.id?.toString(),
        title: v.title,
        sku: v.sku,
        price: parseFloat(v.price) || 0,
        compareAtPrice: v.compare_at_price ? parseFloat(v.compare_at_price) : null,
        inventoryQuantity: v.inventory_quantity || 0,
        inventoryPolicy: v.inventory_policy,
        weight: v.weight,
        weightUnit: v.weight_unit
      })),
      images: (shopifyProduct.images || []).map(img => ({
        shopifyImageId: img.id?.toString(),
        src: img.src,
        alt: img.alt,
        position: img.position
      })),
      featuredImage: shopifyProduct.image?.src || shopifyProduct.images?.[0]?.src,
      shopifyData: shopifyProduct,
      lastSyncedAt: new Date()
    };
    
    // Calcular totalInventory
    productData.totalInventory = (productData.variants || []).reduce(
      (sum, v) => sum + (v.inventoryQuantity || 0), 0
    );
    
    // Calcular priceRange
    const prices = (productData.variants || []).map(v => v.price).filter(p => p > 0);
    if (prices.length > 0) {
      productData.priceRange = { min: Math.min(...prices), max: Math.max(...prices) };
    }
    
    // Calcular stock status
    productData.isOutOfStock = productData.totalInventory <= 0;
    productData.isLowStock = productData.totalInventory > 0 && productData.totalInventory <= 10;
    
    // Auto-detectar categorías
    const titleLower = (productData.title || '').toLowerCase();
    const tagsLower = (productData.tags || []).map(t => t.toLowerCase());
    
    productData.categories = {
      isGiftSet: titleLower.includes('gift') || titleLower.includes('set') || 
                 tagsLower.includes('gift') || tagsLower.includes('gift set'),
      isSeasonal: tagsLower.includes('seasonal') || tagsLower.includes('holiday') || 
                  tagsLower.includes('christmas') || tagsLower.includes('bbq') ||
                  tagsLower.includes('summer'),
      isNewArrival: false,
      isBestSeller: false,
      isOnSale: productData.variants?.some(v => v.compareAtPrice && v.compareAtPrice > v.price)
    };
    
    const product = await Product.findOneAndUpdate(
      { shopifyId: productData.shopifyId },
      productData,
      { upsert: true, new: true, runValidators: true }
    );
    
    return product;
  }

  extractPageInfo(data) {
    // Shopify devuelve page_info en headers para paginación
    // Por ahora retornamos null para no paginar infinitamente
    return null;
  }

  async syncProduct(shopifyProductId) {
    const data = await this.shopifyRequest(`products/${shopifyProductId}.json`);
    return this.upsertProduct(data.product);
  }

  async handleProductWebhook(topic, payload) {
    console.log(`📦 Product webhook: ${topic}`);
    
    const Product = getProductModel();
    if (!Product) {
      console.warn('Product model not available for webhook');
      return;
    }
    
    switch (topic) {
      case 'products/create':
      case 'products/update':
        await this.upsertProduct(payload);
        break;
        
      case 'products/delete':
        await Product.findOneAndUpdate(
          { shopifyId: payload.id?.toString() },
          { status: 'archived' }
        );
        console.log(`📦 Product archived: ${payload.id}`);
        break;
    }
  }

  // ==================== ANÁLISIS ====================

  async calculateTopSellingFromOrders(days = 30) {
    const Order = getOrderModel();
    const Product = getProductModel();
    
    if (!Order) {
      console.warn('Order model not available');
      return [];
    }
    
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
    
    // Enriquecer con datos de Product si está disponible
    const enriched = await Promise.all(topProducts.map(async (item) => {
      let productData = {
        inventory: 'unknown',
        isLowStock: false,
        isOutOfStock: false,
        featuredImage: null,
        priceRange: null
      };
      
      if (Product) {
        try {
          const product = await Product.findOne({ shopifyId: item._id }).lean();
          if (product) {
            productData = {
              inventory: product.totalInventory || 0,
              isLowStock: product.isLowStock || false,
              isOutOfStock: product.isOutOfStock || false,
              featuredImage: product.featuredImage || null,
              priceRange: product.priceRange || null
            };
          }
        } catch (e) {
          console.warn('Error enriching product:', e.message);
        }
      }
      
      return {
        shopifyId: item._id,
        title: item.title,
        totalQuantity: item.totalQuantity,
        totalRevenue: parseFloat(item.totalRevenue?.toFixed(2) || 0),
        ordersCount: item.ordersCount,
        avgOrderQuantity: parseFloat((item.totalQuantity / item.ordersCount).toFixed(2)),
        ...productData
      };
    }));
    
    return enriched;
  }

  async calculateFrequentlyBoughtTogether(days = 90, minCoOccurrences = 3) {
    const Order = getOrderModel();
    if (!Order) return [];
    
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    const orders = await Order.find({
      orderDate: { $gte: startDate },
      'lineItems.1': { $exists: true },
      financialStatus: { $in: ['paid', 'partially_refunded'] }
    }).select('lineItems').lean();
    
    const coOccurrences = new Map();
    
    for (const order of orders) {
      const productIds = [...new Set(order.lineItems.map(li => li.productId))];
      
      for (let i = 0; i < productIds.length; i++) {
        for (let j = i + 1; j < productIds.length; j++) {
          const key = [productIds[i], productIds[j]].sort().join('|');
          
          if (!coOccurrences.has(key)) {
            coOccurrences.set(key, {
              products: [
                order.lineItems.find(li => li.productId === productIds[i]),
                order.lineItems.find(li => li.productId === productIds[j])
              ],
              count: 0
            });
          }
          coOccurrences.get(key).count++;
        }
      }
    }
    
    return Array.from(coOccurrences.values())
      .filter(co => co.count >= minCoOccurrences)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map(co => ({
        products: co.products.map(p => ({
          productId: p?.productId,
          title: p?.title || 'Unknown'
        })),
        coOccurrences: co.count
      }));
  }

  // ==================== HELPERS DE QUERY (REEMPLAZAN STATIC METHODS) ====================

  async getLowStock(threshold = 10) {
    const Product = getProductModel();
    if (!Product) return [];
    
    return Product.find({
      status: 'active',
      totalInventory: { $gt: 0, $lte: threshold }
    })
    .sort({ totalInventory: 1 })
    .select('title handle totalInventory variants.sku salesStats.last30Days shopifyId')
    .lean();
  }

  async getOutOfStock() {
    const Product = getProductModel();
    if (!Product) return [];
    
    return Product.find({
      status: 'active',
      totalInventory: { $lte: 0 }
    })
    .select('title handle salesStats.last30Days shopifyId')
    .lean();
  }

  async getGiftSets() {
    const Product = getProductModel();
    if (!Product) return [];
    
    return Product.find({
      status: 'active',
      'categories.isGiftSet': true,
      totalInventory: { $gt: 0 }
    })
    .sort({ 'salesStats.last30Days.revenue': -1 })
    .lean();
  }

  async getInventorySummary() {
    const Product = getProductModel();
    if (!Product) {
      return {
        totalProducts: 0,
        totalInventory: 0,
        totalValue: 0,
        lowStockCount: 0,
        outOfStockCount: 0,
        giftSetsCount: 0
      };
    }
    
    const [summary] = await Product.aggregate([
      { $match: { status: 'active' } },
      {
        $group: {
          _id: null,
          totalProducts: { $sum: 1 },
          totalInventory: { $sum: '$totalInventory' },
          totalValue: { $sum: { $multiply: ['$totalInventory', { $ifNull: ['$priceRange.min', 0] }] } },
          lowStockCount: { $sum: { $cond: [{ $and: [{ $gt: ['$totalInventory', 0] }, { $lte: ['$totalInventory', 10] }] }, 1, 0] } },
          outOfStockCount: { $sum: { $cond: [{ $lte: ['$totalInventory', 0] }, 1, 0] } },
          giftSetsCount: { $sum: { $cond: [{ $eq: ['$categories.isGiftSet', true] }, 1, 0] } }
        }
      }
    ]);
    
    return summary || {
      totalProducts: 0,
      totalInventory: 0,
      totalValue: 0,
      lowStockCount: 0,
      outOfStockCount: 0,
      giftSetsCount: 0
    };
  }

  async getCriticalInventory(threshold = 10, minRecentSales = 5) {
    const Product = getProductModel();
    if (!Product) return [];
    
    return Product.find({
      status: 'active',
      totalInventory: { $gt: 0, $lte: threshold },
      'salesStats.last7Days.unitsSold': { $gte: minRecentSales }
    })
    .sort({ totalInventory: 1 })
    .lean();
  }

  async recordOrderSales(order, listId = null, listName = null) {
    const Product = getProductModel();
    if (!Product || !order?.lineItems) return;
    
    for (const item of order.lineItems) {
      if (!item.productId) continue;
      
      try {
        const update = {
          $inc: {
            'salesStats.totalUnitsSold': item.quantity,
            'salesStats.totalRevenue': item.price * item.quantity,
            'salesStats.totalOrders': 1,
            'salesStats.last30Days.unitsSold': item.quantity,
            'salesStats.last30Days.revenue': item.price * item.quantity,
            'salesStats.last30Days.orders': 1,
            'salesStats.last7Days.unitsSold': item.quantity,
            'salesStats.last7Days.revenue': item.price * item.quantity,
            'salesStats.last7Days.orders': 1
          },
          $set: { 'salesStats.lastSoldAt': new Date() }
        };
        
        await Product.findOneAndUpdate(
          { shopifyId: item.productId.toString() },
          update
        );
      } catch (e) {
        console.warn(`Error recording sale for product ${item.productId}:`, e.message);
      }
    }
  }

  // ==================== DATOS PARA CLAUDE ====================

  async prepareProductDataForClaude() {
    try {
      const [
        topSelling,
        lowStock,
        outOfStock,
        giftSets,
        inventorySummary,
        frequentlyBought
      ] = await Promise.all([
        this.calculateTopSellingFromOrders(30),
        this.getLowStock(10),
        this.getOutOfStock(),
        this.getGiftSets(),
        this.getInventorySummary(),
        this.calculateFrequentlyBoughtTogether(90, 3)
      ]);
      
      return {
        topSellingProducts: topSelling.slice(0, 10).map(p => ({
          title: p.title,
          revenue: `$${p.totalRevenue}`,
          unitsSold: p.totalQuantity,
          orders: p.ordersCount,
          inventory: p.inventory,
          isLowStock: p.isLowStock,
          isOutOfStock: p.isOutOfStock
        })),
        
        lowStockAlert: lowStock.slice(0, 5).map(p => ({
          title: p.title,
          currentStock: p.totalInventory,
          recentSales: p.salesStats?.last30Days?.unitsSold || 0
        })),
        
        outOfStockProducts: outOfStock.slice(0, 5).map(p => ({
          title: p.title,
          previousRevenue: p.salesStats?.last30Days?.revenue || 0
        })),
        
        giftSetsAvailable: giftSets.slice(0, 5).map(p => ({
          title: p.title,
          inventory: p.totalInventory,
          price: p.priceRange?.min || 0
        })),
        
        inventorySummary: {
          totalProducts: inventorySummary.totalProducts,
          totalUnits: inventorySummary.totalInventory,
          estimatedValue: `$${(inventorySummary.totalValue || 0).toFixed(0)}`,
          lowStockCount: inventorySummary.lowStockCount,
          outOfStockCount: inventorySummary.outOfStockCount
        },
        
        frequentlyBoughtTogether: frequentlyBought.slice(0, 5).map(pair => ({
          products: pair.products.map(p => p.title),
          timesBoughtTogether: pair.coOccurrences
        }))
      };
    } catch (error) {
      console.error('Error preparing product data for Claude:', error);
      return {
        topSellingProducts: [],
        lowStockAlert: [],
        outOfStockProducts: [],
        giftSetsAvailable: [],
        inventorySummary: { totalProducts: 0, totalUnits: 0, estimatedValue: '$0', lowStockCount: 0, outOfStockCount: 0 },
        frequentlyBoughtTogether: []
      };
    }
  }
}

module.exports = new ProductService();