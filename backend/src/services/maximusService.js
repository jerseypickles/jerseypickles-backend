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
      `- [${c.campaignType || 'unknown'}] "${c.subjectLine}" → Product: ${c.productName || 'unknown'}, List: ${c.listName}, Day: ${c.sentDay} ${c.sentHour}:00, Archetype: ${c.contentArchetype || 'n/a'}, Headline: "${c.headline || 'n/a'}", Open: ${c.metrics.openRate}%, Click: ${c.metrics.clickRate}%`
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

CRITICAL SUBJECT RULES — DO NOT BREAK THESE:
- ❌ NEVER use date-specific urgency: "before Sunday", "today only", "ends tonight", "this weekend", "last chance Friday"
  → Reason: Discount codes are valid for 7 FULL DAYS from creation, NOT until the day you mention.
  → Saying "before Sunday" creates confusion + false urgency.
- ❌ NEVER name a specific weekday in subject lines (Monday, Tuesday, etc.)
  → Reason: Campaigns may be sent on a different day than planned, making the subject stale.
- ❌ NEVER put weekday abbreviations in discount codes (SAT, FRI, MON, TUE, etc.)
  → Codes must be product-based: PICKLE20, HOTTOM25, CRUNCH15 — NOT CRUNCH20SAT
- ✅ DO use generic urgency: "limited time", "while it lasts", "grab it now", "this week only" (week = 7 days)
- ✅ DO use product-driven hooks: "Crunchy & addictive", "Made with love", "Bold and tangy"
- ✅ DO use curiosity: "The story behind...", "Meet our...", "Why our pickles are different"

CAMPAIGN TYPES — you MUST choose one:

1. "promotional" — Discount offer (15-30% OFF). Use max 1-2x/week. Include discount code.
   ✅ Good subjects: "20% off our Hot Tomatoes 🌶️", "Crunchy, tangy, on sale", "Bold flavor, sweet deal"

2. "content" — Storytelling, recipes, education. NO discount. Build brand love & engagement.
   You MUST pick a DIFFERENT content archetype each time — NEVER repeat the same archetype used this week:
     a) RECIPE — "3 ways to enjoy Hot Tomatoes", "The perfect pickle charcuterie board"
     b) ORIGIN STORY — "How we started in New Jersey", "The secret behind our brine"
     c) BEHIND THE SCENES — "Inside our kitchen on packing day", "A day in the life at Jersey Pickles"
     d) TIPS / EDUCATION — "How to store pickles for max crunch", "5 foods that pair with pickles"
     e) SEASONAL — "Summer grilling with pickles", "Holiday entertaining ideas"
     f) CUSTOMER LOVE — "Why fans can't stop ordering", "Real reviews, real pickle lovers"
     g) PAIRING GUIDE — "What to eat with Hot Tomatoes", "Pickle & cheese — the duo you need"
   Specify your chosen archetype in "contentArchetype" field.

3. "product_spotlight" — Feature a product without discount. Highlight quality, craft, ingredients.
   ✅ Good subjects: "Meet our Hot Tomatoes 🍅", "Why our olives are different", "Small batch, big flavor"

STRATEGY: Balance your week. Don't send 5 promos — mix it up. Ideal week: 1-2 promotional + 2-3 content/spotlight.
If you already sent a promo this week, strongly prefer content or spotlight.
NEVER repeat the same content archetype, product, or subject angle used in recent campaigns (see history below).

YOUR TASK:
1. Choose campaign type (promotional, content, or product_spotlight)
2. Subject line (compelling, under 50 chars)
3. Preview text (adds context, under 80 chars)
4. Headline for the creative image
5. Which product to feature
6. ONLY if type is "promotional": discount percentage (15-30%) and discount code (ALL CAPS, unique). Do NOT reuse: ${allUsedCodes.join(', ') || 'none yet'}
7. Which list to send to
8. What hour to send — ${earliestSendHour >= config.sendWindowEnd ? `Today\\'s window is closed. Pick any hour between ${config.sendWindowStart} and ${config.sendWindowEnd - 1} for TOMORROW.` : `MUST be >= ${earliestSendHour} and < ${config.sendWindowEnd} (current time is ${currentETHour}:00 ET)`}

${learningData.totalCampaigns < 7 ? 'LEARNING PHASE: Try different types, hours, and lists to gather data.' : 'OPTIMIZED PHASE: Use your learning data to pick the best performing time and list.'}

DO NOT repeat a subject line used this week.

