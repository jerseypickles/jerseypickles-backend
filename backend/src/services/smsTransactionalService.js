// backend/src/services/smsTransactionalService.js
// 📱 SMS Transactional Service - Order confirmations, shipping, delivery notifications
const SmsTransactional = require('../models/SmsTransactional');
const SmsSubscriber = require('../models/SmsSubscriber');
const telnyxService = require('./telnyxService');

// ==================== DEFAULT MESSAGE TEMPLATES ====================
const DEFAULT_TEMPLATES = {
  // Order Confirmation - Warm, family-style, emphasize freshness
  order_confirmation: `Hi {customerName}! 🥒 Thank you so much for your order #{orderNumber}! We're so excited to have you as part of our pickle family. Your order is being prepared fresh with love right here in New Jersey - we ship everything super fresh straight to your door! We'll text you the moment it ships. Questions? We're here for you! - The Jersey Pickles Family 💚`,

  // Shipping Notification - Include tracking (short URL) + support contact
  shipping_notification: `Great news {customerName}! 🎉 Your Jersey Pickles order #{orderNumber} just shipped! 📦 Track: {trackingUrl} Questions? Email info@jerseypickles.com - Jersey Pickles 🥒💚`,

  // Delivery Confirmation - Request feedback + support for issues
  delivery_confirmation: `Hi {customerName}! 🥒 Your Jersey Pickles have arrived! We hope you love them as much as we loved making them for you! If you notice any issues with your order or anything doesn't look right, please let us know right away at info@jerseypickles.com (include order #{orderNumber}) - we'll make it right! Enjoy your fresh pickles! 💚 - The JP Family`,

  // Order Cancelled - Inform customer about cancellation
  order_cancelled: `Hi {customerName}, we're sorry to inform you that your order #{orderNumber} has been cancelled. {cancelReason}If you have any questions or didn't request this, please contact us at info@jerseypickles.com. We hope to serve you again soon! - Jersey Pickles 🥒`,

  // Delayed Shipment - Apology for orders unfulfilled > 72 hours
  delayed_shipment: `Hi {customerName}! 🥒 We wanted to reach out about your order #{orderNumber}. We're working hard to get your fresh pickles ready, but we're experiencing a slight delay. Rest assured, your order will ship very soon and we'll text you the tracking info the moment it does! Thank you so much for your patience - we promise it'll be worth the wait! Questions? Email info@jerseypickles.com - Jersey Pickles 💚`
};

// ==================== URL SHORTENING ====================
/**
 * Create a short tracking URL
 * Uses carrier-specific short URLs when possible
 */
const shortenTrackingUrl = (trackingUrl, trackingNumber, trackingCompany) => {
  if (!trackingUrl && !trackingNumber) return '';

  // Carrier-specific short URL patterns
  const carrierShortUrls = {
    'UPS': (num) => `https://ups.com/track?tracknum=${num}`,
    'USPS': (num) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${num}`,
    'FedEx': (num) => `https://fedex.com/fedextrack/?trknbr=${num}`,
    'DHL': (num) => `https://dhl.com/en/express/tracking.html?AWB=${num}`,
    'OnTrac': (num) => `https://ontrac.com/tracking/?number=${num}`
  };

  // If we have tracking company and number, use short URL
  if (trackingCompany && trackingNumber) {
    const companyKey = Object.keys(carrierShortUrls).find(
      key => trackingCompany.toLowerCase().includes(key.toLowerCase())
    );
    if (companyKey) {
      return carrierShortUrls[companyKey](trackingNumber);
    }
  }

  // If original URL is already short enough (< 50 chars), use it
  if (trackingUrl && trackingUrl.length < 50) {
    return trackingUrl;
  }

  // If we have tracking number but no company match, just show the number
  if (trackingNumber && !trackingUrl) {
    return `Tracking #: ${trackingNumber}`;
  }

  // For long URLs, try to extract and use just the tracking number with carrier
  if (trackingUrl) {
    // Detect carrier from URL and create short version
    if (trackingUrl.includes('ups.com')) {
      const match = trackingUrl.match(/trackNums?=([A-Z0-9]+)/i);
      if (match) return `https://ups.com/track?tracknum=${match[1]}`;
    }
    if (trackingUrl.includes('usps.com')) {
      const match = trackingUrl.match(/tLabels=([A-Z0-9]+)/i);
      if (match) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${match[1]}`;
    }
    if (trackingUrl.includes('fedex.com')) {
      const match = trackingUrl.match(/trknbr=([A-Z0-9]+)/i);
      if (match) return `https://fedex.com/fedextrack/?trknbr=${match[1]}`;
    }
  }

  // Fallback: if URL is too long, just show tracking number
  if (trackingUrl && trackingUrl.length > 60 && trackingNumber) {
    return `Tracking #: ${trackingNumber}`;
  }

  return trackingUrl || `Tracking #: ${trackingNumber}`;
};

