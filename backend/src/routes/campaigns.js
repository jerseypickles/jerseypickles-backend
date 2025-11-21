// backend/src/routes/campaigns.js
const express = require('express');
const router = express.Router();
const campaignsController = require('../controllers/campaignsController');
const { auth, authorize } = require('../middleware/auth');

// Aplicar autenticación a todas las rutas
router.use(auth);

// ==================== RUTAS SIN PARÁMETROS (PRIMERO) ====================

// Listar campañas
router.get('/', campaignsController.list);

// Crear campaña
router.post('/', authorize('admin', 'manager'), campaignsController.create);

// ==================== RUTAS ESPECÍFICAS (ANTES DE /:id) ====================

// Queue management
router.get('/queue/status', authorize('admin', 'manager'), campaignsController.getQueueStatus);
router.post('/queue/pause', authorize('admin'), campaignsController.pauseQueue);
router.post('/queue/resume', authorize('admin'), campaignsController.resumeQueue);
router.post('/queue/clean', authorize('admin'), campaignsController.cleanQueue);
router.post('/queue/check-campaigns', authorize('admin'), campaignsController.forceCheckCampaigns);

// Crear desde template
router.post('/from-template', authorize('admin', 'manager'), campaignsController.createFromTemplate);

// Limpiar campañas borrador
router.delete('/cleanup/drafts', authorize('admin'), campaignsController.cleanupDrafts);

// ==================== RUTAS CON PARÁMETROS /:id (AL FINAL) ====================

// Obtener una campaña
router.get('/:id', campaignsController.getOne);

// Estadísticas de una campaña
router.get('/:id/stats', campaignsController.getStats);

// Obtener eventos de una campaña
router.get('/:id/events', campaignsController.getEvents);

// Actualizar campaña
router.put('/:id', authorize('admin', 'manager'), campaignsController.update);

// Duplicar campaña
router.post('/:id/duplicate', authorize('admin', 'manager'), campaignsController.duplicate);

// Enviar campaña
router.post('/:id/send', authorize('admin', 'manager'), campaignsController.send);

// Eliminar campaña
router.delete('/:id', authorize('admin'), campaignsController.delete);

module.exports = router;