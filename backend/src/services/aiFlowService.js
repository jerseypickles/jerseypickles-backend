// backend/src/services/aiFlowService.js
// 🧠 Claude AI Integration for Flow Automation
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
   * @param {Object} options - Configuración
   * @returns {Promise<Object>} - Subject lines con predicciones
   */
  async generateSubjectLines(options) {
    if (!this.initialized) {
      return { success: false, error: 'AI not configured' };
    }
    
    const {
      flowType,           // 'welcome', 'abandoned_cart', 'post_purchase', etc.
      emailPosition,      // 1, 2, 3... (qué email en la secuencia)
      productContext,     // Productos relacionados
      customerSegment,    // 'new', 'vip', 'dormant'
      brandVoice,         // 'friendly', 'professional', 'playful'
      previousSubjects    // Para evitar repetición
    } = options;
    
    const prompt = `You are an expert email marketer for Jersey Pickles, an artisanal pickle and gourmet food e-commerce brand.

Generate 5 compelling email subject lines for:
- Flow type: ${flowType}
- Email #${emailPosition} in the sequence
- Customer segment: ${customerSegment || 'general'}
- Brand voice: ${brandVoice || 'friendly and playful'}
${productContext ? `- Product context: ${productContext}` : ''}
${previousSubjects?.length ? `- Avoid similar to: ${previousSubjects.join(', ')}` : ''}

Requirements:
1. Keep under 50 characters when possible
2. Use emojis strategically (🥒 is brand signature)
3. Create urgency without being spammy
4. Personalization variables available: {{customer.firstName}}, {{shop.name}}
5. Consider mobile preview (first 30 chars most important)

For each subject line, predict:
- Expected open rate (as percentage)
- Best for: (mobile/desktop/both)
- Emotional trigger used

Respond in JSON format:
{
  "subjectLines": [
    {
      "subject": "Subject line here",
      "predictedOpenRate": 25,
      "bestFor": "both",
      "emotionalTrigger": "curiosity",
      "explanation": "Why this works"
    }
  ],
  "recommendation": "Which one to use and why",
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
   * Genera contenido HTML completo para un email
   * @param {Object} options - Configuración del email
   * @returns {Promise<Object>} - HTML y metadata
   */
  async generateEmailContent(options) {
    if (!this.initialized) {
      return { success: false, error: 'AI not configured' };
    }
    
    const {
      flowType,
      emailPosition,
      subject,
      triggerContext,     // Datos del trigger (carrito, orden, etc.)
      customerData,       // Info del cliente
      goal,               // 'recover_cart', 'build_loyalty', 'get_review'
      includeDiscount,    // true/false
      discountDetails,    // { code: 'SAVE10', value: 10, type: 'percentage' }
      cta                 // { text: 'Shop Now', url: 'https://...' }
    } = options;
    
    const prompt = `You are an expert email designer for Jersey Pickles, creating a ${flowType} email.

Context:
- Email #${emailPosition} in sequence
- Subject: "${subject}"
- Goal: ${goal}
- Trigger data: ${JSON.stringify(triggerContext || {})}
${includeDiscount ? `- Discount: ${discountDetails.code} for ${discountDetails.value}${discountDetails.type === 'percentage' ? '%' : '$'} off` : ''}
- CTA: ${cta?.text || 'Shop Now'}

Brand Guidelines:
- Primary color: #2D5A27 (pickle green)
- Accent color: #F5A623 (mustard yellow)
- Tone: Friendly, playful, with pickle puns welcome
- Logo: https://jerseypickles.com/logo.png

Generate a complete HTML email that:
1. Is mobile-responsive (single column, max-width 600px)
2. Uses inline CSS only
3. Includes personalization: {{customer.firstName}}, {{customer.lastName}}
4. Has clear hierarchy and scannable content
5. Includes preheader text
${triggerContext?.cartItems ? '6. Shows cart items in a clean grid' : ''}

IMPORTANT: Use actual HTML, not placeholders. Make it production-ready.

Respond in JSON:
{
  "html": "<!DOCTYPE html>...",
  "previewText": "Preheader text here",
  "estimatedReadTime": "30 seconds",
  "sections": ["header", "hero", "content", "cta", "footer"],
  "personalizationUsed": ["firstName"],
  "tips": ["Tip for improving this email"]
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
  
  // ==================== 🚀 FLOW BUILDER ASSISTANT ====================
  
  /**
   * Genera un flow completo basado en descripción natural
   * @param {string} description - "Quiero recuperar carritos abandonados"
   * @returns {Promise<Object>} - Flow structure completa
   */
  async generateFlowFromDescription(description) {
    if (!this.initialized) {
      return { success: false, error: 'AI not configured' };
    }
    
    const prompt = `You are an email automation expert. Create a complete flow based on this request:

"${description}"

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

Best practices:
1. Welcome series: 3-5 emails over 2 weeks
2. Abandoned cart: 2-3 emails over 3 days, include discount in last
3. Post-purchase: Thank you immediately, review request after 7 days
4. Win-back: 3 emails over 2 weeks with escalating offers

Respond in JSON with this exact structure:
{
  "name": "Flow name",
  "description": "What this flow does",
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
  "tips": ["Implementation tips"]
}

For send_email steps, include actual subject lines and brief htmlContent descriptions (we'll generate full HTML separately).`;

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
    
    const prompt = `Given this email automation flow:
- Name: ${flow.name}
- Trigger: ${flow.trigger.type}
- Current steps: ${JSON.stringify(currentSteps, null, 2)}

What should be the next step? Consider:
1. If no emails sent yet, probably send one
2. If just sent email, add a wait
3. After 2-3 emails, consider a condition to branch
4. Near the end, consider adding a tag or discount

Respond in JSON:
{
  "suggestedStep": {
    "type": "step_type",
    "config": { ... },
    "order": ${currentSteps.length}
  },
  "reasoning": "Why this step makes sense",
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
      // Obtener flow con métricas
      const flow = await Flow.findById(flowId);
      if (!flow) {
        return { success: false, error: 'Flow not found' };
      }
      
      // Obtener execuciones recientes
      const executions = await FlowExecution.find({ flow: flowId })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();
      
      // Calcular métricas
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
      
      const prompt = `Analyze this email automation flow and suggest improvements:

Flow: ${flow.name}
Type: ${flow.trigger.type}
Steps: ${flow.steps.length}

Performance Metrics:
${JSON.stringify(metrics, null, 2)}

Steps breakdown:
${flow.steps.map((s, i) => `${i + 1}. ${s.type}: ${s.config.subject || s.config.delayMinutes + 'min' || s.config.tagName || 'config'}`).join('\n')}

Industry benchmarks for ${flow.trigger.type}:
- Welcome series: 50% open rate, 10% click rate
- Abandoned cart: 45% open rate, 8% click rate, 10% recovery
- Post-purchase: 40% open rate, 5% click rate

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
      "suggestion": "What to do",
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
   * Sugiere el mejor timing para cada step basado en datos históricos
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
      
      // Obtener datos de timing de campañas similares
      const campaigns = await Campaign.find({ status: 'sent' })
        .select('sentAt stats')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();
      
      // Analizar mejores horas
      const hourlyPerformance = this.analyzeHourlyPerformance(campaigns);
      
      const prompt = `Based on this email performance data by hour:
${JSON.stringify(hourlyPerformance, null, 2)}

Current flow timing:
${flow.steps.filter(s => s.type === 'wait').map((s, i) => `Wait ${i + 1}: ${s.config.delayMinutes} minutes`).join('\n')}

Flow type: ${flow.trigger.type}

Suggest optimal timing for each wait step. Consider:
1. For abandoned cart: 1hr, 24hr, 72hr is standard
2. For welcome: 0, 1day, 3days, 7days
3. Best send times based on the data provided

Respond in JSON:
{
  "currentTiming": [{ "step": 1, "currentDelay": 60 }],
  "recommendedTiming": [
    {
      "step": 1,
      "recommendedDelay": 90,
      "bestSendHour": 10,
      "bestSendDay": "Tuesday",
      "reasoning": "Why"
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
    
    return Math.round(totalMs / completed.length / 1000 / 60); // minutes
  }
  
  analyzeHourlyPerformance(campaigns) {
    const hourlyData = {};
    
    campaigns.forEach(c => {
      if (!c.sentAt || !c.stats) return;
      
      const hour = new Date(c.sentAt).getHours();
      const day = new Date(c.sentAt).getDay();
      
      if (!hourlyData[hour]) {
        hourlyData[hour] = { opens: 0, sent: 0, campaigns: 0 };
      }
      
      hourlyData[hour].opens += c.stats.opened || 0;
      hourlyData[hour].sent += c.stats.sent || 0;
      hourlyData[hour].campaigns += 1;
    });
    
    // Calcular open rate por hora
    return Object.entries(hourlyData).map(([hour, data]) => ({
      hour: parseInt(hour),
      openRate: data.sent > 0 ? (data.opens / data.sent * 100).toFixed(1) : 0,
      sampleSize: data.campaigns
    })).sort((a, b) => b.openRate - a.openRate);
  }
  
  // ==================== 🎨 TEMPLATE ENHANCEMENT ====================
  
  /**
   * Mejora un template existente con AI
   */
  async enhanceTemplate(templateId, html, options = {}) {
    if (!this.initialized) {
      return { success: false, error: 'AI not configured' };
    }
    
    const { 
      goal,           // 'increase_clicks', 'improve_readability', 'add_urgency'
      targetAudience, // 'new_customers', 'vip', 'cart_abandoners'
      keepBranding    // true/false
    } = options;
    
    const prompt = `Improve this email HTML for: ${goal || 'better engagement'}

Target audience: ${targetAudience || 'general'}
${keepBranding ? 'Keep all branding elements intact.' : ''}

Current HTML (abbreviated):
${html.substring(0, 2000)}...

Suggest improvements in JSON:
{
  "improvements": [
    {
      "element": "subject/headline/cta/images/copy",
      "current": "What it is now",
      "suggested": "What it should be",
      "reasoning": "Why this helps"
    }
  ],
  "enhancedCopy": {
    "headline": "Improved headline",
    "cta": "Improved CTA text",
    "preheader": "Improved preheader"
  },
  "structuralChanges": ["Reorder sections", "Add social proof"],
  "expectedImpact": "+X% clicks"
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