// backend/src/routes/sms.js
const express = require('express');
const router = express.Router();
const smsController = require('../controllers/smsController');

// Intentar cargar middleware de auth (opcional)
let protect = null;
try {
  const authMiddleware = require('../middleware/auth');
  protect = authMiddleware.protect;
} catch (e) {
  console.log('⚠️  Auth middleware not available for SMS routes');
}

// Middleware opcional - si no hay auth, permite acceso
const optionalProtect = (req, res, next) => {
  if (protect) {
    return protect(req, res, next);
  }
  next();
};

// ==================== RUTAS PÚBLICAS ====================

// Health check de Telnyx
router.get('/health', smsController.healthCheck);

// Suscribir nuevo número (desde popup)
router.post('/subscribe', smsController.subscribe);

// ==================== RUTAS PROTEGIDAS (Admin Dashboard) ====================

// Estadísticas generales
router.get('/stats', optionalProtect, smsController.getStats);

// 🆕 Estadísticas de conversiones (para dashboard)
router.get('/stats/conversions', optionalProtect, smsController.getConversionStats);

// Listar suscriptores
router.get('/subscribers', optionalProtect, smsController.getSubscribers);

// Detalle de suscriptor
router.get('/subscribers/:id', optionalProtect, smsController.getSubscriber);

// Reenviar SMS de bienvenida
router.post('/subscribers/:id/resend', optionalProtect, smsController.resendWelcomeSms);

module.exports = router;