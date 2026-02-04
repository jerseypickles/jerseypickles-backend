// backend/src/services/secondChanceSmsService.js
// 📱 Second Chance SMS Service - 25-30% OFF A/B Testing with real urgency
const SmsSubscriber = require('../models/SmsSubscriber');
const telnyxService = require('./telnyxService');
const crypto = require('crypto');

// ==================== CONFIGURATION ====================
const CONFIG = {
  // A/B Testing: Random discount between 25-30%
  discountMin: 25,
  discountMax: 30,
  codePrefix: 'JP2',
  expirationHours: 4, // Real urgency - 4 hours to convert
  minHoursSinceFirst: 6, // Send while they still remember (6 hours)
  maxHoursSinceFirst: 24, // Max window
  quietHoursStart: 21, // 9 PM
  quietHoursEnd: 9,    // 9 AM

  // High-converting message templates with real urgency
  // IMPORTANT: Always identify as "Jersey Pickles" so they remember who we are!
  // Each template is a function that takes (code, discountPercent)
  messageTemplates: [
    (code, pct) => `🥒 Jersey Pickles: FLASH SALE! ${pct}% OFF for 4 hours only! Use code ${code} at jerseypickles.com - don't miss out!`,

    (code, pct) => `Jersey Pickles here! 🥒 Still want those pickles? Here's ${pct}% OFF just for you! Code: ${code} - Expires in 4hrs: jerseypickles.com`,

    (code, pct) => `🔥 Jersey Pickles: We REALLY want you to try us! ${pct}% OFF with code ${code} - only 4 hours left! Shop: jerseypickles.com`,

    (code, pct) => `Jersey Pickles 🥒 Last chance! Your exclusive ${pct}% OFF code ${code} expires soon. Free shipping $50+! jerseypickles.com`
  ]
};

/**
 * Get random discount between 25-30% for A/B testing
 * @returns {number} Random discount percentage
 */
const getRandomDiscount = () => {
  return Math.floor(Math.random() * (CONFIG.discountMax - CONFIG.discountMin + 1)) + CONFIG.discountMin;
};

/**
 * Get a high-converting message with the discount percentage
 * @param {string} code - Discount code
 * @param {number} discountPercent - The discount percentage for this subscriber
 * @returns {string} The SMS message
 */
const getPersonalMessage = (code, discountPercent) => {
  const templates = CONFIG.messageTemplates;
  const randomIndex = Math.floor(Math.random() * templates.length);
  return templates[randomIndex](code, discountPercent) + ' Reply STOP to opt-out';
};

// ==================== SHOPIFY CLIENT ====================
const getShopifyClient = () => {
  const shopifyDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  
  if (!shopifyDomain || !accessToken) {
    throw new Error('Shopify credentials not configured');
  }
  
  return {
    domain: shopifyDomain,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken
    }
  };
};

// ==================== CODE GENERATION ====================

/**
 * Generate unique JP2-XXXXX code
 */
const generateSecondCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Sin I, O, 0, 1 para evitar confusión
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(crypto.randomInt(chars.length));
  }
  return `${CONFIG.codePrefix}-${code}`;
};

/**
 * Generate unique code checking DB
 */
const generateUniqueSecondCode = async () => {
  let code;
  let attempts = 0;
  
  do {
    code = generateSecondCode();
    const exists = await SmsSubscriber.findOne({ 
      $or: [
        { discountCode: code },
        { secondDiscountCode: code }
      ]
    });
    if (!exists) return code;
    attempts++;
  } while (attempts < 10);
  
  // Fallback with timestamp
  return `${CONFIG.codePrefix}-${Date.now().toString(36).toUpperCase().slice(-5)}`;
};

// ==================== SHOPIFY DISCOUNT ====================

/**
 * Create discount code in Shopify with expiration
 * @param {string} code - The discount code
 * @param {Date} expiresAt - Expiration date
 * @param {number} discountPercent - The discount percentage (25-30%)
 */
