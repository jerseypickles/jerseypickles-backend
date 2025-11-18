// backend/src/routes/orders.js
const express = require('express');
const router = express.Router();
const ordersController = require('../controllers/ordersController');
const { auth, authorize } = require('../middleware/auth');

// Aplicar autenticación a todas las rutas
router.use(auth);

// Listar órdenes
router.get('/', ordersController.list);

// Estadísticas de órdenes
router.get('/stats', ordersController.stats);

// Revenue timeline
router.get('/revenue-timeline', ordersController.revenueTimeline);

// Obtener una orden específica
router.get('/:id', ordersController.getOne);

// ==================== RUTAS DE ADMIN ====================

// Sincronizar órdenes desde Shopify (solo admin)
router.post('/sync', authorize('admin'), ordersController.syncFromShopify);

module.exports = router;