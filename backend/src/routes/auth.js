// backend/src/routes/auth.js
const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { auth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');

// Aplicar rate limiter
router.use(authLimiter);

// Registro (solo para setup inicial)
router.post('/register', authController.register);

// Login
router.post('/login', authController.login);

// Usuario actual (requiere auth)
router.get('/me', auth, authController.me);

module.exports = router;