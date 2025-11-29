// backend/src/routes/lists.js - COMPLETO CON BOUNCE MANAGEMENT
const express = require('express');
const router = express.Router();
const listsController = require('../controllers/listsController');
const { auth, authorize } = require('../middleware/auth');

// Aplicar autenticación a todas las rutas
router.use(auth);

// ==================== RUTAS SIN PARÁMETROS (PRIMERO) ====================

// Listar listas
router.get('/', listsController.getAll);

// Crear lista
router.post('/', authorize('admin', 'manager'), listsController.create);

// Importar desde CSV
router.post('/import/csv', authorize('admin', 'manager'), listsController.importCSV);

// ==================== RUTAS ESPECÍFICAS CON :id (ANTES DE /:id GENÉRICO) ====================

// ✅ BOUNCE MANAGEMENT (NUEVO)
router.get('/:id/health', listsController.getHealth);
router.get('/:id/bounced', listsController.getBounced);
router.post('/:id/auto-clean', authorize('admin', 'manager'), listsController.autoClean);

// Análisis y limpieza
router.get('/:id/engagement', listsController.analyzeEngagement);
router.post('/:id/clean', authorize('admin', 'manager'), listsController.cleanMembers);

// Obtener miembros de una lista (paginado)
router.get('/:id/members', listsController.getMembers);

// Gestión de miembros
router.post('/:id/members', authorize('admin', 'manager'), listsController.addMember);
router.post('/:id/members/bulk', authorize('admin', 'manager'), listsController.addMembersByEmail);
router.delete('/:id/members/:customerId', authorize('admin', 'manager'), listsController.removeMember);

// ==================== RUTAS GENÉRICAS CON :id (AL FINAL) ====================

// Obtener una lista
router.get('/:id', listsController.getOne);

// Actualizar lista
router.put('/:id', authorize('admin', 'manager'), listsController.update);

// Eliminar lista
router.delete('/:id', authorize('admin'), listsController.delete);

module.exports = router;