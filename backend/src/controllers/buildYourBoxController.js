// backend/src/controllers/buildYourBoxController.js
// Controller para Build Your Box Analytics (Demanda)

const buildYourBoxService = require('../services/buildYourBoxService');

const buildYourBoxController = {
  /**
   * GET /api/byb/overview
   * Dashboard completo de demanda
   */
  async getOverview(req, res) {
    try {
      const { days = 30 } = req.query;
      const overview = await buildYourBoxService.getOverview(parseInt(days));

      res.json({
        success: true,
        ...overview
      });
    } catch (error) {
      console.error('BYB Overview Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting Build Your Box overview'
      });
    }
  },

  /**
   * GET /api/byb/products
   * Top productos más pedidos
   */
  async getTopProducts(req, res) {
    try {
      const { days = 30, limit = 20 } = req.query;
      const products = await buildYourBoxService.getTopProducts(
        parseInt(days),
        parseInt(limit)
      );

      res.json({
        success: true,
        products,
        count: products.length,
        period: { days: parseInt(days) }
      });
    } catch (error) {
      console.error('BYB Top Products Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting top products'
      });
    }
  },

  /**
   * GET /api/byb/sizes
   * Distribución de tamaños de jar
   */
  async getSizeDistribution(req, res) {
    try {
      const { days = 30 } = req.query;
      const sizes = await buildYourBoxService.getSizeDistribution(parseInt(days));

      res.json({
        success: true,
        sizes,
        period: { days: parseInt(days) }
      });
    } catch (error) {
      console.error('BYB Size Distribution Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting size distribution'
      });
    }
  },

  /**
   * GET /api/byb/trends
   * Tendencias diarias
   */
  async getTrends(req, res) {
    try {
      const { days = 30 } = req.query;
      const trends = await buildYourBoxService.getDailyTrends(parseInt(days));

      res.json({
        success: true,
        trends,
        period: { days: parseInt(days) }
      });
    } catch (error) {
      console.error('BYB Trends Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting trends'
      });
    }
  },

  /**
   * GET /api/byb/combos
   * Combinaciones frecuentes de productos
   */
  async getFrequentCombos(req, res) {
    try {
      const { days = 30, minSupport = 3 } = req.query;
      const combos = await buildYourBoxService.getFrequentCombos(
        parseInt(days),
        parseInt(minSupport)
      );

      res.json({
        success: true,
        combos,
        count: combos.length,
        period: { days: parseInt(days) }
      });
    } catch (error) {
      console.error('BYB Combos Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting frequent combos'
      });
    }
  },

  /**
   * GET /api/byb/stats
   * Estadísticas resumidas
   */
  async getStats(req, res) {
    try {
      const { days = 30 } = req.query;
      const stats = await buildYourBoxService.getDemandStats(parseInt(days));

      res.json({
        success: true,
        summary: stats.summary,
        period: { days: parseInt(days) }
      });
    } catch (error) {
      console.error('BYB Stats Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting stats'
      });
    }
  },

  /**
   * GET /api/byb/insights
   * AI-powered insights para escalar Build Your Box
   */
  async getAiInsights(req, res) {
    try {
      const { days = 30 } = req.query;
      console.log(`🧠 Generating BYB AI insights for ${days} days...`);

      const insights = await buildYourBoxService.generateAiInsights(parseInt(days));

      res.json({
        success: true,
        ...insights
      });
    } catch (error) {
      console.error('BYB AI Insights Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error generating AI insights'
      });
    }
  }
};

module.exports = buildYourBoxController;
