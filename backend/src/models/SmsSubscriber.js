// backend/src/models/SmsSubscriber.js
// 📱 SMS Subscriber Model - Con Second Chance SMS Support
const mongoose = require('mongoose');

const smsSubscriberSchema = new mongoose.Schema({
  // ==================== CONTACT INFO ====================
  phone: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  phoneFormatted: {
    type: String // +1 (555) 123-4567 format for display
  },
  countryCode: {
    type: String,
    default: 'US'
  },
  
  // ==================== STATUS ====================
  status: {
    type: String,
    enum: ['active', 'unsubscribed', 'bounced', 'invalid'],
    default: 'active',
    index: true
  },
  
  // ==================== SOURCE ====================
  source: {
    type: String,
    enum: ['popup', 'checkout', 'manual', 'import', 'landing_page', 'website-popup-sms', 'api', 'test'],
    default: 'popup'
  },
  sourceUrl: String,
  ipAddress: String,
  userAgent: String,

  // ==================== GEOLOCATION (IP-based) ====================
  location: {
    country: { type: String, default: 'United States' },
    countryCode: { type: String, default: 'US' },
    region: String,        // State code (e.g., 'NJ')
    regionName: String,    // Full state name (e.g., 'New Jersey')
    city: String,
    zip: String,
    lat: Number,
    lng: Number,
    timezone: { type: String, default: 'America/New_York' },
    source: { type: String, enum: ['ip-api', 'manual', 'default'], default: 'default' },
    resolvedAt: Date
  },
  
  // ==================== FIRST SMS (15% OFF) ====================
  welcomeSmsSent: {
    type: Boolean,
    default: false
  },
  welcomeSmsAt: {
    type: Date
  },
  // Alias for backwards compatibility
  welcomeSmsSentAt: {
    type: Date
  },
  welcomeSmsStatus: {
    type: String,
    enum: ['pending', 'queued', 'sending', 'sent', 'delivered', 'failed', 'undelivered'],
    default: 'pending'
  },
  welcomeSmsMessageId: {
    type: String // Telnyx message ID
  },
  welcomeSmsError: {
    type: String
  },
  
  // First discount code (15% OFF)
  discountCode: {
    type: String,
    unique: true,
    sparse: true
  },
  discountPercent: {
    type: Number,
    default: 15
  },
  shopifyPriceRuleId: {
    type: String
  },
  shopifyDiscountCodeId: {
    type: String
  },
  
  // ==================== SECOND CHANCE SMS (20% OFF) ====================
  secondSmsSent: {
    type: Boolean,
    default: false
  },
  secondSmsAt: {
    type: Date
  },
  secondSmsStatus: {
    type: String,
    enum: ['pending', 'queued', 'sending', 'sent', 'delivered', 'failed', 'undelivered']
  },
  secondSmsMessageId: {
    type: String // Telnyx message ID
  },
  secondSmsError: {
    type: String
  },
  secondSmsScheduledFor: {
    type: Date // When the second SMS should be sent (respecting 9am-9pm)
  },
  
  // Second discount code (20% OFF - expires in 2 hours)
  secondDiscountCode: {
    type: String,
    unique: true,
    sparse: true
  },
  secondDiscountPercent: {
    type: Number,
    default: 20
  },
  secondShopifyPriceRuleId: {
    type: String
  },
  secondShopifyDiscountCodeId: {
    type: String
  },
  secondDiscountExpiresAt: {
    type: Date // Exact expiration time (2 hours from send)
  },
  
  // ==================== CONVERSION TRACKING ====================
  converted: {
    type: Boolean,
    default: false,
    index: true
  },
  convertedAt: {
    type: Date
  },
  convertedWith: {
    type: String,
    enum: ['first', 'second', null],
    default: null
  },
  conversionData: {
    orderId: String,
    orderNumber: String,
    orderTotal: Number,
    subtotal: Number,
    discountAmount: Number,
    discountCodeUsed: String, // Which code they actually used
    currency: { type: String, default: 'USD' },
    convertedAt: Date,
    timeToConvert: Number, // minutes
    products: [{
      productId: String,
      variantId: String,
      title: String,
      quantity: Number,
      price: Number
    }],
    itemCount: Number,
    customerEmail: String,
    shippingAddress: {
      city: String,
      province: String,
      country: String,
      zip: String
    }
  },
  
  // Time from subscription to conversion (in minutes)
  timeToConvert: {
    type: Number
  },
  
  // ==================== CARRIER INFO ====================
  carrier: {
    type: String
  },
  lineType: {
    type: String,
    enum: ['mobile', 'wireless', 'landline', 'voip', 'unknown'],
    default: 'unknown'
  },
  
  // ==================== ENGAGEMENT ====================
  lastEngagedAt: {
    type: Date
  },
  lastSmsAt: {
    type: Date
  },
  totalSmsSent: {
    type: Number,
    default: 0
  },
  totalSmsReceived: {
    type: Number,
    default: 0
  },
  totalSmsDelivered: {
    type: Number,
    default: 0
  },
  totalSmsFailed: {
    type: Number,
    default: 0
  },
  
  // ==================== UNSUBSCRIBE ====================
  subscribedAt: {
    type: Date,
    default: Date.now
  },
  unsubscribedAt: {
    type: Date
  },
  unsubscribeReason: {
    type: String,
    enum: ['stop_keyword', 'too_many_texts', 'not_interested', 'didnt_signup', 'prices_high', 'shipping_issues', 'found_elsewhere', 'other', 'manual', 'carrier_block', null],
    default: null
  },
  // Additional unsubscribe analytics
  unsubscribeSource: {
    type: String,
    enum: ['reply_stop', 'manual', 'complaint', 'carrier_block', 'api', null],
    default: null
  },
  unsubscribeAfterSms: {
    type: String,
    enum: ['welcome', 'second_chance', 'campaign', 'none', null],
    default: null
  },
  timeToUnsubscribe: {
    type: Number // Minutes from subscription to unsubscribe
  },
  smsCountBeforeUnsub: {
    type: Number // How many SMS received before unsubscribing
  },
  unsubscribeFeedback: {
    type: String // Optional text feedback from user
  },
  unsubscribeKeyword: {
    type: String // The exact keyword used (STOP, UNSUBSCRIBE, etc.)
  },
  unsubscribeCampaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SmsCampaign',
    default: null
  },

  // ==================== PENDING UNSUBSCRIBE (Two-step STOP) ====================
  pendingUnsubscribe: {
    type: Boolean,
    default: false
  },
  pendingUnsubscribeAt: {
    type: Date // When first STOP was received
  },
  pendingUnsubscribeExpires: {
    type: Date // Auto-cancel pending after 10 minutes
  }

}, {
  timestamps: true
});