// ==================== MESSAGE TEMPLATES (dynamic) ====================
// These generate messages from templates, supporting variable replacement
const TEMPLATES = {
  order_confirmation: (data) => {
    const template = triggerSettings.order_confirmation?.template || DEFAULT_TEMPLATES.order_confirmation;
    return replaceVariables(template, data);
  },
  shipping_notification: (data) => {
    const template = triggerSettings.shipping_notification?.template || DEFAULT_TEMPLATES.shipping_notification;
    // Use shortened tracking URL
    const shortUrl = shortenTrackingUrl(data.trackingUrl, data.trackingNumber, data.trackingCompany);
    return replaceVariables(template, { ...data, trackingUrl: shortUrl });
  },
  delivery_confirmation: (data) => {
    const template = triggerSettings.delivery_confirmation?.template || DEFAULT_TEMPLATES.delivery_confirmation;
    return replaceVariables(template, data);
  },
  order_cancelled: (data) => {
    const template = triggerSettings.order_cancelled?.template || DEFAULT_TEMPLATES.order_cancelled;
    return replaceVariables(template, data);
  },
  delayed_shipment: (data) => {
    const template = triggerSettings.delayed_shipment?.template || DEFAULT_TEMPLATES.delayed_shipment;
    return replaceVariables(template, data);
  }
};

/**
 * Replace template variables with actual data
 */
const replaceVariables = (template, data) => {
  const name = data.customerName?.split(' ')[0] || 'friend';
  const trackingInfo = data.trackingUrl || data.trackingNumber || '';
  const cancelReason = data.cancelReason ? `Reason: ${data.cancelReason}. ` : '';

  return template
    .replace(/\{customerName\}/g, name)
    .replace(/\{orderNumber\}/g, data.orderNumber || '')
    .replace(/\{orderTotal\}/g, data.orderTotal || '')
    .replace(/\{trackingNumber\}/g, data.trackingNumber || '')
    .replace(/\{trackingUrl\}/g, trackingInfo)
    .replace(/\{cancelReason\}/g, cancelReason);
};

// ==================== TRIGGER SETTINGS ====================
// In-memory settings (can be moved to DB later for dashboard control)
let triggerSettings = {
  order_confirmation: { enabled: true, template: null },
  shipping_notification: { enabled: true, template: null },
  delivery_confirmation: { enabled: true, template: null },
  order_cancelled: { enabled: true, template: null },
  delayed_shipment: { enabled: true, template: null, delayHours: 72 }
};

// ==================== HELPER FUNCTIONS ====================

/**
 * Format phone number to E.164
 */
const formatPhone = (phone) => {
  if (!phone) return null;
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length === 10) return `+1${cleaned}`;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  if (cleaned.startsWith('+')) return phone;
  return null;
};

/**
 * Check if customer has SMS opt-in
 */
const checkOptIn = async (phone) => {
  const formattedPhone = formatPhone(phone);
  if (!formattedPhone) return { optedIn: false, subscriber: null };

  const subscriber = await SmsSubscriber.findOne({
    phone: formattedPhone,
    status: 'active'
  });

  return {
    optedIn: !!subscriber,
    subscriber: subscriber
  };
};

/**
 * Extract phone from Shopify order
 */