const createShopifyDiscountCode = async (code, expiresAt, discountPercent) => {
  const shopify = getShopifyClient();

  // Format dates for Shopify
  const startsAt = new Date().toISOString();
  const endsAt = expiresAt.toISOString();

  // Create Price Rule first
  const priceRulePayload = {
    price_rule: {
      title: code,
      target_type: 'line_item',
      target_selection: 'all',
      allocation_method: 'across',
      value_type: 'percentage',
      value: `-${discountPercent}`,
      customer_selection: 'all',
      usage_limit: 1,
      starts_at: startsAt,
      ends_at: endsAt,
      once_per_customer: true
    }
  };
  
  try {
    // Create price rule
    const priceRuleResponse = await fetch(
      `https://${shopify.domain}/admin/api/2024-01/price_rules.json`,
      {
        method: 'POST',
        headers: shopify.headers,
        body: JSON.stringify(priceRulePayload)
      }
    );
    
    if (!priceRuleResponse.ok) {
      const error = await priceRuleResponse.text();
      console.error('Shopify price rule error:', error);
      throw new Error(`Failed to create price rule: ${priceRuleResponse.status}`);
    }
    
    const priceRuleData = await priceRuleResponse.json();
    const priceRuleId = priceRuleData.price_rule.id;
    
    // Create discount code linked to price rule
    const discountCodePayload = {
      discount_code: {
        code: code
      }
    };
    
    const discountResponse = await fetch(
      `https://${shopify.domain}/admin/api/2024-01/price_rules/${priceRuleId}/discount_codes.json`,
      {
        method: 'POST',
        headers: shopify.headers,
        body: JSON.stringify(discountCodePayload)
      }
    );
    
    if (!discountResponse.ok) {
      const error = await discountResponse.text();
      console.error('Shopify discount code error:', error);
      throw new Error(`Failed to create discount code: ${discountResponse.status}`);
    }
    
    const discountData = await discountResponse.json();
    
    console.log(`✅ Shopify discount created: ${code} (expires: ${endsAt})`);
    
    return {
      success: true,
      priceRuleId: priceRuleId,
      discountCodeId: discountData.discount_code.id,
      code: code,
      expiresAt: endsAt
    };
    
  } catch (error) {
    console.error('Error creating Shopify discount:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// ==================== QUIET HOURS CHECK ====================

/**
 * Get current hour in Eastern Time
 * Handles both EST (UTC-5) and EDT (UTC-4) automatically
 */
const getEasternHour = () => {
  const now = new Date();
  // Use Intl to get the correct Eastern time (handles DST automatically)
  const easternTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false
  }).format(now);
  return parseInt(easternTime, 10);
};

/**
 * Check if current time is within allowed sending hours (9 AM - 9 PM Eastern)
 */
const isWithinSendingHours = () => {
  const hour = getEasternHour();
  const isWithin = hour >= CONFIG.quietHoursEnd && hour < CONFIG.quietHoursStart;
  console.log(`⏰ Eastern Time check: ${hour}:00 ET - Within sending hours (9-21): ${isWithin}`);
  return isWithin;
};

/**
 * Get next available sending time (in Eastern Time)
 */
const getNextSendingTime = () => {
  const now = new Date();
  const hour = getEasternHour();

  if (hour >= CONFIG.quietHoursEnd && hour < CONFIG.quietHoursStart) {
    // Within allowed hours, can send now
    return new Date(now.getTime() + 60000); // 1 minute buffer
  }

  // Calculate next 9 AM Eastern
  // Create a date string in Eastern timezone, then parse it
  const easternDateStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);

  // Parse: MM/DD/YYYY
  const [month, day, year] = easternDateStr.split('/');

  // If after 9 PM ET, next day at 9 AM ET
  // If before 9 AM ET, today at 9 AM ET
  let targetDay = parseInt(day, 10);
  if (hour >= CONFIG.quietHoursStart) {
    targetDay += 1;
  }

  // Create the next 9 AM Eastern time
  // Use a specific Eastern time string and convert to UTC
  const targetDateStr = `${year}-${month}-${String(targetDay).padStart(2, '0')}T09:00:00`;

  // Create date in Eastern and get UTC equivalent
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });

  // Simple approach: 9 AM ET is either 14:00 UTC (EST) or 13:00 UTC (EDT)
  // Check if we're in DST
  const jan = new Date(now.getFullYear(), 0, 1);
  const jul = new Date(now.getFullYear(), 6, 1);
  const stdOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
  const isDST = now.getTimezoneOffset() < stdOffset;

  const nextSend = new Date(now);
  if (hour >= CONFIG.quietHoursStart) {
    nextSend.setDate(nextSend.getDate() + 1);
  }

  // Set to 9 AM Eastern (14:00 UTC in EST, 13:00 UTC in EDT)
  // Eastern is UTC-5 (EST) or UTC-4 (EDT)
  const etOffset = isDST ? 4 : 5;
  nextSend.setUTCHours(CONFIG.quietHoursEnd + etOffset, 0, 0, 0);

  return nextSend;
};

