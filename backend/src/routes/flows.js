// backend/src/routes/flows.js (ACTUALIZADO)
const express = require('express');
const router = express.Router();
const flowsController = require('../controllers/flowsController');
const { auth } = require('../middleware/auth');

// Aplicar autenticación a todas las rutas
router.use(auth);

// ==================== TEMPLATES ====================
// Templates ANTES que las rutas con :id para evitar conflictos
router.get('/templates', flowsController.getTemplates);
router.post('/templates/:templateId', flowsController.createFromTemplate);

// ==================== CRUD DE FLOWS ====================
router.get('/', flowsController.getAll);
router.post('/', flowsController.create);

// ==================== FLOW ESPECÍFICO ====================
router.get('/:id', flowsController.getOne);
router.put('/:id', flowsController.update);
router.delete('/:id', flowsController.delete);

// ==================== STATS Y EXECUTIONS ====================
router.get('/:id/stats', flowsController.getStats);
router.get('/:id/executions', flowsController.getExecutions);

// ==================== ACCIONES DEL FLOW ====================
router.patch('/:id/toggle', flowsController.toggleStatus);
router.post('/:id/pause', flowsController.pauseFlow);
router.post('/:id/resume', flowsController.resumeFlow);
router.post('/:id/test', flowsController.testFlow);

// ==================== EXECUTIONS ====================
router.post('/executions/:executionId/cancel', flowsController.cancelExecution);

module.exports = router;