═══════════════════════════════════════
CONTENT CAMPAIGNS — EDITORIAL FORMAT
═══════════════════════════════════════
If you choose campaignType = "content", you MUST also write:
- "storyBody": 2-3 paragraphs of REAL story content (200-400 words total). This is the actual story that will appear in the email body — not a teaser. Write it fully, with sensory detail, place, craft, and human moments. Think New Yorker / food magazine, not blog post intro.
- "pullQuote": One memorable sentence from the story (max 120 chars) that will be displayed as a stylized pull quote.
- The story must feature ${product?.name || 'the chosen product'} authentically — its ingredients, its making, its taste, its place in a New Jersey home.

Story tone: warm, personal, sensory. Show don't tell. No marketing fluff.

Example storyBody:
"Every Thursday morning, the kitchen at 12 Pine Street fills with the sharp green scent of fresh dill. My grandmother taught me to listen for the brine — when it sings against the glass, you know the pickles are ready. We've been doing it the same way for three generations now: small batches, hand-packed, never rushed.

The tomatoes come in at the peak of summer, still warm from the field. We slice them thick, salt them gently, and let the magic happen overnight. By morning, what was a humble vegetable has become something else entirely — bold, tangy, alive.

This isn't food made by machines. It's food made by people who care."

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
  "contentAngle": "<short angle description, all types>",
  "contentArchetype": "<ONLY for content: recipe|origin_story|behind_the_scenes|tips|seasonal|customer_love|pairing_guide>",
  "storyBody": "<ONLY for content type: 2-3 paragraphs, 200-400 words, real story>",
  "pullQuote": "<ONLY for content type: one memorable sentence, max 120 chars>",
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
      console.log('🏛️ Maximus: Asking Claude for decision...');
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }]
      });

      const content = response.content?.[0]?.text || '';
      console.log('🏛️ Maximus: Claude response length:', content.length);

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('🏛️ Maximus: Could not parse Claude response. Raw:', content.substring(0, 500));
        return null;
      }

      let decision;
      try {
        decision = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        console.error('🏛️ Maximus: JSON parse error:', parseErr.message);
        console.error('🏛️ Maximus: Raw JSON:', jsonMatch[0].substring(0, 500));
        return null;
      }

      console.log('🏛️ Maximus: Decision parsed:', decision.campaignType, decision.subjectLine);

      // Validate the decision
      const validList = config.lists.find(l => l.listId.toString() === decision.listId);
      if (!validList) {
        console.error('🏛️ Maximus: Invalid list selected:', decision.listId);
        console.error('🏛️ Maximus: Available lists:', config.lists.map(l => l.listId.toString()));
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

    // Check weekly limit (only hard block besides pendingProposal)
    const campaignsThisWeek = await MaximusCampaignLog.getCampaignsThisWeek();
    if (campaignsThisWeek.length >= config.maxCampaignsPerWeek) {
      console.log(`🏛️ Maximus: Weekly limit reached (${campaignsThisWeek.length}/${config.maxCampaignsPerWeek})`);
      return { success: false, reason: 'weekly_limit_reached', detail: `${campaignsThisWeek.length}/${config.maxCampaignsPerWeek} campaigns this week` };
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
          productName: decision.productName,
          discount: decision.campaignType === 'promotional' ? `${decision.discountPercent}% OFF` : null,
          code: decision.campaignType === 'promotional' ? decision.discountCode : null,
          campaignType: decision.campaignType,
          contentAngle: decision.contentAngle,
          storyBody: decision.storyBody,
          pullQuote: decision.pullQuote
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
        storyBody: decision.campaignType === 'content' ? decision.storyBody : null,
        pullQuote: decision.campaignType === 'content' ? decision.pullQuote : null,
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

  // ==================== WEEKLY PLAN SYSTEM ====================

  /**
   * Generate a full week plan (5 campaigns) for human review
   */
  async generateWeeklyPlan(opts = {}) {
    console.log('\n🏛️ ═══════════════════════════════════════');
    console.log('   MAXIMUS - Generating Weekly Plan');
    console.log('═══════════════════════════════════════\n');

    const config = await MaximusConfig.getConfig();

    // Skip the pending check if called from background after route already set placeholder
    if (!opts.skipPendingCheck && config.pendingWeeklyPlan?.active) {
      return { success: false, reason: 'pending_weekly_plan_exists' };
    }

    if (!config.lists || config.lists.length === 0) {
      return { success: false, reason: 'no_lists' };
    }

    if (!this.isAvailable()) {
      return { success: false, reason: 'claude_not_available' };
    }

    // Gather context
    const learningData = await this.gatherLearningData();
    const recentInsights = await this._getRecentInsights();

    const ApolloConfig = require('../models/ApolloConfig');
    const apolloConfig = await ApolloConfig.getConfig();
    const availableProducts = apolloConfig.getActiveProducts();
    const productsInfo = availableProducts.length > 0
      ? availableProducts.map(p => `- "${p.name}" (slug: ${p.slug}, category: ${p.category})`).join('\n')
      : '- No products configured yet';

    const listsInfo = config.lists.map(l => `- "${l.name}" (ID: ${l.listId})`).join('\n');

    // Collect used discount codes
    const existingCampaignTags = await Campaign.find({
      tags: 'maximus',
      createdAt: { $gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) }
    }).select('tags').lean();
    const usedCodes = existingCampaignTags.flatMap(c => (c.tags || []).filter(t => t === t.toUpperCase() && t.length >= 4 && t.length <= 12));
    const allUsedCodes = [...new Set(usedCodes)];

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

    // Determine next Monday
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sun
    const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek);
    const nextMonday = new Date(now);
    nextMonday.setDate(now.getDate() + daysUntilMonday);
    nextMonday.setHours(0, 0, 0, 0);

    const weekDays = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(nextMonday);
      d.setDate(nextMonday.getDate() + i);
      const dayName = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][d.getDay()];
      weekDays.push({ date: d.toISOString().split('T')[0], day: dayName });
    }

    const weekLabel = `${weekDays[0].date} to ${weekDays[6].date}`;

    const prompt = `You are MAXIMUS, an autonomous email campaign agent for Jersey Pickles - an artisanal pickle and gourmet olive shop from New Jersey.

PLAN THE COMPLETE WEEK: ${weekLabel}
AVAILABLE DAYS: ${weekDays.map(d => `${d.day} (${d.date})`).join(', ')}
CAMPAIGNS TO PLAN: ${config.maxCampaignsPerWeek} (pick the best ${config.maxCampaignsPerWeek} days, leave others as rest days)
SEND WINDOW: ${config.sendWindowStart}:00 - ${config.sendWindowEnd}:00 (${config.timezone})

AVAILABLE LISTS:
${listsInfo}

AVAILABLE PRODUCTS (for creative):
${productsInfo}

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
- Use emojis sparingly (max 1-2 per subject)
- Keep subjects under 50 characters
- Preview text should complement the subject, not repeat it

CRITICAL SUBJECT RULES — DO NOT BREAK THESE:
- ❌ NEVER use date-specific urgency: "before Sunday", "today only", "ends tonight", "this weekend", "last chance Friday"
  → Discount codes are valid for 7 FULL DAYS, NOT until the day you mention.
- ❌ NEVER name a specific weekday in subject lines (Monday, Tuesday, etc.)
  → Plans may shift days. Subjects must be evergreen.
- ❌ NEVER put weekday abbreviations in discount codes (SAT, FRI, MON, etc.)
  → Codes must be product-based: PICKLE20, HOTTOM25, CRUNCH15 — NOT CRUNCH20SAT
- ✅ DO use: "limited time", "while it lasts", "this week only" (week = 7 days)
- ✅ DO use product hooks: "Crunchy & addictive", "Bold and tangy", "Made with love"
- ✅ DO use curiosity: "The story behind...", "Meet our...", "Why our pickles..."

CAMPAIGN TYPES:
1. "promotional" — Discount offer (15-30% OFF). Include discount code. NO date-specific urgency in subject.
2. "content" — NO discount. Build brand love. You MUST pick a DIFFERENT archetype each time:
   a) RECIPE — "3 ways to enjoy Hot Tomatoes", "The perfect pickle board"
   b) ORIGIN STORY — "How we started in NJ", "The secret behind our brine"
   c) BEHIND THE SCENES — "Inside our kitchen on packing day"
   d) TIPS / EDUCATION — "How to store pickles for max crunch"
   e) SEASONAL — "Summer grilling with pickles"
   f) CUSTOMER LOVE — "Why fans can't stop ordering"
   g) PAIRING GUIDE — "What to eat with Hot Tomatoes"
   Specify in "contentArchetype" field. NEVER repeat same archetype in the same week.
3. "product_spotlight" — Feature a product without discount. Highlight quality, craft.

STRATEGY RULES:
- Balance the week: 1-2 promotional + rest content/spotlight
- NEVER schedule two promotional campaigns on consecutive days — always put at least one content or spotlight between promos
- Rotate products — don't feature the same product 2 days in a row
- Rotate lists — alternate between them
- Vary send hours to gather learning data
- Each discount code MUST be unique. Do NOT reuse: ${allUsedCodes.join(', ') || 'none yet'}
- Pick 2 rest days (no email) — typically the weakest days

CONTENT CAMPAIGNS — EDITORIAL FORMAT:
For any campaign with campaignType = "content", you MUST include:
- "storyBody": 2-3 paragraphs of REAL story content (200-400 words). The actual story body for the email — sensory, personal, warm. Show the product through human moments, not marketing speak.
- "pullQuote": one memorable sentence (max 120 chars) that will be displayed as a stylized pull quote.

Respond ONLY with valid JSON — an array of ${config.maxCampaignsPerWeek} campaigns:
[
  {
    "day": "<day name>",
    "date": "<YYYY-MM-DD>",
    "campaignType": "promotional|content|product_spotlight",
    "subjectLine": "...",
    "previewText": "...",
    "headline": "...",
    "product": "<product slug>",
    "productName": "<product full name>",
    "discountPercent": <number or null>,
    "discountCode": "<CODE or null>",
    "contentAngle": "<short angle, all types>",
    "contentArchetype": "<ONLY for content: recipe|origin_story|behind_the_scenes|tips|seasonal|customer_love|pairing_guide>",
    "storyBody": "<REQUIRED for content type, 200-400 words, null otherwise>",
    "pullQuote": "<REQUIRED for content type, max 120 chars, null otherwise>",
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
  }
]`;

    try {
      console.log('🏛️ Maximus: Asking Claude for weekly plan...');
      console.log('🏛️ Maximus: Prompt length:', prompt.length, 'chars');
      const claudeStart = Date.now();
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }]
      });
      console.log(`🏛️ Maximus: Claude responded in ${((Date.now() - claudeStart) / 1000).toFixed(1)}s`);

      const content = response.content?.[0]?.text || '';
      console.log('🏛️ Maximus: Claude response length:', content.length, 'chars');
      console.log('🏛️ Maximus: Stop reason:', response.stop_reason);
      console.log('🏛️ Maximus: Usage:', JSON.stringify(response.usage));

      if (response.stop_reason === 'max_tokens') {
        console.error('🏛️ Maximus: Response was TRUNCATED (max_tokens hit). Need higher limit or shorter content.');
      }

      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.error('🏛️ Maximus: Could not find JSON array in response');
        console.error('🏛️ Maximus: First 1000 chars:', content.substring(0, 1000));
        console.error('🏛️ Maximus: Last 500 chars:', content.substring(Math.max(0, content.length - 500)));
        return { success: false, reason: 'decision_failed', detail: 'no_json_array' };
      }

      let campaigns;
      try {
        campaigns = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        console.error('🏛️ Maximus: JSON parse error:', parseErr.message);
        console.error('🏛️ Maximus: JSON snippet around error (first 1500):', jsonMatch[0].substring(0, 1500));
        return { success: false, reason: 'decision_failed', detail: 'json_parse_error', error: parseErr.message };
      }

      if (!Array.isArray(campaigns) || campaigns.length === 0) {
        console.error('🏛️ Maximus: No campaigns in parsed plan, type:', typeof campaigns, 'length:', campaigns?.length);
        return { success: false, reason: 'decision_failed', detail: 'empty_plan' };
      }

      console.log(`🏛️ Maximus: ${campaigns.length} campaigns planned`);

      // Enforce: no two promos on consecutive days
      // Sort by date first to ensure correct order
      campaigns.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      for (let i = 1; i < campaigns.length; i++) {
        if (campaigns[i].campaignType === 'promotional' && campaigns[i - 1].campaignType === 'promotional') {
          console.warn(`🏛️ Maximus: Back-to-back promos detected on ${campaigns[i - 1].day} and ${campaigns[i].day}. Switching ${campaigns[i].day} to content.`);
          campaigns[i].campaignType = 'content';
          campaigns[i].discountPercent = null;
          campaigns[i].discountCode = null;
          if (!campaigns[i].contentArchetype) campaigns[i].contentArchetype = 'tips';
          if (!campaigns[i].contentAngle) campaigns[i].contentAngle = 'Product quality & craft';
        }
      }

      // Generate Apollo creatives for each campaign
      apolloService.init();
      for (let i = 0; i < campaigns.length; i++) {
        const c = campaigns[i];
        console.log(`🏛️ Maximus: [${i + 1}/${campaigns.length}] ${c.day} — ${c.campaignType} — "${c.subjectLine}"`);

        // Calculate scheduledAt
        const campDate = new Date(c.date + 'T00:00:00');
        const scheduledAt = new Date(campDate);
        // Convert sendHour ET to UTC approximately (+4 or +5 depending on DST)
        const etOffset = 4; // EDT
        scheduledAt.setUTCHours(c.sendHour + etOffset, 0, 0, 0);
        campaigns[i].scheduledAt = scheduledAt;

        // Validate list
        const validList = config.lists.find(l => l.listId.toString() === c.listId);
        if (!validList) {
          console.warn(`🏛️ Maximus: Invalid list for ${c.day}, using first list`);
          campaigns[i].listId = config.lists[0].listId;
          campaigns[i].listName = config.lists[0].name;
        }

        // Default type
        if (!c.campaignType) campaigns[i].campaignType = 'content';

        // Generate creative with Apollo
        if (apolloService.isAvailable()) {
          const apolloBrief = {
            product: c.product,
            headline: c.headline || c.subjectLine,
            productName: c.productName,
            campaignType: c.campaignType
          };
          if (c.campaignType === 'promotional') {
            apolloBrief.discount = `${c.discountPercent}% OFF TODAY ONLY`;
            apolloBrief.code = c.discountCode;
          } else {
            apolloBrief.discount = null;
            apolloBrief.code = null;
            apolloBrief.contentAngle = c.contentAngle;
          }

          const creative = await apolloService.generateCreative(apolloBrief);
          if (creative.success) {
            campaigns[i].imageUrl = creative.imageUrl;
            campaigns[i].htmlContent = apolloService.buildEmailHtml(creative.imageUrl, {
              headline: c.headline || c.subjectLine,
              product: c.product,
              productName: c.productName,
              discount: c.campaignType === 'promotional' ? `${c.discountPercent}% OFF` : null,
              code: c.campaignType === 'promotional' ? c.discountCode : null,
              campaignType: c.campaignType,
              contentAngle: c.contentAngle,
              storyBody: c.storyBody,
              pullQuote: c.pullQuote
            });
            console.log(`   ✅ Creative generated`);
          } else {
            console.warn(`   ⚠️ Apollo failed: ${creative.error}`);
          }
        }
      }

      // Save weekly plan
      config.pendingWeeklyPlan = {
        active: true,
        createdAt: new Date(),
        weekLabel,
        campaigns: campaigns.map(c => ({
          day: c.day,
          scheduledAt: c.scheduledAt,
          status: 'pending',
          campaignType: c.campaignType,
          subjectLine: c.subjectLine,
          previewText: c.previewText,
          headline: c.headline,
          product: c.product,
          productName: c.productName,
          contentAngle: c.contentAngle,
          storyBody: c.campaignType === 'content' ? c.storyBody : null,
          pullQuote: c.campaignType === 'content' ? c.pullQuote : null,
          discountPercent: c.campaignType === 'promotional' ? c.discountPercent : null,
          discountCode: c.campaignType === 'promotional' ? c.discountCode : null,
          listId: c.listId,
          listName: c.listName,
          sendHour: c.sendHour,
          imageUrl: c.imageUrl || null,
          htmlContent: c.htmlContent || null,
          reasoning: c.reasoning
        }))
      };
      await config.save();

      console.log(`🏛️ Maximus: ✅ Weekly plan saved (${campaigns.length} campaigns)`);

      return { success: true, plan: config.pendingWeeklyPlan };

    } catch (error) {
      console.error('🏛️ Maximus: Weekly plan error:', error.message);
      return { success: false, reason: 'decision_failed', error: error.message };
    }
  }

  /**
   * Get current weekly plan
   */
  async getWeeklyPlan() {
    const config = await MaximusConfig.getConfig();
    if (!config.pendingWeeklyPlan?.active) {
      return { exists: false };
    }
    return { exists: true, plan: config.pendingWeeklyPlan };
  }

  /**
   * Approve a specific campaign in the weekly plan (by index)
   */
  async approveWeekCampaign(index) {
    const config = await MaximusConfig.getConfig();
    if (!config.pendingWeeklyPlan?.active) {
      return { success: false, reason: 'no_pending_plan' };
    }

    const campaign = config.pendingWeeklyPlan.campaigns[index];
    if (!campaign) {
      return { success: false, reason: 'invalid_index' };
    }
    if (campaign.status !== 'pending') {
      return { success: false, reason: `already_${campaign.status}` };
    }

    // Create Shopify discount for promotional
    if (campaign.campaignType === 'promotional' && campaign.discountCode) {
      const discountResult = await this.createShopifyDiscount(campaign);
      if (!discountResult.success) {
        console.warn(`🏛️ Maximus: Discount failed for ${campaign.day}: ${discountResult.error}`);
      }
    }

    // Schedule the campaign
    await this.scheduleCampaign(config, campaign, campaign.htmlContent, campaign.scheduledAt);

    config.pendingWeeklyPlan.campaigns[index].status = 'approved';
    await config.save();

    console.log(`🏛️ Maximus: ✅ ${campaign.day} approved — "${campaign.subjectLine}"`);
    return { success: true, day: campaign.day, subjectLine: campaign.subjectLine };
  }

  /**
   * Reject a specific campaign in the weekly plan
   */
  async rejectWeekCampaign(index) {
    const config = await MaximusConfig.getConfig();
    if (!config.pendingWeeklyPlan?.active) {
      return { success: false, reason: 'no_pending_plan' };
    }

    const campaign = config.pendingWeeklyPlan.campaigns[index];
    if (!campaign) return { success: false, reason: 'invalid_index' };

    config.pendingWeeklyPlan.campaigns[index].status = 'rejected';
    await config.save();

    console.log(`🏛️ Maximus: ❌ ${campaign.day} rejected — "${campaign.subjectLine}"`);
    return { success: true, day: campaign.day };
  }

  /**
   * Approve ALL pending campaigns in the weekly plan
   */
  async approveAllWeekCampaigns() {
    const config = await MaximusConfig.getConfig();
    if (!config.pendingWeeklyPlan?.active) {
      return { success: false, reason: 'no_pending_plan' };
    }

    const results = [];
    for (let i = 0; i < config.pendingWeeklyPlan.campaigns.length; i++) {
      if (config.pendingWeeklyPlan.campaigns[i].status === 'pending') {
        const result = await this.approveWeekCampaign(i);
        results.push(result);
        // Reload config after each save
        const freshConfig = await MaximusConfig.getConfig();
        config.pendingWeeklyPlan = freshConfig.pendingWeeklyPlan;
      }
    }

    // Clear plan after all processed
    config.pendingWeeklyPlan = { active: false };
    await config.save();

    console.log(`🏛️ Maximus: ✅ All campaigns approved (${results.length})`);
    return { success: true, approved: results.length, results };
  }

  /**
   * Discard the entire weekly plan
   */
  async discardWeeklyPlan() {
    const config = await MaximusConfig.getConfig();
    config.pendingWeeklyPlan = { active: false };
    await config.save();
    console.log('🏛️ Maximus: Weekly plan discarded');
    return { success: true };
  }

  /**
   * Approve the pending proposal → create and schedule the campaign
   */
  async approveProposal() {
    const config = await MaximusConfig.getConfig();

    if (!config.pendingProposal?.active) {
      return { success: false, reason: 'no_pending_proposal' };
    }

    const { decision, htmlContent, imageUrl, scheduledAt: proposalScheduledAt } = config.pendingProposal;

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

    // Create and schedule the campaign — use the original scheduledAt from proposal
    const result = await this.scheduleCampaign(config, decision, htmlContent, proposalScheduledAt);

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

    const availability = {
      canGenerate: !config.pendingProposal?.active && campaignsThisWeek.length < config.maxCampaignsPerWeek,
      sentToday: false,
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

      const result = await shopify.createCampaignDiscount(
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
  async scheduleCampaign(config, decision, htmlContent, overrideScheduledAt = null) {
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const now = new Date();

    // Use override from proposal if provided, otherwise calculate
    const scheduledAt = overrideScheduledAt ? new Date(overrideScheduledAt) : this.calculateScheduledAt(decision.sendHour, config.timezone);

    // If scheduledAt is in the past (proposal was old), push to next available slot
    if (scheduledAt <= now) {
      console.log(`🏛️ Maximus: Scheduled time ${scheduledAt.toISOString()} is in the past, recalculating...`);
      const recalculated = this.calculateScheduledAt(decision.sendHour, config.timezone);
      scheduledAt.setTime(recalculated.getTime());
    }

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
      contentArchetype: decision.contentArchetype || null,
      headline: decision.headline || decision.subjectLine,
      productName: decision.productName || decision.product,
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
      .populate('campaign', 'status scheduledAt')
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
