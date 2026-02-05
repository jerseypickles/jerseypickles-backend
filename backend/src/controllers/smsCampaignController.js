// backend/src/controllers/smsCampaignController.js
// 📱 SMS Campaign Controller - Full campaign management
const SmsCampaign = require('../models/SmsCampaign');
const SmsMessage = require('../models/SmsMessage');
const SmsSubscriber = require('../models/SmsSubscriber');
const telnyxService = require('../services/telnyxService');
const urlShortenerService = require('../services/urlShortenerService');

const smsCampaignController = {
  
  // ==================== CREATE CAMPAIGN ====================
  
  /**
   * POST /api/sms/campaigns
   * Create new SMS campaign
   */
  async create(req, res) {
    try {
      const {
        name,
        description,
        message,
        discountCode,
        discountPercent,
        audienceType,
        targetCountry,
        customFilter,
        scheduledAt,
        tags
      } = req.body;
      
      // Validate message
      if (!message || message.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Message is required'
        });
      }
      
      if (message.length > 1600) {
        return res.status(400).json({
          success: false,
          error: 'Message too long. Maximum 1600 characters (10 segments).'
        });
      }
      
      // Create campaign
      const campaign = new SmsCampaign({
        name: name || `SMS Campaign ${new Date().toLocaleDateString()}`,
        description,
        message,
        discountCode: discountCode?.toUpperCase(),
        discountPercent,
        audienceType: audienceType || 'all_delivered',
        targetCountry: targetCountry || 'all',
        customFilter,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        status: scheduledAt ? 'scheduled' : 'draft',
        tags,
        createdBy: req.user?._id
      });
      
      // Get eligible count
      campaign.stats.eligible = await campaign.getEligibleCount();
      
      await campaign.save();
      
      console.log(`📱 SMS Campaign created: ${campaign.name} (${campaign.stats.eligible} eligible)`);
      
      res.status(201).json({
        success: true,
        campaign
      });
      
    } catch (error) {
      console.error('❌ Create SMS Campaign Error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },
  
  // ==================== AUDIENCE COUNT (without campaign) ====================

  /**
   * GET /api/sms/campaigns/audience-count?audienceType=all_delivered&targetCountry=US
   * Get eligible subscriber count for given filters (used by campaign editor before saving)
   */
  async audienceCount(req, res) {
    try {
      const { audienceType = 'all_delivered', targetCountry = 'all' } = req.query;

      const baseQuery = {
        status: 'active',
        welcomeSmsSent: true,
        welcomeSmsStatus: 'delivered'
      };

      // Country filter
      if (targetCountry && targetCountry !== 'all') {
        baseQuery['location.countryCode'] = targetCountry;
      }

      // Audience type filter
      switch (audienceType) {
        case 'not_converted':
          baseQuery.converted = false;
          break;
        case 'converted':
          baseQuery.converted = true;
          break;
        case 'recent_7d':
          baseQuery.createdAt = { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) };
          break;
        case 'recent_30d':
          baseQuery.createdAt = { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) };
          break;
        case 'inactive_30d':
          baseQuery.lastEngagedAt = { $lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) };
          break;
        // 'all_delivered' uses baseQuery as-is
      }

      const count = await SmsSubscriber.countDocuments(baseQuery);

      res.json({ success: true, count, audienceType, targetCountry });
    } catch (error) {
      console.error('❌ Audience Count Error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  },

  // ==================== GET CAMPAIGNS ====================
  
  /**
   * GET /api/sms/campaigns
   * List all campaigns with pagination
   */
  async list(req, res) {
    try {
      const {
        page = 1,
        limit = 20,
        status,
        sortBy = 'createdAt',
        sortOrder = 'desc'
      } = req.query;
      
      const query = {};
      if (status && status !== 'all') {
        query.status = status;
      }
      
      const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };
      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      const [campaigns, total] = await Promise.all([
        SmsCampaign.find(query)
          .sort(sort)
          .skip(skip)
          .limit(parseInt(limit))
          .lean(),
        SmsCampaign.countDocuments(query)
      ]);
      
      res.json({
        success: true,
        campaigns,
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit))
      });
      
    } catch (error) {
      console.error('❌ List SMS Campaigns Error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },
  
  /**
   * GET /api/sms/campaigns/:id
   * Get single campaign details
   */
  async get(req, res) {
    try {
      const campaign = await SmsCampaign.findById(req.params.id);
      
      if (!campaign) {
        return res.status(404).json({
          success: false,
          error: 'Campaign not found'
        });
      }
      
      // Get fresh eligible count
      campaign.stats.eligible = await campaign.getEligibleCount();
      
      // Get message stats
      const messageStats = await SmsMessage.getCampaignStats(campaign._id);
      
      res.json({
        success: true,
        campaign,
        messageStats
      });
      
    } catch (error) {
      console.error('❌ Get SMS Campaign Error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },
  
  // ==================== UPDATE CAMPAIGN ====================
  
  /**
   * PUT /api/sms/campaigns/:id
   * Update campaign (only if draft or scheduled)
   */
  async update(req, res) {
    try {
      const campaign = await SmsCampaign.findById(req.params.id);
      
      if (!campaign) {
        return res.status(404).json({
          success: false,
          error: 'Campaign not found'
        });
      }
      
      if (!['draft', 'scheduled'].includes(campaign.status)) {
        return res.status(400).json({
          success: false,
          error: 'Cannot edit campaign that has already been sent'
        });
      }
      
      const allowedUpdates = [
        'name', 'description', 'message', 'discountCode', 'discountPercent',
        'audienceType', 'targetCountry', 'customFilter', 'scheduledAt', 'tags', 'excludedSubscribers'
      ];
      
      allowedUpdates.forEach(field => {
        if (req.body[field] !== undefined) {
          campaign[field] = req.body[field];
        }
      });
      
      // Update status based on scheduledAt
      if (req.body.scheduledAt) {
        campaign.status = 'scheduled';
        campaign.scheduledAt = new Date(req.body.scheduledAt);
      }
      
      // Refresh eligible count
      campaign.stats.eligible = await campaign.getEligibleCount();
      
      await campaign.save();
      
      res.json({
        success: true,
        campaign
      });
      
    } catch (error) {
      console.error('❌ Update SMS Campaign Error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },
  
  // ==================== DELETE CAMPAIGN ====================
  
  /**
   * DELETE /api/sms/campaigns/:id
   */
  async delete(req, res) {
    try {
      const campaign = await SmsCampaign.findById(req.params.id);
      
      if (!campaign) {
        return res.status(404).json({
          success: false,
          error: 'Campaign not found'
        });
      }
      
      if (campaign.status === 'sending') {
        return res.status(400).json({
          success: false,
          error: 'Cannot delete campaign while sending'
        });
      }
      
      // Delete associated messages
      await SmsMessage.deleteMany({ campaign: campaign._id });
      
      await campaign.deleteOne();
      
      res.json({
        success: true,
        message: 'Campaign deleted'
      });
      
    } catch (error) {
      console.error('❌ Delete SMS Campaign Error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },
  
  // ==================== PREVIEW AUDIENCE ====================
  
  /**
   * GET /api/sms/campaigns/:id/audience
   * Preview target audience
   */
  async previewAudience(req, res) {
    try {
      const { limit = 50 } = req.query;
      
      const campaign = await SmsCampaign.findById(req.params.id);
      
      if (!campaign) {
        return res.status(404).json({
          success: false,
          error: 'Campaign not found'
        });
      }
      
      const [count, subscribers] = await Promise.all([
        campaign.getEligibleCount(),
        campaign.getEligibleSubscribers({ limit: parseInt(limit) })
      ]);
      
      res.json({
        success: true,
        totalEligible: count,
        preview: subscribers,
        previewCount: subscribers.length
      });
      
    } catch (error) {
      console.error('❌ Preview Audience Error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },
  
  // ==================== SEND TEST SMS ====================
  
  /**
   * POST /api/sms/campaigns/:id/test
   * Send test SMS to specified phone number
   */
  async sendTest(req, res) {
    try {
      const { phone } = req.body;
      
      if (!phone) {
        return res.status(400).json({
          success: false,
          error: 'Phone number is required'
        });
      }
      
      const campaign = await SmsCampaign.findById(req.params.id);
      
      if (!campaign) {
        return res.status(404).json({
          success: false,
          error: 'Campaign not found'
        });
      }
      
      // Format phone
      const formattedPhone = telnyxService.formatPhoneNumber(phone);
      if (!formattedPhone) {
        return res.status(400).json({
          success: false,
          error: 'Invalid phone number'
        });
      }
      
      // Build test message with [TEST] prefix
      let testMessage = `[TEST] ${campaign.message}`;
      
      // Send SMS
      const result = await telnyxService.sendSms(formattedPhone, testMessage);
      
      if (result.success) {
        // Record test send
        await campaign.addTestSms(formattedPhone, result.messageId, result.status);
        
        console.log(`📱 Test SMS sent for campaign ${campaign.name} to ${formattedPhone}`);
        
        res.json({
          success: true,
          message: 'Test SMS sent successfully',
          messageId: result.messageId,
          phone: formattedPhone,
          segments: campaign.segments
        });
      } else {
        res.status(400).json({
          success: false,
          error: result.error || 'Failed to send test SMS'
        });
      }
      
    } catch (error) {
      console.error('❌ Send Test SMS Error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },
  
  // ==================== SEND CAMPAIGN ====================
  
  /**
   * POST /api/sms/campaigns/:id/send
   * Start sending campaign immediately
   */
  async send(req, res) {
    try {
      const campaign = await SmsCampaign.findById(req.params.id);
      
      if (!campaign) {
        return res.status(404).json({
          success: false,
          error: 'Campaign not found'
        });
      }
      
      if (!['draft', 'scheduled'].includes(campaign.status)) {
        return res.status(400).json({
          success: false,
          error: `Cannot send campaign with status: ${campaign.status}`
        });
      }
      
      // Get eligible subscribers
      const subscribers = await campaign.getEligibleSubscribers();
      
      if (subscribers.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No eligible subscribers for this campaign'
        });
      }
      
      // Update campaign status
      campaign.status = 'sending';
      campaign.startedAt = new Date();
      campaign.stats.eligible = subscribers.length;
      campaign.stats.queued = subscribers.length;
      await campaign.save();
      
      // Create SmsMessage records for each subscriber
      const messages = subscribers.map(sub => ({
        campaign: campaign._id,
        subscriber: sub._id,
        phone: sub.phone,
        message: campaign.message,
        segments: campaign.segments,
        discountCode: campaign.discountCode || sub.discountCode,
        status: 'pending'
      }));
      
      await SmsMessage.insertMany(messages, { ordered: false });
      
      console.log(`📱 SMS Campaign ${campaign.name} started - ${subscribers.length} messages queued`);
      
      // Start background processing
      processCampaignQueue(campaign._id);
      
      res.json({
        success: true,
        message: 'Campaign sending started',
        totalQueued: subscribers.length,
        campaignId: campaign._id
      });
      
    } catch (error) {
      console.error('❌ Send Campaign Error:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },
  
  // ==================== PAUSE/RESUME CAMPAIGN ====================
  
  /**
   * POST /api/sms/campaigns/:id/pause
   */
  async pause(req, res) {
    try {
      const campaign = await SmsCampaign.findById(req.params.id);
      
      if (!campaign) {
        return res.status(404).json({ success: false, error: 'Campaign not found' });
      }
      
      if (campaign.status !== 'sending') {
        return res.status(400).json({ success: false, error: 'Campaign is not sending' });
      }
      
      campaign.status = 'paused';
      await campaign.save();
      
      res.json({ success: true, message: 'Campaign paused' });
      
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
  
  /**
   * POST /api/sms/campaigns/:id/resume
   */
  async resume(req, res) {
    try {
      const campaign = await SmsCampaign.findById(req.params.id);
      
      if (!campaign) {
        return res.status(404).json({ success: false, error: 'Campaign not found' });
      }
      
      if (campaign.status !== 'paused') {
        return res.status(400).json({ success: false, error: 'Campaign is not paused' });
      }
      
      campaign.status = 'sending';
      await campaign.save();
      
      // Resume processing
      processCampaignQueue(campaign._id);
      
      res.json({ success: true, message: 'Campaign resumed' });
      
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
  
  // ==================== CANCEL CAMPAIGN ====================
  
  /**
   * POST /api/sms/campaigns/:id/cancel
   */
  async cancel(req, res) {
    try {
      const campaign = await SmsCampaign.findById(req.params.id);
      
      if (!campaign) {
        return res.status(404).json({ success: false, error: 'Campaign not found' });
      }
      
      if (!['sending', 'paused', 'scheduled'].includes(campaign.status)) {
        return res.status(400).json({ 
          success: false, 
          error: 'Cannot cancel campaign with status: ' + campaign.status 
        });
      }
      
      // Delete pending messages
      const deleted = await SmsMessage.deleteMany({
        campaign: campaign._id,
        status: 'pending'
      });
      
      campaign.status = 'cancelled';
      await campaign.save();
      
      res.json({
        success: true,
        message: 'Campaign cancelled',
        pendingDeleted: deleted.deletedCount
      });
      
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
  
  // ==================== GET CAMPAIGN STATS ====================
  
  /**
   * GET /api/sms/campaigns/:id/stats
   * Detailed campaign statistics
   */
  async getStats(req, res) {
    try {
      const campaign = await SmsCampaign.findById(req.params.id);
      
      if (!campaign) {
        return res.status(404).json({ success: false, error: 'Campaign not found' });
      }
      
      // Get fresh message stats
      const messageStats = await SmsMessage.getCampaignStats(campaign._id);
      
      // Update campaign stats
      Object.assign(campaign.stats, {
        sent: messageStats.sent + messageStats.delivered + messageStats.queued,
        delivered: messageStats.delivered,
        failed: messageStats.failed,
        totalCost: messageStats.totalCost
      });
      
      campaign.updateRates();
      await campaign.save();
      
      // Get recent conversions
      const recentConversions = await SmsMessage.find({
        campaign: campaign._id,
        converted: true
      })
      .sort({ convertedAt: -1 })
      .limit(10)
      .select('phone conversionData convertedAt')
      .lean();
      
      res.json({
        success: true,
        stats: campaign.stats,
        messageBreakdown: messageStats,
        recentConversions
      });
      
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },
  
  // ==================== TRACK CLICK ====================
  
  /**
   * GET /api/sms/click/:campaignId/:messageId
   * Track link click and redirect
   */
  async trackClick(req, res) {
    try {
      const { campaignId, messageId } = req.params;
      const { url } = req.query;
      
      // Find the message
      const message = await SmsMessage.findOne({
        campaign: campaignId,
        _id: messageId
      });
      
      if (message && !message.clicked) {
        await message.recordClick({
          url: url || 'direct',
          userAgent: req.headers['user-agent'],
          ip: req.ip
        });
        
        console.log(`📱 SMS Click tracked: Campaign ${campaignId}`);
      }
      
      // Get campaign for redirect URL
      const campaign = await SmsCampaign.findById(campaignId);
      const redirectUrl = url || campaign?.trackingUrl || 'https://jerseypickles.com';
      
      res.redirect(redirectUrl);
      
    } catch (error) {
      console.error('❌ Track Click Error:', error);
      res.redirect('https://jerseypickles.com');
    }
  },
  
  // ==================== CLICK STATS ====================

  /**
   * GET /api/sms/campaigns/:id/clicks
   * Get click statistics for a campaign
   */
  async getClickStats(req, res) {
    try {
      const campaign = await SmsCampaign.findById(req.params.id);

      if (!campaign) {
        return res.status(404).json({ success: false, error: 'Campaign not found' });
      }

      const clickStats = await urlShortenerService.getCampaignClickStats(campaign._id);

      // Also get click count from messages
      const messageClickStats = await SmsMessage.aggregate([
        { $match: { campaign: campaign._id } },
        {
          $group: {
            _id: null,
            totalMessages: { $sum: 1 },
            clicked: { $sum: { $cond: ['$clicked', 1, 0] } }
          }
        }
      ]);

      const messageStats = messageClickStats[0] || { totalMessages: 0, clicked: 0 };

      res.json({
        success: true,
        campaignId: campaign._id,
        campaignName: campaign.name,
        clicks: {
          total: clickStats.totalClicks || 0,
          unique: clickStats.uniqueClicks || 0,
          messagesClicked: messageStats.clicked,
          ctr: messageStats.totalMessages > 0
            ? ((messageStats.clicked / messageStats.totalMessages) * 100).toFixed(1)
            : '0'
        },
        topUrls: clickStats.topUrls || [],
        timeline: clickStats.timeline || [],
        conversions: clickStats.converted || 0
      });

    } catch (error) {
      console.error('❌ Get Click Stats Error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  },

  // ==================== OVERALL STATS ====================

  /**
   * GET /api/sms/campaigns/stats/overview
   * Overall SMS campaign statistics
   */
  async getOverview(req, res) {
    try {
      const { days = 30 } = req.query;

      const summary = await SmsCampaign.getStatsSummary(parseInt(days));

      // Get campaign counts by status
      const statusCounts = await SmsCampaign.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);

      const byStatus = {};
      statusCounts.forEach(s => { byStatus[s._id] = s.count; });

      res.json({
        success: true,
        summary,
        byStatus,
        period: `${days} days`
      });

    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  },

  // ==================== SET DISCOUNT CODE ====================

  /**
   * PUT /api/sms/campaigns/:id/discount-code
   * Set/update discount code for tracking conversions (works on any status)
   * This extracts the discount code from message if not provided
   */
  async setDiscountCode(req, res) {
    try {
      const campaign = await SmsCampaign.findById(req.params.id);

      if (!campaign) {
        return res.status(404).json({
          success: false,
          error: 'Campaign not found'
        });
      }

      let { discountCode, discountPercent } = req.body;

      // If no discountCode provided, try to extract from message
      if (!discountCode && campaign.message) {
        // Common patterns: "Use CODE for", "code: CODE", "CODE for X% off"
        const patterns = [
          /(?:use|code:?|with)\s+([A-Z0-9_-]{3,20})\s+(?:for|to get)/i,
          /([A-Z0-9_-]{3,20})\s+(?:for|to get)\s+\d+%/i,
          /code[:\s]+([A-Z0-9_-]{3,20})/i
        ];

        for (const pattern of patterns) {
          const match = campaign.message.match(pattern);
          if (match) {
            discountCode = match[1].toUpperCase();
            console.log(`📱 Extracted discount code from message: ${discountCode}`);
            break;
          }
        }
      }

      if (!discountCode) {
        return res.status(400).json({
          success: false,
          error: 'Could not extract discount code from message. Please provide discountCode in request body.'
        });
      }

      // Update campaign
      campaign.discountCode = discountCode.toUpperCase();
      if (discountPercent !== undefined) {
        campaign.discountPercent = discountPercent;
      }

      await campaign.save();

      console.log(`📱 Campaign ${campaign.name} discount code set to: ${campaign.discountCode}`);

      res.json({
        success: true,
        message: `Discount code set to ${campaign.discountCode}`,
        campaign: {
          _id: campaign._id,
          name: campaign.name,
          discountCode: campaign.discountCode,
          discountPercent: campaign.discountPercent,
          status: campaign.status
        }
      });

    } catch (error) {
      console.error('❌ Set Discount Code Error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  },

  // ==================== REPROCESS CONVERSIONS ====================

  /**
   * POST /api/sms/campaigns/:id/reprocess-conversions
   * Re-scan Shopify orders to find conversions for this campaign's discount code
   */
  async reprocessConversions(req, res) {
    try {
      const campaign = await SmsCampaign.findById(req.params.id);

      if (!campaign) {
        return res.status(404).json({
          success: false,
          error: 'Campaign not found'
        });
      }

      if (!campaign.discountCode) {
        return res.status(400).json({
          success: false,
          error: 'Campaign has no discount code set. Use PUT /discount-code first.'
        });
      }

      const { days = 7 } = req.query;
      const Order = require('../models/Order');

      // Find orders that used this discount code
      const startDate = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);

      const orders = await Order.find({
        createdAt: { $gte: startDate },
        'shopifyData.discount_codes.code': { $regex: new RegExp(`^${campaign.discountCode}$`, 'i') }
      }).lean();

      console.log(`📱 Found ${orders.length} orders with code ${campaign.discountCode} in last ${days} days`);

      let conversionsTracked = 0;
      let alreadyTracked = 0;
      let totalRevenue = 0;

      for (const order of orders) {
        // Check if already converted in SmsMessage
        const existingMessage = await SmsMessage.findOne({
          campaign: campaign._id,
          converted: true,
          'conversionData.orderId': order.shopifyOrderId?.toString() || order.shopifyData?.id?.toString()
        });

        if (existingMessage) {
          alreadyTracked++;
          continue;
        }

        // Find the subscriber who received this campaign
        const customerPhone = formatPhoneForConversion(
          order.shopifyData?.phone ||
          order.shopifyData?.customer?.phone ||
          order.shopifyData?.shipping_address?.phone ||
          order.shopifyData?.billing_address?.phone
        );

        if (!customerPhone) continue;

        const message = await SmsMessage.findOne({
          campaign: campaign._id,
          phone: customerPhone,
          converted: false
        });

        if (message) {
          const orderTotal = parseFloat(order.total || order.shopifyData?.total_price || 0);
          const discountAmount = order.shopifyData?.discount_codes?.find(
            d => d.code?.toUpperCase() === campaign.discountCode
          )?.amount || 0;

          await message.recordConversion({
            orderId: order.shopifyOrderId?.toString() || order.shopifyData?.id?.toString(),
            orderNumber: order.orderNumber || order.shopifyData?.order_number,
            orderTotal: orderTotal,
            discountAmount: parseFloat(discountAmount)
          });

          conversionsTracked++;
          totalRevenue += orderTotal;

          console.log(`   ✅ Tracked conversion: Order #${order.orderNumber} - $${orderTotal}`);
        }
      }

      // Update campaign stats
      campaign.updateRates();
      await campaign.save();

      res.json({
        success: true,
        message: `Reprocessed conversions for ${campaign.name}`,
        results: {
          ordersFound: orders.length,
          newConversions: conversionsTracked,
          alreadyTracked: alreadyTracked,
          totalRevenue: totalRevenue.toFixed(2),
          daysScanned: parseInt(days)
        },
        campaignStats: campaign.stats
      });

    } catch (error) {
      console.error('❌ Reprocess Conversions Error:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
};

// Helper function for phone formatting
function formatPhoneForConversion(phone) {
  if (!phone) return null;

  let cleaned = phone.toString().replace(/\D/g, '');

  if (cleaned.startsWith('1') && cleaned.length === 11) {
    return '+' + cleaned;
  }

  if (cleaned.length === 10) {
    return '+1' + cleaned;
  }

  if (cleaned.startsWith('+')) {
    return cleaned;
  }

  return null;
}

// ==================== BACKGROUND QUEUE PROCESSOR ====================

/**
 * Process SMS queue for a campaign
 * Sends ~1 SMS per second to respect rate limits
 */
async function processCampaignQueue(campaignId) {
  console.log(`📱 Starting queue processor for campaign ${campaignId}`);
  
  const BATCH_SIZE = 50;
  const DELAY_BETWEEN_SMS = 1100; // 1.1 seconds (safe rate limit)
  
  try {
    while (true) {
      // Check campaign status
      const campaign = await SmsCampaign.findById(campaignId);
      
      if (!campaign || campaign.status !== 'sending') {
        console.log(`📱 Campaign ${campaignId} stopped: ${campaign?.status || 'not found'}`);
        break;
      }
      
      // Get pending messages
      const pendingMessages = await SmsMessage.getPendingForCampaign(campaignId, BATCH_SIZE);
      
      if (pendingMessages.length === 0) {
        // No more messages - campaign complete
        campaign.status = 'sent';
        campaign.completedAt = new Date();
        campaign.updateRates();
        await campaign.save();
        
        console.log(`✅ SMS Campaign ${campaign.name} completed`);
        break;
      }
      
      // Process each message
      for (const msg of pendingMessages) {
        // Re-check campaign status
        const currentStatus = await SmsCampaign.findById(campaignId).select('status');
        if (currentStatus?.status !== 'sending') {
          console.log(`📱 Campaign paused/cancelled during processing`);
          return;
        }

        try {
          // Process URLs in message - replace with short URLs for tracking
          let finalMessage = msg.message;
          try {
            const { processedMessage } = await urlShortenerService.processMessageUrls(
              msg.message,
              {
                sourceType: 'sms_campaign',
                campaignId: campaignId,
                subscriberId: msg.subscriber,
                messageId: msg._id,
                discountCode: msg.discountCode
              }
            );
            finalMessage = processedMessage;
          } catch (urlError) {
            console.log(`⚠️ URL shortening failed, using original message:`, urlError.message);
          }

          // Send SMS with processed message
          const result = await telnyxService.sendSms(msg.phone, finalMessage);

          // Update message record
          await SmsMessage.findByIdAndUpdate(msg._id, {
            status: result.success ? 'queued' : 'failed',
            messageId: result.messageId,
            message: finalMessage, // Store the processed message
            queuedAt: result.success ? new Date() : undefined,
            failedAt: result.success ? undefined : new Date(),
            errorMessage: result.error,
            carrier: result.carrier
          });

          // Update campaign stats
          if (result.success) {
            await SmsCampaign.findByIdAndUpdate(campaignId, {
              $inc: { 'stats.sent': 1, 'stats.queued': -1 }
            });
          } else {
            await SmsCampaign.findByIdAndUpdate(campaignId, {
              $inc: { 'stats.failed': 1, 'stats.queued': -1 }
            });
          }

        } catch (error) {
          console.error(`❌ Error sending SMS to ${msg.phone}:`, error.message);

          await SmsMessage.findByIdAndUpdate(msg._id, {
            status: 'failed',
            failedAt: new Date(),
            errorMessage: error.message
          });

          await SmsCampaign.findByIdAndUpdate(campaignId, {
            $inc: { 'stats.failed': 1, 'stats.queued': -1 }
          });
        }

        // Rate limit delay
        await sleep(DELAY_BETWEEN_SMS);
      }
    }
    
  } catch (error) {
    console.error(`❌ Queue processor error for campaign ${campaignId}:`, error);
    
    // Mark campaign as failed
    await SmsCampaign.findByIdAndUpdate(campaignId, {
      status: 'failed',
      notes: `Queue processor error: ${error.message}`
    });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = smsCampaignController;