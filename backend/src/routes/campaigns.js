// backend/src/routes/campaigns.js
const express = require('express');
const router = express.Router();
const campaignsController = require('../controllers/campaignsController');
const { auth, authorize } = require('../middleware/auth');

// Aplicar autenticación a todas las rutas
router.use(auth);

// Listar campañas
router.get('/', campaignsController.list);

// Obtener una campaña
router.get('/:id', campaignsController.getOne);

// Estadísticas de una campaña
router.get('/:id/stats', campaignsController.getStats);

// Obtener eventos de una campaña
router.get('/:id/events', campaignsController.getEvents);

// ==================== CRUD (admin/manager) ====================

// Crear campaña
router.post('/', authorize('admin', 'manager'), campaignsController.create);

// Crear desde template
router.post('/from-template', authorize('admin', 'manager'), campaignsController.createFromTemplate);

// Actualizar campaña
router.put('/:id', authorize('admin', 'manager'), campaignsController.update);

// Duplicar campaña
router.post('/:id/duplicate', authorize('admin', 'manager'), campaignsController.duplicate);

// Eliminar campaña
router.delete('/:id', authorize('admin'), campaignsController.delete);

// ==================== ENVÍO (admin/manager) ====================

// Enviar campaña
router.post('/:id/send', authorize('admin', 'manager'), campaignsController.send);

module.exports = router;