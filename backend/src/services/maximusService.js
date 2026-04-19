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
    this.initialized = false;
    // Fallbacks only — real model comes from MaximusConfig (editable via UI)
    this.defaultModel = 'claude-opus-4-7';
    this.defaultAnalysisModel = 'claude-sonnet-4-6';
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

  // ==================== PROMPT BUILDERS ====================

  _buildLearningSection(learningData) {
    if (!learningData.totalCampaigns) return 'No historical data yet (initial phase).';
    const dayLine = learningData.byDay?.map(d => `  ${d._id}: ${d.avgOpenRate?.toFixed(1)}% opens, ${d.avgClickRate?.toFixed(1)}% clicks (${d.campaigns} campaigns)`).join('\n') || '  No data yet';
    const hourLine = learningData.byHour?.map(h => `  ${h._id}:00: ${h.avgOpenRate?.toFixed(1)}% opens, ${h.avgClickRate?.toFixed(1)}% clicks (${h.campaigns} campaigns)`).join('\n') || '  No data yet';
    const listLine = learningData.byList?.map(l => `  "${l.listName}": ${l.avgOpenRate?.toFixed(1)}% opens, ${l.avgClickRate?.toFixed(1)}% clicks (${l.campaigns} campaigns)`).join('\n') || '  No data yet';
    return `Historical data (${learningData.totalCampaigns} campaigns):
- Average open rate: ${learningData.avgOpenRate?.toFixed(1)}%
- Average click rate: ${learningData.avgClickRate?.toFixed(1)}%
- Total revenue: $${learningData.totalRevenue?.toFixed(0)}

Best performing days:
${dayLine}

Best performing hours:
${hourLine}

Performance by list:
${listLine}`;
  }

  async _buildProductsInfo() {
    const ApolloConfig = require('../models/ApolloConfig');
    const apolloConfig = await ApolloConfig.getConfig();
    const products = apolloConfig.getActiveProducts();
    return products.length > 0
      ? products.map(p => `- "${p.name}" (slug: ${p.slug}, category: ${p.category})`).join('\n')
      : '- No products configured yet';
  }

  async _collectUsedDiscountCodes(extraCodes = []) {
    const existingCampaignTags = await Campaign.find({
      tags: 'maximus',
      createdAt: { $gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) }
    }).select('tags').lean();
    const fromTags = existingCampaignTags.flatMap(c =>
      (c.tags || []).filter(t => t === t.toUpperCase() && t.length >= 4 && t.length <= 12)
    );
    return [...new Set([...extraCodes.filter(Boolean), ...fromTags])];
  }

  // ==================== TIMEZONE HELPERS ====================

  /**
   * Get the UTC offset hours for America/New_York on a given date (handles DST).
   * EDT = UTC-4 (second Sunday of March → first Sunday of November)
   * EST = UTC-5 (rest of year)
   */
  getEtOffsetHours(date = new Date()) {
    const tzName = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      timeZoneName: 'short'
    }).formatToParts(date).find(p => p.type === 'timeZoneName')?.value;
    return tzName === 'EDT' ? 4 : 5;
  }

  // ==================== SUBJECT VALIDATION ====================

  /**
   * Validate a subject line against the critical rules the prompt sets:
   * - no weekday names (monday, tuesday, etc.)
   * - no date-specific urgency phrases (today only, ends tonight, etc.)
   * Returns { valid, violations: [reason] }
   */
  validateSubject(subject) {
    if (!subject) return { valid: false, violations: ['empty_subject'] };
    const s = subject.toLowerCase();
    const violations = [];

    const weekdayRx = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/;
    const wkMatch = s.match(weekdayRx);
    if (wkMatch) violations.push(`weekday_name: "${wkMatch[0]}"`);

    const urgencyPhrases = [
      'today only', 'ends tonight', 'ends today', 'last chance',
      'this weekend', 'before monday', 'before tuesday', 'before wednesday',
      'before thursday', 'before friday', 'before saturday', 'before sunday',
      'by monday', 'by tuesday', 'by wednesday', 'by thursday',
      'by friday', 'by saturday', 'by sunday',
      'ends monday', 'ends tuesday', 'ends wednesday', 'ends thursday',
      'ends friday', 'ends saturday', 'ends sunday'
    ];
    for (const phrase of urgencyPhrases) {
      if (s.includes(phrase)) {
        violations.push(`date_urgency: "${phrase}"`);
        break;
      }
    }

    return { valid: violations.length === 0, violations };
  }

  /**
   * Validate that a decision carries the required payload for its type
   */
  validateTypePayload(c) {
    const violations = [];
    const t = c.campaignType;
    if (t === 'content') {
      if (!c.storyBody || c.storyBody.length < 150) violations.push('missing_or_short_storyBody');
      if (!c.pullQuote) violations.push('missing_pullQuote');
    }
    if (t === 'recipe') {
      const r = c.recipe || {};
      if (!r.dishName) violations.push('recipe.missing_dishName');
      if (!Array.isArray(r.ingredients) || r.ingredients.length < 3) violations.push('recipe.insufficient_ingredients');
      if (!Array.isArray(r.steps) || r.steps.length < 3) violations.push('recipe.insufficient_steps');
    }
    if (t === 'pairing') {
      const p = c.pairing || {};
      if (!p.leftItem?.name || !p.rightItem?.name) violations.push('pairing.missing_items');
      if (!p.pairingNote) violations.push('pairing.missing_note');
    }
    if (t === 'customer_love') {
      const cl = c.customerLove || {};
      if (!Array.isArray(cl.quotes) || cl.quotes.length < 2) violations.push('customerLove.needs_2plus_quotes');
      else if (cl.quotes.some(q => !q.text || !q.author)) violations.push('customerLove.quote_incomplete');
    }
    return { valid: violations.length === 0, violations };
  }

  /**
   * Validate a discount code — must be uppercase, 4-12 chars, no weekday abbreviations
   */
  validateDiscountCode(code) {
    if (!code) return { valid: true, violations: [] };
    const violations = [];
    if (!/^[A-Z0-9]{4,12}$/.test(code)) violations.push('format_invalid');
    if (/^(MON|TUE|WED|THU|FRI|SAT|SUN)/.test(code) || /(MON|TUE|WED|THU|FRI|SAT|SUN)$/.test(code)) {
      violations.push('weekday_in_code');
    }
    return { valid: violations.length === 0, violations };
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

    // Check day limit — allow up to maxCampaignsPerDay (default 2) with distinct lists
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sentToday = campaignsThisWeek.filter(c => new Date(c.sentAt) >= today);
    const maxPerDay = config.maxCampaignsPerDay || 2;
    if (sentToday.length >= maxPerDay) {
      console.log(`🏛️ Maximus: Day limit reached (${sentToday.length}/${maxPerDay})`);
      return { executed: false, reason: 'day_limit_reached' };
    }
    const usedListsToday = sentToday.map(c => c.list.toString());
    const usedHoursToday = sentToday.map(c => c.sentHour);

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
    const decision = await this.makeDecision(config, learningData, campaignsThisWeek, { usedListsToday, usedHoursToday });
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
  async makeDecision(config, learningData, campaignsThisWeek, opts = {}) {
    if (!this.isAvailable()) {
      console.log('🏛️ Maximus: Claude not available');
      return null;
    }

    const { usedListsToday = [], usedHoursToday = [] } = opts;
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const now = new Date();
    const today = dayNames[now.getDay()];

    const listsInfo = config.lists.map(l => `- "${l.name}" (ID: ${l.listId})`).join('\n');

    // Lists still available today (the rest must wait until tomorrow)
    const availableListsToday = config.lists.filter(l => !usedListsToday.includes(l.listId.toString()));
    const minGap = config.minHoursBetweenSameDay || 3;

    const recentCampaigns = campaignsThisWeek.map(c =>
      `- [${c.campaignType || 'unknown'}] "${c.subjectLine}" → Product: ${c.productName || 'unknown'}, List: ${c.listName}, Day: ${c.sentDay} ${c.sentHour}:00, Archetype: ${c.contentArchetype || 'n/a'}, Headline: "${c.headline || 'n/a'}", Open: ${c.metrics.openRate}%, Click: ${c.metrics.clickRate}%`
    ).join('\n') || 'No campaigns sent this week yet.';

    const learningSection = this._buildLearningSection(learningData);
    const productsInfo = await this._buildProductsInfo();
    const recentInsights = await this._getRecentInsights();

    // Calculate current ET hour for the prompt
    const currentETHour = parseInt(now.toLocaleString('en-US', { timeZone: config.timezone, hour: 'numeric', hour12: false }));
    const earliestSendHour = Math.max(config.sendWindowStart, currentETHour + 1);

    // Collect existing discount codes this week to avoid duplicates
    const weekCodes = campaignsThisWeek.map(c => c.reasoning?.discountCode).filter(Boolean);
    const allUsedCodes = await this._collectUsedDiscountCodes(weekCodes);

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

TODAY'S CAPACITY: ${config.maxCampaignsPerDay - usedListsToday.length} slot(s) remaining (max ${config.maxCampaignsPerDay}/day)
${usedListsToday.length > 0 ? `ALREADY SENT TODAY to lists: [${usedListsToday.map(id => config.lists.find(l => l.listId.toString() === id)?.name || id).join(', ')}] at hour(s) ${usedHoursToday.join(', ')}h. NEVER repeat the same list same day. NEW send must be at least ${minGap}h apart.` : ''}
${usedListsToday.length > 0 ? `ALLOWED LISTS TODAY (you MUST pick one of these): ${availableListsToday.map(l => `"${l.name}" (${l.listId})`).join(', ') || 'NONE — schedule for tomorrow'}` : ''}

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

CAMPAIGN TYPES — you MUST choose ONE of these 6:

1. "promotional" — Discount offer (15-30% OFF). Include discount code.
   ✅ "20% off our Hot Tomatoes 🌶️", "Bold flavor, sweet deal"

2. "content" — Storytelling, origin, tips (NO recipe or pairing here — those have their own types below). NO discount.
   Pick a DIFFERENT archetype each time:
     a) ORIGIN STORY — "How we started in New Jersey", "The secret behind our brine"
     b) BEHIND THE SCENES — "Inside our kitchen on packing day"
     c) TIPS / EDUCATION — "How to store pickles for max crunch"
     d) SEASONAL — "Summer grilling with pickles"
   Specify archetype in "contentArchetype". Include full storyBody + pullQuote.

