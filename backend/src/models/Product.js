// backend/src/models/Product.js
// 🛒 Product Model - Productos sincronizados desde Shopify
// ⚠️ FIXED: Manejo defensivo de registro de modelo
const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  // ==================== IDENTIFICACIÓN ====================
  shopifyId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  title: {
    type: String,
    required: true,
    index: true
  },
  
  handle: {
    type: String,
    index: true
  },
  
  // ==================== CATEGORIZACIÓN ====================
  productType: {
    type: String,
    index: true
  },
  
  vendor: String,
  
  tags: [{
    type: String,
    index: true
  }],
  
  // ==================== VARIANTES ====================
  variants: [{
    shopifyVariantId: String,
    title: String,
    sku: String,
    price: Number,
    compareAtPrice: Number,
    inventoryQuantity: {
      type: Number,
      default: 0
    },
    inventoryPolicy: String,
    weight: Number,
    weightUnit: String
  }],
  
  // ==================== IMÁGENES ====================
  images: [{
    shopifyImageId: String,
    src: String,
    alt: String,
    position: Number
  }],
  
  featuredImage: String,
  
  // ==================== ESTADO ====================
  status: {
    type: String,
    enum: ['active', 'draft', 'archived'],
    default: 'active',
    index: true
  },
  
  // ==================== PRECIOS AGREGADOS ====================
  priceRange: {
    min: Number,
    max: Number
  },
  
  // ==================== INVENTARIO AGREGADO ====================
  totalInventory: {
    type: Number,
    default: 0,
    index: true
  },
  
  isLowStock: {
    type: Boolean,
    default: false,
    index: true
  },
  
  lowStockThreshold: {
    type: Number,
    default: 10
  },
  
  isOutOfStock: {
    type: Boolean,
    default: false,
    index: true
  },
  
  // ==================== ESTADÍSTICAS DE VENTAS ====================
  salesStats: {
    totalUnitsSold: { type: Number, default: 0 },
    totalRevenue: { type: Number, default: 0 },
    totalOrders: { type: Number, default: 0 },
    avgOrderQuantity: { type: Number, default: 0 },
    lastSoldAt: Date,
    
    last30Days: {
      unitsSold: { type: Number, default: 0 },
      revenue: { type: Number, default: 0 },
      orders: { type: Number, default: 0 }
    },
    
    last7Days: {
      unitsSold: { type: Number, default: 0 },
      revenue: { type: Number, default: 0 },
      orders: { type: Number, default: 0 }
    }
  },
  
  // ==================== PRODUCTOS RELACIONADOS ====================
  frequentlyBoughtWith: [{
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    shopifyId: String,
    title: String,
    coOccurrences: Number,
    lastUpdated: Date
  }],
  
  // ==================== PERFORMANCE POR LISTA ====================
  listPerformance: [{
    listId: { type: mongoose.Schema.Types.ObjectId, ref: 'List' },
    listName: String,
    unitsSold: Number,
    revenue: Number,
    lastPurchase: Date
  }],
  
  // ==================== CATEGORÍAS ESPECIALES ====================
  categories: {
    isGiftSet: { type: Boolean, default: false },
    isSeasonal: { type: Boolean, default: false },
    seasonalEvent: String,
    isNewArrival: { type: Boolean, default: false },
    isBestSeller: { type: Boolean, default: false },
    isOnSale: { type: Boolean, default: false }
  },
  
  // ==================== SHOPIFY RAW DATA ====================
  shopifyData: mongoose.Schema.Types.Mixed,
  
  // ==================== SYNC STATUS ====================
  lastSyncedAt: {
    type: Date,
    default: Date.now
  }
  
}, {
  timestamps: true,
  collection: 'products'
});

// ==================== ÍNDICES ====================
productSchema.index({ 'salesStats.totalRevenue': -1 });
productSchema.index({ 'salesStats.last30Days.revenue': -1 });
productSchema.index({ 'salesStats.last7Days.revenue': -1 });
productSchema.index({ totalInventory: 1 });
productSchema.index({ 'categories.isGiftSet': 1 });
productSchema.index({ 'categories.isSeasonal': 1 });
productSchema.index({ tags: 1 });

// ==================== PRE-SAVE ====================
productSchema.pre('save', function(next) {
  if (this.variants && this.variants.length > 0) {
    this.totalInventory = this.variants.reduce((sum, v) => sum + (v.inventoryQuantity || 0), 0);
    
    const prices = this.variants.map(v => v.price).filter(p => p > 0);
    if (prices.length > 0) {
      this.priceRange = { min: Math.min(...prices), max: Math.max(...prices) };
    }
  }
  
  this.isOutOfStock = this.totalInventory <= 0;
  this.isLowStock = this.totalInventory > 0 && this.totalInventory <= this.lowStockThreshold;
  
  const titleLower = (this.title || '').toLowerCase();
  const tagsLower = (this.tags || []).map(t => t.toLowerCase());
  
  this.categories.isGiftSet = titleLower.includes('gift') || titleLower.includes('set') || 
                               tagsLower.includes('gift') || tagsLower.includes('gift set');
  
  this.categories.isSeasonal = tagsLower.includes('seasonal') || tagsLower.includes('holiday') || 
                                tagsLower.includes('christmas') || tagsLower.includes('bbq') ||
                                tagsLower.includes('summer');
  
  next();
});

// ==================== MÉTODOS DE INSTANCIA ====================