// ==================== INDEXES ====================
smsSubscriberSchema.index({ status: 1, converted: 1 });
smsSubscriberSchema.index({ welcomeSmsStatus: 1, converted: 1, secondSmsSent: 1 });
smsSubscriberSchema.index({ secondSmsScheduledFor: 1, secondSmsSent: 1 });
smsSubscriberSchema.index({ createdAt: -1 });
smsSubscriberSchema.index({ convertedWith: 1 });
smsSubscriberSchema.index({ 'conversionData.convertedAt': -1 });
// Geolocation indexes for map analytics
smsSubscriberSchema.index({ 'location.region': 1, status: 1 });
smsSubscriberSchema.index({ 'location.city': 1, 'location.region': 1 });
smsSubscriberSchema.index({ unsubscribeCampaignId: 1, status: 1 });

// ==================== VIRTUALS ====================

// Check if eligible for second SMS
// Now uses 6 hours - strike while they still remember!
smsSubscriberSchema.virtual('eligibleForSecondSms').get(function() {
  if (this.converted) return false;
  if (this.secondSmsSent) return false;
  if (this.status !== 'active') return false;
  if (this.welcomeSmsStatus !== 'delivered') return false;

  // Must be between 6-24 hours since first SMS (sweet spot for recovery)
  const smsTime = this.welcomeSmsAt || this.welcomeSmsSentAt;
  if (!smsTime) return false;

  const hoursSinceFirst = (Date.now() - new Date(smsTime).getTime()) / (1000 * 60 * 60);

  return hoursSinceFirst >= 6 && hoursSinceFirst <= 24;
});

