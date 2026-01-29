// backend/src/routes/sms.js
// 📱 SMS Routes - VIP Text Club
const express = require('express');
const router = express.Router();
const smsController = require('../controllers/smsController');
const { authMiddleware } = require('../middleware/auth');

// ==================== PUBLIC ROUTES (No auth required) ====================

// Subscribe new phone number (from website popup)
router.post('/subscribe', smsController.subscribe);

// Health check (can be public for monitoring)
router.get('/health', smsController.healthCheck);

// ==================== PROTECTED ROUTES (Auth required) ====================

// Get general SMS stats
router.get('/stats', authMiddleware, smsController.getStats);

// 🆕 Get conversion stats (for dashboard)
router.get('/stats/conversions', authMiddleware, smsController.getConversionStats);

// Get all subscribers with pagination
router.get('/subscribers', authMiddleware, smsController.getSubscribers);

// Get single subscriber
router.get('/subscribers/:id', authMiddleware, smsController.getSubscriber);

// Resend welcome SMS
router.post('/subscribers/:id/resend', authMiddleware, smsController.resendWelcomeSms);

module.exports = router;