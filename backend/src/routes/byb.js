// backend/src/routes/byb.js
// Rutas para Build Your Box Analytics (Demanda)

const express = require('express');
const router = express.Router();
const buildYourBoxController = require('../controllers/buildYourBoxController');

// Middleware de autenticación opcional (para desarrollo)
const optionalProtect = (req, res, next) => {
  // Por ahora permitimos acceso sin auth para desarrollo
  next();
};

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

module.exports = router;
