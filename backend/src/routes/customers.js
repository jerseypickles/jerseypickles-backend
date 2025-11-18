// backend/src/routes/customers.js
const express = require('express');
const router = express.Router();
const customersController = require('../controllers/customersController');
const { auth, authorize } = require('../middleware/auth');

// ==================== RUTAS PÚBLICAS (sin auth) ====================

// Test de conexión a Shopify (útil para debugging)
router.get('/test-shopify', customersController.testShopify);

// ==================== RUTAS PROTEGIDAS ====================

// Aplicar autenticación a todas las rutas siguientes
router.use(auth);

// Listar clientes
router.get('/', customersController.list);

// Estadísticas de clientes
router.get('/stats', customersController.stats);

// Obtener un cliente específico por ID
router.get('/:id', customersController.getOne);

// ==================== RUTAS DE ADMIN ====================

// Sincronizar clientes desde Shopify (solo admin)
router.post('/sync', authorize('admin'), customersController.syncFromShopify);

// Configurar webhooks de Shopify (solo admin)
router.post('/setup-webhooks', authorize('admin'), customersController.setupWebhooks);

// Listar webhooks actuales (solo admin)
router.get('/webhooks/list', authorize('admin'), customersController.listWebhooks);

module.exports = router;