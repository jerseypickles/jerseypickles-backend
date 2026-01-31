// backend/src/controllers/smsAnalyticsController.js
// 📊 SMS Analytics Controller - API endpoints para dashboard de analytics

const smsAnalyticsService = require('../services/smsAnalyticsService');

// Cargar claudeService de forma segura
let claudeService = null;
try {
  claudeService = require('../services/claudeService');
  claudeService.init();
  console.log('📊 SMS Analytics Controller: Claude service loaded');
} catch (e) {
  console.log('⚠️  SMS Analytics Controller: Claude service not available');
}

const smsAnalyticsController = {
  /**
   * GET /api/sms/analytics/map
   * Obtiene datos de suscriptores por estado para el mapa USA
   */
  async getMapData(req, res) {
    try {
      const { days = 30 } = req.query;
      const stateData = await smsAnalyticsService.getSubscribersByState(parseInt(days));

      res.json({
        success: true,
        data: stateData,
        totalStates: stateData.length,
        totalSubscribers: stateData.reduce((sum, s) => sum + s.subscribers, 0),
        totalRevenue: stateData.reduce((sum, s) => sum + s.revenue, 0),
        period: { days: parseInt(days) }
      });
    } catch (error) {
      console.error('❌ Map Data Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting map data'
      });
    }
  },

  /**
   * GET /api/sms/analytics/activity
   * Feed de actividad en tiempo real
   */
  async getRecentActivity(req, res) {
    try {
      const { limit = 20, since } = req.query;
      const activity = await smsAnalyticsService.getRecentActivity(
        parseInt(limit),
        since || null
      );

      res.json({
        success: true,
        activity,
        count: activity.length,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ Activity Feed Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting activity feed'
      });
    }
  },

  /**
   * GET /api/sms/analytics/metrics
   * Métricas de resumen para dashboard
   */
  async getDashboardMetrics(req, res) {
    try {
      const { days = 30 } = req.query;
      const metrics = await smsAnalyticsService.getDashboardMetrics(parseInt(days));

      res.json({
        success: true,
        ...metrics
      });
    } catch (error) {
      console.error('❌ Dashboard Metrics Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting dashboard metrics'
      });
    }
  },

  /**
   * GET /api/sms/analytics/trends
   * Tendencias diarias para gráficos
   */
  async getDailyTrends(req, res) {
    try {
      const { days = 30 } = req.query;
      const trends = await smsAnalyticsService.getDailyTrends(parseInt(days));

      res.json({
        success: true,
        trends,
        period: { days: parseInt(days) }
      });
    } catch (error) {
      console.error('❌ Trends Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting trends data'
      });
    }
  },

  /**
   * GET /api/sms/analytics/top-states
   * Top estados por métrica
   */
  async getTopStates(req, res) {
    try {
      const { metric = 'subscribers', limit = 10 } = req.query;
      const topStates = await smsAnalyticsService.getTopStates(metric, parseInt(limit));

      res.json({
        success: true,
        metric,
        states: topStates
      });
    } catch (error) {
      console.error('❌ Top States Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting top states'
      });
    }
  },

  /**
   * GET /api/sms/analytics/state/:code
   * Detalles de un estado específico
   */
  async getStateDetails(req, res) {
    try {
      const { code } = req.params;
      const details = await smsAnalyticsService.getStateDetails(code);

      if (!details) {
        return res.status(404).json({
          success: false,
          error: 'State not found or no data available'
        });
      }

      res.json({
        success: true,
        ...details
      });
    } catch (error) {
      console.error('❌ State Details Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting state details'
      });
    }
  },

  /**
   * GET /api/sms/analytics/insights
   * Obtener insights de IA (guardados o generar nuevos)
   */
  async getAiInsights(req, res) {
    try {
      const { forceRefresh = false } = req.query;

      // Obtener últimos insights guardados
      const cached = smsAnalyticsService.getLastAiInsights();

      // Si hay insights válidos y no se pide refresh, devolverlos
      if (cached.insights && !cached.isStale && forceRefresh !== 'true') {
        return res.json({
          success: true,
          insights: cached.insights,
          generatedAt: cached.generatedAt,
          fromCache: true
        });
      }

      // Generar nuevos insights
      if (!claudeService || !claudeService.isAvailable()) {
        return res.json({
          success: true,
          insights: cached.insights || null,
          generatedAt: cached.generatedAt,
          message: 'Claude AI not available. Showing cached insights if available.',
          aiAvailable: false
        });
      }

      // Preparar datos y generar insights
      const data = await smsAnalyticsService.prepareAiInsightsData();
      const insights = await claudeService.generateSmsInsights(data);

      // Guardar para cache
      if (insights.success) {
        smsAnalyticsService.saveAiInsights(insights);
      }

      res.json({
        success: true,
        insights,
        generatedAt: new Date().toISOString(),
        fromCache: false
      });

    } catch (error) {
      console.error('❌ AI Insights Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error generating AI insights'
      });
    }
  },

  /**
   * POST /api/sms/analytics/insights/generate
   * Forzar generación de nuevos insights
   */
  async generateInsights(req, res) {
    try {
      if (!claudeService || !claudeService.isAvailable()) {
        return res.status(503).json({
          success: false,
          error: 'Claude AI service not available'
        });
      }

      console.log('🧠 Generating new SMS AI insights...');

      const data = await smsAnalyticsService.prepareAiInsightsData();
      const insights = await claudeService.generateSmsInsights(data);

      if (insights.success) {
        smsAnalyticsService.saveAiInsights(insights);
        console.log('✅ SMS AI insights generated and cached');
      }

      res.json({
        success: true,
        insights,
        generatedAt: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ Generate Insights Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error generating insights'
      });
    }
  },

  /**
   * GET /api/sms/analytics/overview
   * Resumen completo para dashboard (combina múltiples endpoints)
   */
  async getOverview(req, res) {
    try {
      const { days = 30 } = req.query;

      const [metrics, stateData, trends, activity] = await Promise.all([
        smsAnalyticsService.getDashboardMetrics(parseInt(days)),
        smsAnalyticsService.getSubscribersByState(parseInt(days)),
        smsAnalyticsService.getDailyTrends(14), // Últimos 14 días para gráfico
        smsAnalyticsService.getRecentActivity(10)
      ]);

      // Top 5 estados
      const topStates = stateData
        .sort((a, b) => b.subscribers - a.subscribers)
        .slice(0, 5);

      // Insights cacheados
      const cachedInsights = smsAnalyticsService.getLastAiInsights();

      res.json({
        success: true,
        metrics,
        map: {
          states: stateData,
          topStates,
          totalStates: stateData.length
        },
        trends,
        activity,
        insights: {
          data: cachedInsights.insights,
          generatedAt: cachedInsights.generatedAt,
          isStale: cachedInsights.isStale
        },
        period: { days: parseInt(days) },
        generatedAt: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ Overview Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting analytics overview'
      });
    }
  }
};

module.exports = smsAnalyticsController;
