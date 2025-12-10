// backend/src/services/aiFlowService.js
// 🧠 Claude AI Integration for Flow Automation
// 🥒 Optimized for Jersey Pickles - Artisanal Style
const Anthropic = require('@anthropic-ai/sdk');
const Flow = require('../models/Flow');
const FlowExecution = require('../models/FlowExecution');
const Campaign = require('../models/Campaign');
const Customer = require('../models/Customer');

class AIFlowService {
  constructor() {
    this.client = null;
    this.model = 'claude-sonnet-4-20250514';
    this.initialized = false;
    
    // 🥒 Jersey Pickles Brand Guidelines
    this.brand = {
      name: 'Jersey Pickles',
      logo: 'https://cdn.shopify.com/s/files/1/0812/1873/2307/files/image_1_1671a1c5-b2cf-4c8b-9755-54e56911aa6f_-_Edited.png?v=1765135259',
      website: 'https://jerseypickles.com',
      tagline: 'Fresh, bold, and stadium-ready',
      colors: {
        primary: '#2D5A27',      // Pickle green
        secondary: '#1a3d17',    // Dark green
        accent: '#F5A623',       // Mustard yellow
        background: '#FFFFFF',   // White
        lightBg: '#f8faf8',      // Light green tint
        text: '#333333',         // Dark gray
        textLight: '#666666'     // Medium gray
      },
      tone: 'Warm, friendly, artisanal, family-oriented. Not overly commercial - focus on craft and quality.',
      products: ['Pickles', 'Olives', 'Marinated Mushrooms', 'Pickled Vegetables'],
      features: ['Build Your Box', 'Farmers Markets', 'Local New Jersey', 'Fresh Daily']
    };
    
    this.init();
  }
  
  init() {
    if (process.env.ANTHROPIC_API_KEY) {
      this.client = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
      this.initialized = true;
      console.log('✅ AI Flow Service initialized');
    } else {
      console.log('⚠️  AI Flow Service: No API key configured');
    }
  }
  
  // ==================== 📧 EMAIL CONTENT GENERATION ====================
  
