// backend/src/routes/byb.js
// Rutas para Build Your Box Analytics (Demanda)
// Enhanced with Opportunity Dashboard routes

const express = require('express');
const router = express.Router();
const buildYourBoxController = require('../controllers/buildYourBoxController');

// Middleware de autenticación opcional (para desarrollo)
const optionalProtect = (req, res, next) => {
  // Por ahora permitimos acceso sin auth para desarrollo
  next();
};

// ============================================
// OPPORTUNITY DASHBOARD - Main endpoint
// ============================================
router.get('/opportunity-dashboard', optionalProtect, buildYourBoxController.getOpportunityDashboard);

// ============================================
// ANALYTICS ENDPOINTS
// ============================================

// Dashboard overview completo
router.get('/overview', optionalProtect, buildYourBoxController.getOverview);

// Estadísticas resumidas
router.get('/stats', optionalProtect, buildYourBoxController.getStats);

// Top productos más pedidos
router.get('/products', optionalProtect, buildYourBoxController.getTopProducts);

// Distribución de tamaños de jar
router.get('/sizes', optionalProtect, buildYourBoxController.getSizeDistribution);

// Tendencias diarias
router.get('/trends', optionalProtect, buildYourBoxController.getTrends);

// Combinaciones frecuentes
router.get('/combos', optionalProtect, buildYourBoxController.getFrequentCombos);

// AI Insights para escalar Build Your Box
router.get('/insights', optionalProtect, buildYourBoxController.getAiInsights);

// ============================================
// NEW OPPORTUNITY METRICS
// ============================================

// Trending products with week-over-week comparison
router.get('/trending', optionalProtect, buildYourBoxController.getTrendingProducts);

// Ticket analysis by box configuration
router.get('/ticket-analysis', optionalProtect, buildYourBoxController.getTicketAnalysis);

// Week-over-week comparison
router.get('/week-over-week', optionalProtect, buildYourBoxController.getWeekOverWeek);

module.exports = router;
