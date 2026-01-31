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
    enum: ['mobile', 'landline', 'voip', 'unknown'],
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
    type: String
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

// ==================== VIRTUALS ====================

// Check if eligible for second SMS
smsSubscriberSchema.virtual('eligibleForSecondSms').get(function() {
  if (this.converted) return false;
  if (this.secondSmsSent) return false;
  if (this.status !== 'active') return false;
  if (this.welcomeSmsStatus !== 'delivered') return false;
  
  // Must be at least 6 hours since first SMS
  const smsTime = this.welcomeSmsAt || this.welcomeSmsSentAt;
  if (!smsTime) return false;
  
  const hoursSinceFirst = (Date.now() - new Date(smsTime).getTime()) / (1000 * 60 * 60);
  
  return hoursSinceFirst >= 6;
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
// FIXED: Ahora busca >= 6 horas (sin límite superior) para no perder suscriptores
smsSubscriberSchema.statics.findEligibleForSecondSms = function(limit = 50) {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

  return this.find({
    status: 'active',
    converted: false,
    secondSmsSent: { $ne: true },
    welcomeSmsStatus: 'delivered',
    $or: [
      { welcomeSmsAt: { $lte: sixHoursAgo } },
      { welcomeSmsSentAt: { $lte: sixHoursAgo } }
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

const SmsSubscriber = mongoose.model('SmsSubscriber', smsSubscriberSchema);

module.exports = SmsSubscriber;