// backend/src/controllers/smsAnalyticsController.js
// 📊 SMS Analytics Controller - API endpoints para dashboard de analytics

const smsAnalyticsService = require('../services/smsAnalyticsService');
const SmsSubscriber = require('../models/SmsSubscriber');
const AIInsight = require('../models/AIInsight');

// Cargar claudeService de forma segura
let claudeService = null;
try {
  claudeService = require('../services/claudeService');
  claudeService.init();
  console.log('📊 SMS Analytics Controller: Claude service loaded');
} catch (e) {
  console.log('⚠️  SMS Analytics Controller: Claude service not available');
}

// Cargar geoLocationService
let geoLocationService = null;
try {
  geoLocationService = require('../services/geoLocationService');
  console.log('📊 SMS Analytics Controller: GeoLocation service loaded');
} catch (e) {
  console.log('⚠️  SMS Analytics Controller: GeoLocation service not available');
}

const smsAnalyticsController = {
  /**
   * POST /api/sms/analytics/migrate-locations
   * Migrar ubicaciones de suscriptores existentes sin datos de geolocalización
   */
  async migrateLocations(req, res) {
    try {
      if (!geoLocationService) {
        return res.status(503).json({
          success: false,
          error: 'GeoLocation service not available'
        });
      }

      // IPs de Cloudflare que no son útiles para geolocalizar
      // Estos rangos son de Cloudflare proxy, no de usuarios reales
      const cloudflareRanges = [
        '172.68.', '172.69.', '172.70.', '172.71.',
        '104.22.', '104.23.', '104.24.', '104.25.',
        '162.159.', '108.162.', '141.101.', '173.245.',
        '188.114.', '190.93.', '197.234.', '198.41.'
      ];

      const isCloudflareIP = (ip) => {
        if (!ip) return true;
        return cloudflareRanges.some(range => ip.startsWith(range));
      };

      // Buscar suscriptores que necesitan geolocalización
      // Excluir IPs de Cloudflare ya que no son útiles
      const subscribersWithoutLocation = await SmsSubscriber.find({
        ipAddress: { $exists: true, $ne: null, $ne: '' },
        'location.source': { $ne: 'ip-api' }
      }).limit(40); // Reducido a 40 para respetar rate limit (45/min)

      if (subscribersWithoutLocation.length === 0) {
        return res.json({
          success: true,
          message: 'No subscribers need location migration',
          processed: 0,
          remaining: 0
        });
      }

      console.log(`📍 Migrating locations for ${subscribersWithoutLocation.length} subscribers...`);

      let processed = 0;
      let failed = 0;
      let skippedCloudflare = 0;
      const results = [];

      for (const subscriber of subscribersWithoutLocation) {
        try {
          // Verificar si es IP de Cloudflare (no útil)
          if (isCloudflareIP(subscriber.ipAddress)) {
            // Marcar como procesado con ubicación "unknown"
            subscriber.location = {
              country: 'United States',
              countryCode: 'US',
              region: null,
              regionName: null,
              city: null,
              source: 'cloudflare-ip', // Marcar como IP de Cloudflare
              resolvedAt: new Date()
            };
            await subscriber.save();
            skippedCloudflare++;
            continue;
          }

          // Rate limiting - esperar 1.5 segundos entre requests (45/min = 1 cada 1.33s)
          if (processed > 0) {
            await new Promise(resolve => setTimeout(resolve, 1500));
          }

          const locationData = await geoLocationService.getLocationByIp(subscriber.ipAddress);

          if (locationData && locationData.region) {
            subscriber.location = locationData;
            await subscriber.save();
            processed++;
            results.push({
              phone: subscriber.phone.slice(-4),
              ip: subscriber.ipAddress,
              state: locationData.regionName,
              success: true
            });
          } else {
            // Marcar como procesado pero sin ubicación
            subscriber.location = {
              ...locationData,
              source: 'ip-api-failed'
            };
            await subscriber.save();
            failed++;
            results.push({
              phone: subscriber.phone.slice(-4),
              ip: subscriber.ipAddress,
              error: 'Could not resolve location',
              success: false
            });
          }
        } catch (err) {
          // Si es error 429, detenemos y devolvemos lo que tenemos
          if (err.message && err.message.includes('429')) {
            console.log('⚠️ Rate limit hit, stopping batch early');
            break;
          }
          failed++;
          results.push({
            phone: subscriber.phone.slice(-4),
            ip: subscriber.ipAddress,
            error: err.message,
            success: false
          });
        }
      }

      if (skippedCloudflare > 0) {
        console.log(`⚠️ Skipped ${skippedCloudflare} Cloudflare IPs (not useful for geolocation)`);
      }

      // Contar cuántos quedan por migrar (excluyendo ya procesados)
      const remaining = await SmsSubscriber.countDocuments({
        ipAddress: { $exists: true, $ne: null, $ne: '' },
        'location.source': { $nin: ['ip-api', 'cloudflare-ip', 'ip-api-failed'] }
      });

      console.log(`✅ Migration batch complete: ${processed} success, ${failed} failed, ${skippedCloudflare} cloudflare, ${remaining} remaining`);

      res.json({
        success: true,
        message: `Processed ${processed} subscribers`,
        processed,
        failed,
        skippedCloudflare,
        remaining,
        results: results.slice(0, 20) // Solo mostrar primeros 20 resultados
      });

    } catch (error) {
      console.error('❌ Migration Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error migrating subscriber locations'
      });
    }
  },

  /**
   * GET /api/sms/analytics/migration-status
   * Estado de la migración de ubicaciones
   */
  async getMigrationStatus(req, res) {
    try {
      const [withLocation, cloudflareIps, pendingMigration, total] = await Promise.all([
        // Suscriptores con ubicación resuelta exitosamente
        SmsSubscriber.countDocuments({
          'location.source': 'ip-api'
        }),
        // Suscriptores con IPs de Cloudflare (no útiles)
        SmsSubscriber.countDocuments({
          'location.source': 'cloudflare-ip'
        }),
        // Suscriptores pendientes de migrar
        SmsSubscriber.countDocuments({
          ipAddress: { $exists: true, $ne: null, $ne: '' },
          'location.source': { $nin: ['ip-api', 'cloudflare-ip', 'ip-api-failed'] }
        }),
        SmsSubscriber.countDocuments({})
      ]);

      res.json({
        success: true,
        total,
        withLocation,
        cloudflareIps,
        withoutLocation: pendingMigration,
        percentage: total > 0 ? Math.round((withLocation / total) * 100) : 0,
        note: cloudflareIps > 0 ? `${cloudflareIps} subscribers have Cloudflare proxy IPs (cannot geolocate)` : null
      });

    } catch (error) {
      console.error('❌ Migration Status Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting migration status'
      });
    }
  },
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

      // 1. Intentar cache en memoria (más rápido)
      const cached = smsAnalyticsService.getLastAiInsights();

      if (cached.insights && !cached.isStale && forceRefresh !== 'true') {
        return res.json({
          success: true,
          insights: cached.insights,
          generatedAt: cached.generatedAt,
          fromCache: true,
          source: 'memory'
        });
      }

      // 2. Si no hay cache en memoria, leer de MongoDB (generado por aiAnalyticsJob)
      if (forceRefresh !== 'true') {
        const dbInsight = await AIInsight.getLatest('sms_ai_insights', 30);
        if (dbInsight?.data) {
          // Rehidratar cache en memoria para próximas peticiones
          smsAnalyticsService.saveAiInsights(dbInsight.data);
          return res.json({
            success: true,
            insights: dbInsight.data,
            generatedAt: dbInsight.createdAt,
            fromCache: true,
            source: 'database'
          });
        }
      }

      // 3. Generar con fallback (sin Claude) bajo demanda
      const data = await smsAnalyticsService.prepareAiInsightsData();
      const insights = claudeService.getSmsFallbackInsights(data);

      smsAnalyticsService.saveAiInsights(insights);
      await AIInsight.saveAnalysis('sms_ai_insights', 30, insights, {
        recalculateHours: 24
      });

      res.json({
        success: true,
        insights,
        generatedAt: new Date().toISOString(),
        fromCache: false,
        source: 'fallback_analysis'
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
      console.log('📊 Generating new SMS insights with fallback...');

      const data = await smsAnalyticsService.prepareAiInsightsData();
      const insights = claudeService.getSmsFallbackInsights(data);

      smsAnalyticsService.saveAiInsights(insights);
      console.log('✅ SMS insights generated and cached');

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
   * GET /api/sms/analytics/unsubscribes
   * Analytics completo de bajas y churn
   */
  async getUnsubscribeAnalytics(req, res) {
    try {
      const { days = 30 } = req.query;
      const analytics = await SmsSubscriber.getUnsubscribeAnalytics(parseInt(days));

      // Enrich byCampaign with campaign names
      if (analytics.byCampaign && analytics.byCampaign.length > 0) {
        try {
          const SmsCampaign = require('../models/SmsCampaign');
          const campaignIds = analytics.byCampaign.map(c => c._id);
          const campaigns = await SmsCampaign.find({ _id: { $in: campaignIds } })
            .select('name stats.delivered stats.sent')
            .lean();

          const campaignMap = {};
          campaigns.forEach(c => { campaignMap[c._id.toString()] = c; });

          analytics.byCampaign = analytics.byCampaign.map(c => {
            const campaign = campaignMap[c._id?.toString()];
            const delivered = campaign?.stats?.delivered || 0;
            return {
              campaignId: c._id,
              name: campaign?.name || 'Campaña eliminada',
              count: c.count,
              unsubscribeRate: delivered > 0
                ? ((c.count / delivered) * 100).toFixed(2) + '%'
                : 'N/A'
            };
          });
        } catch (e) {
          // SmsCampaign model might not be available
        }
      }

      res.json({
        success: true,
        ...analytics,
        generatedAt: new Date().toISOString()
      });

    } catch (error) {
      console.error('❌ Unsubscribe Analytics Error:', error);
      res.status(500).json({
        success: false,
        error: 'Error getting unsubscribe analytics'
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

      // Insights: intentar cache en memoria, fallback a MongoDB
      let cachedInsights = smsAnalyticsService.getLastAiInsights();

      if (!cachedInsights.insights) {
        // Rehidratar desde MongoDB si el cache en memoria está vacío
        const dbInsight = await AIInsight.getLatest('sms_ai_insights', 30);
        if (dbInsight?.data) {
          smsAnalyticsService.saveAiInsights(dbInsight.data);
          cachedInsights = {
            insights: dbInsight.data,
            generatedAt: dbInsight.createdAt,
            isStale: false
          };
        }
      }

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