const extractPhone = (order) => {
  // Try shipping address first, then billing, then customer
  return order.shipping_address?.phone ||
         order.billing_address?.phone ||
         order.customer?.phone ||
         order.phone ||
         null;
};

/**
 * Extract customer name from order
 */
const extractCustomerName = (order) => {
  if (order.customer?.first_name) {
    return `${order.customer.first_name} ${order.customer.last_name || ''}`.trim();
  }
  if (order.shipping_address?.first_name) {
    return `${order.shipping_address.first_name} ${order.shipping_address.last_name || ''}`.trim();
  }
  if (order.billing_address?.first_name) {
    return `${order.billing_address.first_name} ${order.billing_address.last_name || ''}`.trim();
  }
  return null;
};

// ==================== MAIN TRIGGER FUNCTIONS ====================

/**
 * Send Order Confirmation SMS
 * Triggered by: orders/create webhook
 */
const sendOrderConfirmation = async (order) => {
  const triggerType = 'order_confirmation';

  try {
    // Check if trigger is enabled
    if (!triggerSettings[triggerType]?.enabled) {
      console.log(`📱 [${triggerType}] Trigger disabled, skipping`);
      return { success: false, reason: 'trigger_disabled' };
    }

    const orderId = order.id?.toString();
    const orderNumber = order.order_number || order.name?.replace('#', '') || orderId;

    console.log(`📱 [${triggerType}] Processing order #${orderNumber}`);

    // Check if already sent
    const alreadySent = await SmsTransactional.alreadySent(orderId, triggerType);
    if (alreadySent) {
      console.log(`   ⏭️ Already sent, skipping`);
      return { success: false, reason: 'already_sent' };
    }

    // Get phone
    const phone = extractPhone(order);
    if (!phone) {
      console.log(`   ⚠️ No phone number found`);
      return { success: false, reason: 'no_phone' };
    }

    const formattedPhone = formatPhone(phone);
    if (!formattedPhone) {
      console.log(`   ⚠️ Invalid phone format: ${phone}`);
      return { success: false, reason: 'invalid_phone' };
    }

    // Check if subscriber exists (optional - for linking purposes only)
    const { subscriber } = await checkOptIn(formattedPhone);

    // Build message
    const customerName = extractCustomerName(order);
    const message = TEMPLATES[triggerType]({
      customerName,
      orderNumber,
      orderTotal: order.total_price
    });

    // Create log entry
    const smsLog = new SmsTransactional({
      triggerType,
      phone: formattedPhone,
      phoneFormatted: phone,
      customerName,
      customerEmail: order.email || order.customer?.email,
      customerId: order.customer?.id?.toString(),
      shopifyOrderId: orderId,
      orderNumber,
      orderName: order.name,
      orderTotal: parseFloat(order.total_price || 0),
      message,
      messageLength: message.length,
      optInVerified: false, // Transactional SMS - no opt-in required
      smsSubscriberId: subscriber?._id || null,
      status: 'pending'
    });

    await smsLog.save();

    // Send SMS with logging options
    console.log(`   📤 Sending SMS to ${formattedPhone}...`);
    const result = await telnyxService.sendSms(formattedPhone, message, {
      messageType: 'transactional',
      subscriberId: subscriber?._id,
      metadata: {
        triggerType,
        orderNumber,
        orderId
      }
    });

    // Update log
    smsLog.telnyxMessageId = result.messageId;
    smsLog.status = result.success ? 'sent' : 'failed';
    smsLog.sentAt = result.success ? new Date() : null;
    smsLog.error = result.error || null;
    smsLog.statusUpdatedAt = new Date();
    await smsLog.save();

    if (result.success) {
      console.log(`   ✅ Order confirmation sent for #${orderNumber}`);
    } else {
      console.log(`   ❌ Failed to send: ${result.error}`);
    }

    return {
      success: result.success,
      messageId: result.messageId,
      logId: smsLog._id
    };

  } catch (error) {
    console.error(`❌ [${triggerType}] Error:`, error);
    return { success: false, reason: 'error', error: error.message };
  }
};

/**
 * Send Shipping Notification SMS
 * Triggered by: orders/updated webhook (when fulfillment added)
 */