// Conversion status label for frontend
smsSubscriberSchema.virtual('conversionStatus').get(function() {
  // Legacy data (converted sin convertedWith) se trata como 'first'
  if (this.converted && this.convertedWith === 'second') return 'recovered';
  if (this.converted) return 'converted'; // first o legacy
  if (this.secondSmsSent && !this.converted) return 'no_conversion';
  if (!this.secondSmsSent && this.eligibleForSecondSms) return 'pending_second';
  if (!this.converted) return 'waiting';
  return 'unknown';
});

// ==================== PRE-SAVE MIDDLEWARE ====================

// Sync welcomeSmsAt and welcomeSmsSentAt for backwards compatibility
smsSubscriberSchema.pre('save', function(next) {
  if (this.welcomeSmsAt && !this.welcomeSmsSentAt) {
    this.welcomeSmsSentAt = this.welcomeSmsAt;
  } else if (this.welcomeSmsSentAt && !this.welcomeSmsAt) {
    this.welcomeSmsAt = this.welcomeSmsSentAt;
  }
  next();
});

// ==================== STATICS ====================

// Find subscribers eligible for second chance SMS
// Now uses 6-24 hour window - strike while they still remember!
smsSubscriberSchema.statics.findEligibleForSecondSms = function(limit = 50) {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  return this.find({
    status: 'active',
    converted: false,
    secondSmsSent: { $ne: true },
    welcomeSmsStatus: 'delivered',
    $or: [
      { welcomeSmsAt: { $lte: sixHoursAgo, $gte: twentyFourHoursAgo } },
      { welcomeSmsSentAt: { $lte: sixHoursAgo, $gte: twentyFourHoursAgo } }
    ]
  })
  .sort({ welcomeSmsAt: 1, welcomeSmsSentAt: 1 }) // Oldest first
  .limit(limit);
};

// Find subscribers with scheduled second SMS ready to send
smsSubscriberSchema.statics.findScheduledSecondSms = function(limit = 50) {
  const now = new Date();
  
  return this.find({
    status: 'active',
    converted: false,
    secondSmsSent: { $ne: true },
    secondSmsScheduledFor: { $lte: now }
  })
  .sort({ secondSmsScheduledFor: 1 })
  .limit(limit);
};

// Get subscribers by US state for map visualization
smsSubscriberSchema.statics.getSubscribersByState = async function(days = 30) {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  return this.aggregate([
    {
      $match: {
        'location.countryCode': 'US',
        'location.region': { $exists: true, $ne: null },
        createdAt: { $gte: startDate }
      }
    },
    {
      $group: {
        _id: '$location.region',
        count: { $sum: 1 },
        converted: { $sum: { $cond: ['$converted', 1, 0] } },
        revenue: { $sum: { $ifNull: ['$conversionData.orderTotal', 0] } },
        cities: { $addToSet: '$location.city' }
      }
    },
    {
      $project: {
        _id: 0,
        state: '$_id',
        subscribers: '$count',
        converted: 1,
        revenue: 1,
        conversionRate: {
          $cond: [
            { $gt: ['$count', 0] },
            { $multiply: [{ $divide: ['$converted', '$count'] }, 100] },
            0
          ]
        },
        topCities: { $slice: ['$cities', 5] }
      }
    },
    { $sort: { subscribers: -1 } }
  ]);
};

