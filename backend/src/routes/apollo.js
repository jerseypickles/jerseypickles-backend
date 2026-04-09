// backend/src/routes/apollo.js
// 🏛️ APOLLO - Creative Agent API Routes

const express = require('express');
const router = express.Router();
const { auth, authorize } = require('../middleware/auth');
const ApolloConfig = require('../models/ApolloConfig');
const apolloService = require('../services/apolloService');

router.use(auth);

// ==================== STATUS ====================

/**
 * GET /api/apollo/status
 */
router.get('/status', authorize('admin'), async (req, res) => {
  try {
    apolloService.init();
    const status = await apolloService.getStatus();
    res.json({ success: true, ...status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== PRODUCT BANK ====================

/**
 * GET /api/apollo/products
 * List all products in the bank
 */
router.get('/products', authorize('admin'), async (req, res) => {
  try {
    const config = await ApolloConfig.getConfig();
    res.json({ success: true, products: config.products });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/apollo/products
 * Add a product to the bank
 */
router.post('/products', authorize('admin'), async (req, res) => {
  try {
    const { slug, name, category, bankImageUrl, bankImageCloudinaryId, promptHints } = req.body;

    if (!slug || !name || !bankImageUrl) {
      return res.status(400).json({ error: 'slug, name, and bankImageUrl are required' });
    }

    const config = await ApolloConfig.getConfig();

    // Check if slug already exists
    const existing = config.products.find(p => p.slug === slug);
    if (existing) {
      return res.status(400).json({ error: `Product with slug "${slug}" already exists` });
    }

    config.products.push({
      slug,
      name,
      category: category || 'pickles',
      bankImageUrl,
      bankImageCloudinaryId,
      promptHints: promptHints || '',
      active: true
    });

    await config.save();

    console.log(`🏛️ Apollo: Product added - ${name} (${slug})`);
    res.json({ success: true, product: config.products[config.products.length - 1] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/apollo/products/:slug
 * Remove a product from the bank
 */
router.delete('/products/:slug', authorize('admin'), async (req, res) => {
  try {
    const config = await ApolloConfig.getConfig();
    const index = config.products.findIndex(p => p.slug === req.params.slug);

    if (index === -1) {
      return res.status(404).json({ error: 'Product not found' });
    }

    config.products.splice(index, 1);
    await config.save();

    res.json({ success: true, message: `Product "${req.params.slug}" removed` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== CONFIGURATION ====================

/**
 * PUT /api/apollo/config
 */
router.put('/config', authorize('admin'), async (req, res) => {
  try {
    const config = await ApolloConfig.getConfig();
    const { active, geminiModel, aspectRatio, cloudinaryFolder } = req.body;

    if (typeof active === 'boolean') config.active = active;
    if (geminiModel) config.geminiModel = geminiModel;
    if (aspectRatio) config.aspectRatio = aspectRatio;
    if (cloudinaryFolder) config.cloudinaryFolder = cloudinaryFolder;

    await config.save();
    res.json({ success: true, config });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== MANUAL GENERATION ====================

/**
 * POST /api/apollo/generate
 * Manually generate a creative (for testing)
 */
router.post('/generate', authorize('admin'), async (req, res) => {
  try {
    const { product, discount, code, headline, productName } = req.body;

    if (!product || !discount || !code || !headline) {
      return res.status(400).json({ error: 'product, discount, code, and headline are required' });
    }

    apolloService.init();

    const result = await apolloService.generateCreative({
      product,
      discount,
      code,
      headline,
      productName: productName || product
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
