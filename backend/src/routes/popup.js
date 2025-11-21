// backend/src/routes/popup.js
const express = require('express');
const router = express.Router();
const popupController = require('../controllers/popupController');
const { auth } = require('../middleware/auth');

// ==================== RUTA PÚBLICA ====================
// Esta ruta NO necesita autenticación porque viene del sitio web público
router.post('/subscribe', popupController.subscribe);

// ==================== RUTAS PROTEGIDAS ====================
// Stats del popup (requiere autenticación)
router.get('/stats', auth, popupController.getStats);

module.exports = router;