// Get recent activity for live feed
smsSubscriberSchema.statics.getRecentActivity = async function(limit = 20, since = null) {
  const query = {};

  if (since) {
    query.$or = [
      { createdAt: { $gt: new Date(since) } },
      { convertedAt: { $gt: new Date(since) } },
      { welcomeSmsAt: { $gt: new Date(since) } },
      { secondSmsAt: { $gt: new Date(since) } }
    ];
  }

  const subscribers = await this.find(query)
    .sort({ createdAt: -1 })
    .limit(limit * 2) // Get more to filter
    .select('phone phoneFormatted status createdAt location converted convertedAt convertedWith welcomeSmsAt welcomeSmsStatus secondSmsAt secondSmsStatus conversionData.orderTotal discountCode secondDiscountCode')
    .lean();

  // Transform to activity events
  const activities = [];

  for (const sub of subscribers) {
    // Subscription event
    if (sub.createdAt) {
      activities.push({
        type: 'subscription',
        timestamp: sub.createdAt,
        phone: sub.phoneFormatted || sub.phone?.slice(-4),
        location: sub.location ? {
          city: sub.location.city,
          state: sub.location.region,
          stateName: sub.location.regionName
        } : null,
        data: { status: sub.status }
      });
    }

    // Conversion event
    if (sub.converted && sub.convertedAt) {
      activities.push({
        type: 'conversion',
        timestamp: sub.convertedAt,
        phone: sub.phoneFormatted || sub.phone?.slice(-4),
        location: sub.location ? {
          city: sub.location.city,
          state: sub.location.region,
          stateName: sub.location.regionName
        } : null,
        data: {
          convertedWith: sub.convertedWith,
          orderTotal: sub.conversionData?.orderTotal,
          discountCode: sub.convertedWith === 'second' ? sub.secondDiscountCode : sub.discountCode
        }
      });
    }

    // Welcome SMS sent
    if (sub.welcomeSmsAt && sub.welcomeSmsStatus === 'delivered') {
      activities.push({
        type: 'welcome_sms',
        timestamp: sub.welcomeSmsAt,
        phone: sub.phoneFormatted || sub.phone?.slice(-4),
        location: sub.location ? {
          city: sub.location.city,
          state: sub.location.region
        } : null,
        data: { status: sub.welcomeSmsStatus }
      });
    }

    // Second chance SMS sent
    if (sub.secondSmsAt && sub.secondSmsStatus === 'delivered') {
      activities.push({
        type: 'second_chance_sms',
        timestamp: sub.secondSmsAt,
        phone: sub.phoneFormatted || sub.phone?.slice(-4),
        location: sub.location ? {
          city: sub.location.city,
          state: sub.location.region
        } : null,
        data: { status: sub.secondSmsStatus }
      });
    }
  }

  // Sort by timestamp and limit
  return activities
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, limit);
};

// Get conversion stats breakdown
smsSubscriberSchema.statics.getConversionBreakdown = async function() {
  const stats = await this.aggregate([
    {
      $facet: {
        total: [{ $count: 'count' }],
        active: [{ $match: { status: 'active' } }, { $count: 'count' }],
        
        // First SMS stats
        firstSmsDelivered: [
          { $match: { welcomeSmsStatus: 'delivered' } },
          { $count: 'count' }
        ],
        
        // Second SMS stats
        secondSmsSent: [
          { $match: { secondSmsSent: true } },
          { $count: 'count' }
        ],
        secondSmsDelivered: [
          { $match: { secondSmsStatus: 'delivered' } },
          { $count: 'count' }
        ],
        pendingSecondSms: [
          { 
            $match: { 
              status: 'active',
              converted: false, 
              secondSmsSent: { $ne: true },
              welcomeSmsStatus: 'delivered'
            } 
          },
          { $count: 'count' }
        ],
        
        // Conversion breakdown - INCLUIR LEGACY (sin convertedWith) como first
        convertedFirst: [
          { 
            $match: { 
              converted: true,
              $or: [
                { convertedWith: 'first' },
                { convertedWith: { $exists: false } },
                { convertedWith: null }
              ]
            } 
          },
          { $count: 'count' }
        ],
        convertedSecond: [
          { $match: { converted: true, convertedWith: 'second' } },
          { $count: 'count' }
        ],
        totalConverted: [
          { $match: { converted: true } },
          { $count: 'count' }
        ],
        
        // Revenue breakdown - INCLUIR LEGACY en first
        revenueFirst: [
          { 
            $match: { 
              converted: true,
              $or: [
                { convertedWith: 'first' },
                { convertedWith: { $exists: false } },
                { convertedWith: null }
              ]
            } 
          },
          { $group: { _id: null, total: { $sum: '$conversionData.orderTotal' } } }
        ],
        revenueSecond: [
          { $match: { converted: true, convertedWith: 'second' } },
          { $group: { _id: null, total: { $sum: '$conversionData.orderTotal' } } }
        ],
        
        // No conversion after both SMS
        noConversion: [
          { 
            $match: { 
              converted: false, 
              secondSmsSent: true,
              secondSmsStatus: 'delivered'
            } 
          },
          { $count: 'count' }
        ]
      }
    }
  ]);
  
  const s = stats[0];
  
  return {
    total: s.total[0]?.count || 0,
    active: s.active[0]?.count || 0,
    
    firstSms: {
      delivered: s.firstSmsDelivered[0]?.count || 0
    },
    
    secondSms: {
      sent: s.secondSmsSent[0]?.count || 0,
      delivered: s.secondSmsDelivered[0]?.count || 0,
      pending: s.pendingSecondSms[0]?.count || 0
    },
    
    conversions: {
      total: s.totalConverted[0]?.count || 0,
      first: s.convertedFirst[0]?.count || 0,
      second: s.convertedSecond[0]?.count || 0,
      none: s.noConversion[0]?.count || 0
    },
    
    revenue: {
      total: (s.revenueFirst[0]?.total || 0) + (s.revenueSecond[0]?.total || 0),
      first: s.revenueFirst[0]?.total || 0,
      second: s.revenueSecond[0]?.total || 0
    }
  };
};

