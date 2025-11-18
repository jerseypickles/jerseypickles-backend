// backend/src/routes/segments.js
const express = require('express');
const router = express.Router();
const segmentsController = require('../controllers/segmentsController');
const { auth, authorize } = require('../middleware/auth');

// Aplicar autenticación a todas las rutas
router.use(auth);

// Listar todos los segmentos
router.get('/', segmentsController.list);

// Preview de segmento (POST para enviar condiciones)
router.post('/preview', segmentsController.preview);

// Obtener segmentos predefinidos por tipo
router.get('/predefined/:type', segmentsController.getPredefined);

// Crear segmentos predefinidos en la BD (solo admin)
router.post('/predefined/create-all', authorize('admin'), segmentsController.createPredefinedSegments);

// Obtener un segmento específico
router.get('/:id', segmentsController.getOne);

// Obtener clientes de un segmento
router.get('/:id/customers', segmentsController.getCustomers);

// Recalcular segmento
router.post('/:id/recalculate', segmentsController.recalculate);

// ==================== CRUD (solo admin o manager) ====================

// Crear segmento
router.post('/', authorize('admin', 'manager'), segmentsController.create);

// Actualizar segmento
router.put('/:id', authorize('admin', 'manager'), segmentsController.update);

// Eliminar segmento
router.delete('/:id', authorize('admin'), segmentsController.delete);

module.exports = router;