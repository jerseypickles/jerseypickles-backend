// backend/src/middleware/rateLimiter.js
const rateLimit = require('express-rate-limit');

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Demasiadas peticiones desde esta IP, por favor intenta más tarde',
  standardHeaders: true,
  legacyHeaders: false,
  // trustProxy: true, // ⬅️ COMENTAR TEMPORALMENTE para evitar el warning
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Demasiados intentos de inicio de sesión, intenta en 15 minutos',
  skipSuccessfulRequests: true,
  // trustProxy: true, // ⬅️ COMENTAR TEMPORALMENTE
});

const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 100,
  message: 'Demasiados webhooks',
  // trustProxy: true, // ⬅️ COMENTAR TEMPORALMENTE
  skip: (req) => {
    return req.path === '/resend';
  }
});

module.exports = {
  apiLimiter,
  authLimiter,
  webhookLimiter
};