productSchema.methods.getMainPrice = function() {
  if (this.variants && this.variants.length > 0) {
    return this.variants[0].price;
  }
  return this.priceRange?.min || 0;
};

productSchema.methods.hasDiscount = function() {
  return this.variants.some(v => v.compareAtPrice && v.compareAtPrice > v.price);
};

productSchema.methods.getDiscountPercentage = function() {
  const variant = this.variants.find(v => v.compareAtPrice && v.compareAtPrice > v.price);
  if (variant) {
    return Math.round((1 - variant.price / variant.compareAtPrice) * 100);
  }
  return 0;
};

// ==================== MÉTODOS ESTÁTICOS ====================

productSchema.statics.upsertFromShopify = async function(shopifyProduct) {
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
  
  const product = await this.findOneAndUpdate(
    { shopifyId: productData.shopifyId },
    productData,
    { upsert: true, new: true, runValidators: true }
  );
  
  console.log(`✅ Product synced: ${product.title}`);
  return product;
};

productSchema.statics.getTopSelling = async function(options = {}) {
  const { limit = 10, days = 30 } = options;
  const periodField = days <= 7 ? 'salesStats.last7Days.revenue' : 'salesStats.last30Days.revenue';
  
  return this.find({ status: 'active' })
    .sort({ [periodField]: -1 })
    .limit(limit)
    .select('title handle priceRange totalInventory salesStats categories featuredImage')
    .lean();
};

productSchema.statics.getLowStock = async function(threshold = 10) {
  return this.find({
    status: 'active',
    totalInventory: { $gt: 0, $lte: threshold }
  })
  .sort({ totalInventory: 1 })
  .select('title handle totalInventory variants.sku salesStats.last30Days')
  .lean();
};

productSchema.statics.getOutOfStock = async function() {
  return this.find({
    status: 'active',
    totalInventory: { $lte: 0 }
  })
  .select('title handle salesStats.last30Days')
  .lean();
};

productSchema.statics.getGiftSets = async function() {
  return this.find({
    status: 'active',
    'categories.isGiftSet': true,
    totalInventory: { $gt: 0 }
  })
  .sort({ 'salesStats.last30Days.revenue': -1 })
  .lean();
};

productSchema.statics.recordSale = async function(shopifyProductId, quantity, revenue, listId = null, listName = null) {
  const update = {
    $inc: {
      'salesStats.totalUnitsSold': quantity,
      'salesStats.totalRevenue': revenue,
      'salesStats.totalOrders': 1,
      'salesStats.last30Days.unitsSold': quantity,
      'salesStats.last30Days.revenue': revenue,
      'salesStats.last30Days.orders': 1,
      'salesStats.last7Days.unitsSold': quantity,
      'salesStats.last7Days.revenue': revenue,
      'salesStats.last7Days.orders': 1
    },
    $set: { 'salesStats.lastSoldAt': new Date() }
  };
  
  const product = await this.findOneAndUpdate(
    { shopifyId: shopifyProductId.toString() },
    update,
    { new: true }
  );
  
  if (product && listId) {
    const existingList = product.listPerformance.find(
      lp => lp.listId?.toString() === listId.toString()
    );
    
    if (existingList) {
      existingList.unitsSold += quantity;
      existingList.revenue += revenue;
      existingList.lastPurchase = new Date();
    } else {
      product.listPerformance.push({
        listId, listName: listName || 'Unknown',
        unitsSold: quantity, revenue, lastPurchase: new Date()
      });
    }
    await product.save();
  }
  
  return product;
};

productSchema.statics.resetPeriodStats = async function(period = '7days') {
  const field = period === '7days' ? 'salesStats.last7Days' : 'salesStats.last30Days';
  
  const result = await this.updateMany({}, {
    $set: {
      [`${field}.unitsSold`]: 0,
      [`${field}.revenue`]: 0,
      [`${field}.orders`]: 0
    }
  });
  
  console.log(`🔄 Reset ${period} stats for ${result.modifiedCount} products`);
  return result.modifiedCount;
};

productSchema.statics.getInventorySummary = async function() {
  const [summary] = await this.aggregate([
    { $match: { status: 'active' } },
    {
      $group: {
        _id: null,
        totalProducts: { $sum: 1 },
        totalInventory: { $sum: '$totalInventory' },
        totalValue: { $sum: { $multiply: ['$totalInventory', { $ifNull: ['$priceRange.min', 0] }] } },
        lowStockCount: { $sum: { $cond: ['$isLowStock', 1, 0] } },
        outOfStockCount: { $sum: { $cond: ['$isOutOfStock', 1, 0] } },
        giftSetsCount: { $sum: { $cond: ['$categories.isGiftSet', 1, 0] } }
      }
    }
  ]);
  
  return summary || {
    totalProducts: 0, totalInventory: 0, totalValue: 0,
    lowStockCount: 0, outOfStockCount: 0, giftSetsCount: 0
  };
};

// ==================== EXPORTAR MODELO ====================
// ⚠️ IMPORTANTE: Eliminar modelo existente si hay conflicto
let Product;
try {
  // Intentar obtener modelo existente
  Product = mongoose.model('Product');
  console.log('⚠️ Product model already exists, reusing...');
} catch (e) {
  // No existe, crear nuevo
  Product = mongoose.model('Product', productSchema);
  console.log('✅ Product model created');
}

module.exports = Product;