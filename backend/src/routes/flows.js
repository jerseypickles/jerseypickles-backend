// backend/src/routes/flows.js
const express = require('express');
const router = express.Router();
const flowsController = require('../controllers/flowsController');
const authMiddleware = require('../middleware/auth');

// Aplicar autenticación a todas las rutas
router.use(authMiddleware);

// ==================== FLOWS CRUD ====================
router.get('/', flowsController.getAll);
router.get('/templates', flowsController.getTemplates);
router.get('/:id', flowsController.getOne);
router.get('/:id/stats', flowsController.getStats);
router.get('/:id/executions', flowsController.getExecutions);

router.post('/', flowsController.create);
router.post('/templates/:templateId', flowsController.createFromTemplate);
router.post('/:id/test', flowsController.testFlow);
router.post('/:id/pause', flowsController.pauseFlow);
router.post('/:id/resume', flowsController.resumeFlow);

router.put('/:id', flowsController.update);
router.patch('/:id/toggle', flowsController.toggleStatus);

router.delete('/:id', flowsController.delete);

module.exports = router;