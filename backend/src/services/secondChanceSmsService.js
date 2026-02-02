// backend/src/services/secondChanceSmsService.js
// 📱 Second Chance SMS Service - 20% OFF with 2-hour expiration
const SmsSubscriber = require('../models/SmsSubscriber');
const telnyxService = require('./telnyxService');
const crypto = require('crypto');

// ==================== CONFIGURATION ====================
const CONFIG = {
  discountPercent: 20,
  codePrefix: 'JP2',
  expirationHours: 24, // Changed from 2 to 24 hours - more time to convert
  minHoursSinceFirst: 24, // Changed from 6 to 24 hours - let them "forget" first
  maxHoursSinceFirst: 48, // Changed from 8 to 48 hours
  quietHoursStart: 21, // 9 PM
  quietHoursEnd: 9,    // 9 AM
  // Urgency-focused message templates (rotates randomly)
  messageTemplates: [
    (code) => `Hey! Your 20% OFF code ${code} expires in 24hrs ⏰ Over 500 pickle lovers ordered this month - don't miss out! jerseypickles.com 🥒`,

    (code) => `Last chance! 🔥 We saved you 20% OFF with code ${code} - but it expires tomorrow. Our spicy pickles are almost sold out! jerseypickles.com`,

    (code) => `Quick reminder: Your exclusive 20% OFF (${code}) expires soon! 🥒 Free shipping on orders $50+ at jerseypickles.com - don't miss this deal!`
  ],
  // Fallback simple template
  messageTemplate: (code, expiresIn) =>
    `Last chance! Use ${code} for 20% OFF at jerseypickles.com - expires in 24hrs! 🥒 Reply STOP to opt-out`
};

/**
 * Get a personal message template (rotates to feel more natural)
 */
const getPersonalMessage = (code) => {
  const templates = CONFIG.messageTemplates;
  const randomIndex = Math.floor(Math.random() * templates.length);
  return templates[randomIndex](code) + ' Reply STOP to opt-out';
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
 * Create discount code in Shopify with 2-hour expiration
 */
const createShopifyDiscountCode = async (code, expiresAt) => {
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
      value: `-${CONFIG.discountPercent}`,
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
 */
const processSubscriberForSecondSms = async (subscriber) => {
  try {
    console.log(`📱 Processing second SMS for: ${subscriber.phone}`);
    
    // Double-check eligibility
    if (subscriber.converted || subscriber.secondSmsSent || subscriber.status !== 'active') {
      console.log(`   ⏭️ Skipping: not eligible`);
      return { success: false, reason: 'not_eligible' };
    }
    
    // Generate unique code
    const secondCode = await generateUniqueSecondCode();
    
    // Calculate expiration (2 hours from now)
    const expiresAt = new Date(Date.now() + CONFIG.expirationHours * 60 * 60 * 1000);
    
    // Create Shopify discount with expiration
    const shopifyResult = await createShopifyDiscountCode(secondCode, expiresAt);
    
    if (!shopifyResult.success) {
      console.error(`   ❌ Failed to create Shopify discount: ${shopifyResult.error}`);
      
      // Update subscriber with error
      subscriber.secondSmsError = `Shopify: ${shopifyResult.error}`;
      await subscriber.save();
      
      return { success: false, reason: 'shopify_error', error: shopifyResult.error };
    }
    
    // Build personal, family-style message
    const message = getPersonalMessage(secondCode);

    console.log(`   📝 Message style: Personal/Family (${message.length} chars)`);

    // Send SMS via Telnyx
    const smsResult = await telnyxService.sendSms(subscriber.phone, message);
    
    // Update subscriber
    subscriber.secondSmsSent = true;
    subscriber.secondSmsAt = new Date();
    subscriber.secondSmsStatus = smsResult.success ? 'sent' : 'failed';
    subscriber.secondSmsMessageId = smsResult.messageId || null;
    subscriber.secondDiscountCode = secondCode;
    subscriber.secondDiscountPercent = CONFIG.discountPercent;
    subscriber.secondShopifyDiscountCodeId = shopifyResult.discountCodeId;
    subscriber.secondDiscountExpiresAt = expiresAt;
    subscriber.totalSmsReceived = (subscriber.totalSmsReceived || 0) + 1;
    
    if (!smsResult.success) {
      subscriber.secondSmsError = smsResult.error;
    }
    
    await subscriber.save();
    
    console.log(`   ✅ Second SMS sent: ${secondCode} (expires: ${expiresAt.toISOString()})`);
    
    return {
      success: true,
      phone: subscriber.phone,
      code: secondCode,
      expiresAt: expiresAt,
      messageId: smsResult.messageId
    };
    
  } catch (error) {
    console.error(`   ❌ Error processing ${subscriber.phone}:`, error);
    
    subscriber.secondSmsError = error.message;
    await subscriber.save();
    
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
 * Changed from 6 hours to 24 hours - better conversion timing
 */
const scheduleSecondSmsForEligible = async () => {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Find subscribers who need scheduling
  // Incluye los que nunca fueron agendados (secondSmsScheduledFor no existe o es null)
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
      // Han pasado al menos 24 horas desde el primer SMS
      {
        $or: [
          { welcomeSmsAt: { $lte: twentyFourHoursAgo } },
          { welcomeSmsSentAt: { $lte: twentyFourHoursAgo } }
        ]
      }
    ]
  }).limit(500); // Increased limit to handle all pending

  let scheduled = 0;

  for (const subscriber of subscribers) {
    await subscriber.scheduleSecondSms();
    scheduled++;
  }

  console.log(`📅 Scheduled ${scheduled} subscribers for second SMS`);

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
 * Get second chance SMS statistics
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

  return {
    ...breakdown,
    rates: {
      firstConversion: firstConversionRate,
      secondConversion: secondConversionRate,
      recovery: recoveryRate
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
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

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

  // 3. Eligible but not yet scheduled (24-48h window, no scheduled time)
  const eligibleNotScheduled = await SmsSubscriber.find({
    status: 'active',
    converted: false,
    secondSmsSent: { $ne: true },
    welcomeSmsStatus: 'delivered',
    secondSmsScheduledFor: null,
    $or: [
      { welcomeSmsAt: { $gte: fortyEightHoursAgo, $lte: twentyFourHoursAgo } },
      { welcomeSmsSentAt: { $gte: fortyEightHoursAgo, $lte: twentyFourHoursAgo } }
    ]
  })
  .sort({ welcomeSmsAt: 1, welcomeSmsSentAt: 1 })
  .limit(limit)
  .select('phone phoneFormatted welcomeSmsAt welcomeSmsSentAt secondSmsScheduledFor createdAt discountCode')
  .lean();

  // 4. Waiting (< 24 hours since first SMS)
  const waitingForEligibility = await SmsSubscriber.find({
    status: 'active',
    converted: false,
    secondSmsSent: { $ne: true },
    welcomeSmsStatus: 'delivered',
    $or: [
      { welcomeSmsAt: { $gt: twentyFourHoursAgo } },
      { welcomeSmsSentAt: { $gt: twentyFourHoursAgo } }
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

      // Still waiting for 24h window
      waitingForWindow: waitingForEligibility.map(sub => {
        const item = formatQueueItem(sub, false);
        const firstSmsTime = sub.welcomeSmsAt || sub.welcomeSmsSentAt;
        if (firstSmsTime) {
          const eligibleAt = new Date(new Date(firstSmsTime).getTime() + 24 * 60 * 60 * 1000);
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