// backend/src/routes/products.js
// 🛒 Product Routes - API para gestión de productos
const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const Product = require('../models/Product');
const productService = require('../services/productService');

router.use(auth);

// ==================== SYNC ====================

/**
 * POST /api/products/sync
 * Sincronizar todos los productos desde Shopify
 */
router.post('/sync', authorize('admin'), async (req, res) => {
  try {
    console.log('🔄 Starting manual product sync...');
    
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

/**
 * GET /api/products
 * Listar todos los productos
 */
router.get('/', authorize('admin', 'manager'), async (req, res) => {
  try {
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

/**
 * GET /api/products/top-selling
 * Obtener productos más vendidos
 */
router.get('/top-selling', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { days = 30, limit = 10 } = req.query;
    
    const topProducts = await productService.calculateTopSellingFromOrders(
      parseInt(days)
    );
    
    res.json({
      success: true,
      period: `${days} días`,
      products: topProducts.slice(0, parseInt(limit))
    });
    
  } catch (error) {
    console.error('Error getting top selling:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/products/low-stock
 * Obtener productos con bajo stock
 */
router.get('/low-stock', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { threshold = 10 } = req.query;
    
    const lowStock = await Product.getLowStock(parseInt(threshold));
    
    res.json({
      success: true,
      threshold: parseInt(threshold),
      count: lowStock.length,
      products: lowStock
    });
    
  } catch (error) {
    console.error('Error getting low stock:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/products/out-of-stock
 * Obtener productos agotados
 */
router.get('/out-of-stock', authorize('admin', 'manager'), async (req, res) => {
  try {
    const outOfStock = await Product.getOutOfStock();
    
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

/**
 * GET /api/products/gift-sets
 * Obtener gift sets disponibles
 */
router.get('/gift-sets', authorize('admin', 'manager'), async (req, res) => {
  try {
    const giftSets = await Product.getGiftSets();
    
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

/**
 * GET /api/products/frequently-bought-together
 * Obtener productos comprados juntos frecuentemente
 */
router.get('/frequently-bought-together', authorize('admin', 'manager'), async (req, res) => {
  try {
    const { days = 90, minOccurrences = 3 } = req.query;
    
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

/**
 * GET /api/products/inventory-summary
 * Obtener resumen de inventario
 */
router.get('/inventory-summary', authorize('admin', 'manager'), async (req, res) => {
  try {
    const summary = await Product.getInventorySummary();
    
    res.json({
      success: true,
      summary
    });
    
  } catch (error) {
    console.error('Error getting inventory summary:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/products/critical-inventory
 * Obtener productos críticos (bajo stock + vendiéndose)
 */
router.get('/critical-inventory', authorize('admin', 'manager'), async (req, res) => {
  try {
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

/**
 * GET /api/products/:id
 * Obtener detalle de un producto
 */
router.get('/:id', authorize('admin', 'manager'), async (req, res) => {
  try {
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