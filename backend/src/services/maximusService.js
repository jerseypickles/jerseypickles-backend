// backend/src/services/maximusService.js
// 🏛️ MAXIMUS - Autonomous Email Campaign Agent
// Named after the greatest gladiator - he fights for your revenue

const Anthropic = require('@anthropic-ai/sdk');
const MaximusConfig = require('../models/MaximusConfig');
const MaximusCampaignLog = require('../models/MaximusCampaignLog');
const Campaign = require('../models/Campaign');
const List = require('../models/List');
const apolloService = require('./apolloService');

// Lazy load shopifyService to avoid circular deps
let shopifyService = null;
const getShopifyService = () => {
  if (!shopifyService) {
    try { shopifyService = require('./shopifyService'); } catch (e) {}
  }
  return shopifyService;
};

class MaximusService {
  constructor() {
    this.client = null;
    this.model = 'claude-sonnet-4-6';
    this.initialized = false;
  }

  // ==================== INITIALIZATION ====================

  init() {
    if (this.initialized) return;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.log('🏛️ Maximus: ANTHROPIC_API_KEY not configured');
      return;
    }

    try {
      this.client = new Anthropic({ apiKey });
      this.initialized = true;
      console.log('🏛️ Maximus: Initialized');
    } catch (error) {
      console.error('🏛️ Maximus: Init error:', error.message);
    }
  }

  isAvailable() {
    return this.initialized && this.client !== null;
  }

  // ==================== MAIN EXECUTION ====================

  /**
   * Main daily execution - called by maximusJob
   * Maximus decides everything: whether to send, what, to whom, when
   */
  async execute() {
    console.log('\n🏛️ ═══════════════════════════════════════');
    console.log('   MAXIMUS - Campaign Agent Executing');
    console.log('═══════════════════════════════════════\n');

    const config = await MaximusConfig.getConfig();

    // Check if active
    if (!config.active) {
      console.log('🏛️ Maximus: Dormant (not active)');
      return { executed: false, reason: 'not_active' };
    }

    if (!config.creativeAgentReady) {
      console.log('🏛️ Maximus: Waiting for creative agent');
      return { executed: false, reason: 'creative_agent_not_ready' };
    }

    // Check weekly limit
    const campaignsThisWeek = await MaximusCampaignLog.getCampaignsThisWeek();
    if (campaignsThisWeek.length >= config.maxCampaignsPerWeek) {
      console.log(`🏛️ Maximus: Weekly limit reached (${campaignsThisWeek.length}/${config.maxCampaignsPerWeek})`);
      return { executed: false, reason: 'weekly_limit_reached' };
    }

    // Check if already sent today
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sentToday = campaignsThisWeek.find(c =>
      new Date(c.sentAt) >= today
    );
    if (sentToday) {
      console.log('🏛️ Maximus: Already sent today');
      return { executed: false, reason: 'already_sent_today' };
    }

    // Check if today is a rest day
    if (!config.canSendToday()) {
      console.log('🏛️ Maximus: Today is a rest day');
      return { executed: false, reason: 'rest_day' };
    }

    // Check lists
    if (!config.lists || config.lists.length === 0) {
      console.log('🏛️ Maximus: No lists configured');
      return { executed: false, reason: 'no_lists' };
    }

    // Gather learning data
    const learningData = await this.gatherLearningData();

    // Ask Claude to make decisions
    const decision = await this.makeDecision(config, learningData, campaignsThisWeek);
    if (!decision) {
      console.log('🏛️ Maximus: Could not make decision');
      return { executed: false, reason: 'decision_failed' };
    }

    console.log('🏛️ Maximus Decision:');
    console.log(`   Subject: "${decision.subjectLine}"`);
    console.log(`   Preview: "${decision.previewText}"`);
    console.log(`   Product: ${decision.product}`);
    console.log(`   Discount: ${decision.discountPercent}% OFF`);
    console.log(`   Code: ${decision.discountCode}`);
    console.log(`   List: ${decision.listName}`);
    console.log(`   Hour: ${decision.sendHour}:00`);

    // Step 2: Create Shopify discount code
    console.log('\n🏛️ Maximus: Creating Shopify discount code...');
    const discountResult = await this.createShopifyDiscount(decision);
    if (!discountResult.success) {
      console.error('🏛️ Maximus: Failed to create discount code:', discountResult.error);
      return { executed: false, reason: 'discount_creation_failed', error: discountResult.error };
    }
    console.log(`🏛️ Maximus: ✅ Discount code "${decision.discountCode}" created`);

    // Step 3: Ask Apollo to generate creative
    console.log('\n🏛️ Maximus: Requesting creative from Apollo...');
    apolloService.init();
    const creative = await apolloService.generateCreative({
      product: decision.product,
      discount: `${decision.discountPercent}% OFF TODAY ONLY`,
      code: decision.discountCode,
      headline: decision.headline || decision.subjectLine,
      productName: decision.productName
    });

    if (!creative.success) {
      console.error('🏛️ Maximus: Apollo failed:', creative.error);
      return { executed: false, reason: 'creative_generation_failed', error: creative.error };
    }
    console.log(`🏛️ Maximus: ✅ Creative received from Apollo (${(creative.generationTime / 1000).toFixed(1)}s)`);

    // Step 4: Build email HTML
    const htmlContent = apolloService.buildEmailHtml(creative.imageUrl, {
      headline: decision.headline || decision.subjectLine,
      product: decision.product,
      discount: `${decision.discountPercent}% OFF`,
      code: decision.discountCode
    });

    // Step 5: Schedule campaign
    const result = await this.scheduleCampaign(config, decision, htmlContent);

    return { executed: true, ...result, imageUrl: creative.imageUrl };
  }

  // ==================== DECISION MAKING ====================

  /**
   * Ask Claude Sonnet 4.6 to decide subject, preview text, list, and timing
   */
  async makeDecision(config, learningData, campaignsThisWeek) {
    if (!this.isAvailable()) {
      console.log('🏛️ Maximus: Claude not available');
      return null;
    }

    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const now = new Date();
    const today = dayNames[now.getDay()];

    const listsInfo = config.lists.map(l => `- "${l.name}" (ID: ${l.listId})`).join('\n');

    const recentCampaigns = campaignsThisWeek.map(c =>
      `- "${c.subjectLine}" → List: ${c.listName}, Day: ${c.sentDay}, Hour: ${c.sentHour}:00, Open: ${c.metrics.openRate}%, Click: ${c.metrics.clickRate}%`
    ).join('\n') || 'No campaigns sent this week yet.';

    let learningSection = 'No historical data yet (initial phase).';
    if (learningData.totalCampaigns > 0) {
      learningSection = `Historical data (${learningData.totalCampaigns} campaigns):
- Average open rate: ${learningData.avgOpenRate?.toFixed(1)}%
- Average click rate: ${learningData.avgClickRate?.toFixed(1)}%
- Total revenue: $${learningData.totalRevenue?.toFixed(0)}

Best performing days:
${learningData.byDay?.map(d => `  ${d._id}: ${d.avgOpenRate?.toFixed(1)}% opens, ${d.avgClickRate?.toFixed(1)}% clicks (${d.campaigns} campaigns)`).join('\n') || '  No data yet'}

Best performing hours:
${learningData.byHour?.map(h => `  ${h._id}:00: ${h.avgOpenRate?.toFixed(1)}% opens, ${h.avgClickRate?.toFixed(1)}% clicks (${h.campaigns} campaigns)`).join('\n') || '  No data yet'}

Performance by list:
${learningData.byList?.map(l => `  "${l.listName}": ${l.avgOpenRate?.toFixed(1)}% opens, ${l.avgClickRate?.toFixed(1)}% clicks (${l.campaigns} campaigns)`).join('\n') || '  No data yet'}`;
    }

    // Get available products from Apollo bank
    const ApolloConfig = require('../models/ApolloConfig');
    const apolloConfig = await ApolloConfig.getConfig();
    const availableProducts = apolloConfig.getActiveProducts();
    const productsInfo = availableProducts.length > 0
      ? availableProducts.map(p => `- "${p.name}" (slug: ${p.slug}, category: ${p.category})`).join('\n')
      : '- No products configured yet';

    const recentInsights = await this._getRecentInsights();

    // Calculate current ET hour for the prompt
    const currentETHour = parseInt(now.toLocaleString('en-US', { timeZone: config.timezone, hour: 'numeric', hour12: false }));
    const earliestSendHour = Math.max(config.sendWindowStart, currentETHour + 1);

    // Collect existing discount codes this week to avoid duplicates
    const usedCodes = campaignsThisWeek.map(c => c.reasoning?.discountCode).filter(Boolean);
    const existingCampaignTags = await Campaign.find({
      tags: 'maximus',
      createdAt: { $gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) }
    }).select('tags').lean();
    const usedCodesFromTags = existingCampaignTags.flatMap(c => (c.tags || []).filter(t => t === t.toUpperCase() && t.length >= 4 && t.length <= 12));
    const allUsedCodes = [...new Set([...usedCodes, ...usedCodesFromTags])];

    // Count campaign types this week
    const promoThisWeek = campaignsThisWeek.filter(c => c.campaignType === 'promotional').length;
    const contentThisWeek = campaignsThisWeek.filter(c => c.campaignType === 'content').length;
    const spotlightThisWeek = campaignsThisWeek.filter(c => c.campaignType === 'product_spotlight').length;

    const prompt = `You are MAXIMUS, an autonomous email campaign agent for Jersey Pickles - an artisanal pickle and gourmet olive shop from New Jersey.

TODAY: ${today}, ${now.toISOString().split('T')[0]}
CURRENT TIME: ${currentETHour}:00 ${config.timezone}
SEND WINDOW: ${config.sendWindowStart}:00 - ${config.sendWindowEnd}:00 (${config.timezone})
EARLIEST POSSIBLE SEND HOUR TODAY: ${earliestSendHour}:00 (must be AFTER current time)
${earliestSendHour >= config.sendWindowEnd ? 'NOTE: Today\'s send window has closed. Schedule for tomorrow — pick any hour in the send window.' : ''}
CAMPAIGNS LEFT THIS WEEK: ${config.maxCampaignsPerWeek - campaignsThisWeek.length}

AVAILABLE LISTS:
${listsInfo}

AVAILABLE PRODUCTS (for creative):
${productsInfo}

THIS WEEK'S CAMPAIGNS:
${recentCampaigns}
Types sent this week: ${promoThisWeek} promotional, ${contentThisWeek} content, ${spotlightThisWeek} product spotlight

LEARNING DATA:
${learningSection}

YOUR MEMORY (lessons from past campaigns):
${config.memory?.insights?.length > 0 ? config.memory.insights.map(i => `- ${i}`).join('\n') : 'No memories yet — this is early stage.'}

RECENT CAMPAIGN INSIGHTS:
${recentInsights}

BRAND VOICE:
- Warm, friendly, artisanal, family-oriented
- Products: Pickles, Olives, Marinated Mushrooms, Pickled Vegetables, Gift Sets
- NOT overly commercial - focus on craft and quality
- Use emojis sparingly (max 1-2)
- Keep subjects under 50 characters
- Preview text should complement the subject, not repeat it

CAMPAIGN TYPES — you MUST choose one:

1. "promotional" — Discount offer (15-30% OFF). Use max 1-2x/week. Include discount code.
   Example subjects: "20% OFF Hot Tomatoes today only", "Your weekend pickle deal 🥒"

2. "content" — Storytelling, recipes, behind the scenes. NO discount. Build brand love & engagement.
   Example subjects: "The secret behind our Hot Tomatoes", "3 ways to enjoy pickles this weekend"

3. "product_spotlight" — Feature a product without discount. Highlight quality, craft, ingredients. Link to shop.
   Example subjects: "Meet our Hot Tomatoes 🍅", "Why our olives are different"

STRATEGY: Balance your week. Don't send 5 promos — mix it up. Ideal week: 1-2 promotional + 2-3 content/spotlight.
If you already sent a promo this week, strongly prefer content or spotlight.

YOUR TASK:
1. Choose campaign type (promotional, content, or product_spotlight)
2. Subject line (compelling, under 50 chars)
3. Preview text (adds context, under 80 chars)
4. Headline for the creative image
5. Which product to feature
6. ONLY if type is "promotional": discount percentage (15-30%) and discount code (ALL CAPS, unique). Do NOT reuse: ${allUsedCodes.join(', ') || 'none yet'}
7. Which list to send to
8. What hour to send — MUST be >= ${earliestSendHour} and < ${config.sendWindowEnd} (current time is ${currentETHour}:00 ET)${earliestSendHour >= config.sendWindowEnd ? '. Today is over — pick hour for TOMORROW.' : ''}

${learningData.totalCampaigns < 7 ? 'LEARNING PHASE: Try different types, hours, and lists to gather data.' : 'OPTIMIZED PHASE: Use your learning data to pick the best performing time and list.'}

DO NOT repeat a subject line used this week.

Respond ONLY with valid JSON:
{
  "campaignType": "promotional|content|product_spotlight",
  "subjectLine": "...",
  "previewText": "...",
  "headline": "...",
  "product": "<product slug>",
  "productName": "<product full name>",
  "discountPercent": <number 15-30 or null if not promotional>,
  "discountCode": "<SHORT_CODE or null if not promotional>",
  "contentAngle": "<only for content/spotlight: what story or angle to use>",
  "listId": "...",
  "listName": "...",
  "sendHour": <number>,
  "reasoning": {
    "whyThisType": "...",
    "whyThisSubject": "...",
    "whyThisProduct": "...",
    "whyThisList": "...",
    "whyThisTime": "..."
  }
}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      });

      const content = response.content?.[0]?.text || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('🏛️ Maximus: Could not parse Claude response');
        return null;
      }

      const decision = JSON.parse(jsonMatch[0]);

      // Validate the decision
      const validList = config.lists.find(l => l.listId.toString() === decision.listId);
      if (!validList) {
        console.error('🏛️ Maximus: Invalid list selected');
        return null;
      }

      // Validate send hour — must be in the future and within window
      if (decision.sendHour < earliestSendHour || decision.sendHour >= config.sendWindowEnd) {
        // If today's window is still open, use earliest available hour
        if (earliestSendHour < config.sendWindowEnd) {
          decision.sendHour = earliestSendHour;
        } else {
          // Window closed — keep Claude's choice, calculateScheduledAt will push to tomorrow
          decision.sendHour = Math.max(config.sendWindowStart, Math.min(decision.sendHour, config.sendWindowEnd - 1));
        }
      }

      return decision;

    } catch (error) {
      console.error('🏛️ Maximus: Claude error:', error.message);
      return null;
    }
  }

  // ==================== PROPOSAL SYSTEM ====================

  /**
   * Generate a proposal for human review (does NOT schedule)
   * Creates discount, generates creative, saves as pending proposal
   */
  async generateProposal() {
    console.log('\n🏛️ ═══════════════════════════════════════');
    console.log('   MAXIMUS - Generating Proposal for Review');
    console.log('═══════════════════════════════════════\n');

    const config = await MaximusConfig.getConfig();

    // Check for existing pending proposal
    if (config.pendingProposal?.active) {
      console.log('🏛️ Maximus: Already has a pending proposal');
      return { success: false, reason: 'pending_proposal_exists' };
    }

    // Check lists
    if (!config.lists || config.lists.length === 0) {
      return { success: false, reason: 'no_lists' };
    }

    // Check weekly limit
    const campaignsThisWeek = await MaximusCampaignLog.getCampaignsThisWeek();
    if (campaignsThisWeek.length >= config.maxCampaignsPerWeek) {
      console.log(`🏛️ Maximus: Weekly limit reached (${campaignsThisWeek.length}/${config.maxCampaignsPerWeek})`);
      return { success: false, reason: 'weekly_limit_reached', detail: `${campaignsThisWeek.length}/${config.maxCampaignsPerWeek} campaigns this week` };
    }

    // Check if there's already a campaign SCHEDULED for today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);

    const scheduledToday = await Campaign.findOne({
      tags: 'maximus',
      status: { $in: ['scheduled', 'sending', 'sent', 'preparing'] },
      scheduledAt: { $gte: todayStart, $lt: tomorrowStart }
    }).lean();

    if (scheduledToday) {
      console.log('🏛️ Maximus: Already has a campaign scheduled for today');
      return { success: false, reason: 'already_sent_today' };
    }

    // Gather learning data
    const learningData = await this.gatherLearningData();

    // Step 1: Ask Claude for decision
    const decision = await this.makeDecision(config, learningData, campaignsThisWeek);
    if (!decision) {
      return { success: false, reason: 'decision_failed' };
    }

    // Default campaignType if missing
    if (!decision.campaignType) decision.campaignType = 'promotional';

    console.log('🏛️ Maximus Proposal Decision:');
    console.log(`   Type: ${decision.campaignType}`);
    console.log(`   Subject: "${decision.subjectLine}"`);
    console.log(`   Product: ${decision.product}`);
    if (decision.campaignType === 'promotional') {
      console.log(`   Discount: ${decision.discountPercent}% OFF (${decision.discountCode})`);
    } else {
      console.log(`   Angle: ${decision.contentAngle || 'N/A'}`);
    }
    console.log(`   List: ${decision.listName}`);

    // Step 2: Generate creative with Apollo
    let imageUrl = null;
    let htmlContent = null;

    apolloService.init();
    if (apolloService.isAvailable()) {
      console.log('\n🏛️ Maximus: Requesting creative from Apollo...');

      const apolloBrief = {
        product: decision.product,
        headline: decision.headline || decision.subjectLine,
        productName: decision.productName,
        campaignType: decision.campaignType
      };

      if (decision.campaignType === 'promotional') {
        apolloBrief.discount = `${decision.discountPercent}% OFF TODAY ONLY`;
        apolloBrief.code = decision.discountCode;
      } else {
        apolloBrief.discount = null;
        apolloBrief.code = null;
        apolloBrief.contentAngle = decision.contentAngle;
      }

      const creative = await apolloService.generateCreative(apolloBrief);

      if (creative.success) {
        imageUrl = creative.imageUrl;
        htmlContent = apolloService.buildEmailHtml(creative.imageUrl, {
          headline: decision.headline || decision.subjectLine,
          product: decision.product,
          discount: decision.campaignType === 'promotional' ? `${decision.discountPercent}% OFF` : null,
          code: decision.campaignType === 'promotional' ? decision.discountCode : null,
          campaignType: decision.campaignType,
          contentAngle: decision.contentAngle
        });
        console.log(`🏛️ Maximus: ✅ Creative received from Apollo`);
      } else {
        console.warn('🏛️ Maximus: Apollo failed, proposal will be without image:', creative.error);
      }
    } else {
      console.log('🏛️ Maximus: Apollo not available, proposal without image');
    }

    // Step 4: Calculate when it would be sent
    const config2 = await MaximusConfig.getConfig();
    const scheduledAt = this.calculateScheduledAt(decision.sendHour, config2.timezone || 'America/New_York');

    // Step 5: Save as pending proposal
    config.pendingProposal = {
      active: true,
      createdAt: new Date(),
      scheduledAt,
      decision: {
        campaignType: decision.campaignType,
        subjectLine: decision.subjectLine,
        previewText: decision.previewText,
        headline: decision.headline,
        product: decision.product,
        productName: decision.productName,
        contentAngle: decision.contentAngle,
        discountPercent: decision.campaignType === 'promotional' ? decision.discountPercent : null,
        discountCode: decision.campaignType === 'promotional' ? decision.discountCode : null,
        listId: decision.listId,
        listName: decision.listName,
        sendHour: decision.sendHour,
        reasoning: decision.reasoning
      },
      imageUrl,
      htmlContent,
      discountCreated: false
    };
    await config.save();

    console.log('🏛️ Maximus: ✅ Proposal saved, awaiting approval');

    return {
      success: true,
      proposal: config.pendingProposal
    };
  }

  /**
   * Approve the pending proposal → create and schedule the campaign
   */
  async approveProposal() {
    const config = await MaximusConfig.getConfig();

    if (!config.pendingProposal?.active) {
      return { success: false, reason: 'no_pending_proposal' };
    }

    const { decision, htmlContent, imageUrl } = config.pendingProposal;

    console.log(`🏛️ Maximus: Proposal APPROVED (${decision.campaignType || 'promotional'}) — scheduling campaign`);

    // Create Shopify discount code ONLY for promotional campaigns
    if (decision.campaignType === 'promotional' && decision.discountCode) {
      console.log('🏛️ Maximus: Creating Shopify discount code...');
      const discountResult = await this.createShopifyDiscount(decision);
      if (!discountResult.success) {
        console.error('🏛️ Maximus: Failed to create discount code:', discountResult.error);
        return { success: false, reason: 'discount_creation_failed', error: discountResult.error };
      }
      console.log(`🏛️ Maximus: ✅ Discount code "${decision.discountCode}" created`);
    }

    // Create and schedule the campaign
    const result = await this.scheduleCampaign(config, decision, htmlContent);

    // Clear the proposal
    config.pendingProposal = { active: false };
    await config.save();

    console.log(`🏛️ Maximus: ✅ Campaign scheduled (${result.campaignId})`);

    return { success: true, ...result, imageUrl };
  }

  /**
   * Reject the pending proposal
   */
  async rejectProposal(reason) {
    const config = await MaximusConfig.getConfig();

    if (!config.pendingProposal?.active) {
      return { success: false, reason: 'no_pending_proposal' };
    }

    const { decision } = config.pendingProposal;
    console.log(`🏛️ Maximus: Proposal REJECTED — "${decision.subjectLine}"`);
    if (reason) console.log(`   Reason: ${reason}`);

    // Clear the proposal
    config.pendingProposal = { active: false };
    await config.save();

    return { success: true, rejected: decision.subjectLine };
  }

  /**
   * Get the current pending proposal (if any)
   */
  async getProposal() {
    const config = await MaximusConfig.getConfig();
    const campaignsThisWeek = await MaximusCampaignLog.getCampaignsThisWeek();

    // Check if there's a campaign scheduled for today (not just logged today)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);

    const scheduledToday = await Campaign.findOne({
      tags: 'maximus',
      status: { $in: ['scheduled', 'sending', 'sent', 'preparing'] },
      scheduledAt: { $gte: todayStart, $lt: tomorrowStart }
    }).lean();

    const hasScheduledToday = !!scheduledToday;

    const availability = {
      canGenerate: !config.pendingProposal?.active && !hasScheduledToday && campaignsThisWeek.length < config.maxCampaignsPerWeek,
      sentToday: hasScheduledToday,
      thisWeek: campaignsThisWeek.length,
      maxPerWeek: config.maxCampaignsPerWeek,
      remaining: config.maxCampaignsPerWeek - campaignsThisWeek.length
    };

    if (!config.pendingProposal?.active) {
      return { exists: false, availability };
    }
    return { exists: true, proposal: config.pendingProposal, availability };
  }

  /**
   * Get recent campaign insights for the prompt
   */
  async _getRecentInsights() {
    const recentLogs = await MaximusCampaignLog.find({
      'claudeInsight.analyzedAt': { $exists: true }
    }).sort({ sentAt: -1 }).limit(5).lean();

    if (recentLogs.length === 0) return 'No analyzed campaigns yet.';

    return recentLogs.map(l =>
      `- "${l.subjectLine}" (${l.listName}, ${l.sentDay} ${l.sentHour}:00) → ${l.metrics.openRate}% opens, ${l.metrics.clickRate}% clicks, $${l.metrics.revenue} revenue. Lesson: ${l.claudeInsight.lessonForNext}`
    ).join('\n');
  }

  // ==================== SCHEDULING HELPERS ====================

  /**
   * Calculate the actual scheduledAt Date for a given hour in ET
   * If the hour has already passed today, schedules for tomorrow
   */
  calculateScheduledAt(sendHour, timezone = 'America/New_York') {
    const now = new Date();
    const etString = now.toLocaleString('en-US', { timeZone: timezone, hour12: false });
    const etNow = new Date(etString);
    const currentETHour = etNow.getHours();

    let hourDiff = sendHour - currentETHour;

    // If the hour has passed today, schedule for tomorrow
    if (hourDiff <= 0) {
      hourDiff += 24;
    }

    const scheduledAt = new Date(now.getTime() + hourDiff * 60 * 60 * 1000);
    scheduledAt.setMinutes(0, 0, 0);
    return scheduledAt;
  }

  // ==================== SHOPIFY DISCOUNT CODE ====================

  /**
   * Create a discount code in Shopify for this campaign
   */
  async createShopifyDiscount(decision) {
    try {
      const shopify = getShopifyService();
      if (!shopify) {
        return { success: false, error: 'Shopify service not available' };
      }

      const result = await shopify.createSmsDiscount(
        decision.discountCode,
        decision.discountPercent,
        7 // expires in 7 days
      );

      return result;
    } catch (error) {
      console.error('🏛️ Maximus: Shopify discount error:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ==================== CAMPAIGN CREATION & SCHEDULING ====================

  /**
   * Create the campaign in the system and schedule it
   */
  async scheduleCampaign(config, decision, htmlContent) {
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const now = new Date();

    // Calculate scheduledAt based on decision.sendHour (in ET)
    const scheduledAt = this.calculateScheduledAt(decision.sendHour, config.timezone);

    // Use the SCHEDULED date for the log (not approval date)
    const scheduledDay = dayNames[scheduledAt.getDay()];
    const scheduledHourET = parseInt(scheduledAt.toLocaleString('en-US', { timeZone: config.timezone, hour: 'numeric', hour12: false }));

    // Get the week number based on scheduled date
    const startOfYear = new Date(scheduledAt.getFullYear(), 0, 1);
    const weekNumber = Math.ceil(((scheduledAt - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);

    // If we have htmlContent (from Apollo), campaign is ready to schedule
    const hasCreative = htmlContent && htmlContent !== '<p>Awaiting creative from design agent</p>';

    const campaign = await Campaign.create({
      name: `[Maximus] ${decision.subjectLine}`,
      subject: decision.subjectLine,
      previewText: decision.previewText,
      htmlContent: htmlContent || '<p>Awaiting creative from design agent</p>',
      targetType: 'list',
      list: decision.listId,
      fromName: 'Jersey Pickles',
      fromEmail: 'info@jerseypickles.com',
      status: hasCreative ? 'scheduled' : 'draft',
      scheduledAt: hasCreative ? scheduledAt : null,
      tags: ['maximus', 'agent-generated', decision.product, decision.discountCode].filter(Boolean),
      'stats.totalRecipients': 0
    });

    // Log in Maximus history (use scheduled date, not approval date)
    const log = await MaximusCampaignLog.create({
      campaign: campaign._id,
      campaignType: decision.campaignType || 'promotional',
      subjectLine: decision.subjectLine,
      previewText: decision.previewText,
      list: decision.listId,
      listName: decision.listName,
      sentAt: scheduledAt,
      sentDay: scheduledDay,
      sentHour: scheduledHourET,
      isLearningPhase: config.learning.phase !== 'optimized',
      weekNumber,
      weekYear: now.getFullYear(),
      reasoning: decision.reasoning
    });

    // Update config stats
    config.stats.totalCampaignsSent += 1;
    config.stats.lastCampaignAt = now;
    await config.save();

    console.log(`🏛️ Maximus: Campaign created - ${campaign._id} (${campaign.status})`);
    if (hasCreative) {
      console.log(`🏛️ Maximus: Scheduled for ${scheduledAt.toISOString()}`);
    } else {
      console.log(`🏛️ Maximus: Draft (waiting for creative agent)`);
    }

    return {
      campaignId: campaign._id,
      logId: log._id,
      subjectLine: decision.subjectLine,
      previewText: decision.previewText,
      listName: decision.listName,
      sendHour: decision.sendHour
    };
  }

  // ==================== LEARNING ====================

  /**
   * Gather all historical data for decision making
   */
  async gatherLearningData() {
    const [summary, byDay, byHour, byList] = await Promise.all([
      MaximusCampaignLog.getLearningSummary(),
      MaximusCampaignLog.getPerformanceByDay(),
      MaximusCampaignLog.getPerformanceByHour(),
      MaximusCampaignLog.getPerformanceByList()
    ]);

    const summaryData = summary[0] || {
      totalCampaigns: 0,
      avgOpenRate: 0,
      avgClickRate: 0,
      totalRevenue: 0
    };

    return {
      ...summaryData,
      byDay,
      byHour,
      byList
    };
  }

  /**
   * Update metrics for a campaign log after data comes in
   * Called by a separate job or webhook handler
   */
  async updateCampaignMetrics(campaignId) {
    const campaign = await Campaign.findById(campaignId);
    if (!campaign) return null;

    const log = await MaximusCampaignLog.findOne({ campaign: campaignId });
    if (!log) return null;

    const stats = campaign.stats || {};
    const delivered = stats.delivered || 0;

    log.metrics = {
      sent: stats.sent || 0,
      delivered,
      opened: stats.opened || 0,
      clicked: stats.clicked || 0,
      converted: stats.converted || 0,
      bounced: stats.bounced || 0,
      unsubscribed: stats.unsubscribed || 0,
      revenue: stats.revenue || 0,
      openRate: delivered > 0 ? parseFloat(((stats.opened || 0) / delivered * 100).toFixed(1)) : 0,
      clickRate: delivered > 0 ? parseFloat(((stats.clicked || 0) / delivered * 100).toFixed(1)) : 0,
      conversionRate: delivered > 0 ? parseFloat(((stats.converted || 0) / delivered * 100).toFixed(1)) : 0
    };
    log.metricsUpdatedAt = new Date();
    await log.save();

    // Update learning in config
    await this.updateLearning();

    // Analyze with Claude if enough data and not yet analyzed
    if (delivered >= 50 && !log.claudeInsight?.analyzedAt) {
      try {
        await this.analyzeCampaignWithClaude(log);
      } catch (err) {
        console.error('🏛️ Maximus: Campaign analysis error:', err.message);
      }
    }

    return log;
  }

  /**
   * Ask Claude to analyze a completed campaign and extract learnings
   * Updates the log with insights and accumulates memory in config
   */
  async analyzeCampaignWithClaude(log) {
    if (!this.isAvailable()) return;

    const config = await MaximusConfig.getConfig();
    const existingMemory = (config.memory?.insights || []).join('\n- ');

    const prompt = `You are MAXIMUS, an email campaign agent for Jersey Pickles. Analyze this campaign result and extract learnings.

