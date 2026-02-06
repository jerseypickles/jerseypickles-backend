// backend/src/routes/smsCampaigns.js
// 📱 SMS Campaign Routes
const express = require('express');
const router = express.Router();
const smsCampaignController = require('../controllers/smsCampaignController');

// Intentar cargar middleware de auth
let protect = null;
try {
  const authMiddleware = require('../middleware/auth');
  protect = authMiddleware.protect;
} catch (e) {
  console.log('⚠️  Auth middleware not available for SMS Campaign routes');
}

// Middleware opcional
const optionalProtect = (req, res, next) => {
  if (protect) {
    return protect(req, res, next);
  }
  next();
};

// ==================== CAMPAIGN CRUD ====================

// Get overall stats (must be before /:id routes)
router.get('/stats/overview', optionalProtect, smsCampaignController.getOverview);

// Get audience count by filters (must be before /:id routes)
router.get('/audience-count', optionalProtect, smsCampaignController.audienceCount);

// Generate AI templates (must be before /:id routes)
router.post('/generate-templates', optionalProtect, smsCampaignController.generateTemplates);

// List campaigns
router.get('/', optionalProtect, smsCampaignController.list);

// Create campaign
router.post('/', optionalProtect, smsCampaignController.create);

// Get single campaign
router.get('/:id', optionalProtect, smsCampaignController.get);

// Update campaign
router.put('/:id', optionalProtect, smsCampaignController.update);

// Delete campaign
router.delete('/:id', optionalProtect, smsCampaignController.delete);

// ==================== CAMPAIGN ACTIONS ====================

// Preview audience
router.get('/:id/audience', optionalProtect, smsCampaignController.previewAudience);

// Send test SMS
router.post('/:id/test', optionalProtect, smsCampaignController.sendTest);

// Send campaign
router.post('/:id/send', optionalProtect, smsCampaignController.send);

// Pause campaign
router.post('/:id/pause', optionalProtect, smsCampaignController.pause);

// Resume campaign
router.post('/:id/resume', optionalProtect, smsCampaignController.resume);

// Cancel campaign
router.post('/:id/cancel', optionalProtect, smsCampaignController.cancel);

// Get campaign stats
router.get('/:id/stats', optionalProtect, smsCampaignController.getStats);

// Get campaign click stats
router.get('/:id/clicks', optionalProtect, smsCampaignController.getClickStats);

// Set/update discount code for conversion tracking
router.put('/:id/discount-code', optionalProtect, smsCampaignController.setDiscountCode);

// Reprocess conversions from existing orders
router.post('/:id/reprocess-conversions', optionalProtect, smsCampaignController.reprocessConversions);

// ==================== TRACKING (PUBLIC) ====================

// Track click (no auth - accessed from SMS links)
router.get('/click/:campaignId/:messageId', smsCampaignController.trackClick);

module.exports = router;