const sendShippingNotification = async (order, fulfillment) => {
  const triggerType = 'shipping_notification';

  try {
    // Check if trigger is enabled
    if (!triggerSettings[triggerType]?.enabled) {
      console.log(`📱 [${triggerType}] Trigger disabled, skipping`);
      return { success: false, reason: 'trigger_disabled' };
    }

    const orderId = order.id?.toString();
    const orderNumber = order.order_number || order.name?.replace('#', '') || orderId;
    const fulfillmentId = fulfillment?.id?.toString();

    console.log(`📱 [${triggerType}] Processing order #${orderNumber}, fulfillment ${fulfillmentId}`);

    // Must have tracking info
    const trackingNumber = fulfillment?.tracking_number || fulfillment?.tracking_numbers?.[0];
    const trackingUrl = fulfillment?.tracking_url || fulfillment?.tracking_urls?.[0];
    const trackingCompany = fulfillment?.tracking_company;

    if (!trackingNumber && !trackingUrl) {
      console.log(`   ⚠️ No tracking info found`);
      return { success: false, reason: 'no_tracking' };
    }

    // Check if already sent for this fulfillment
    const alreadySent = await SmsTransactional.alreadySent(orderId, triggerType, fulfillmentId);
    if (alreadySent) {
      console.log(`   ⏭️ Already sent for this fulfillment, skipping`);
      return { success: false, reason: 'already_sent' };
    }

    // Get phone
    const phone = extractPhone(order);
    if (!phone) {
      console.log(`   ⚠️ No phone number found`);
      return { success: false, reason: 'no_phone' };
    }

    const formattedPhone = formatPhone(phone);
    if (!formattedPhone) {
      console.log(`   ⚠️ Invalid phone format`);
      return { success: false, reason: 'invalid_phone' };
    }

    // Check if subscriber exists (optional - for linking purposes only)
    const { subscriber } = await checkOptIn(formattedPhone);

    // Build message
    const customerName = extractCustomerName(order);
    const message = TEMPLATES[triggerType]({
      customerName,
      orderNumber,
      trackingNumber,
      trackingUrl,
      trackingCompany
    });

    // Create log entry
    const smsLog = new SmsTransactional({
      triggerType,
      phone: formattedPhone,
      phoneFormatted: phone,
      customerName,
      customerEmail: order.email || order.customer?.email,
      customerId: order.customer?.id?.toString(),
      shopifyOrderId: orderId,
      orderNumber,
      orderName: order.name,
      orderTotal: parseFloat(order.total_price || 0),
      trackingNumber,
      trackingUrl,
      trackingCompany,
      fulfillmentId,
      message,
      messageLength: message.length,
      optInVerified: false, // Transactional SMS - no opt-in required
      smsSubscriberId: subscriber?._id || null,
      status: 'pending'
    });

    await smsLog.save();

    // Send SMS with logging options
    console.log(`   📤 Sending shipping SMS to ${formattedPhone}...`);
    const result = await telnyxService.sendSms(formattedPhone, message, {
      messageType: 'transactional',
      subscriberId: subscriber?._id,
      metadata: {
        triggerType,
        orderNumber,
        orderId,
        trackingNumber,
        trackingCompany
      }
    });

    // Update log
    smsLog.telnyxMessageId = result.messageId;
    smsLog.status = result.success ? 'sent' : 'failed';
    smsLog.sentAt = result.success ? new Date() : null;
    smsLog.error = result.error || null;
    smsLog.statusUpdatedAt = new Date();
    await smsLog.save();

    if (result.success) {
      console.log(`   ✅ Shipping notification sent for #${orderNumber}`);
    } else {
      console.log(`   ❌ Failed to send: ${result.error}`);
    }

    return {
      success: result.success,
      messageId: result.messageId,
      logId: smsLog._id
    };

  } catch (error) {
    console.error(`❌ [${triggerType}] Error:`, error);
    return { success: false, reason: 'error', error: error.message };
  }
};

/**
 * Send Delivery Confirmation SMS
 * Triggered by: fulfillments/update webhook (when status = delivered)
 * Note: This depends on carrier reporting delivery status to Shopify
 */