CAMPAIGN:
- Subject: "${log.subjectLine}"
- Preview: "${log.previewText}"
- List: ${log.listName}
- Day: ${log.sentDay}, Hour: ${log.sentHour}:00 ET
- Product: ${log.reasoning?.whyThisProduct || 'unknown'}

RESULTS:
- Delivered: ${log.metrics.delivered}
- Opened: ${log.metrics.opened} (${log.metrics.openRate}%)
- Clicked: ${log.metrics.clicked} (${log.metrics.clickRate}%)
- Converted: ${log.metrics.converted} (${log.metrics.conversionRate}%)
- Revenue: $${log.metrics.revenue}
- Bounced: ${log.metrics.bounced}
- Unsubscribed: ${log.metrics.unsubscribed}

YOUR EXISTING MEMORY:
${existingMemory ? `- ${existingMemory}` : 'Empty — this is your first campaign.'}

BENCHMARKS: Open rate 40-50% is good, 50%+ excellent. Click rate 2-5% is good. Conversion 0.5-2% is good.

Respond ONLY with valid JSON:
{
  "analysis": "Brief 1-sentence summary of how this campaign performed",
  "whatWorked": "What aspect drove good results (or null if poor)",
  "whatDidnt": "What underperformed (or null if all good)",
  "lessonForNext": "One concrete takeaway for future campaigns",
  "newInsight": "A new pattern or learning to add to your memory (max 100 chars, or null if nothing new)"
}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      });

      const content = response.content?.[0]?.text || '';
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const analysis = JSON.parse(jsonMatch[0]);

      // Save insight to the campaign log
      log.claudeInsight = {
        analysis: analysis.analysis,
        whatWorked: analysis.whatWorked,
        whatDidnt: analysis.whatDidnt,
        lessonForNext: analysis.lessonForNext,
        analyzedAt: new Date()
      };
      await log.save();

      // Accumulate insight in config memory (max 15)
      if (analysis.newInsight) {
        if (!config.memory) config.memory = { insights: [] };
        config.memory.insights.push(analysis.newInsight);
        if (config.memory.insights.length > 15) {
          config.memory.insights = config.memory.insights.slice(-15);
        }
        config.memory.lastUpdated = new Date();
        await config.save();
        console.log(`🏛️ Maximus Memory: "${analysis.newInsight}"`);
      }

      console.log(`🏛️ Maximus: Campaign analyzed — ${analysis.analysis}`);
    } catch (error) {
      console.error('🏛️ Maximus: Analysis Claude error:', error.message);
    }
  }

  /**
   * Recalculate learning data and update config
   */
  async updateLearning() {
    const config = await MaximusConfig.getConfig();
    const learningData = await this.gatherLearningData();

    if (learningData.totalCampaigns === 0) return;

    // Update phase
    if (learningData.totalCampaigns >= 7) {
      config.learning.phase = 'optimized';
    } else if (learningData.totalCampaigns >= 1) {
      config.learning.phase = 'learning';
    }

    config.learning.campaignsAnalyzed = learningData.totalCampaigns;

    // Best days
    if (learningData.byDay.length > 0) {
      config.learning.bestDays = learningData.byDay.map(d => ({
        day: d._id,
        score: (d.avgOpenRate * 0.6) + (d.avgClickRate * 0.4),
        avgOpenRate: d.avgOpenRate,
        avgClickRate: d.avgClickRate
      }));

      // Determine rest days (worst 1-2 days if we have enough data)
      if (learningData.totalCampaigns >= 7) {
        const sorted = [...config.learning.bestDays].sort((a, b) => a.score - b.score);
        config.learning.restDays = sorted.slice(0, 2).map(d => d.day);
      }
    }

    // Best hours
    if (learningData.byHour.length > 0) {
      config.learning.bestHours = learningData.byHour.map(h => ({
        hour: h._id,
        score: (h.avgOpenRate * 0.6) + (h.avgClickRate * 0.4),
        avgOpenRate: h.avgOpenRate,
        avgClickRate: h.avgClickRate
      })).sort((a, b) => b.score - a.score);
    }

    // Best list
    if (learningData.byList.length > 0) {
      const bestList = learningData.byList.sort((a, b) =>
        ((b.avgOpenRate * 0.6) + (b.avgClickRate * 0.4)) -
        ((a.avgOpenRate * 0.6) + (a.avgClickRate * 0.4))
      )[0];
      config.learning.bestList = {
        listId: bestList._id,
        name: bestList.listName,
        avgOpenRate: bestList.avgOpenRate
      };
    }

    // Update global stats
    config.stats.avgOpenRate = learningData.avgOpenRate || 0;
    config.stats.avgClickRate = learningData.avgClickRate || 0;
    config.stats.totalRevenue = learningData.totalRevenue || 0;

    config.learning.lastLearningUpdate = new Date();
    await config.save();

    console.log(`🏛️ Maximus: Learning updated (${learningData.totalCampaigns} campaigns, phase: ${config.learning.phase})`);
  }

  // ==================== STATUS ====================

  async getStatus() {
    const config = await MaximusConfig.getConfig();
    const learningData = await this.gatherLearningData();
    const campaignsThisWeek = await MaximusCampaignLog.getCampaignsThisWeek();
    const recentLogs = await MaximusCampaignLog.find()
      .sort({ sentAt: -1 })
      .limit(10)
      .lean();

    return {
      agent: 'Maximus',
      active: config.active,
      creativeAgentReady: config.creativeAgentReady,
      model: this.model,
      claudeAvailable: this.isAvailable(),
      lists: config.lists,
      constraints: {
        maxPerWeek: config.maxCampaignsPerWeek,
        sendWindow: `${config.sendWindowStart}:00 - ${config.sendWindowEnd}:00`,
        timezone: config.timezone
      },
      thisWeek: {
        sent: campaignsThisWeek.length,
        remaining: config.maxCampaignsPerWeek - campaignsThisWeek.length,
        campaigns: campaignsThisWeek.map(c => ({
          subject: c.subjectLine,
          list: c.listName,
          day: c.sentDay,
          hour: c.sentHour,
          openRate: c.metrics.openRate,
          clickRate: c.metrics.clickRate
        }))
      },
      learning: {
        phase: config.learning.phase,
        campaignsAnalyzed: config.learning.campaignsAnalyzed,
        bestDays: config.learning.bestDays,
        bestHours: config.learning.bestHours?.slice(0, 3),
        bestList: config.learning.bestList,
        restDays: config.learning.restDays
      },
      stats: config.stats,
      recentCampaigns: recentLogs
    };
  }
}

const maximusService = new MaximusService();
module.exports = maximusService;
