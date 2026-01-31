// backend/src/services/secondChanceSmsService.js
// 📱 Second Chance SMS Service - 20% OFF with 2-hour expiration
const SmsSubscriber = require('../models/SmsSubscriber');
const telnyxService = require('./telnyxService');
const crypto = require('crypto');

// ==================== CONFIGURATION ====================
const CONFIG = {
  discountPercent: 20,
  codePrefix: 'JP2',
  expirationHours: 2,
  minHoursSinceFirst: 6,
  maxHoursSinceFirst: 8,
  quietHoursStart: 21, // 9 PM
  quietHoursEnd: 9,    // 9 AM
  // Personal, family-style message templates (rotates randomly)
  messageTemplates: [
    (code) => `Hi, it's Mike from Jersey Pickles! 🥒 I saw you were checking us out earlier. We're a small family business here in NJ, and we put a lot of love into every jar. Would love for you to try us - here's ${code} for 20% off. Hope to see you soon! - The Jersey Pickles Family 💚`,

    (code) => `Hey there! Sarah here from Jersey Pickles 👋 Just wanted to reach out personally - we noticed you haven't completed your order. We're a family-run business and every customer means the world to us. Use ${code} for 20% off your first order. Handcrafted with love in NJ! 🥒💚`,

    (code) => `Hi! This is the team at Jersey Pickles 🥒 We're a small family business making pickles the old-fashioned way right here in New Jersey. We'd love to welcome you to our pickle family! Here's a special code just for you: ${code} for 20% off. Made with love, The Jersey Pickles Crew 💚`
  ],
  // Fallback simple template
  messageTemplate: (code, expiresIn) =>
    `Hi from Jersey Pickles! 🥒 We're a small family business in NJ and we'd love for you to try our handcrafted pickles. Here's ${code} for 20% off your order. Made with love! - The JP Family 💚 Reply STOP to opt-out`
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
 * Check if current time is within allowed sending hours
 */
const isWithinSendingHours = () => {
  const now = new Date();
  const hour = now.getHours();
  return hour >= CONFIG.quietHoursEnd && hour < CONFIG.quietHoursStart;
};

/**
 * Get next available sending time
 */
const getNextSendingTime = () => {
  const now = new Date();
  const hour = now.getHours();
  
  if (hour >= CONFIG.quietHoursEnd && hour < CONFIG.quietHoursStart) {
    // Within allowed hours, can send now
    return new Date(now.getTime() + 60000); // 1 minute buffer
  }
  
  // Calculate next 9 AM
  const nextSend = new Date(now);
  
  if (hour >= CONFIG.quietHoursStart) {
    // After 9 PM, next day at 9 AM
    nextSend.setDate(nextSend.getDate() + 1);
  }
  // Before 9 AM, today at 9 AM
  
  nextSend.setHours(CONFIG.quietHoursEnd, 0, 0, 0);
  
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
 * FIXED: Incluye suscriptores con secondSmsScheduledFor undefined/null
 * y también busca por welcomeSmsSentAt para compatibilidad
 */
const scheduleSecondSmsForEligible = async () => {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);

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
      // Han pasado al menos 6 horas desde el primer SMS
      {
        $or: [
          { welcomeSmsAt: { $lte: sixHoursAgo } },
          { welcomeSmsSentAt: { $lte: sixHoursAgo } }
        ]
      }
    ]
  }).limit(100);

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
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);

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

  // 3. Eligible but not yet scheduled (6-8h window, no scheduled time)
  const eligibleNotScheduled = await SmsSubscriber.find({
    status: 'active',
    converted: false,
    secondSmsSent: { $ne: true },
    welcomeSmsStatus: 'delivered',
    secondSmsScheduledFor: null,
    $or: [
      { welcomeSmsAt: { $gte: eightHoursAgo, $lte: sixHoursAgo } },
      { welcomeSmsSentAt: { $gte: eightHoursAgo, $lte: sixHoursAgo } }
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
          const eligibleAt = new Date(new Date(firstSmsTime).getTime() + 6 * 60 * 60 * 1000);
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