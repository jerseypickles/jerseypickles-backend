// backend/src/routes/sms.js
// 📱 SMS Marketing Routes - Con Second Chance SMS y Analytics
const express = require('express');
const router = express.Router();
const smsController = require('../controllers/smsController');
const smsAnalyticsController = require('../controllers/smsAnalyticsController');

// Intentar cargar middleware de auth (opcional)
let protect = null;
try {
  const authMiddleware = require('../middleware/auth');
  protect = authMiddleware.protect;
} catch (e) {
  console.log('⚠️  Auth middleware not available for SMS routes');
}

// Middleware opcional - si no hay auth, permite acceso
const optionalProtect = (req, res, next) => {
  if (protect) {
    return protect(req, res, next);
  }
  next();
};

// ==================== RUTAS PÚBLICAS ====================

// Health check de Telnyx
router.get('/health', smsController.healthCheck);

// Suscribir nuevo número (desde popup)
router.post('/subscribe', smsController.subscribe);

// ==================== RUTAS PROTEGIDAS (Admin Dashboard) ====================

// Estadísticas generales
router.get('/stats', optionalProtect, smsController.getStats);

// Estadísticas de conversiones (para dashboard)
router.get('/stats/conversions', optionalProtect, smsController.getConversionStats);

// 🆕 Estadísticas de Second Chance SMS
router.get('/stats/second-chance', optionalProtect, smsController.getSecondChanceStats);

// Listar suscriptores
router.get('/subscribers', optionalProtect, smsController.getSubscribers);

// Detalle de suscriptor
router.get('/subscribers/:id', optionalProtect, smsController.getSubscriber);

// Reenviar SMS de bienvenida
router.post('/subscribers/:id/resend', optionalProtect, smsController.resendWelcomeSms);

// 🆕 Second Chance SMS - Trigger manual (para testing)
router.post('/second-chance/trigger', optionalProtect, smsController.triggerSecondChance);
router.post('/second-chance/trigger/:subscriberId', optionalProtect, smsController.triggerSecondChance);

// 🆕 Second Chance SMS - Job status
router.get('/second-chance/status', optionalProtect, smsController.getSecondChanceJobStatus);

// 🆕 Second Chance SMS - Recover missed subscribers (procesa los que se perdieron)
router.post('/second-chance/recover', optionalProtect, smsController.recoverMissedSubscribers);

// 🆕 Second Chance SMS - Detailed queue visibility
router.get('/second-chance/queue', optionalProtect, smsController.getSecondChanceQueue);

// ==================== 📊 SMS ANALYTICS ROUTES ====================

// Overview completo (combina todas las métricas para dashboard)
router.get('/analytics/overview', optionalProtect, smsAnalyticsController.getOverview);

// Datos del mapa USA (suscriptores por estado)
router.get('/analytics/map', optionalProtect, smsAnalyticsController.getMapData);

// Feed de actividad en tiempo real
router.get('/analytics/activity', optionalProtect, smsAnalyticsController.getRecentActivity);

// Métricas del dashboard
router.get('/analytics/metrics', optionalProtect, smsAnalyticsController.getDashboardMetrics);

// Tendencias diarias (para gráficos)
router.get('/analytics/trends', optionalProtect, smsAnalyticsController.getDailyTrends);

// Top estados por métrica
router.get('/analytics/top-states', optionalProtect, smsAnalyticsController.getTopStates);

// Detalles de un estado específico
router.get('/analytics/state/:code', optionalProtect, smsAnalyticsController.getStateDetails);

// AI Insights (leer caché o generar)
router.get('/analytics/insights', optionalProtect, smsAnalyticsController.getAiInsights);

// Forzar generación de insights
router.post('/analytics/insights/generate', optionalProtect, smsAnalyticsController.generateInsights);

module.exports = router;
