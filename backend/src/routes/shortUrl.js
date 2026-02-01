// backend/src/routes/shortUrl.js
// 🔗 Short URL Routes - Public redirect endpoint for SMS link tracking
const express = require('express');
const router = express.Router();
const urlShortenerService = require('../services/urlShortenerService');

/**
 * GET /s/:code
 * Redirect short URL to original URL with click tracking
 * This is the PUBLIC endpoint that SMS recipients click
 */
router.get('/:code', async (req, res) => {
  try {
    const { code } = req.params;

    console.log(`🔗 Short URL click: ${code}`);

    // Get click info
    const clickInfo = {
      ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
      userAgent: req.headers['user-agent'],
      referer: req.headers['referer']
    };

    // Record click and get original URL
    const result = await urlShortenerService.recordClick(code, clickInfo);

    if (!result) {
      console.log(`❌ Short URL not found or expired: ${code}`);
      // Redirect to store homepage if URL not found
      return res.redirect('https://jerseypickles.com');
    }

    const { originalUrl, isUniqueClick } = result;

    console.log(`✅ Redirecting to: ${originalUrl} (unique: ${isUniqueClick})`);

    // Set attribution cookie for conversion tracking (30 days)
    res.cookie('sms_click', code, {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });

    // Redirect to original URL
    res.redirect(originalUrl);

  } catch (error) {
    console.error('❌ Short URL redirect error:', error);
    res.redirect('https://jerseypickles.com');
  }
});

/**
 * GET /s/:code/preview
 * Preview short URL info without redirecting (for debugging/admin)
 */
router.get('/:code/preview', async (req, res) => {
  try {
    const { code } = req.params;

    const shortUrl = await urlShortenerService.findByCode(code);

    if (!shortUrl) {
      return res.status(404).json({
        success: false,
        error: 'Short URL not found'
      });
    }

    res.json({
      success: true,
      data: {
        code: shortUrl.code,
        originalUrl: shortUrl.originalUrl,
        sourceType: shortUrl.sourceType,
        clicks: shortUrl.clicks,
        uniqueClicks: shortUrl.uniqueClicks,
        lastClickedAt: shortUrl.lastClickedAt,
        createdAt: shortUrl.createdAt,
        isActive: shortUrl.isActive
      }
    });

  } catch (error) {
    console.error('❌ Short URL preview error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
