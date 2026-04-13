// backend/src/services/vulcanService.js
// 🔨 VULCAN - Segmentation Agent
// God of fire and forge — builds and maintains smart customer segments

const Anthropic = require('@anthropic-ai/sdk');
const VulcanConfig = require('../models/VulcanConfig');
const Customer = require('../models/Customer');
const List = require('../models/List');

class VulcanService {
  constructor() {
    this.client = null;
    this.model = 'claude-sonnet-4-6';
    this.initialized = false;
  }

  init() {
    if (this.initialized) return;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.log('🔨 Vulcan: ANTHROPIC_API_KEY not configured (insights disabled)');
      return;
    }
    try {
      this.client = new Anthropic({ apiKey });
      this.initialized = true;
      console.log('🔨 Vulcan: Initialized');
    } catch (error) {
      console.error('🔨 Vulcan: Init error:', error.message);
    }
  }

  isAvailable() {
    return this.initialized && this.client !== null;
  }

  // ==================== MAIN EXECUTION ====================

  async runSegmentation() {
    console.log('\n🔨 ═══════════════════════════════════════');
    console.log('   VULCAN - Forging Customer Segments');
    console.log('═══════════════════════════════════════\n');

    const startTime = Date.now();
    const config = await VulcanConfig.getConfig();

    if (!config.active) {
      console.log('🔨 Vulcan: Inactive, skipping');
      return { success: false, reason: 'inactive' };
    }

    // Build each segment
    const results = {};
    for (const segDef of config.segments) {
      if (!segDef.active) continue;
      try {
        const customerIds = await this.buildSegment(segDef.key);
        const listId = await this.syncToList(segDef, customerIds);

        // Update stats
        const idx = config.segments.findIndex(s => s.key === segDef.key);
        if (idx >= 0) {
          config.segments[idx].previousCount = config.segments[idx].memberCount || 0;
          config.segments[idx].memberCount = customerIds.length;
          config.segments[idx].listId = listId;
          config.segments[idx].lastUpdated = new Date();
        }

        results[segDef.key] = {
          name: segDef.name,
          count: customerIds.length,
          previousCount: config.segments[idx]?.previousCount || 0,
          delta: customerIds.length - (config.segments[idx]?.previousCount || 0)
        };

        console.log(`🔨 ${segDef.name}: ${customerIds.length} members`);
      } catch (err) {
        console.error(`🔨 Vulcan: Error building ${segDef.key}:`, err.message);
        results[segDef.key] = { name: segDef.name, error: err.message };
      }
    }

    config.lastRunAt = new Date();
    config.lastRunDurationMs = Date.now() - startTime;
    config.totalRuns = (config.totalRuns || 0) + 1;
    await config.save();

    // Generate Claude insight
    if (this.isAvailable()) {
      try {
        const insight = await this.generateInsight(results);
        if (insight) {
          config.lastInsight = insight;
          config.insightHistory = config.insightHistory || [];
          config.insightHistory.unshift({ insight, createdAt: new Date() });
          config.insightHistory = config.insightHistory.slice(0, 20);
          await config.save();
          console.log(`🔨 Vulcan Insight: "${insight}"`);
        }
      } catch (err) {
        console.error('🔨 Vulcan: Insight generation error:', err.message);
      }
    }

    console.log(`🔨 Vulcan: ✅ Segmentation complete in ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);

    return { success: true, results, durationMs: Date.now() - startTime };
  }

  // ==================== SEGMENT BUILDERS ====================

  /**
   * Build a segment and return array of customer IDs
   */
  async buildSegment(key) {
    const baseFilter = {
      acceptsMarketing: true,
      emailStatus: 'active',
      'bounceInfo.isBounced': { $ne: true }
    };

    const now = Date.now();
    const days = (n) => new Date(now - n * 24 * 60 * 60 * 1000);

    switch (key) {
      case 'vip': {
        // Top 10% by totalSpent (min $50 to qualify)
        const totalSpenders = await Customer.countDocuments({
          ...baseFilter,
          totalSpent: { $gte: 50 }
        });
        const topCount = Math.ceil(totalSpenders * 0.1);
        const vips = await Customer
          .find({ ...baseFilter, totalSpent: { $gte: 50 } })
          .sort({ totalSpent: -1 })
          .limit(topCount)
          .select('_id')
          .lean();
        return vips.map(c => c._id);
      }

      case 'active': {
        // Purchased in last 30 days, EXCLUDING new customers (created in last 30 days)
        const customers = await Customer
          .find({
            ...baseFilter,
            ordersCount: { $gte: 1 },
            lastOrderDate: { $gte: days(30) },
            createdAt: { $lt: days(30) }
          })
          .select('_id')
          .lean();
        return customers.map(c => c._id);
      }

      case 'new_customers': {
        // First purchase in last 30 days (ordersCount >=1 AND created in last 30 days)
        const customers = await Customer
          .find({
            ...baseFilter,
            ordersCount: { $gte: 1 },
            createdAt: { $gte: days(30) }
          })
          .select('_id')
          .lean();
        return customers.map(c => c._id);
      }

      case 'at_risk': {
        // Used to buy (2+ orders) but no purchase in 45-90 days
        const customers = await Customer
          .find({
            ...baseFilter,
            ordersCount: { $gte: 2 },
            lastOrderDate: { $gte: days(90), $lt: days(45) }
          })
          .select('_id')
          .lean();
        return customers.map(c => c._id);
      }

      case 'dormant': {
        // 1+ order but nothing in 90+ days, EXCLUDING VIPs (they have their own segment)
        // Get VIP threshold to exclude them
        const vipThreshold = await this._getVipSpentThreshold();
        const dormantFilter = {
          ...baseFilter,
          ordersCount: { $gte: 1 },
          lastOrderDate: { $lt: days(90) }
        };
        if (vipThreshold) {
          dormantFilter.totalSpent = { $lt: vipThreshold };
        }
        const customers = await Customer
          .find(dormantFilter)
          .select('_id')
          .lean();
        return customers.map(c => c._id);
      }

      case 'hot_leads': {
        // Clicked an email in last 14 days but 0 orders
        const customers = await Customer
          .find({
            ...baseFilter,
            ordersCount: 0,
            'emailStats.clicked': { $gte: 1 },
            'emailStats.lastClickedAt': { $exists: true, $gte: days(14) }
          })
          .select('_id')
          .lean();
        return customers.map(c => c._id);
      }

      case 'engaged_no_purchase': {
        // Opens emails (2+) but 0 orders, EXCLUDING hot_leads (who clicked recently)
        const customers = await Customer
          .find({
            ...baseFilter,
            ordersCount: 0,
            'emailStats.opened': { $gte: 2 },
            $or: [
              { 'emailStats.clicked': { $exists: false } },
              { 'emailStats.clicked': 0 },
              { 'emailStats.lastClickedAt': { $exists: false } },
              { 'emailStats.lastClickedAt': { $lt: days(14) } }
            ]
          })
          .select('_id')
          .lean();
        return customers.map(c => c._id);
      }

      default:
        return [];
    }
  }

  /**
   * Get the minimum totalSpent to qualify as VIP (top 10% threshold)
   * Used to exclude VIPs from other segments like dormant
   */
  async _getVipSpentThreshold() {
    const baseFilter = {
      acceptsMarketing: true,
      emailStatus: 'active',
      'bounceInfo.isBounced': { $ne: true }
    };
    const totalSpenders = await Customer.countDocuments({
      ...baseFilter,
      totalSpent: { $gte: 50 }
    });
    if (totalSpenders === 0) return null;
    const topCount = Math.ceil(totalSpenders * 0.1);
    const lowestVip = await Customer
      .find({ ...baseFilter, totalSpent: { $gte: 50 } })
      .sort({ totalSpent: -1 })
      .skip(topCount - 1)
      .limit(1)
      .select('totalSpent')
      .lean();
    return lowestVip[0]?.totalSpent || null;
  }

  /**
   * Sync a segment's member list to a List document (create if missing)
   */
  async syncToList(segDef, customerIds) {
    // Tag with 'vulcan' so we can distinguish auto-generated lists
    let list = await List.findOne({ tags: 'vulcan', name: segDef.name });

    if (!list) {
      list = await List.create({
        name: segDef.name,
        description: segDef.description,
        members: customerIds,
        memberCount: customerIds.length,
        tags: ['vulcan', 'auto', segDef.key],
        isActive: true
      });
      console.log(`🔨 Vulcan: Created list "${segDef.name}"`);
    } else {
      list.members = customerIds;
      list.memberCount = customerIds.length;
      list.description = segDef.description;
      await list.save();
    }

    return list._id;
  }

  // ==================== CLAUDE INSIGHT ====================

  async generateInsight(results) {
    if (!this.isAvailable()) return null;

    const summary = Object.entries(results)
      .filter(([_, r]) => !r.error)
      .map(([key, r]) => {
        const deltaStr = r.delta > 0 ? `+${r.delta}` : r.delta;
        return `- ${r.name}: ${r.count} members (${deltaStr} from last run)`;
      })
      .join('\n');

    const config = await VulcanConfig.getConfig();
    const model = config.model || this.model;

    const prompt = `You are VULCAN, the segmentation agent for Jersey Pickles email marketing.

Current segment snapshot:
${summary}

Write ONE concise strategic insight (max 200 chars) about what these numbers reveal.
Focus on actionable observations: which segments are growing, shrinking, or worth targeting next.
Respond with just the insight text, no preamble.`;

    try {
      const response = await this.client.messages.create({
        model,
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      });
      return response.content?.[0]?.text?.trim() || null;
    } catch (err) {
      console.error('🔨 Vulcan: Claude error:', err.message);
      return null;
    }
  }

  // ==================== STATUS ====================

  async getStatus() {
    const config = await VulcanConfig.getConfig();
    return {
      agent: 'Vulcan',
      active: config.active,
      model: this.model,
      claudeAvailable: this.isAvailable(),
      lastRunAt: config.lastRunAt,
      lastRunDurationMs: config.lastRunDurationMs,
      totalRuns: config.totalRuns,
      lastInsight: config.lastInsight,
      segments: config.segments.map(s => ({
        key: s.key,
        name: s.name,
        description: s.description,
        listId: s.listId,
        memberCount: s.memberCount,
        previousCount: s.previousCount,
        delta: (s.memberCount || 0) - (s.previousCount || 0),
        lastUpdated: s.lastUpdated,
        active: s.active
      })),
      insightHistory: (config.insightHistory || []).slice(0, 10)
    };
  }
}

const vulcanService = new VulcanService();
module.exports = vulcanService;
