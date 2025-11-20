// backend/src/routes/lists.js
const express = require('express');
const router = express.Router();
const listsController = require('../controllers/listsController');
const { auth, authorize } = require('../middleware/auth');

// Aplicar autenticación a todas las rutas
router.use(auth);

// Listar listas - ✅ ACTUALIZADO
router.get('/', listsController.getAll);  // ← Cambió de "list" a "getAll"

// Obtener una lista
router.get('/:id', listsController.getOne);

// Obtener miembros de una lista (paginado)
router.get('/:id/members', listsController.getMembers);

// ==================== ANÁLISIS Y LIMPIEZA ====================
// ✅ NUEVO: Analizar engagement de una lista
router.get('/:id/engagement', listsController.analyzeEngagement);

// ✅ NUEVO: Limpiar lista (remover miembros inactivos)
router.post('/:id/clean', authorize('admin', 'manager'), listsController.cleanMembers);

// Crear lista
router.post('/', authorize('admin', 'manager'), listsController.create);

// Actualizar lista
router.put('/:id', authorize('admin', 'manager'), listsController.update);

// Eliminar lista
router.delete('/:id', authorize('admin'), listsController.delete);

// Importar desde CSV
router.post('/import/csv', authorize('admin', 'manager'), listsController.importCSV);

// Gestión de miembros
router.post('/:id/members', authorize('admin', 'manager'), listsController.addMember);
router.post('/:id/members/bulk', authorize('admin', 'manager'), listsController.addMembersByEmail);
router.delete('/:id/members/:customerId', authorize('admin', 'manager'), listsController.removeMember);

module.exports = router;