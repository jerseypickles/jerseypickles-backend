// backend/src/middleware/rateLimiter.js
const rateLimit = require('express-rate-limit');

// Rate limiter general para API
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // 100 requests por ventana
  message: 'Demasiadas peticiones desde esta IP, por favor intenta más tarde',
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true // 🆕 AGREGAR ESTA LÍNEA
});

// Rate limiter estricto para auth
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // 5 intentos de login
  message: 'Demasiados intentos de inicio de sesión, intenta en 15 minutos',
  skipSuccessfulRequests: true,
  trustProxy: true // 🆕 AGREGAR ESTA LÍNEA
});

// Rate limiter para webhooks
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 100, // 100 webhooks por minuto
  message: 'Demasiados webhooks',
  trustProxy: true, // 🆕 AGREGAR ESTA LÍNEA
  skip: (req) => {
    // No aplicar rate limit a webhooks de Resend
    return req.path === '/resend';
  }
});

module.exports = {
  apiLimiter,
  authLimiter,
  webhookLimiter
};