// ==================== MAIN SERVICE FUNCTIONS ====================

/**
 * Process a single subscriber for second chance SMS
 * Now with A/B testing: random 25-30% discount
 * 🔒 Uses atomic lock to prevent duplicate SMS (race condition fix)
 */
const processSubscriberForSecondSms = async (subscriber) => {
  try {
    console.log(`📱 Processing second SMS for: ${subscriber.phone}`);

    // Double-check eligibility first (quick check before atomic lock)
    if (subscriber.converted || subscriber.secondSmsSent || subscriber.status !== 'active') {
      console.log(`   ⏭️ Skipping: not eligible (pre-check)`);
      return { success: false, reason: 'not_eligible' };
    }

    // 🔒 ATOMIC LOCK: Use findOneAndUpdate to prevent race conditions
    // This ensures only ONE process can mark a subscriber for processing
    const lockResult = await SmsSubscriber.findOneAndUpdate(
      {
        _id: subscriber._id,
        secondSmsSent: { $ne: true },  // Only if not already sent
        converted: { $ne: true },       // Only if not converted
        status: 'active'
      },
      {
        $set: {
          secondSmsSent: true,          // Lock immediately!
          secondSmsAt: new Date()
        }
      },
      { new: true }
    );

    // If lockResult is null, another process already grabbed this subscriber
    if (!lockResult) {
      console.log(`   ⏭️ Skipping: already being processed by another job`);
      return { success: false, reason: 'already_processing' };
    }

    // Use the locked subscriber from here on
    subscriber = lockResult;
    console.log(`   🔒 Locked subscriber for processing`);

    // Generate unique code
    const secondCode = await generateUniqueSecondCode();

    // 🆕 A/B Testing: Random discount between 25-30%
    const discountPercent = getRandomDiscount();
    console.log(`   🎯 A/B Test: Assigned ${discountPercent}% discount`);

    // Calculate expiration (4 hours from now - real urgency!)
    const expiresAt = new Date(Date.now() + CONFIG.expirationHours * 60 * 60 * 1000);

    // Create Shopify discount with the random percentage
    const shopifyResult = await createShopifyDiscountCode(secondCode, expiresAt, discountPercent);

    if (!shopifyResult.success) {
      console.error(`   ❌ Failed to create Shopify discount: ${shopifyResult.error}`);

      // 🔓 UNLOCK: Reset secondSmsSent so it can be retried later
      subscriber.secondSmsSent = false;
      subscriber.secondSmsAt = null;
      subscriber.secondSmsStatus = 'failed';
      subscriber.secondSmsError = `Shopify: ${shopifyResult.error}`;
      await subscriber.save();

      return { success: false, reason: 'shopify_error', error: shopifyResult.error };
    }

    // Build high-converting message with the discount percentage
    const message = getPersonalMessage(secondCode, discountPercent);

    console.log(`   📝 Message (${message.length} chars): ${discountPercent}% OFF, expires in ${CONFIG.expirationHours}h`);

    // Send SMS via Telnyx with logging options
    const smsResult = await telnyxService.sendSms(subscriber.phone, message, {
      messageType: 'second_chance',
      subscriberId: subscriber._id,
      discountCode: secondCode,
      discountPercent: discountPercent,
      metadata: {
        expiresAt: expiresAt,
        hoursSinceFirstSms: CONFIG.minHoursSinceFirst
      }
    });

    // Update subscriber with SMS result data
    // Note: secondSmsSent and secondSmsAt were already set by the atomic lock
    subscriber.secondSmsStatus = smsResult.success ? 'sent' : 'failed';
    subscriber.secondSmsMessageId = smsResult.messageId || null;
    subscriber.secondDiscountCode = secondCode;
    subscriber.secondDiscountPercent = discountPercent; // 🆕 Now variable 25-30%
    subscriber.secondShopifyDiscountCodeId = shopifyResult.discountCodeId;
    subscriber.secondDiscountExpiresAt = expiresAt;
    subscriber.totalSmsReceived = (subscriber.totalSmsReceived || 0) + 1;

    if (!smsResult.success) {
      subscriber.secondSmsError = smsResult.error;
    }

    await subscriber.save();

    console.log(`   ✅ Second SMS sent: ${secondCode} @ ${discountPercent}% OFF (expires: ${expiresAt.toISOString()})`);

    return {
      success: true,
      phone: subscriber.phone,
      code: secondCode,
      discountPercent: discountPercent, // 🆕 Include for metrics
      expiresAt: expiresAt,
      messageId: smsResult.messageId
    };

  } catch (error) {
    console.error(`   ❌ Error processing ${subscriber.phone}:`, error);

    // 🔓 UNLOCK on error: Reset so it can be retried
    try {
      await SmsSubscriber.findByIdAndUpdate(subscriber._id, {
        $set: {
          secondSmsSent: false,
          secondSmsAt: null,
          secondSmsStatus: 'failed',
          secondSmsError: error.message
        }
      });
    } catch (unlockError) {
      console.error(`   ⚠️ Failed to unlock subscriber:`, unlockError.message);
    }

    return { success: false, reason: 'error', error: error.message };
  }
};