const sendDeliveryConfirmation = async (order, fulfillment) => {
  const triggerType = 'delivery_confirmation';

  try {
    // Check if trigger is enabled
    if (!triggerSettings[triggerType]?.enabled) {
      console.log(`📱 [${triggerType}] Trigger disabled, skipping`);
      return { success: false, reason: 'trigger_disabled' };
    }

    const orderId = order.id?.toString();
    const orderNumber = order.order_number || order.name?.replace('#', '') || orderId;
    const fulfillmentId = fulfillment?.id?.toString();

    console.log(`📱 [${triggerType}] Processing order #${orderNumber}`);

    // Check if already sent
    const alreadySent = await SmsTransactional.alreadySent(orderId, triggerType, fulfillmentId);
    if (alreadySent) {
      console.log(`   ⏭️ Already sent, skipping`);
      return { success: false, reason: 'already_sent' };
    }

    // Get phone
    const phone = extractPhone(order);
    if (!phone) {
      console.log(`   ⚠️ No phone number found`);
      return { success: false, reason: 'no_phone' };
    }

    const formattedPhone = formatPhone(phone);
    if (!formattedPhone) {
      console.log(`   ⚠️ Invalid phone format`);
      return { success: false, reason: 'invalid_phone' };
    }

    // Check if subscriber exists (optional - for linking purposes only)
    const { subscriber } = await checkOptIn(formattedPhone);

    // Build message
    const customerName = extractCustomerName(order);
    const message = TEMPLATES[triggerType]({
      customerName,
      orderNumber
    });

    // Create log entry
    const smsLog = new SmsTransactional({
      triggerType,
      phone: formattedPhone,
      phoneFormatted: phone,
      customerName,
      customerEmail: order.email || order.customer?.email,
      customerId: order.customer?.id?.toString(),
      shopifyOrderId: orderId,
      orderNumber,
      orderName: order.name,
      fulfillmentId,
      message,
      messageLength: message.length,
      optInVerified: false, // Transactional SMS - no opt-in required
      smsSubscriberId: subscriber?._id || null,
      status: 'pending'
    });

    await smsLog.save();

    // Send SMS with logging options
    console.log(`   📤 Sending delivery SMS to ${formattedPhone}...`);
    const result = await telnyxService.sendSms(formattedPhone, message, {
      messageType: 'transactional',
      subscriberId: subscriber?._id,
      metadata: {
        triggerType,
        orderNumber,
        orderId
      }
    });

    // Update log
    smsLog.telnyxMessageId = result.messageId;
    smsLog.status = result.success ? 'sent' : 'failed';
    smsLog.sentAt = result.success ? new Date() : null;
    smsLog.error = result.error || null;
    smsLog.statusUpdatedAt = new Date();
    await smsLog.save();

    if (result.success) {
      console.log(`   ✅ Delivery confirmation sent for #${orderNumber}`);
    } else {
      console.log(`   ❌ Failed to send: ${result.error}`);
    }

    return {
      success: result.success,
      messageId: result.messageId,
      logId: smsLog._id
    };

  } catch (error) {
    console.error(`❌ [${triggerType}] Error:`, error);
    return { success: false, reason: 'error', error: error.message };
  }
};

/**
 * Send Order Cancelled SMS
 * Triggered by: orders/cancelled webhook
 */
