// backend/src/controllers/buildYourBoxController.js
// Controller para Build Your Box Analytics (Demanda)
// Enhanced with Opportunity Dashboard endpoints

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
   * GET /api/byb/opportunity-dashboard
   * Comprehensive Opportunity Dashboard with all metrics
   */
  async getOpportunityDashboard(req, res) {
    try {
      const { days = 30 } = req.query;
      console.log(`📊 API: Getting BYB Opportunity Dashboard for ${days} days`);

      const dashboard = await buildYourBoxService.getOpportunityDashboard(parseInt(days));

      res.json({
        success: true,
        ...dashboard
      });
    } catch (error) {
      console.error('BYB Opportunity Dashboard Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting opportunity dashboard'
      });
    }
  },

  /**
   * GET /api/byb/trending
   * Trending products with week-over-week comparison
   */
  async getTrendingProducts(req, res) {
    try {
      const { days = 14 } = req.query;
      const trending = await buildYourBoxService.getTrendingProducts(parseInt(days));

      res.json({
        success: true,
        ...trending
      });
    } catch (error) {
      console.error('BYB Trending Products Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting trending products'
      });
    }
  },

  /**
   * GET /api/byb/ticket-analysis
   * Ticket analysis by box configuration
   */
  async getTicketAnalysis(req, res) {
    try {
      const { days = 30 } = req.query;
      const analysis = await buildYourBoxService.getTicketAnalysis(parseInt(days));

      res.json({
        success: true,
        ...analysis
      });
    } catch (error) {
      console.error('BYB Ticket Analysis Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting ticket analysis'
      });
    }
  },

  /**
   * GET /api/byb/week-over-week
   * Week-over-week comparison
   */
  async getWeekOverWeek(req, res) {
    try {
      const comparison = await buildYourBoxService.getWeekOverWeek();

      res.json({
        success: true,
        ...comparison
      });
    } catch (error) {
      console.error('BYB Week Over Week Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting week over week comparison'
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