  /**
   * Genera subject lines optimizados para un email de flow
   */
  async generateSubjectLines(options) {
    if (!this.initialized) {
      return { success: false, error: 'AI not configured' };
    }
    
    const {
      flowType,
      emailPosition,
      productContext,
      customerSegment,
      brandVoice,
      previousSubjects
    } = options;
    
    const prompt = `You are an email marketing expert for ${this.brand.name}, an artisanal pickle and olive company from New Jersey.

BRAND PERSONALITY:
- Tone: ${this.brand.tone}
- Tagline: "${this.brand.tagline}"
- Products: ${this.brand.products.join(', ')}
- NOT a big corporation - we're a family business at farmers markets

Generate 5 compelling email subject lines for:
- Flow type: ${flowType}
- Email #${emailPosition} in the sequence
- Customer segment: ${customerSegment || 'general'}
${productContext ? `- Product context: ${productContext}` : ''}
${previousSubjects?.length ? `- Avoid similar to: ${previousSubjects.join(', ')}` : ''}

IMPORTANT GUIDELINES:
1. Keep under 50 characters when possible
2. Use pickle emoji 🥒 sparingly (not in every one)
3. Sound personal and warm, like a friend sharing good food
4. NO aggressive sales language like "BUY NOW", "HURRY", "LIMITED TIME"
5. Focus on experience, flavor, craft - not discounts
6. Variables available: {{customer.firstName}}, {{shop.name}}
7. Think farmers market vibes, not big box store

GOOD EXAMPLES:
- "Hey {{customer.firstName}}, your pickles are waiting 🥒"
- "Fresh batch just dropped - thought of you"
- "The secret to the perfect pickle..."
- "From our kitchen to yours"

BAD EXAMPLES (too commercial):
- "🚨 HUGE SALE - 50% OFF!!!"
- "Don't miss out on this LIMITED offer!"
- "Act NOW before it's gone!"

Respond in JSON:
{
  "subjectLines": [
    {
      "subject": "Subject line here",
      "predictedOpenRate": 25,
      "bestFor": "both",
      "emotionalTrigger": "curiosity/warmth/nostalgia/appetite",
      "explanation": "Why this works for an artisanal brand"
    }
  ],
  "recommendation": "Which one best fits the artisanal vibe",
  "abTestSuggestion": "Which 2 to A/B test"
}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      });
      
      const content = response.content[0].text;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        return {
          success: true,
          ...result,
          tokensUsed: {
            input: response.usage.input_tokens,
            output: response.usage.output_tokens
          }
        };
      }
      
      return { success: false, error: 'Could not parse response' };
      
    } catch (error) {
      console.error('❌ AI Subject Generation Error:', error.message);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Genera contenido HTML completo para un email - ARTISANAL STYLE
   */
  async generateEmailContent(options) {
    if (!this.initialized) {
      return { success: false, error: 'AI not configured' };
    }
    
    const {
      flowType,
      emailPosition,
      subject,
      triggerContext,
      customerData,
      goal,
      includeDiscount,
      discountDetails,
      cta
    } = options;
    
    const prompt = `You are creating an email for ${this.brand.name}, an artisanal pickle and olive company.

EMAIL CONTEXT:
- Flow type: ${flowType}
- Email #${emailPosition} in sequence
- Subject: "${subject}"
- Goal: ${goal}
${includeDiscount ? `- Include discount: ${discountDetails?.code} for ${discountDetails?.value}${discountDetails?.type === 'percentage' ? '%' : '$'} off` : ''}
- CTA: ${cta?.text || 'Shop Now'} → ${cta?.url || this.brand.website}

BRAND REQUIREMENTS:
- Logo URL: ${this.brand.logo}
- Primary green: ${this.brand.colors.primary}
- Accent yellow: ${this.brand.colors.accent}
- Website: ${this.brand.website}
- Tone: ${this.brand.tone}

DESIGN REQUIREMENTS - CRITICAL:
1. MUST be fully responsive (mobile-first, works on all devices)
2. Max-width: 600px, centered
3. Use ONLY inline CSS (no <style> blocks)
4. White background header with logo
5. Clean, minimal design - artisanal feel, NOT corporate
6. Font: Georgia for headings (classic feel), Arial for body
7. Generous white space
8. Simple, warm imagery descriptions (we'll add real images)

CONTENT TONE:
- Write like you're talking to a friend who loves good food
- Share the story/craft behind the products
- NO aggressive sales language
- Focus on flavor, freshness, family recipes
- Can include a pickle pun, but don't overdo it
- Sign off warmly (e.g., "Stay crunchy, The Jersey Pickles Family")

EMAIL STRUCTURE:
1. Header: White background, centered logo, simple
2. Hero: Warm greeting, personal touch
3. Body: Story-driven content, not just product pushing
4. CTA: Subtle, inviting (green button, not screaming)
5. Footer: Warm sign-off, social links, unsubscribe

Generate COMPLETE, PRODUCTION-READY HTML. Use this exact structure:

<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Email</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f5f5;font-family:Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f5f5f5;">
    <tr>
      <td align="center" style="padding:20px 10px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;">
          <!-- HEADER -->
          <tr>
            <td align="center" style="padding:30px 20px;background-color:#ffffff;border-bottom:1px solid #eee;">
              <img src="${this.brand.logo}" alt="Jersey Pickles" width="180" style="max-width:180px;height:auto;display:block;">
            </td>
          </tr>
          <!-- CONTENT GOES HERE -->
          ...
        </table>
      </td>
    </tr>
  </table>
</body>
</html>

Respond in JSON:
{
  "html": "<!DOCTYPE html>... (complete HTML)",
  "previewText": "Preheader text (50-100 chars, warm and inviting)",
  "estimatedReadTime": "30 seconds",
  "sections": ["header", "greeting", "story", "cta", "footer"],
  "personalizationUsed": ["firstName"],
  "tips": ["Tips for this email"]
}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      });
      
