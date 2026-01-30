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
  messageTemplate: (code, expiresIn) => 
    `🥒 Hey Pickle Fan! We noticed you haven't used your discount yet... Here's 20% OFF just for you! Use code ${code} at jerseypickles.com ⏰ Expires in ${expiresIn}! Reply STOP to opt-out`
};

// ==================== SHOPIFY CLIENT ====================
const getShopifyClient = () => {
  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  
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
    
    // Build message
    const message = CONFIG.messageTemplate(secondCode, '2 hours');
    
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
 */
const scheduleSecondSmsForEligible = async () => {
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
  
  // Find subscribers who need scheduling
  const subscribers = await SmsSubscriber.find({
    status: 'active',
    converted: false,
    secondSmsSent: false,
    secondSmsScheduledFor: null,
    welcomeSmsStatus: 'delivered',
    welcomeSmsAt: { $lte: sixHoursAgo }
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

// ==================== EXPORTS ====================

module.exports = {
  processSecondChanceBatch,
  processSubscriberForSecondSms,
  scheduleSecondSmsForEligible,
  processScheduledSecondSms,
  getSecondChanceStats,
  isWithinSendingHours,
  getNextSendingTime,
  generateUniqueSecondCode,
  createShopifyDiscountCode,
  CONFIG
};