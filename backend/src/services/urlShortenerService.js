// backend/src/services/urlShortenerService.js
// 🔗 URL Shortener Service - Create and manage short URLs for SMS tracking
const ShortUrl = require('../models/ShortUrl');

// Base URL for short links (update this to your domain)
const BASE_URL = process.env.SHORT_URL_BASE || process.env.API_URL || 'https://jerseypickles-backend.onrender.com';

const urlShortenerService = {

  /**
   * Get the full short URL from a code
   */
  getShortUrl(code) {
    return `${BASE_URL}/s/${code}`;
  },

  /**
   * Create a short URL for SMS campaign
   */
  async createForCampaign(options) {
    const {
      originalUrl,
      campaignId,
      subscriberId,
      messageId,
      discountCode
    } = options;

    const shortUrl = await ShortUrl.createShortUrl({
      originalUrl,
      sourceType: 'sms_campaign',
      campaignId,
      subscriberId,
      messageId,
      discountCode
    });

    return {
      code: shortUrl.code,
      shortUrl: this.getShortUrl(shortUrl.code),
      originalUrl: shortUrl.originalUrl
    };
  },

  /**
   * Create a short URL for Welcome SMS
   */
  async createForWelcomeSms(options) {
    const {
      originalUrl,
      subscriberId,
      discountCode
    } = options;

    const shortUrl = await ShortUrl.createShortUrl({
      originalUrl,
      sourceType: 'sms_welcome',
      subscriberId,
      discountCode
    });

    return {
      code: shortUrl.code,
      shortUrl: this.getShortUrl(shortUrl.code),
      originalUrl: shortUrl.originalUrl
    };
  },

  /**
   * Create a short URL for Second Chance SMS
   */
  async createForSecondChanceSms(options) {
    const {
      originalUrl,
      subscriberId,
      discountCode
    } = options;

    const shortUrl = await ShortUrl.createShortUrl({
      originalUrl,
      sourceType: 'sms_second_chance',
      subscriberId,
      discountCode
    });

    return {
      code: shortUrl.code,
      shortUrl: this.getShortUrl(shortUrl.code),
      originalUrl: shortUrl.originalUrl
    };
  },

  /**
   * Create a short URL for Transactional SMS
   */
  async createForTransactional(options) {
    const {
      originalUrl,
      transactionalId,
      triggerType
    } = options;

    const shortUrl = await ShortUrl.createShortUrl({
      originalUrl,
      sourceType: 'sms_transactional',
      transactionalId,
      metadata: { triggerType }
    });

    return {
      code: shortUrl.code,
      shortUrl: this.getShortUrl(shortUrl.code),
      originalUrl: shortUrl.originalUrl
    };
  },

  /**
   * Process message and replace URLs with short URLs
   * Returns the processed message and array of created short URLs
   */
  async processMessageUrls(message, options = {}) {
    const {
      sourceType = 'other',
      campaignId,
      subscriberId,
      messageId,
      transactionalId,
      discountCode
    } = options;

    // URL regex pattern
    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    const urls = message.match(urlRegex);

    if (!urls || urls.length === 0) {
      return {
        processedMessage: message,
        shortUrls: []
      };
    }

    const shortUrls = [];
    let processedMessage = message;

    for (const url of urls) {
      // Clean URL (remove trailing punctuation)
      const cleanUrl = url.replace(/[.,!?;:]+$/, '');

      try {
        const shortUrl = await ShortUrl.createShortUrl({
          originalUrl: cleanUrl,
          sourceType,
          campaignId,
          subscriberId,
          messageId,
          transactionalId,
          discountCode
        });

        const shortLink = this.getShortUrl(shortUrl.code);
        shortUrls.push({
          original: cleanUrl,
          short: shortLink,
          code: shortUrl.code
        });

        // Replace in message
        processedMessage = processedMessage.replace(cleanUrl, shortLink);

      } catch (error) {
        console.error(`Error creating short URL for ${cleanUrl}:`, error.message);
        // Keep original URL if shortening fails
      }
    }

    return {
      processedMessage,
      shortUrls
    };
  },

  /**
   * Record a click on a short URL
   */
  async recordClick(code, clickInfo = {}) {
    const result = await ShortUrl.recordClick(code, clickInfo);

    if (!result) {
      return null;
    }

    const { shortUrl, isUniqueClick, originalUrl } = result;

    // Update related models based on source type
    try {
      if (shortUrl.sourceType === 'sms_campaign' && shortUrl.messageId) {
        const SmsMessage = require('../models/SmsMessage');
        const message = await SmsMessage.findById(shortUrl.messageId);
        if (message && !message.clicked) {
          await message.recordClick({
            url: originalUrl,
            userAgent: clickInfo.userAgent,
            ip: clickInfo.ip
          });
        }
      }

      if (shortUrl.sourceType === 'sms_welcome' || shortUrl.sourceType === 'sms_second_chance') {
        if (shortUrl.subscriberId) {
          const SmsSubscriber = require('../models/SmsSubscriber');
          await SmsSubscriber.findByIdAndUpdate(shortUrl.subscriberId, {
            lastEngagedAt: new Date(),
            $inc: { engagementScore: isUniqueClick ? 5 : 1 }
          });
        }
      }

    } catch (error) {
      console.error('Error updating related models on click:', error.message);
    }

    return {
      originalUrl,
      shortUrl,
      isUniqueClick
    };
  },

  /**
   * Record conversion for a short URL
   */
  async recordConversion(code, conversionData) {
    const shortUrl = await ShortUrl.findOne({ code });

    if (!shortUrl || shortUrl.converted) {
      return null;
    }

    shortUrl.converted = true;
    shortUrl.conversionData = {
      orderId: conversionData.orderId,
      orderNumber: conversionData.orderNumber,
      orderTotal: conversionData.orderTotal,
      convertedAt: new Date()
    };

    await shortUrl.save();

    return shortUrl;
  },

  /**
   * Get click statistics for a campaign
   */
  async getCampaignClickStats(campaignId) {
    const stats = await ShortUrl.getCampaignStats(campaignId);
    const topUrls = await ShortUrl.getTopUrls(campaignId, 5);
    const timeline = await ShortUrl.getClickTimeline(campaignId, 7);

    return {
      ...stats,
      topUrls,
      timeline
    };
  },

  /**
   * Get overall click stats by source type
   */
  async getStatsBySourceType(days = 30) {
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const stats = await ShortUrl.aggregate([
      { $match: { createdAt: { $gte: startDate } } },
      {
        $group: {
          _id: '$sourceType',
          totalUrls: { $sum: 1 },
          totalClicks: { $sum: '$clicks' },
          uniqueClicks: { $sum: '$uniqueClicks' },
          conversions: { $sum: { $cond: ['$converted', 1, 0] } }
        }
      }
    ]);

    const result = {};
    stats.forEach(s => {
      result[s._id] = {
        urls: s.totalUrls,
        clicks: s.totalClicks,
        uniqueClicks: s.uniqueClicks,
        conversions: s.conversions,
        ctr: s.totalUrls > 0 ? ((s.uniqueClicks / s.totalUrls) * 100).toFixed(1) : '0'
      };
    });

    return result;
  },

  /**
   * Find short URL by code
   */
  async findByCode(code) {
    return ShortUrl.findOne({ code, isActive: true });
  },

  /**
   * Deactivate expired URLs (cleanup job)
   */
  async cleanupExpired() {
    const result = await ShortUrl.updateMany(
      {
        expiresAt: { $lt: new Date() },
        isActive: true
      },
      { isActive: false }
    );

    return result.modifiedCount;
  }
};

module.exports = urlShortenerService;