      const content = response.content[0].text;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        return {
          success: true,
          ...result,
          tokensUsed: {
            input: response.usage.input_tokens,
            output: response.usage.output_tokens
          }
        };
      }
      
      return { success: false, error: 'Could not parse response' };
      
    } catch (error) {
      console.error('❌ AI Email Generation Error:', error.message);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Genera un template base artesanal para Jersey Pickles
   */
  getBaseEmailTemplate(content = {}) {
    const {
      greeting = 'Hey there!',
      body = '',
      ctaText = 'Visit Our Shop',
      ctaUrl = this.brand.website,
      signOff = 'Stay crunchy,<br>The Jersey Pickles Family 🥒'
    } = content;
    
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jersey Pickles</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f5f5;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f5f5f5;">
    <tr>
      <td align="center" style="padding:20px 10px;">
        <!--[if mso]>
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" align="center">
        <tr>
        <td>
        <![endif]-->
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.05);">
          
          <!-- HEADER WITH LOGO -->
          <tr>
            <td align="center" style="padding:32px 24px;background-color:#ffffff;border-bottom:1px solid #f0f0f0;">
              <a href="${this.brand.website}" target="_blank" style="text-decoration:none;">
                <img src="${this.brand.logo}" alt="Jersey Pickles" width="200" style="max-width:200px;height:auto;display:block;border:0;">
              </a>
            </td>
          </tr>
          
          <!-- MAIN CONTENT -->
          <tr>
            <td style="padding:40px 32px;background-color:#ffffff;">
              <!-- Greeting -->
              <h1 style="margin:0 0 24px 0;font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:normal;color:${this.brand.colors.primary};line-height:1.3;">
                ${greeting}
              </h1>
              
              <!-- Body Content -->
              <div style="font-size:16px;line-height:1.7;color:${this.brand.colors.text};">
                ${body}
              </div>
              
              <!-- CTA Button -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:32px 0;">
                <tr>
                  <td align="center" style="border-radius:8px;background-color:${this.brand.colors.primary};">
                    <a href="${ctaUrl}" target="_blank" style="display:inline-block;padding:16px 32px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;">
                      ${ctaText}
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- WARM SIGN-OFF -->
          <tr>
            <td style="padding:0 32px 40px 32px;background-color:#ffffff;">
              <p style="margin:0;font-size:16px;line-height:1.6;color:${this.brand.colors.textLight};font-style:italic;">
                ${signOff}
              </p>
            </td>
          </tr>
          
          <!-- FOOTER -->
          <tr>
            <td style="padding:24px 32px;background-color:${this.brand.colors.lightBg};border-top:1px solid #e8e8e8;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center" style="padding-bottom:16px;">
                    <p style="margin:0;font-size:13px;color:${this.brand.colors.textLight};">
                      Made with ❤️ in New Jersey
                    </p>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding-bottom:16px;">
                    <a href="${this.brand.website}" style="color:${this.brand.colors.primary};text-decoration:none;font-size:13px;margin:0 8px;">Shop</a>
                    <span style="color:#ccc;">|</span>
                    <a href="${this.brand.website}/pages/build-you-box" style="color:${this.brand.colors.primary};text-decoration:none;font-size:13px;margin:0 8px;">Build Your Box</a>
                    <span style="color:#ccc;">|</span>
                    <a href="${this.brand.website}/pages/store-locator-2" style="color:${this.brand.colors.primary};text-decoration:none;font-size:13px;margin:0 8px;">Find Us</a>
                  </td>
                </tr>
                <tr>
                  <td align="center">
                    <p style="margin:0;font-size:11px;color:#999;">
                      © ${new Date().getFullYear()} Jersey Pickles. All rights reserved.<br>
                      <a href="{{unsubscribe_url}}" style="color:#999;text-decoration:underline;">Unsubscribe</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
        </table>
        <!--[if mso]>
        </td>
        </tr>
        </table>
        <![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;
  }
  
  // ==================== 🚀 FLOW BUILDER ASSISTANT ====================
  
  /**
   * Genera un flow completo basado en descripción natural
   */
  async generateFlowFromDescription(description) {
    if (!this.initialized) {
      return { success: false, error: 'AI not configured' };
    }
    
    const prompt = `You are an email automation expert for ${this.brand.name}, an artisanal pickle and olive company.

Create a complete automation flow based on this request:
"${description}"

BRAND CONTEXT:
- We're a family business, not a corporation
- Products: pickles, olives, marinated vegetables
- Tone: warm, friendly, craft-focused
- Feature: Build Your Box custom orders

Available triggers:
- customer_created: New customer signs up
- order_placed: Order completed
- order_fulfilled: Order shipped
- cart_abandoned: Cart left without purchase (config: abandonedAfterMinutes)
- customer_tag_added: Tag added in Shopify (config: tagName)
- popup_signup: Email popup submission

Available step types:
- send_email: { subject, htmlContent, previewText }
- wait: { delayMinutes } (1440 = 1 day)
- condition: { conditionType, conditionValue, ifTrue: [], ifFalse: [] }
  - conditionTypes: has_purchased, tag_exists, total_spent_greater, orders_count_greater
- add_tag: { tagName }
- create_discount: { discountCode, discountType: 'percentage'|'fixed_amount', discountValue, expiresInDays }

TIMING BEST PRACTICES for artisanal brands:
1. Welcome series: Space out more (0, 3 days, 7 days, 14 days) - don't overwhelm
2. Abandoned cart: Be gentle (1hr, 24hr, 72hr) - remind, don't pressure
3. Post-purchase: Focus on experience (immediate thank you, 10 days check-in, 21 days review)
4. Win-back: Patient approach (7 days, 21 days, 45 days)

SUBJECT LINE STYLE:
- Warm and personal, not salesy
- Can include 🥒 emoji occasionally
- Examples: "Your pickles are packed!", "From our brine to your table"

Respond in JSON with this exact structure:
{
  "name": "Flow name",
  "description": "What this flow does (warm, friendly description)",
  "trigger": {
    "type": "trigger_type",
    "config": {}
  },
  "steps": [
    {
      "type": "step_type",
      "config": { ... },
      "order": 0
    }
  ],
  "estimatedRevenue": "+X% expected improvement",
  "tips": ["Implementation tips specific to artisanal brands"]
}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 3000,
        messages: [{ role: 'user', content: prompt }]
      });
      
      const content = response.content[0].text;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        return {
          success: true,
          flow: result,
          tokensUsed: {
            input: response.usage.input_tokens,
            output: response.usage.output_tokens
          }
        };
      }
      
      return { success: false, error: 'Could not parse response' };
      
    } catch (error) {
      console.error('❌ AI Flow Generation Error:', error.message);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Sugiere el siguiente step basado en el contexto actual
   */
  async suggestNextStep(flow, currentSteps) {
    if (!this.initialized) {
      return { success: false, error: 'AI not configured' };
    }
    
    const prompt = `Given this email automation flow for an artisanal pickle company:
- Name: ${flow.name}
- Trigger: ${flow.trigger.type}
- Current steps: ${JSON.stringify(currentSteps, null, 2)}

What should be the next step? Consider:
1. Don't send too many emails (artisanal brands should be less aggressive)
2. Space out communications - quality over quantity
3. Focus on relationship building, not just sales
4. After 2-3 emails, consider a longer wait or condition

Respond in JSON:
{
  "suggestedStep": {
    "type": "step_type",
    "config": { ... },
    "order": ${currentSteps.length}
  },
  "reasoning": "Why this step makes sense for an artisanal brand",
  "alternatives": [
    { "type": "...", "description": "Alternative option" }
  ]
}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      });
      
      const content = response.content[0].text;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        return { success: true, ...JSON.parse(jsonMatch[0]) };
      }
      
      return { success: false, error: 'Could not parse response' };
      
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  // ==================== 📊 FLOW OPTIMIZATION ====================
  
  /**
   * Analiza un flow y sugiere mejoras basadas en performance
   */
  async analyzeFlowPerformance(flowId) {
    if (!this.initialized) {
      return { success: false, error: 'AI not configured' };
    }
    
    try {
      const flow = await Flow.findById(flowId);
      if (!flow) {
        return { success: false, error: 'Flow not found' };
      }
      
      const executions = await FlowExecution.find({ flow: flowId })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();
      
      const metrics = {
        totalExecutions: executions.length,
        completed: executions.filter(e => e.status === 'completed').length,
        failed: executions.filter(e => e.status === 'failed').length,
        avgDuration: this.calculateAvgDuration(executions),
        conversionRate: flow.metrics.totalOrders / (flow.metrics.totalTriggered || 1) * 100,
        revenuePerExecution: flow.metrics.totalRevenue / (flow.metrics.completed || 1),
        emailMetrics: {
          sent: flow.metrics.emailsSent,
          openRate: flow.metrics.emailsSent > 0 
            ? (flow.metrics.opens / flow.metrics.emailsSent * 100).toFixed(1) 
            : 0,
          clickRate: flow.metrics.emailsSent > 0 
            ? (flow.metrics.clicks / flow.metrics.emailsSent * 100).toFixed(1) 
            : 0
        }
      };
      
      const prompt = `Analyze this email automation flow for an artisanal pickle company:

Flow: ${flow.name}
Type: ${flow.trigger.type}
Steps: ${flow.steps.length}

Performance Metrics:
${JSON.stringify(metrics, null, 2)}

Steps breakdown:
${flow.steps.map((s, i) => `${i + 1}. ${s.type}: ${s.config.subject || s.config.delayMinutes + 'min' || s.config.tagName || 'config'}`).join('\n')}

Industry benchmarks for artisanal food brands:
- Welcome series: 45-55% open rate, 8-12% click rate
- Abandoned cart: 40-50% open rate, 6-10% click rate
- Post-purchase: 50-60% open rate, 5-8% click rate

IMPORTANT: This is an artisanal brand. Recommendations should focus on:
- Building genuine relationships, not aggressive selling
- Quality of engagement over quantity
- Storytelling and brand connection
- NOT suggesting more emails or faster sequences

Provide actionable recommendations in JSON:
{
  "overallScore": 75,
  "scoreExplanation": "Why this score",
  "strengths": ["What's working well"],
  "weaknesses": ["What needs improvement"],
  "recommendations": [
    {
      "priority": "high|medium|low",
      "area": "timing|content|structure|targeting",
      "issue": "The problem",
      "suggestion": "What to do (artisanal-appropriate)",
      "expectedImpact": "+X% improvement"
    }
  ],
  "quickWins": ["Easy changes with high impact"],
  "abTestIdeas": ["What to test"]
}`;

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      });
      
      const content = response.content[0].text;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const analysis = JSON.parse(jsonMatch[0]);
        return {
          success: true,
          flowId,
          flowName: flow.name,
          metrics,
          analysis,
          generatedAt: new Date().toISOString()
        };
      }
      
      return { success: false, error: 'Could not parse response' };
      
    } catch (error) {
      console.error('❌ AI Flow Analysis Error:', error.message);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Sugiere el mejor timing para cada step
   */
  async optimizeTiming(flowId) {
    if (!this.initialized) {
      return { success: false, error: 'AI not configured' };
    }
    
    try {
      const flow = await Flow.findById(flowId);
      if (!flow) {
        return { success: false, error: 'Flow not found' };
      }
      
      const campaigns = await Campaign.find({ status: 'sent' })
        .select('sentAt stats')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();
      
      const hourlyPerformance = this.analyzeHourlyPerformance(campaigns);
      
      const prompt = `Based on this email performance data by hour:
${JSON.stringify(hourlyPerformance, null, 2)}

Current flow timing for ${flow.name} (${flow.trigger.type}):
${flow.steps.filter(s => s.type === 'wait').map((s, i) => `Wait ${i + 1}: ${s.config.delayMinutes} minutes (${Math.round(s.config.delayMinutes/60)}h)`).join('\n')}

This is an ARTISANAL pickle brand. Timing philosophy:
- Don't rush customers - they appreciate thoughtful timing
- Quality engagement > frequent contact
- Best send times for food brands: typically mid-morning (10-11am) or early evening (6-7pm)
- Avoid weekends for promotional emails, save for story-telling content

Suggest optimal timing that respects the artisanal approach.

Respond in JSON:
{
  "currentTiming": [{ "step": 1, "currentDelay": 60 }],
  "recommendedTiming": [
    {
      "step": 1,
      "recommendedDelay": 90,
      "bestSendHour": 10,
      "bestSendDay": "Tuesday",
      "reasoning": "Why (artisanal context)"
    }
  ],
  "expectedImprovement": "+X% open rate",
  "implementation": "How to apply these changes"
}`;

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      });
      
      const content = response.content[0].text;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        return { success: true, ...JSON.parse(jsonMatch[0]) };
      }
      
      return { success: false, error: 'Could not parse response' };
      
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  // ==================== 🔧 HELPER METHODS ====================
  
  calculateAvgDuration(executions) {
    const completed = executions.filter(e => e.completedAt && e.startedAt);
    if (completed.length === 0) return 0;
    
    const totalMs = completed.reduce((sum, e) => {
      return sum + (new Date(e.completedAt) - new Date(e.startedAt));
    }, 0);
    
    return Math.round(totalMs / completed.length / 1000 / 60);
  }
  
  analyzeHourlyPerformance(campaigns) {
    const hourlyData = {};
    
    campaigns.forEach(c => {
      if (!c.sentAt || !c.stats) return;
      
      const hour = new Date(c.sentAt).getHours();
      
      if (!hourlyData[hour]) {
        hourlyData[hour] = { opens: 0, sent: 0, campaigns: 0 };
      }
      
      hourlyData[hour].opens += c.stats.opened || 0;
      hourlyData[hour].sent += c.stats.sent || 0;
      hourlyData[hour].campaigns += 1;
    });
    
    return Object.entries(hourlyData).map(([hour, data]) => ({
      hour: parseInt(hour),
      openRate: data.sent > 0 ? (data.opens / data.sent * 100).toFixed(1) : 0,
      sampleSize: data.campaigns
    })).sort((a, b) => b.openRate - a.openRate);
  }
  
  /**
   * Mejora un template existente con AI
   */
  async enhanceTemplate(templateId, html, options = {}) {
    if (!this.initialized) {
      return { success: false, error: 'AI not configured' };
    }
    
    const { 
      goal,
      targetAudience,
      keepBranding
    } = options;
    
    const prompt = `Improve this email HTML for ${this.brand.name}, an artisanal pickle company.
Goal: ${goal || 'better engagement'}
Target audience: ${targetAudience || 'general'}
${keepBranding ? 'Keep all branding elements intact.' : ''}

Current HTML (abbreviated):
${html.substring(0, 2000)}...

IMPORTANT: We're an artisanal brand. Improvements should:
- Enhance warmth and personal connection
- NOT make it more aggressive or salesy
- Focus on storytelling and craft
- Keep mobile responsiveness

Suggest improvements in JSON:
{
  "improvements": [
    {
      "element": "subject/headline/cta/images/copy",
      "current": "What it is now",
      "suggested": "What it should be",
      "reasoning": "Why this helps (artisanal context)"
    }
  ],
  "enhancedCopy": {
    "headline": "Improved headline (warm, not salesy)",
    "cta": "Improved CTA text (inviting, not pushy)",
    "preheader": "Improved preheader"
  },
  "structuralChanges": ["Suggestions that maintain artisanal feel"],
  "expectedImpact": "+X% engagement"
}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      });
      
      const content = response.content[0].text;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        return { success: true, ...JSON.parse(jsonMatch[0]) };
      }
      
      return { success: false, error: 'Could not parse response' };
      
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = new AIFlowService();