// backend/src/routes/flows.js (ACTUALIZADO CON AI ROUTES)
const express = require('express');
const router = express.Router();
const flowsController = require('../controllers/flowsController');
const { auth } = require('../middleware/auth');

// Aplicar autenticación a todas las rutas
router.use(auth);

// ==================== 🧠 AI ENDPOINTS (antes de :id para evitar conflictos) ====================

// Generar subject lines con AI
router.post('/ai/subject-lines', flowsController.generateSubjectLines);

// Generar contenido de email con AI
router.post('/ai/email-content', flowsController.generateEmailContent);

// Generar flow completo desde descripción natural
router.post('/ai/generate', flowsController.generateFlowFromDescription);

// Mejorar template existente con AI
router.post('/ai/enhance-template', flowsController.enhanceTemplate);

// ==================== TEMPLATES ====================

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

// ==================== 🧠 AI PER-FLOW ENDPOINTS ====================

// Sugerir siguiente step para un flow
router.post('/:id/ai/suggest-step', flowsController.suggestNextStep);

// Analizar performance de un flow
router.get('/:id/ai/analyze', flowsController.analyzeFlow);

// Optimizar timing de un flow
router.get('/:id/ai/optimize-timing', flowsController.optimizeTiming);

// ==================== ACCIONES DEL FLOW ====================

router.patch('/:id/toggle', flowsController.toggleStatus);
router.post('/:id/pause', flowsController.pauseFlow);
router.post('/:id/resume', flowsController.resumeFlow);
router.post('/:id/test', flowsController.testFlow);

// ==================== EXECUTIONS ====================

router.post('/executions/:executionId/cancel', flowsController.cancelExecution);

module.exports = router;