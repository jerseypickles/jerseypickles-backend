// backend/src/routes/sms.js
const express = require('express');
const router = express.Router();
const smsController = require('../controllers/smsController');
const { protect, adminOnly } = require('../middleware/auth');

// ==================== RUTAS PÚBLICAS ====================

// Suscribir nuevo número (desde popup)
router.post('/subscribe', smsController.subscribe);

// Health check de Telnyx
router.get('/health', smsController.healthCheck);

// ==================== RUTAS PROTEGIDAS (Admin Dashboard) ====================

// Estadísticas generales
router.get('/stats', protect, smsController.getStats);

// Listar suscriptores
router.get('/subscribers', protect, smsController.getSubscribers);

// Detalle de suscriptor
router.get('/subscribers/:id', protect, smsController.getSubscriber);

// Reenviar SMS de bienvenida
router.post('/subscribers/:id/resend', protect, smsController.resendWelcomeSms);

module.exports = router;