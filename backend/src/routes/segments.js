// backend/src/routes/segments.js - ACTUALIZADO
const express = require('express');
const router = express.Router();
const segmentsController = require('../controllers/segmentsController');
const { auth, authorize } = require('../middleware/auth');

// Aplicar autenticación a todas las rutas
router.use(auth);

// ==================== LECTURA ====================

// Listar todos los segmentos
// GET /segments?category=purchase&type=predefined&active=true
router.get('/', segmentsController.list);

// Preview de segmento (POST para enviar condiciones)
router.post('/preview', segmentsController.preview);

// Diagnóstico de datos para segmentación
router.get('/diagnose', segmentsController.diagnose);

// Obtener segmentos predefinidos por tipo/categoría
// GET /segments/predefined/all
// GET /segments/predefined/purchase
// GET /segments/predefined/engagement
router.get('/predefined/:type', segmentsController.getPredefined);

// Recalcular TODOS los segmentos activos
router.post('/recalculate-all', authorize('admin'), segmentsController.recalculateAll);

// Crear/actualizar TODOS los segmentos predefinidos en la BD
router.post('/predefined/create-all', authorize('admin'), segmentsController.createPredefinedSegments);

// ==================== POR ID ====================

// Obtener un segmento específico
router.get('/:id', segmentsController.getOne);

// Obtener clientes de un segmento
// GET /segments/:id/customers?page=1&limit=50&onlyMarketing=true
router.get('/:id/customers', segmentsController.getCustomers);

// Recalcular un segmento específico
router.post('/:id/recalculate', segmentsController.recalculate);

// ==================== CRUD (solo admin o manager) ====================

// Crear segmento custom
router.post('/', authorize('admin', 'manager'), segmentsController.create);

// Actualizar segmento
router.put('/:id', authorize('admin', 'manager'), segmentsController.update);

// Eliminar segmento (solo custom, no predefinidos)
router.delete('/:id', authorize('admin'), segmentsController.delete);

module.exports = router;