3. "product_spotlight" — Feature a product, premium craft focus. NO discount.
   ✅ "Meet our Hot Tomatoes 🍅", "Small batch, big flavor"

4. "recipe" — A full recipe built around a product. NO discount.
   ✅ "Quick pickle tartine in 15 min", "Hot Tomato & ricotta toast"
   REQUIRES the "recipe" object: { dishName, prepTime, ingredients[4-7], steps[3-5] }

5. "pairing" — A pairing guide — product + complementary item. NO discount.
   ✅ "Hot Tomatoes × aged gouda", "Pickles meet their match"
   REQUIRES the "pairing" object: { leftItem{name,description}, rightItem{name,description}, pairingNote }

6. "customer_love" — Real customer testimonials (2-3 quotes). NO discount.
   ✅ "Why fans can't stop ordering", "Real reviews from real pickle people"
   REQUIRES the "customerLove" object: { quotes: [{text, author, location, rating}] }

STRATEGY: Balance your week. Mix types widely. Ideal week: 1-2 promo + 4-5 mix of content/spotlight/recipe/pairing/customer_love.
NEVER repeat the same type 2 days in a row. NEVER repeat same product 2 days in a row.
NEVER repeat the same content archetype, product, or subject angle used in recent campaigns.

YOUR TASK:
1. Choose campaign type (promotional, content, or product_spotlight)
2. Subject line (compelling, under 50 chars)
3. Preview text (adds context, under 80 chars)
4. Headline for the creative image
5. Which product to feature
6. ONLY if type is "promotional": discount percentage (15-30%) and discount code (ALL CAPS, unique). Do NOT reuse: ${allUsedCodes.join(', ') || 'none yet'}
7. Which list to send to
8. What hour to send — ${earliestSendHour >= config.sendWindowEnd ? `Today\\'s window is closed. Pick any hour between ${config.sendWindowStart} and ${config.sendWindowEnd - 1} for TOMORROW.` : `MUST be >= ${earliestSendHour} and < ${config.sendWindowEnd} (current time is ${currentETHour}:00 ET)`}