// ==================== METHODS ====================

// Record conversion
smsSubscriberSchema.methods.recordConversion = function(orderData, whichCode) {
  this.converted = true;
  this.convertedAt = new Date();
  this.convertedWith = whichCode; // 'first' or 'second'
  this.conversionData = {
    orderId: orderData.orderId,
    orderNumber: orderData.orderNumber,
    orderTotal: orderData.orderTotal,
    discountAmount: orderData.discountAmount,
    discountCodeUsed: orderData.discountCode
  };
  
  // Calculate time to convert
  const startTime = this.createdAt;
  this.timeToConvert = Math.round((this.convertedAt - startTime) / (1000 * 60));
  
  return this.save();
};

// Schedule second SMS respecting quiet hours
smsSubscriberSchema.methods.scheduleSecondSms = function() {
  const now = new Date();
  const currentHour = now.getHours();
  
  let scheduledTime;
  
  // If current time is within allowed hours (9am - 9pm)
  if (currentHour >= 9 && currentHour < 21) {
    // Send now (or within minutes)
    scheduledTime = new Date(now.getTime() + 60000); // 1 minute from now
  } else {
    // Schedule for 9am next day (or same day if before 9am)
    scheduledTime = new Date(now);
    
    if (currentHour >= 21) {
      // After 9pm, schedule for 9am tomorrow
      scheduledTime.setDate(scheduledTime.getDate() + 1);
    }
    // If before 9am, schedule for 9am today
    
    scheduledTime.setHours(9, 0, 0, 0);
  }
  
  this.secondSmsScheduledFor = scheduledTime;
  return this.save();
};

// ==================== UNSUBSCRIBE ANALYTICS ====================