/**
 * Find and process all eligible subscribers for second SMS
 */
const processSecondChanceBatch = async (limit = 20) => {
  // Check if within sending hours
  if (!isWithinSendingHours()) {
    console.log('⏰ Outside sending hours (9am-9pm). Skipping batch.');
    return { processed: 0, skipped: 0, reason: 'quiet_hours' };
  }
  
  const results = {
    processed: 0,
    success: 0,
    failed: 0,
    details: []
  };
  
  try {
    // Find eligible subscribers
    const subscribers = await SmsSubscriber.findEligibleForSecondSms(limit);
    
    console.log(`\n🔍 Found ${subscribers.length} subscribers eligible for second SMS`);
    
    if (subscribers.length === 0) {
      return { ...results, message: 'No eligible subscribers' };
    }
    
    // Process each subscriber with rate limiting
    for (const subscriber of subscribers) {
      const result = await processSubscriberForSecondSms(subscriber);
      
      results.processed++;
      results.details.push({
        phone: subscriber.phone,
        ...result
      });
      
      if (result.success) {
        results.success++;
      } else {
        results.failed++;
      }
      
      // Rate limit: wait 1.2 seconds between SMS
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
    
    console.log(`\n📊 Batch complete: ${results.success} sent, ${results.failed} failed`);
    
    return results;
    
  } catch (error) {
    console.error('Error processing second chance batch:', error);
    return { ...results, error: error.message };
  }
};

/**
 * Schedule second SMS for subscribers (respecting quiet hours)
 * Now uses 6 hours - strike while they still remember!
 */
const scheduleSecondSmsForEligible = async () => {
  const minHoursAgo = new Date(Date.now() - CONFIG.minHoursSinceFirst * 60 * 60 * 1000);
  const maxHoursAgo = new Date(Date.now() - CONFIG.maxHoursSinceFirst * 60 * 60 * 1000);

  // Find subscribers who need scheduling
  // Must be between 6-24 hours since first SMS
  const subscribers = await SmsSubscriber.find({
    status: 'active',
    converted: false,
    secondSmsSent: { $ne: true },
    welcomeSmsStatus: 'delivered',
    $and: [
      // No tiene agendado el segundo SMS
      {
        $or: [
          { secondSmsScheduledFor: null },
          { secondSmsScheduledFor: { $exists: false } }
        ]
      },
      // Between 6-24 hours since first SMS (sweet spot for recovery)
      {
        $or: [
          { welcomeSmsAt: { $lte: minHoursAgo, $gte: maxHoursAgo } },
          { welcomeSmsSentAt: { $lte: minHoursAgo, $gte: maxHoursAgo } }
        ]
      }
    ]
  }).limit(500);

  let scheduled = 0;

  for (const subscriber of subscribers) {
    await subscriber.scheduleSecondSms();
    scheduled++;
  }

  console.log(`📅 Scheduled ${scheduled} subscribers for second SMS (${CONFIG.minHoursSinceFirst}-${CONFIG.maxHoursSinceFirst}h window)`);

  return { scheduled };
};

/**
 * Process scheduled second SMS (called by cron job)
 */
const processScheduledSecondSms = async (limit = 20) => {
  // Check if within sending hours
  if (!isWithinSendingHours()) {
    return { processed: 0, reason: 'quiet_hours' };
  }
  
  const results = {
    processed: 0,
    success: 0,
    failed: 0
  };
  
  // Find subscribers with scheduled second SMS ready to send
  const subscribers = await SmsSubscriber.findScheduledSecondSms(limit);
  
  for (const subscriber of subscribers) {
    // Double check they haven't converted in the meantime
    if (subscriber.converted) {
      subscriber.secondSmsScheduledFor = null;
      await subscriber.save();
      continue;
    }
    
    const result = await processSubscriberForSecondSms(subscriber);
    
    results.processed++;
    if (result.success) results.success++;
    else results.failed++;
    
    // Rate limit
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  
  return results;
};

/**
 * Get second chance SMS statistics with A/B testing breakdown
 */
const getSecondChanceStats = async () => {
  const breakdown = await SmsSubscriber.getConversionBreakdown();

  // Calculate rates
  const firstConversionRate = breakdown.firstSms.delivered > 0
    ? ((breakdown.conversions.first / breakdown.firstSms.delivered) * 100).toFixed(1)
    : '0';

  const secondConversionRate = breakdown.secondSms.delivered > 0
    ? ((breakdown.conversions.second / breakdown.secondSms.delivered) * 100).toFixed(1)
    : '0';

  const recoveryRate = breakdown.secondSms.sent > 0
    ? ((breakdown.conversions.second / breakdown.secondSms.sent) * 100).toFixed(1)
    : '0';

  // 🆕 A/B Testing: Get conversion breakdown by discount percentage
  const abTestResults = await SmsSubscriber.aggregate([
    {
      $match: {
        secondSmsSent: true,
        secondDiscountPercent: { $exists: true, $ne: null }
      }
    },
    {
      $group: {
        _id: '$secondDiscountPercent',
        sent: { $sum: 1 },
        delivered: { $sum: { $cond: [{ $eq: ['$secondSmsStatus', 'delivered'] }, 1, 0] } },
        converted: { $sum: { $cond: [{ $and: ['$converted', { $eq: ['$convertedWith', 'second'] }] }, 1, 0] } },
        revenue: { $sum: { $cond: [{ $eq: ['$convertedWith', 'second'] }, { $ifNull: ['$conversionData.orderTotal', 0] }, 0] } }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  // Format A/B test results
  const abTesting = {};
  for (const result of abTestResults) {
    const pct = result._id;
    abTesting[`${pct}%`] = {
      sent: result.sent,
      delivered: result.delivered,
      converted: result.converted,
      conversionRate: result.delivered > 0 ? ((result.converted / result.delivered) * 100).toFixed(1) + '%' : '0%',
      revenue: result.revenue.toFixed(2),
      avgOrderValue: result.converted > 0 ? (result.revenue / result.converted).toFixed(2) : '0.00'
    };
  }

  return {
    ...breakdown,
    rates: {
      firstConversion: firstConversionRate,
      secondConversion: secondConversionRate,
      recovery: recoveryRate
    },
    // 🆕 A/B Testing breakdown
    abTesting: {
      discountRange: `${CONFIG.discountMin}-${CONFIG.discountMax}%`,
      expirationHours: CONFIG.expirationHours,
      byPercentage: abTesting
    }
  };
};

/**
 * Get detailed queue visibility for Second Chance SMS
 * Shows exactly when each SMS is scheduled and will be sent
 */
const getQueueDetails = async (options = {}) => {
  const { limit = 50 } = options;
  const now = new Date();
  const sixHoursAgo = new Date(Date.now() - CONFIG.minHoursSinceFirst * 60 * 60 * 1000);
  const twentyFourHoursAgo = new Date(Date.now() - CONFIG.maxHoursSinceFirst * 60 * 60 * 1000);

  // ==================== QUEUE BREAKDOWN ====================

  // 1. Ready to send NOW (scheduled time has passed, within sending hours)
  const readyToSend = await SmsSubscriber.find({
    status: 'active',
    converted: false,
    secondSmsSent: { $ne: true },
    secondSmsScheduledFor: { $lte: now }
  })
  .sort({ secondSmsScheduledFor: 1 })
  .limit(limit)
  .select('phone phoneFormatted welcomeSmsAt welcomeSmsSentAt secondSmsScheduledFor createdAt discountCode')
  .lean();

  // 2. Scheduled for later (have a future scheduled time)
  const scheduledForLater = await SmsSubscriber.find({
    status: 'active',
    converted: false,
    secondSmsSent: { $ne: true },
    secondSmsScheduledFor: { $gt: now }
  })
  .sort({ secondSmsScheduledFor: 1 })
  .limit(limit)
  .select('phone phoneFormatted welcomeSmsAt welcomeSmsSentAt secondSmsScheduledFor createdAt discountCode')
  .lean();

  // 3. Eligible but not yet scheduled (6-24h window, no scheduled time)
  const eligibleNotScheduled = await SmsSubscriber.find({
    status: 'active',
    converted: false,
    secondSmsSent: { $ne: true },
    welcomeSmsStatus: 'delivered',
    secondSmsScheduledFor: null,
    $or: [
      { welcomeSmsAt: { $gte: twentyFourHoursAgo, $lte: sixHoursAgo } },
      { welcomeSmsSentAt: { $gte: twentyFourHoursAgo, $lte: sixHoursAgo } }
    ]
  })
  .sort({ welcomeSmsAt: 1, welcomeSmsSentAt: 1 })
  .limit(limit)
  .select('phone phoneFormatted welcomeSmsAt welcomeSmsSentAt secondSmsScheduledFor createdAt discountCode')
  .lean();

  // 4. Waiting (< 6 hours since first SMS)
  const waitingForEligibility = await SmsSubscriber.find({
    status: 'active',
    converted: false,
    secondSmsSent: { $ne: true },
    welcomeSmsStatus: 'delivered',
    $or: [
      { welcomeSmsAt: { $gt: sixHoursAgo } },
      { welcomeSmsSentAt: { $gt: sixHoursAgo } }
    ]
  })
  .sort({ welcomeSmsAt: 1, welcomeSmsSentAt: 1 })
  .limit(limit)
  .select('phone phoneFormatted welcomeSmsAt welcomeSmsSentAt secondSmsScheduledFor createdAt discountCode')
  .lean();

  // ==================== RECENT ACTIVITY ====================

  // Recently sent second SMS (last 24 hours)
  const recentlySent = await SmsSubscriber.find({
    secondSmsSent: true,
    secondSmsAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
  })
  .sort({ secondSmsAt: -1 })
  .limit(20)
  .select('phone phoneFormatted secondSmsAt secondSmsStatus secondDiscountCode converted convertedWith')
  .lean();

  // ==================== FORMAT RESULTS ====================

  const maskPhone = (phone) => {
    if (!phone) return '***';
    // Show last 4 digits: ***-***-1234
    return `***-***-${phone.slice(-4)}`;
  };

  const formatQueueItem = (sub, includeScheduledFor = true) => {
    const firstSmsTime = sub.welcomeSmsAt || sub.welcomeSmsSentAt;
    const hoursSinceFirst = firstSmsTime
      ? ((now - new Date(firstSmsTime)) / (1000 * 60 * 60)).toFixed(1)
      : null;

    const item = {
      id: sub._id,
      phone: maskPhone(sub.phone),
      phoneFormatted: sub.phoneFormatted ? maskPhone(sub.phoneFormatted) : null,
      subscribedAt: sub.createdAt,
      firstSmsAt: firstSmsTime,
      hoursSinceFirstSms: hoursSinceFirst ? parseFloat(hoursSinceFirst) : null,
      discountCode: sub.discountCode
    };

    if (includeScheduledFor && sub.secondSmsScheduledFor) {
      item.scheduledFor = sub.secondSmsScheduledFor;
      const msUntilSend = new Date(sub.secondSmsScheduledFor) - now;
      item.minutesUntilSend = Math.max(0, Math.round(msUntilSend / (1000 * 60)));
      item.timeUntilSend = formatTimeUntil(msUntilSend);
    }

    return item;
  };

  const formatTimeUntil = (ms) => {
    if (ms <= 0) return 'Now';
    const minutes = Math.floor(ms / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;

    if (hours > 0) {
      return `${hours}h ${mins}m`;
    }
    return `${mins}m`;
  };

  // ==================== CALCULATE ESTIMATES ====================

  const withinHours = isWithinSendingHours();
  const nextWindow = getNextSendingTime();

  // Estimate processing time (1.2s per SMS + some buffer)
  const readyCount = readyToSend.length;
  const estimatedProcessingMinutes = Math.ceil((readyCount * 1.5) / 60);

  return {
    summary: {
      readyToSendNow: readyToSend.length,
      scheduledForLater: scheduledForLater.length,
      eligibleNotScheduled: eligibleNotScheduled.length,
      waitingForEligibility: waitingForEligibility.length,
      totalInQueue: readyToSend.length + scheduledForLater.length + eligibleNotScheduled.length + waitingForEligibility.length,
      recentlySent24h: recentlySent.length
    },

    sendingWindow: {
      isOpen: withinHours,
      currentHour: now.getHours(),
      allowedHours: `${CONFIG.quietHoursEnd}:00 - ${CONFIG.quietHoursStart}:00`,
      nextWindowOpens: withinHours ? null : nextWindow,
      nextWindowOpensIn: withinHours ? null : formatTimeUntil(nextWindow - now)
    },

    estimates: {
      readyToProcess: readyCount,
      estimatedProcessingTime: `~${estimatedProcessingMinutes} minutes`,
      rateLimit: '1.2 seconds per SMS'
    },

    queues: {
      // Ready to send immediately
      readyNow: readyToSend.map(sub => formatQueueItem(sub, true)),

      // Scheduled for a future time
      scheduled: scheduledForLater.map(sub => formatQueueItem(sub, true)),

      // Eligible but needs scheduling (will be picked up by next cron run)
      eligiblePendingSchedule: eligibleNotScheduled.map(sub => {
        const item = formatQueueItem(sub, false);
        item.willBeScheduledFor = withinHours ? 'Next cron run' : nextWindow;
        return item;
      }),

      // Still waiting for 6h window
      waitingForWindow: waitingForEligibility.map(sub => {
        const item = formatQueueItem(sub, false);
        const firstSmsTime = sub.welcomeSmsAt || sub.welcomeSmsSentAt;
        if (firstSmsTime) {
          const eligibleAt = new Date(new Date(firstSmsTime).getTime() + CONFIG.minHoursSinceFirst * 60 * 60 * 1000);
          item.eligibleAt = eligibleAt;
          item.eligibleIn = formatTimeUntil(eligibleAt - now);
        }
        return item;
      })
    },

    recentActivity: recentlySent.map(sub => ({
      id: sub._id,
      phone: maskPhone(sub.phone),
      sentAt: sub.secondSmsAt,
      status: sub.secondSmsStatus,
      discountCode: sub.secondDiscountCode,
      converted: sub.converted,
      convertedWith: sub.convertedWith
    })),

    timestamp: now
  };
};

// ==================== EXPORTS ====================

module.exports = {
  processSecondChanceBatch,
  processSubscriberForSecondSms,
  scheduleSecondSmsForEligible,
  processScheduledSecondSms,
  getSecondChanceStats,
  getQueueDetails,
  isWithinSendingHours,
  getNextSendingTime,
  generateUniqueSecondCode,
  createShopifyDiscountCode,
  CONFIG
};