const sendOrderCancelled = async (order, cancelReason = null) => {
  const triggerType = 'order_cancelled';

  try {
    // Check if trigger is enabled
    if (!triggerSettings[triggerType]?.enabled) {
      console.log(`📱 [${triggerType}] Trigger disabled, skipping`);
      return { success: false, reason: 'trigger_disabled' };
    }

    const orderId = order.id?.toString();
    const orderNumber = order.order_number || order.name?.replace('#', '') || orderId;

    console.log(`📱 [${triggerType}] Processing order #${orderNumber}`);

    // Check if already sent
    const alreadySent = await SmsTransactional.alreadySent(orderId, triggerType);
    if (alreadySent) {
      console.log(`   ⏭️ Already sent, skipping`);
      return { success: false, reason: 'already_sent' };
    }

    // Get phone
    const phone = extractPhone(order);
    if (!phone) {
      console.log(`   ⚠️ No phone number found`);
      return { success: false, reason: 'no_phone' };
    }

    const formattedPhone = formatPhone(phone);
    if (!formattedPhone) {
      console.log(`   ⚠️ Invalid phone format: ${phone}`);
      return { success: false, reason: 'invalid_phone' };
    }

    // Check if subscriber exists (optional - for linking purposes only)
    const { subscriber } = await checkOptIn(formattedPhone);

    // Extract cancel reason from order if not provided
    const reason = cancelReason || order.cancel_reason || null;

    // Build message
    const customerName = extractCustomerName(order);
    const message = TEMPLATES[triggerType]({
      customerName,
      orderNumber,
      cancelReason: reason
    });

    // Create log entry
    const smsLog = new SmsTransactional({
      triggerType,
      phone: formattedPhone,
      phoneFormatted: phone,
      customerName,
      customerEmail: order.email || order.customer?.email,
      customerId: order.customer?.id?.toString(),
      shopifyOrderId: orderId,
      orderNumber,
      orderName: order.name,
      orderTotal: parseFloat(order.total_price || 0),
      message,
      messageLength: message.length,
      optInVerified: false, // Transactional SMS - no opt-in required
      smsSubscriberId: subscriber?._id || null,
      status: 'pending',
      metadata: { cancelReason: reason }
    });

    await smsLog.save();

    // Send SMS with logging options
    console.log(`   📤 Sending cancellation SMS to ${formattedPhone}...`);
    const result = await telnyxService.sendSms(formattedPhone, message, {
      messageType: 'transactional',
      subscriberId: subscriber?._id,
      metadata: {
        triggerType,
        orderNumber,
        orderId,
        cancelReason: reason
      }
    });

    // Update log
    smsLog.telnyxMessageId = result.messageId;
    smsLog.status = result.success ? 'sent' : 'failed';
    smsLog.sentAt = result.success ? new Date() : null;
    smsLog.error = result.error || null;
    smsLog.statusUpdatedAt = new Date();
    await smsLog.save();

    if (result.success) {
      console.log(`   ✅ Order cancellation SMS sent for #${orderNumber}`);
    } else {
      console.log(`   ❌ Failed to send: ${result.error}`);
    }

    return {
      success: result.success,
      messageId: result.messageId,
      logId: smsLog._id
    };

  } catch (error) {
    console.error(`❌ [${triggerType}] Error:`, error);
    return { success: false, reason: 'error', error: error.message };
  }
};

/**
 * Send Delayed Shipment Notification SMS
 * Triggered by: Scheduled job checking for unfulfilled orders > 72 hours
 */
