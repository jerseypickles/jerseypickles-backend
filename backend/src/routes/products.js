// backend/src/routes/products.js
// 🛒 Product Routes - API para gestión de productos
// ⚠️ FIXED: No depende de métodos estáticos del modelo
const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const mongoose = require('mongoose');

// Import dinámico del modelo para evitar conflictos
const getProductModel = () => {
  try {
    return mongoose.model('Product');
  } catch (e) {
    // Si no existe, retornar null
    return null;
  }
};

// Lazy import del service
let _productService = null;
const getProductService = () => {
  if (!_productService) {
    try {
      _productService = require('../services/productService');
    } catch (e) {
      console.error('ProductService not available:', e.message);
    }
  }
  return _productService;
};

router.use(auth);

// ==================== SYNC ====================

router.post('/sync', authorize('admin'), async (req, res) => {
  try {
    console.log('🔄 Starting manual product sync...');
    
    const productService = getProductService();
    if (!productService) {
      return res.status(503).json({ error: 'Product service not available' });
    }
    
    const result = await productService.syncAllProducts();
    
    res.json({
      success: true,
      message: `Sync completado: ${result.synced} productos sincronizados`,
      ...result
    });
    
  } catch (error) {
    console.error('Error syncing products:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== LISTADO ====================

router.get('/', authorize('admin', 'manager'), async (req, res) => {
  try {
    const Product = getProductModel();
    if (!Product) {
      return res.json({ success: true, products: [], message: 'Product model not initialized' });
    }
    
    const { 
      status = 'active',
      limit = 50,
      page = 1,
      sort = '-salesStats.last30Days.revenue',
      search = ''
    } = req.query;
    
    const query = { status };
    
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { tags: { $regex: search, $options: 'i' } }
      ];
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [products, total] = await Promise.all([
      Product.find(query)
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .select('title handle productType priceRange totalInventory isLowStock isOutOfStock salesStats.last30Days categories featuredImage')
        .lean(),
      Product.countDocuments(query)
    ]);
    
    res.json({
      success: true,
      products,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
    
  } catch (error) {
    console.error('Error listing products:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ANÁLISIS ====================

router.get('/top-selling', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { days = 30, limit = 10 } = req.query;
    
    const productService = getProductService();
    if (productService) {
      try {
        const topProducts = await productService.calculateTopSellingFromOrders(parseInt(days));
        return res.json({
          success: true,
          period: `${days} días`,
          products: topProducts.slice(0, parseInt(limit))
        });
      } catch (e) {
        console.warn('calculateTopSellingFromOrders failed:', e.message);
      }
    }
    
    // Fallback: query directo al modelo
    const Product = getProductModel();
    if (!Product) {
      return res.json({ success: true, products: [], message: 'Product model not initialized' });
    }
    
    const periodField = parseInt(days) <= 7 ? 'salesStats.last7Days.revenue' : 'salesStats.last30Days.revenue';
    
    const products = await Product.find({ status: 'active' })
      .sort({ [periodField]: -1 })
      .limit(parseInt(limit))
      .select('title handle priceRange totalInventory salesStats categories featuredImage isLowStock isOutOfStock')
      .lean();
    
    const formatted = products.map(p => ({
      shopifyId: p.shopifyId,
      title: p.title,
      revenue: `$${(p.salesStats?.last30Days?.revenue || 0).toFixed(2)}`,
      unitsSold: p.salesStats?.last30Days?.unitsSold || 0,
      inventory: p.totalInventory || 0,
      isLowStock: p.isLowStock || false,
      isOutOfStock: p.isOutOfStock || false,
      featuredImage: p.featuredImage
    }));
    
    res.json({
      success: true,
      period: `${days} días`,
      products: formatted
    });
    
  } catch (error) {
    console.error('Error getting top selling:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/low-stock', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { threshold = 10 } = req.query;
    
    const Product = getProductModel();
    if (!Product) {
      return res.json({ success: true, products: [], count: 0, message: 'Product model not initialized' });
    }
    
    // Query directo en lugar de método estático
    const lowStock = await Product.find({
      status: 'active',
      totalInventory: { $gt: 0, $lte: parseInt(threshold) }
    })
    .sort({ totalInventory: 1 })
    .select('title handle totalInventory variants.sku salesStats.last30Days shopifyId')
    .lean();
    
    const formatted = lowStock.map(p => ({
      shopifyId: p.shopifyId,
      title: p.title,
      handle: p.handle,
      currentStock: p.totalInventory,
      recentSales: p.salesStats?.last30Days?.unitsSold || 0
    }));
    
    res.json({
      success: true,
      threshold: parseInt(threshold),
      count: lowStock.length,
      products: formatted
    });
    
  } catch (error) {
    console.error('Error getting low stock:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/out-of-stock', authorize('admin', 'manager'), async (req, res) => {
  try {
    const Product = getProductModel();
    if (!Product) {
      return res.json({ success: true, products: [], count: 0, message: 'Product model not initialized' });
    }
    
    const outOfStock = await Product.find({
      status: 'active',
      totalInventory: { $lte: 0 }
    })
    .select('title handle salesStats.last30Days shopifyId')
    .lean();
    
    res.json({
      success: true,
      count: outOfStock.length,
      products: outOfStock
    });
    
  } catch (error) {
    console.error('Error getting out of stock:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/gift-sets', authorize('admin', 'manager'), async (req, res) => {
  try {
    const Product = getProductModel();
    if (!Product) {
      return res.json({ success: true, products: [], count: 0, message: 'Product model not initialized' });
    }
    
    const giftSets = await Product.find({
      status: 'active',
      'categories.isGiftSet': true,
      totalInventory: { $gt: 0 }
    })
    .sort({ 'salesStats.last30Days.revenue': -1 })
    .lean();
    
    res.json({
      success: true,
      count: giftSets.length,
      products: giftSets
    });
    
  } catch (error) {
    console.error('Error getting gift sets:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/frequently-bought-together', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { days = 90, minOccurrences = 3 } = req.query;
    
    const productService = getProductService();
    if (!productService) {
      return res.json({ success: true, pairs: [], message: 'Product service not available' });
    }
    
    const pairs = await productService.calculateFrequentlyBoughtTogether(
      parseInt(days),
      parseInt(minOccurrences)
    );
    
    res.json({
      success: true,
      period: `${days} días`,
      minOccurrences: parseInt(minOccurrences),
      pairs
    });
    
  } catch (error) {
    console.error('Error getting frequently bought together:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/inventory-summary', authorize('admin', 'manager'), async (req, res) => {
  try {
    const Product = getProductModel();
    if (!Product) {
      return res.json({ 
        success: true, 
        summary: {
          totalProducts: 0,
          totalInventory: 0,
          totalValue: 0,
          lowStockCount: 0,
          outOfStockCount: 0,
          giftSetsCount: 0,
          estimatedValue: '$0'
        },
        message: 'Product model not initialized' 
      });
    }
    
    // Query de agregación directo
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
    
    const result = summary || {
      totalProducts: 0,
      totalInventory: 0,
      totalValue: 0,
      lowStockCount: 0,
      outOfStockCount: 0,
      giftSetsCount: 0
    };
    
    result.estimatedValue = `$${(result.totalValue || 0).toLocaleString()}`;
    
    res.json({
      success: true,
      summary: result
    });
    
  } catch (error) {
    console.error('Error getting inventory summary:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/critical-inventory', authorize('admin', 'manager'), async (req, res) => {
  try {
    const productService = getProductService();
    if (!productService) {
      return res.json({ success: true, products: [], count: 0, message: 'Product service not available' });
    }
    
    const critical = await productService.getCriticalInventory();
    
    res.json({
      success: true,
      count: critical.length,
      products: critical
    });
    
  } catch (error) {
    console.error('Error getting critical inventory:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== DETALLE ====================

router.get('/:id', authorize('admin', 'manager'), async (req, res) => {
  try {
    const Product = getProductModel();
    if (!Product) {
      return res.status(404).json({ error: 'Product model not initialized' });
    }
    
    const product = await Product.findById(req.params.id).lean();
    
    if (!product) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    
    res.json({
      success: true,
      product
    });
    
  } catch (error) {
    console.error('Error getting product:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;