// Get comprehensive unsubscribe analytics
smsSubscriberSchema.statics.getUnsubscribeAnalytics = async function(dateRange = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - dateRange);

  const stats = await this.aggregate([
    {
      $facet: {
        // Total subscribers and unsubscribes
        totals: [
          {
            $group: {
              _id: null,
              totalSubscribers: { $sum: 1 },
              totalUnsubscribed: {
                $sum: { $cond: [{ $eq: ['$status', 'unsubscribed'] }, 1, 0] }
              },
              activeSubscribers: {
                $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] }
              }
            }
          }
        ],

        // Recent unsubscribes in date range
        recentUnsubscribes: [
          {
            $match: {
              status: 'unsubscribed',
              unsubscribedAt: { $gte: startDate }
            }
          },
          { $count: 'count' }
        ],

        // Unsubscribe by reason
        byReason: [
          {
            $match: { status: 'unsubscribed' }
          },
          {
            $group: {
              _id: '$unsubscribeReason',
              count: { $sum: 1 }
            }
          },
          { $sort: { count: -1 } }
        ],

        // Unsubscribe by source
        bySource: [
          {
            $match: { status: 'unsubscribed' }
          },
          {
            $group: {
              _id: '$unsubscribeSource',
              count: { $sum: 1 }
            }
          },
          { $sort: { count: -1 } }
        ],

        // Unsubscribe after which SMS
        byTriggerSms: [
          {
            $match: { status: 'unsubscribed' }
          },
          {
            $group: {
              _id: '$unsubscribeAfterSms',
              count: { $sum: 1 }
            }
          },
          { $sort: { count: -1 } }
        ],

        // Average time to unsubscribe
        avgTimeToUnsub: [
          {
            $match: {
              status: 'unsubscribed',
              timeToUnsubscribe: { $exists: true, $ne: null }
            }
          },
          {
            $group: {
              _id: null,
              avgMinutes: { $avg: '$timeToUnsubscribe' },
              minMinutes: { $min: '$timeToUnsubscribe' },
              maxMinutes: { $max: '$timeToUnsubscribe' }
            }
          }
        ],

        // Average SMS count before unsub
        avgSmsBeforeUnsub: [
          {
            $match: {
              status: 'unsubscribed',
              smsCountBeforeUnsub: { $exists: true, $ne: null }
            }
          },
          {
            $group: {
              _id: null,
              avgCount: { $avg: '$smsCountBeforeUnsub' }
            }
          }
        ],

        // Unsubscribes by day (last 30 days)
        byDay: [
          {
            $match: {
              status: 'unsubscribed',
              unsubscribedAt: { $gte: startDate }
            }
          },
          {
            $group: {
              _id: {
                $dateToString: { format: '%Y-%m-%d', date: '$unsubscribedAt' }
              },
              count: { $sum: 1 }
            }
          },
          { $sort: { _id: 1 } }
        ],

        // Keywords used
        byKeyword: [
          {
            $match: {
              status: 'unsubscribed',
              unsubscribeKeyword: { $exists: true, $ne: null }
            }
          },
          {
            $group: {
              _id: { $toUpper: '$unsubscribeKeyword' },
              count: { $sum: 1 }
            }
          },
          { $sort: { count: -1 } }
        ],

        // Recent feedback
        recentFeedback: [
          {
            $match: {
              status: 'unsubscribed',
              unsubscribeFeedback: { $exists: true, $ne: null, $ne: '' }
            }
          },
          {
            $project: {
              phone: 1,
              feedback: '$unsubscribeFeedback',
              reason: '$unsubscribeReason',
              unsubscribedAt: 1
            }
          },
          { $sort: { unsubscribedAt: -1 } },
          { $limit: 20 }
        ],

        // Churn rate by week
        weeklyChurn: [
          {
            $match: {
              unsubscribedAt: { $gte: startDate }
            }
          },
          {
            $group: {
              _id: {
                week: { $isoWeek: '$unsubscribedAt' },
                year: { $isoWeekYear: '$unsubscribedAt' }
              },
              unsubscribes: { $sum: 1 }
            }
          },
          { $sort: { '_id.year': -1, '_id.week': -1 } },
          { $limit: 4 }
        ],

        // Unsubscribes by campaign
        byCampaign: [
          {
            $match: {
              status: 'unsubscribed',
              unsubscribeCampaignId: { $exists: true, $ne: null }
            }
          },
          {
            $group: {
              _id: '$unsubscribeCampaignId',
              count: { $sum: 1 }
            }
          },
          { $sort: { count: -1 } },
          { $limit: 20 }
        ]
      }
    }
  ]);

  const s = stats[0];
  const totals = s.totals[0] || { totalSubscribers: 0, totalUnsubscribed: 0, activeSubscribers: 0 };

  // Calculate churn rate
  const churnRate = totals.totalSubscribers > 0
    ? ((totals.totalUnsubscribed / totals.totalSubscribers) * 100).toFixed(2)
    : '0.00';

  // Format reasons with labels
  const reasonLabels = {
    stop_keyword: 'Respondió STOP',
    too_many_texts: 'Demasiados mensajes',
    not_interested: 'No interesado',
    didnt_signup: 'No se registró',
    prices_high: 'Precios altos',
    shipping_issues: 'Problemas de envío',
    found_elsewhere: 'Encontró en otro lugar',
    other: 'Otro motivo',
    manual: 'Baja manual',
    carrier_block: 'Bloqueado por operador',
    null: 'Sin especificar'
  };

  const sourceLabels = {
    reply_stop: 'Respondió STOP',
    manual: 'Baja manual',
    complaint: 'Queja/Reporte',
    carrier_block: 'Bloqueado',
    api: 'Vía API',
    null: 'Sin especificar'
  };

  const triggerLabels = {
    welcome: 'SMS de Bienvenida',
    second_chance: 'SMS Second Chance',
    campaign: 'Campaña',
    none: 'Sin SMS previo',
    null: 'Sin especificar'
  };

  return {
    summary: {
      totalSubscribers: totals.totalSubscribers,
      totalUnsubscribed: totals.totalUnsubscribed,
      activeSubscribers: totals.activeSubscribers,
      churnRate: `${churnRate}%`,
      recentUnsubscribes: s.recentUnsubscribes[0]?.count || 0,
      period: `${dateRange} días`
    },

    byReason: s.byReason.map(r => ({
      reason: r._id,
      label: reasonLabels[r._id] || r._id || 'Sin especificar',
      count: r.count,
      percentage: totals.totalUnsubscribed > 0
        ? ((r.count / totals.totalUnsubscribed) * 100).toFixed(1) + '%'
        : '0%'
    })),

    bySource: s.bySource.map(r => ({
      source: r._id,
      label: sourceLabels[r._id] || r._id || 'Sin especificar',
      count: r.count
    })),

    byTriggerSms: s.byTriggerSms.map(r => ({
      trigger: r._id,
      label: triggerLabels[r._id] || r._id || 'Sin especificar',
      count: r.count
    })),

    timing: {
      avgTimeToUnsubscribe: s.avgTimeToUnsub[0] ? {
        minutes: Math.round(s.avgTimeToUnsub[0].avgMinutes),
        hours: (s.avgTimeToUnsub[0].avgMinutes / 60).toFixed(1),
        days: (s.avgTimeToUnsub[0].avgMinutes / 1440).toFixed(1)
      } : null,
      avgSmsBeforeUnsub: s.avgSmsBeforeUnsub[0]?.avgCount
        ? Math.round(s.avgSmsBeforeUnsub[0].avgCount * 10) / 10
        : null
    },

    trends: {
      byDay: s.byDay,
      weeklyChurn: s.weeklyChurn
    },

    keywords: s.byKeyword,

    byCampaign: s.byCampaign || [],

    feedback: s.recentFeedback.map(f => {
      // Clean up feedback text from two-step STOP system
      let cleanFeedback = f.feedback;
      if (cleanFeedback && cleanFeedback.startsWith('Feedback option:')) {
        // Convert "Feedback option: 1 (too_many_texts)" to human-readable
        const feedbackMap = {
          '1': 'Demasiados mensajes',
          '2': 'No me interesa',
          '3': 'Precios muy altos',
          '4': 'Otro motivo'
        };
        const match = cleanFeedback.match(/Feedback option: (\d)/);
        if (match && feedbackMap[match[1]]) {
          cleanFeedback = feedbackMap[match[1]];
        }
      } else if (cleanFeedback === 'Confirmed via second STOP (skipped feedback)') {
        cleanFeedback = 'Saltó la encuesta (doble STOP)';
      }

      return {
        phone: f.phone ? `***${f.phone.slice(-4)}` : 'N/A',
        feedback: cleanFeedback,
        reason: reasonLabels[f.reason] || f.reason,
        date: f.unsubscribedAt
      };
    })
  };
};