const sendDelayedShipmentNotification = async (order) => {
  const triggerType = 'delayed_shipment';

  try {
    // Check if trigger is enabled
    if (!triggerSettings[triggerType]?.enabled) {
      console.log(`📱 [${triggerType}] Trigger disabled, skipping`);
      return { success: false, reason: 'trigger_disabled' };
    }

    const orderId = order.id?.toString();
    const orderNumber = order.order_number || order.name?.replace('#', '') || orderId;

    console.log(`📱 [${triggerType}] Processing order #${orderNumber}`);

    // Check if already sent
    const alreadySent = await SmsTransactional.alreadySent(orderId, triggerType);
    if (alreadySent) {
      console.log(`   ⏭️ Already sent, skipping`);
      return { success: false, reason: 'already_sent' };
    }

    // Get phone
    const phone = extractPhone(order);
    if (!phone) {
      console.log(`   ⚠️ No phone number found`);
      return { success: false, reason: 'no_phone' };
    }

    const formattedPhone = formatPhone(phone);
    if (!formattedPhone) {
      console.log(`   ⚠️ Invalid phone format: ${phone}`);
      return { success: false, reason: 'invalid_phone' };
    }

    // Check if subscriber exists (optional - for linking purposes only)
    const { subscriber } = await checkOptIn(formattedPhone);

    // Build message
    const customerName = extractCustomerName(order);
    const message = TEMPLATES[triggerType]({
      customerName,
      orderNumber
    });

    // Create log entry
    const smsLog = new SmsTransactional({
      triggerType,
      phone: formattedPhone,
      phoneFormatted: phone,
      customerName,
      customerEmail: order.email || order.customer?.email,
      customerId: order.customer?.id?.toString(),
      shopifyOrderId: orderId,
      orderNumber,
      orderName: order.name,
      orderTotal: parseFloat(order.total_price || 0),
      message,
      messageLength: message.length,
      optInVerified: false,
      smsSubscriberId: subscriber?._id || null,
      status: 'pending',
      metadata: {
        orderCreatedAt: order.created_at,
        hoursDelayed: Math.round((Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60))
      }
    });

    await smsLog.save();

    // Send SMS with logging options
    console.log(`   📤 Sending delayed shipment SMS to ${formattedPhone}...`);
    const result = await telnyxService.sendSms(formattedPhone, message, {
      messageType: 'transactional',
      subscriberId: subscriber?._id,
      metadata: {
        triggerType,
        orderNumber,
        orderId,
        orderCreatedAt: order.created_at,
        hoursDelayed: Math.round((Date.now() - new Date(order.created_at).getTime()) / (1000 * 60 * 60))
      }
    });

    // Update log
    smsLog.telnyxMessageId = result.messageId;
    smsLog.status = result.success ? 'sent' : 'failed';
    smsLog.sentAt = result.success ? new Date() : null;
    smsLog.error = result.error || null;
    smsLog.statusUpdatedAt = new Date();
    await smsLog.save();

    if (result.success) {
      console.log(`   ✅ Delayed shipment SMS sent for #${orderNumber}`);
    } else {
      console.log(`   ❌ Failed to send: ${result.error}`);
    }

    return {
      success: result.success,
      messageId: result.messageId,
      logId: smsLog._id
    };

  } catch (error) {
    console.error(`❌ [${triggerType}] Error:`, error);
    return { success: false, reason: 'error', error: error.message };
  }
};

/**
 * Get delay hours setting for delayed shipment trigger
 */
const getDelayHours = () => {
  return triggerSettings.delayed_shipment?.delayHours || 72;
};

// ==================== SETTINGS MANAGEMENT ====================

/**
 * Get trigger settings
 */
const getSettings = () => {
  return { ...triggerSettings };
};

/**
 * Update trigger settings
 */
const updateSettings = (newSettings) => {
  triggerSettings = {
    ...triggerSettings,
    ...newSettings
  };
  console.log('📱 Trigger settings updated:', triggerSettings);
  return triggerSettings;
};

/**
 * Toggle a specific trigger
 */
const toggleTrigger = (triggerType, enabled) => {
  if (triggerSettings[triggerType]) {
    triggerSettings[triggerType].enabled = enabled;
    console.log(`📱 Trigger ${triggerType}: ${enabled ? 'ENABLED' : 'DISABLED'}`);
    return true;
  }
  return false;
};

// ==================== STATS ====================

/**
 * Get transactional SMS stats
 */
const getStats = async (days = 30) => {
  const stats = await SmsTransactional.getStatsByTrigger(days);

  const totals = {
    total: 0,
    sent: 0,
    delivered: 0,
    failed: 0
  };

  Object.values(stats).forEach(s => {
    totals.total += s.total;
    totals.sent += s.sent;
    totals.delivered += s.delivered;
    totals.failed += s.failed;
  });

  return {
    byTrigger: stats,
    totals,
    settings: triggerSettings
  };
};

/**
 * Get recent transactional SMS
 */
const getRecent = async (limit = 50) => {
  return SmsTransactional.find()
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

// ==================== EXPORTS ====================

module.exports = {
  // Triggers
  sendOrderConfirmation,
  sendShippingNotification,
  sendDeliveryConfirmation,
  sendOrderCancelled,
  sendDelayedShipmentNotification,

  // Settings
  getSettings,
  updateSettings,
  toggleTrigger,
  getDelayHours,

  // Stats
  getStats,
  getRecent,

  // Templates (for preview)
  TEMPLATES,
  DEFAULT_TEMPLATES
};