${learningData.totalCampaigns < 15 ? 'LEARNING PHASE: Try different types, hours, and lists to gather data.' : 'OPTIMIZED PHASE: Use your learning data to pick the best performing time and list.'}

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
  "campaignType": "promotional|content|product_spotlight|recipe|pairing|customer_love",
  "subjectLine": "...",
  "previewText": "...",
  "headline": "...",
  "product": "<product slug>",
  "productName": "<product full name>",
  "discountPercent": <number 15-30 or null if not promotional>,
  "discountCode": "<SHORT_CODE or null if not promotional>",
  "contentAngle": "<short angle description, all types>",
  "contentArchetype": "<ONLY for content: origin_story|behind_the_scenes|tips|seasonal>",
  "storyBody": "<ONLY for content type: 2-3 paragraphs, 200-400 words, real story>",
  "pullQuote": "<ONLY for content type: one memorable sentence, max 120 chars>",
  "recipe": { "dishName": "...", "prepTime": "15 min", "ingredients": ["...","...","..."], "steps": ["...","...","..."] },
  "pairing": { "leftItem": {"name":"...","description":"..."}, "rightItem":{"name":"...","description":"..."}, "pairingNote":"..." },
  "customerLove": { "quotes": [{"text":"...","author":"...","location":"NJ","rating":5}] },
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

    const decisionModel = config.model || this.defaultModel;
    try {
      console.log(`🏛️ Maximus: Asking ${decisionModel} for decision...`);
      const response = await this.client.messages.create({
        model: decisionModel,
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

      // Reject if list already used today (only when scheduling same day)
      const isSameDay = decision.sendHour >= earliestSendHour && decision.sendHour < config.sendWindowEnd;
      if (isSameDay && usedListsToday.includes(decision.listId.toString())) {
        console.error(`🏛️ Maximus: List "${validList.name}" already used today — rejecting`);
        return null;
      }

      // Enforce minimum hour gap with other same-day campaigns
      if (isSameDay) {
        const tooClose = usedHoursToday.find(h => Math.abs(decision.sendHour - h) < minGap);
        if (tooClose !== undefined) {
          console.error(`🏛️ Maximus: Chosen hour ${decision.sendHour}:00 too close to ${tooClose}:00 (min gap ${minGap}h)`);
          return null;
        }
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

      // Validate subject, discount code, and type-specific payload
      const subjectCheck = this.validateSubject(decision.subjectLine);
      const codeCheck = decision.campaignType === 'promotional'
        ? this.validateDiscountCode(decision.discountCode)
        : { valid: true, violations: [] };
      const payloadCheck = this.validateTypePayload(decision);

      if (!subjectCheck.valid || !codeCheck.valid || !payloadCheck.valid) {
        const allViolations = [...subjectCheck.violations, ...codeCheck.violations, ...payloadCheck.violations];
        console.warn(`🏛️ Maximus: Decision failed validation — ${allViolations.join(', ')}. Retrying once...`);

        const retryPrompt = `${prompt}

⚠️ CRITICAL: Your previous attempt violated the rules:
- Subject: "${decision.subjectLine}"
- Discount code: ${decision.discountCode || 'n/a'}
- Violations: ${allViolations.join(', ')}

Retry with a subject that contains NO weekday names and NO date-specific urgency phrases, and a discount code with NO weekday abbreviations (MON/TUE/etc).`;

        try {
          const retryResp = await this.client.messages.create({
            model: decisionModel,
            max_tokens: 2048,
            messages: [{ role: 'user', content: retryPrompt }]
          });
          const retryContent = retryResp.content?.[0]?.text || '';
          const retryMatch = retryContent.match(/\{[\s\S]*\}/);
          if (retryMatch) {
            const retryDecision = JSON.parse(retryMatch[0]);
            const rs = this.validateSubject(retryDecision.subjectLine);
            const rc = retryDecision.campaignType === 'promotional'
              ? this.validateDiscountCode(retryDecision.discountCode)
              : { valid: true, violations: [] };
            const rp = this.validateTypePayload(retryDecision);
            if (rs.valid && rc.valid && rp.valid) {
              console.log('🏛️ Maximus: Retry produced valid subject/code/payload');
              // Carry over hour validation result
              if (retryDecision.sendHour < earliestSendHour || retryDecision.sendHour >= config.sendWindowEnd) {
                retryDecision.sendHour = earliestSendHour < config.sendWindowEnd
                  ? earliestSendHour
                  : Math.max(config.sendWindowStart, Math.min(retryDecision.sendHour, config.sendWindowEnd - 1));
              }
              return retryDecision;
            }
            console.error(`🏛️ Maximus: Retry still invalid — ${[...rs.violations, ...rc.violations, ...rp.violations].join(', ')}`);
          }
        } catch (retryErr) {
          console.error('🏛️ Maximus: Retry error:', retryErr.message);
        }
        return null;
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

    // Same-day awareness (for the proposal flow too)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const sentToday = campaignsThisWeek.filter(c => new Date(c.sentAt) >= todayStart);
    const usedListsToday = sentToday.map(c => c.list.toString());
    const usedHoursToday = sentToday.map(c => c.sentHour);

    // Gather learning data
    const learningData = await this.gatherLearningData();

    // Step 1: Ask Claude for decision
    const decision = await this.makeDecision(config, learningData, campaignsThisWeek, { usedListsToday, usedHoursToday });
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
      console.log('\n🏛️ Maximus: Directing creative brief...');
      const director = await this.directCreative(decision);

      console.log('\n🏛️ Maximus: Requesting creative from Apollo...');
      const apolloBrief = {
        product: decision.product,
        headline: decision.headline || decision.subjectLine,
        productName: decision.productName,
        campaignType: decision.campaignType,
        contentAngle: decision.contentAngle,
        recipe: decision.recipe,
        pairing: decision.pairing,
        customerLove: decision.customerLove,
        director
      };

      if (decision.campaignType === 'promotional') {
        apolloBrief.discount = `${decision.discountPercent}% OFF TODAY ONLY`;
        apolloBrief.code = decision.discountCode;
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
          pullQuote: decision.pullQuote,
          recipe: decision.recipe,
          pairing: decision.pairing,
          customerLove: decision.customerLove
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
        recipe: decision.campaignType === 'recipe' ? decision.recipe : null,
        pairing: decision.campaignType === 'pairing' ? decision.pairing : null,
        customerLove: decision.campaignType === 'customer_love' ? decision.customerLove : null,
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
    const productsInfo = await this._buildProductsInfo();
    const listsInfo = config.lists.map(l => `- "${l.name}" (ID: ${l.listId})`).join('\n');
    const allUsedCodes = await this._collectUsedDiscountCodes();
    const learningSection = this._buildLearningSection(learningData);

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
CAMPAIGNS TO PLAN: up to ${config.maxCampaignsPerWeek} total this week, up to ${config.maxCampaignsPerDay} per day
SEND WINDOW: ${config.sendWindowStart}:00 - ${config.sendWindowEnd}:00 (${config.timezone})
MIN HOURS BETWEEN SAME-DAY SENDS: ${config.minHoursBetweenSameDay}h

AVAILABLE LISTS (${config.lists.length} total):
${listsInfo}

MULTI-SEND STRATEGY — when to double up on one day:
- A strong day (based on learning data) can host 2 campaigns in different time slots
- The 2 campaigns MUST go to DIFFERENT lists (never same list twice same day)
- The 2 campaigns MUST be spaced at least ${config.minHoursBetweenSameDay}h apart (e.g. 11am + 3pm)
- On a double-day, mix types: if one is promotional, the other should be content/spotlight (never 2 promos same day)
- Prefer doubling on your best-performing day(s) to maximize impressions on strong slots

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

CAMPAIGN TYPES (choose ONE per campaign — mix types widely across the week):
1. "promotional" — Discount 15-30% OFF. Include discount code. No date-specific urgency.
2. "content" — Origin/tips/seasonal/behind-the-scenes storytelling. NO discount. Requires storyBody + pullQuote.
   contentArchetype ∈ {origin_story, behind_the_scenes, tips, seasonal}
3. "product_spotlight" — Feature a product's craft. NO discount.
4. "recipe" — A complete recipe built around a product. NO discount. Requires "recipe" object.
5. "pairing" — Product × complementary item pairing guide. NO discount. Requires "pairing" object.
6. "customer_love" — 2-3 real testimonials. NO discount. Requires "customerLove" object.

VARIETY RULE: use at least 4 DIFFERENT types across the week. Never repeat same type 2 days in a row.

STRATEGY RULES:
- Balance the week: ~25-35% promotional, rest content/spotlight/recipe/pairing
- NEVER schedule two promotional campaigns on consecutive days — always put at least one content or spotlight between promos
- NEVER send two promos on the SAME day (even with different lists)
- Rotate products — don't feature the same product 2 days in a row
- Rotate lists — avoid hitting the same list on consecutive days if possible
- SAME DAY RULE: if you schedule 2 campaigns on one day, they MUST go to different lists, with ≥${config.minHoursBetweenSameDay}h between them, and at least one must be non-promotional
- Vary send hours to gather learning data
- Each discount code MUST be unique. Do NOT reuse: ${allUsedCodes.join(', ') || 'none yet'}
- It's OK to leave weak days empty (rest days) — don't force campaigns on low-performing days just to fill slots

TYPE-SPECIFIC REQUIREMENTS:
- content  → storyBody (200-400 words, real sensory story) + pullQuote (≤120 chars)
- recipe   → recipe: { dishName, prepTime: "15 min", ingredients: [4-7 strings], steps: [3-5 numbered strings, each 1-2 sentences] }
- pairing  → pairing: { leftItem: {name, description≤80 chars}, rightItem: {name, description≤80 chars}, pairingNote (1 memorable sentence, ≤140 chars) }
- customer_love → customerLove: { quotes: [{text (≤180 chars), author, location: "NJ" or similar, rating: 5}, ...2-3 quotes] }

Respond ONLY with valid JSON — an array of up to ${config.maxCampaignsPerWeek} campaigns (multiple per day allowed, up to ${config.maxCampaignsPerDay}/day):
[
  {
    "day": "<day name>",
    "date": "<YYYY-MM-DD>",
    "campaignType": "promotional|content|product_spotlight|recipe|pairing|customer_love",
    "subjectLine": "...",
    "previewText": "...",
    "headline": "...",
    "product": "<product slug>",
    "productName": "<product full name>",
    "discountPercent": <number or null>,
    "discountCode": "<CODE or null>",
    "contentAngle": "<short angle, all types>",
    "contentArchetype": "<ONLY for content: origin_story|behind_the_scenes|tips|seasonal>",
    "storyBody": "<REQUIRED for content, 200-400 words, null otherwise>",
    "pullQuote": "<REQUIRED for content, ≤120 chars, null otherwise>",
    "recipe": "<REQUIRED for recipe type, null otherwise>",
    "pairing": "<REQUIRED for pairing type, null otherwise>",
    "customerLove": "<REQUIRED for customer_love type, null otherwise>",
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

    const planModel = config.model || this.defaultModel;
    try {
      console.log(`🏛️ Maximus: Asking ${planModel} for weekly plan...`);
      console.log('🏛️ Maximus: Prompt length:', prompt.length, 'chars');
      const claudeStart = Date.now();
      const response = await this.client.messages.create({
        model: planModel,
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }]
      });
      console.log(`🏛️ Maximus: ${planModel} responded in ${((Date.now() - claudeStart) / 1000).toFixed(1)}s`);

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

      // Sort by date + hour to reason about same-day pairs and consecutive days
      campaigns.sort((a, b) => {
        const d = (a.date || '').localeCompare(b.date || '');
        return d !== 0 ? d : (a.sendHour || 0) - (b.sendHour || 0);
      });

      // Group by date for same-day validation
      const byDate = {};
      for (const c of campaigns) {
        if (!byDate[c.date]) byDate[c.date] = [];
        byDate[c.date].push(c);
      }

      // Same-day rules: max per day, distinct lists, min hour gap, no 2 promos
      const structuralViolations = [];
      for (const [date, dayCamps] of Object.entries(byDate)) {
        if (dayCamps.length > config.maxCampaignsPerDay) {
          structuralViolations.push(`${date}: ${dayCamps.length} campaigns exceeds maxCampaignsPerDay=${config.maxCampaignsPerDay}`);
        }
        const listIds = dayCamps.map(c => c.listId);
        if (new Set(listIds).size !== listIds.length) {
          structuralViolations.push(`${date}: duplicate list on same day`);
        }
        const promoCount = dayCamps.filter(c => c.campaignType === 'promotional').length;
        if (promoCount > 1) {
          structuralViolations.push(`${date}: ${promoCount} promos on same day (max 1)`);
        }
        // min hour gap
        for (let i = 1; i < dayCamps.length; i++) {
          const gap = Math.abs(dayCamps[i].sendHour - dayCamps[i - 1].sendHour);
          if (gap < config.minHoursBetweenSameDay) {
            structuralViolations.push(`${date}: hours ${dayCamps[i - 1].sendHour}h and ${dayCamps[i].sendHour}h too close (min ${config.minHoursBetweenSameDay}h gap)`);
          }
        }
      }

      // Back-to-back promos across consecutive DATES (regardless of same/different day grouping)
      const promoDates = [...new Set(campaigns.filter(c => c.campaignType === 'promotional').map(c => c.date))].sort();
      for (let i = 1; i < promoDates.length; i++) {
        const diffDays = (new Date(promoDates[i]) - new Date(promoDates[i - 1])) / 86400000;
        if (diffDays === 1) {
          // auto-demote the second day's promo(s) to content
          const toFlip = campaigns.filter(c => c.date === promoDates[i] && c.campaignType === 'promotional');
          toFlip.forEach(c => {
            console.warn(`🏛️ Maximus: Back-to-back promo demoted (${promoDates[i - 1]} → ${promoDates[i]}): "${c.subjectLine}" → content`);
            c.campaignType = 'content';
            c.discountPercent = null;
            c.discountCode = null;
            if (!c.contentArchetype) c.contentArchetype = 'tips';
            if (!c.contentAngle) c.contentAngle = 'Product quality & craft';
          });
        }
      }

      if (structuralViolations.length > 0) {
        console.error('🏛️ Maximus: Weekly plan rejected — structural violations:');
        structuralViolations.forEach(v => console.error(`   ${v}`));
        return { success: false, reason: 'validation_failed', violations: structuralViolations };
      }

      // Validate every subject, discount code, and type-specific payload
      const violations = [];
      for (const c of campaigns) {
        const sc = this.validateSubject(c.subjectLine);
        const dc = c.campaignType === 'promotional'
          ? this.validateDiscountCode(c.discountCode)
          : { valid: true, violations: [] };
        const pc = this.validateTypePayload(c);
        if (!sc.valid || !dc.valid || !pc.valid) {
          violations.push({
            day: c.day,
            subject: c.subjectLine,
            code: c.discountCode,
            type: c.campaignType,
            issues: [...sc.violations, ...dc.violations, ...pc.violations]
          });
        }
      }
      if (violations.length > 0) {
        console.error('🏛️ Maximus: Weekly plan rejected — rule violations:');
        violations.forEach(v => console.error(`   ${v.day}: "${v.subject}" (code: ${v.code || 'n/a'}) → ${v.issues.join(', ')}`));
        return { success: false, reason: 'validation_failed', violations };
      }

      // Generate Apollo creatives for each campaign
      apolloService.init();
      for (let i = 0; i < campaigns.length; i++) {
        const c = campaigns[i];
        console.log(`🏛️ Maximus: [${i + 1}/${campaigns.length}] ${c.day} — ${c.campaignType} — "${c.subjectLine}"`);

        // Calculate scheduledAt — compute ET offset for this specific date (handles DST)
        const campDate = new Date(c.date + 'T12:00:00Z'); // mid-day probe to avoid DST edge
        const etOffset = this.getEtOffsetHours(campDate);
        const scheduledAt = new Date(c.date + 'T00:00:00Z');
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

        // Direct + generate creative with Apollo
        if (apolloService.isAvailable()) {
          const director = await this.directCreative(c);
          const apolloBrief = {
            product: c.product,
            headline: c.headline || c.subjectLine,
            productName: c.productName,
            campaignType: c.campaignType,
            contentAngle: c.contentAngle,
            recipe: c.recipe,
            pairing: c.pairing,
            customerLove: c.customerLove,
            director
          };
          if (c.campaignType === 'promotional') {
            apolloBrief.discount = `${c.discountPercent}% OFF TODAY ONLY`;
            apolloBrief.code = c.discountCode;
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
              pullQuote: c.pullQuote,
              recipe: c.recipe,
              pairing: c.pairing,
              customerLove: c.customerLove
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
          recipe: c.campaignType === 'recipe' ? c.recipe : null,
          pairing: c.campaignType === 'pairing' ? c.pairing : null,
          customerLove: c.campaignType === 'customer_love' ? c.customerLove : null,
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
    const currentETHour = parseInt(now.toLocaleString('en-US', {
      timeZone: timezone, hour: 'numeric', hour12: false
    }));

    let hourDiff = sendHour - currentETHour;
    if (hourDiff <= 0) hourDiff += 24;

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
      converted: stats.purchased || 0,
      bounced: stats.bounced || 0,
      unsubscribed: stats.unsubscribed || 0,
      revenue: parseFloat((stats.totalRevenue || 0).toFixed(2)),
      openRate: delivered > 0 ? parseFloat(((stats.opened || 0) / delivered * 100).toFixed(1)) : 0,
      clickRate: delivered > 0 ? parseFloat(((stats.clicked || 0) / delivered * 100).toFixed(1)) : 0,
      conversionRate: delivered > 0 ? parseFloat(((stats.purchased || 0) / delivered * 100).toFixed(1)) : 0
    };
    log.metricsUpdatedAt = new Date();
    await log.save();

    // Update learning in config
    await this.updateLearning();

    // Analyze with Claude only when metrics are mature:
    // - delivered >= 100 (statistically meaningful sample)
    // - at least 48h since send (open rates stabilize)
    // - not yet analyzed
    const ageMs = Date.now() - new Date(log.sentAt).getTime();
    const MIN_AGE_MS = 48 * 60 * 60 * 1000;
    if (delivered >= 100 && ageMs >= MIN_AGE_MS && !log.claudeInsight?.analyzedAt) {
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
  // ==================== DIRECTOR (creative brief for Apollo/Gemini) ====================

  /**
   * Given a decision, ask Claude (Opus) to design a bespoke visual brief:
   * scene, lighting, palette, composition, extras. Beats the random-pool
   * approach because every field is coherent with type/product/narrative/season.
   *
   * Returns null on failure — Apollo will fall back to random pools.
   */
  async directCreative(decision) {
    if (!this.isAvailable()) return null;

    const config = await MaximusConfig.getConfig();
    const model = config.model || this.defaultModel;

    const typeHints = {
      promotional: 'urgency-friendly lifestyle — jar hero, props suggesting reward/indulgence',
      content: 'editorial magazine cover — quiet, narrative, a human presence felt not shown',
      product_spotlight: 'clean premium product photography — craft-forward, texture close-up',
      recipe: 'overhead flat-lay of the finished dish with jar beside — Bon Appétit / NYT Cooking',
      pairing: 'side-by-side on shared surface — two hero items, even visual weight',
      customer_love: 'lived-in kitchen moment — mid-use, warmth, everyday joy'
    };

    const narrativeHook = [
      decision.storyBody?.substring(0, 220),
      decision.recipe?.dishName,
      decision.pairing?.pairingNote,
      decision.customerLove?.quotes?.[0]?.text
    ].filter(Boolean).join(' | ') || decision.headline || decision.subjectLine;

    const now = new Date();
    const month = now.toLocaleString('en-US', { month: 'long' });
    const season = ['December','January','February'].includes(month) ? 'winter'
                 : ['March','April','May'].includes(month) ? 'spring'
                 : ['June','July','August'].includes(month) ? 'summer'
                 : 'autumn';

    const prompt = `You are the creative director for a single Jersey Pickles email poster.

CAMPAIGN CONTEXT:
- Type: ${decision.campaignType}  (${typeHints[decision.campaignType] || 'premium lifestyle'})
- Product: ${decision.productName || decision.product}
- Headline: "${decision.headline || decision.subjectLine}"
- Narrative hint: ${narrativeHook}
- Month: ${month} (${season})

YOUR JOB: design a bespoke visual brief that is coherent with type, product, narrative, and season. Avoid clichés. Avoid mismatches (e.g. no "winter candlelight" for a summer grilling recipe).

Respond ONLY with valid JSON (no prose, no markdown):
{
  "scene": "<one vivid sentence describing the surface and setting — specific objects, not generic>",
  "lighting": "<one sentence, specific time of day, quality and color temperature>",
  "palette": "<4-6 color words anchored to the product + season>",
  "composition": "<one sentence, camera angle, subject placement, negative space>",
  "extras": "<optional one sentence of distinctive props/textures that tie to the narrative, or null>"
}`;

    try {
      const response = await this.client.messages.create({
        model,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      });
      const content = response.content?.[0]?.text || '';
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) return null;
      const director = JSON.parse(match[0]);
      console.log(`🎬 Director (${model}): ${director.scene?.substring(0, 60)}...`);
      return director;
    } catch (err) {
      console.error('🎬 Director error:', err.message);
      return null;
    }
  }

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

    const analysisModel = config.modelForAnalysis || this.defaultAnalysisModel;
    try {
      const response = await this.client.messages.create({
        model: analysisModel,
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

    // Phase thresholds:
    //   initial   — 0 campaigns
    //   learning  — 1 to 14 campaigns (gathering data, exploring)
    //   optimized — 15+ campaigns (enough samples per day/hour/list for meaningful ranking)
    const OPTIMIZED_THRESHOLD = 15;
    if (learningData.totalCampaigns >= OPTIMIZED_THRESHOLD) {
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

      // Determine rest days only once we have a meaningful sample
      if (learningData.totalCampaigns >= OPTIMIZED_THRESHOLD) {
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
      model: config.model || this.defaultModel,
      modelForAnalysis: config.modelForAnalysis || this.defaultAnalysisModel,
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