// Record unsubscribe with full analytics
smsSubscriberSchema.methods.recordUnsubscribe = async function(data = {}) {
  this.status = 'unsubscribed';
  this.unsubscribedAt = new Date();

  // Calculate time to unsubscribe (in minutes)
  if (this.subscribedAt) {
    this.timeToUnsubscribe = Math.round(
      (this.unsubscribedAt - this.subscribedAt) / (1000 * 60)
    );
  }

  // Count SMS received before unsubscribe
  let smsCount = 0;
  if (this.welcomeSmsStatus === 'delivered') smsCount++;
  if (this.secondSmsStatus === 'delivered') smsCount++;
  this.smsCountBeforeUnsub = smsCount;

  // Determine which SMS triggered the unsub
  if (data.afterSms) {
    this.unsubscribeAfterSms = data.afterSms;
  } else if (this.secondSmsSent && this.secondSmsStatus === 'delivered') {
    this.unsubscribeAfterSms = 'second_chance';
  } else if (this.welcomeSmsStatus === 'delivered') {
    this.unsubscribeAfterSms = 'welcome';
  } else {
    this.unsubscribeAfterSms = 'none';
  }

  // Set source, reason, keyword, feedback
  this.unsubscribeSource = data.source || 'reply_stop';
  this.unsubscribeReason = data.reason || 'stop_keyword';
  this.unsubscribeKeyword = data.keyword || null;
  this.unsubscribeFeedback = data.feedback || null;
  this.unsubscribeCampaignId = data.campaignId || null;

  return this.save();
};

const SmsSubscriber = mongoose.model('SmsSubscriber', smsSubscriberSchema);

module.exports = SmsSubscriber;