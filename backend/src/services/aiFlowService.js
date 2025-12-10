// backend/src/services/aiFlowService.js
// 🧠 Claude AI Integration for Flow Automation
// 🥒 Optimized for Jersey Pickles - Artisanal Style with Flow-Specific Templates
const Anthropic = require('@anthropic-ai/sdk');
const Flow = require('../models/Flow');
const FlowExecution = require('../models/FlowExecution');
const Campaign = require('../models/Campaign');

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
      phone: '(973) 555-1234',
      colors: {
        primary: '#2D5A27',
        secondary: '#1a3d17',
        accent: '#F5A623',
        background: '#FFFFFF',
        lightBg: '#f8faf8',
        text: '#333333',
        textLight: '#666666',
        border: '#e8e8e8'
      },
      tone: 'Warm, friendly, artisanal, family-oriented. Not overly commercial - focus on craft and quality.',
      products: ['Pickles', 'Olives', 'Marinated Mushrooms', 'Pickled Vegetables', 'Build Your Box']
    };
    
    // 📧 Flow-specific configurations - THE KEY DIFFERENTIATOR
    this.flowConfigs = this.initFlowConfigs();
    
    this.init();
  }
  
  initFlowConfigs() {
    return {
      // ==================== WELCOME SERIES ====================
      welcome: {
        name: 'Welcome Series',
        goal: 'Introduce brand, build relationship, encourage first purchase',
        tone: 'Warm, excited to meet them, storytelling focused',
        variables: ['{{customer.firstName}}', '{{customer.email}}'],
        ctas: ['Explore Our Pickles', 'Build Your Box', 'Find Us Near You', 'Meet the Family'],
        emailTypes: {
          1: { 
            purpose: 'Welcome & brand story', 
            subject_style: 'warm greeting',
            focus: 'Who we are, our family story, New Jersey roots'
          },
          2: { 
            purpose: 'Product education & bestsellers', 
            subject_style: 'helpful tips',
            focus: 'What makes our pickles special, top sellers'
          },
          3: { 
            purpose: 'Social proof & community', 
            subject_style: 'community invite',
            focus: 'Customer love, farmers markets, where to find us'
          },
          4: { 
            purpose: 'First purchase incentive', 
            subject_style: 'special welcome gift',
            focus: 'Exclusive welcome offer, Build Your Box'
          }
        },
        contentFocus: [
          'Our family story and New Jersey roots',
          'What makes our pickles different (fresh, small-batch)',
          'Farmers market presence and community',
          'Build Your Box customization'
        ],
        timingRecommendation: 'Day 0, Day 3, Day 7, Day 14'
      },
      
      // ==================== ABANDONED CART ====================
      abandoned_cart: {
        name: 'Abandoned Cart Recovery',
        goal: 'Recover abandoned carts gently without being pushy',
        tone: 'Helpful reminder, understanding, NO pressure or urgency',
        variables: [
          '{{customer.firstName}}',
          '{{cart.items}}',
          '{{cart.totalPrice}}',
          '{{cart.itemCount}}',
          '{{cart.checkoutUrl}}',
          '{{abandoned.productNames}}',
          '{{abandoned.firstProductImage}}',
          '{{abandoned.firstProductName}}',
          '{{abandoned.firstProductPrice}}'
        ],
        ctas: ['Complete My Order', 'Return to Cart', 'Finish Checkout'],
        emailTypes: {
          1: { 
            purpose: 'Gentle reminder (1-2 hours)', 
            subject_style: 'helpful, NOT urgent',
            focus: 'Simple reminder, show what they left, easy return link'
          },
          2: { 
            purpose: 'Product value highlight (24 hours)', 
            subject_style: 'value focused',
            focus: 'Why customers love this product, reviews, benefits'
          },
          3: { 
            purpose: 'Last chance + small incentive (72 hours)', 
            subject_style: 'final friendly reminder',
            focus: 'Soft urgency, optional discount, final nudge'
          }
        },
        contentFocus: [
          'Your pickles are waiting (NOT "HURRY!")',
          'Why customers love these specific products',
          'Easy checkout - we saved your cart',
          'Optional small incentive on final email only'
        ],
        timingRecommendation: '1 hour, 24 hours, 72 hours',
        bannedPhrases: ['HURRY', 'LIMITED TIME', 'ACT NOW', 'DONT MISS OUT', 'LAST CHANCE!!!', 'URGENT']
      },
      
      // ==================== POST PURCHASE ====================
      post_purchase: {
        name: 'Post-Purchase Journey',
        goal: 'Thank customer, ensure great experience, build loyalty, get reviews',
        tone: 'Grateful, helpful, relationship building - NOT selling more',
        variables: [
          '{{customer.firstName}}',
          '{{order.number}}',
          '{{order.totalPrice}}',
          '{{order.itemCount}}',
          '{{order.items}}',
          '{{order.trackingUrl}}',
          '{{order.trackingNumber}}',
          '{{order.estimatedDelivery}}',
          '{{order.firstProductName}}',
          '{{order.firstProductImage}}'
        ],
        ctas: ['Track My Order', 'Leave a Review', 'Shop Again', 'Share with Friends'],
        emailTypes: {
          1: { 
            purpose: 'Order confirmation & thank you', 
            subject_style: 'excited gratitude',
            focus: 'Genuine thanks, order details, what happens next'
          },
          2: { 
            purpose: 'Shipping notification', 
            subject_style: 'informative excitement',
            focus: 'Package is on its way, tracking info, delivery estimate'
          },
          3: { 
            purpose: 'Delivery follow-up & tips', 
            subject_style: 'helpful tips',
            focus: 'How to enjoy pickles, storage tips, serving suggestions'
          },
          4: { 
            purpose: 'Review request', 
            subject_style: 'friendly ask',
            focus: 'How reviews help small business, make it easy'
          },
          5: { 
            purpose: 'Replenishment reminder', 
            subject_style: 'thoughtful reminder',
            focus: 'Running low? Easy reorder, try something new'
          }
        },
        contentFocus: [
          'Genuine thank you for supporting small business',
          'Clear order and shipping information',
          'Storage tips and serving suggestions',
          'Why reviews matter to a family business',
          'Thoughtful replenishment timing'
        ],
        timingRecommendation: 'Immediate, Shipped, Day 7, Day 14, Day 30'
      },
      
      // ==================== WIN-BACK ====================
      win_back: {
        name: 'Win-Back Campaign',
        goal: 'Re-engage inactive customers with warmth, not guilt',
        tone: 'We miss you (genuinely), no guilt tripping, reconnection',
        variables: [
          '{{customer.firstName}}',
          '{{customer.lastOrderDate}}',
          '{{customer.daysSinceOrder}}',
          '{{customer.favoriteProduct}}',
          '{{customer.totalOrders}}'
        ],
        ctas: ['See What\'s New', 'Shop Now', 'Rediscover Your Favorites', 'Come Back & Save'],
        emailTypes: {
          1: { 
            purpose: 'We miss you (30 days)', 
            subject_style: 'friendly check-in',
            focus: 'Genuine "hey, haven\'t seen you", brief update'
          },
          2: { 
            purpose: 'What\'s new update (45 days)', 
            subject_style: 'exciting updates',
            focus: 'New products, seasonal items, what\'s popular'
          },
          3: { 
            purpose: 'Special comeback offer (60 days)', 
            subject_style: 'exclusive welcome back',
            focus: 'Personal discount, we\'d love to have you back'
          },
          4: { 
            purpose: 'Last heartfelt attempt (90 days)', 
            subject_style: 'genuine goodbye option',
            focus: 'Preference center, respect their choice, open door'
          }
        },
        contentFocus: [
          'Genuine "we noticed you haven\'t been around"',
          'What\'s new since they last ordered',
          'Special comeback incentive',
          'Respectful option to unsubscribe or update preferences'
        ],
        timingRecommendation: '30 days, 45 days, 60 days, 90 days',
        bannedPhrases: ['You\'re missing out!', 'Don\'t abandon us!', 'We\'re hurt you left']
      },
      
      // ==================== VIP PROGRAM ====================
      vip: {
        name: 'VIP Program',
        goal: 'Reward loyal customers, make them feel genuinely special',
        tone: 'Exclusive, appreciative, insider access - earned not marketed',
        variables: [
          '{{customer.firstName}}',
          '{{customer.totalSpent}}',
          '{{customer.orderCount}}',
          '{{customer.vipTier}}',
          '{{customer.vipSince}}'
        ],
        ctas: ['Shop VIP Exclusives', 'Claim Your Reward', 'Early Access', 'VIP Perks'],
        emailTypes: {
          1: { 
            purpose: 'VIP welcome & status', 
            subject_style: 'exclusive welcome',
            focus: 'Congratulations, what VIP means, your perks'
          },
          2: { 
            purpose: 'Monthly VIP exclusive', 
            subject_style: 'insider access',
            focus: 'This month\'s VIP-only offer or product'
          },
          3: { 
            purpose: 'Early access to new products', 
            subject_style: 'first look invitation',
            focus: 'See it before anyone else, VIP preview'
          },
          4: { 
            purpose: 'Birthday/anniversary reward', 
            subject_style: 'celebration',
            focus: 'Special day recognition, personal reward'
          }
        },
        contentFocus: [
          'Thank you for being a loyal customer',
          'Exclusive early access to new products',
          'VIP-only discounts and offers',
          'Behind the scenes content and stories'
        ],
        timingRecommendation: 'When earned, Monthly, New products, Special dates'
      },
      
      // ==================== REVIEW REQUEST ====================
      review_request: {
        name: 'Review Request',
        goal: 'Get authentic reviews from satisfied customers',
        tone: 'Appreciative, easy ask, explains why it matters',
        variables: [
          '{{customer.firstName}}',
          '{{order.number}}',
          '{{order.items}}',
          '{{product.name}}',
          '{{product.image}}',
          '{{review.url}}'
        ],
        ctas: ['Leave a Review', 'Share Your Experience', 'Tell Us What You Think'],
        emailTypes: {
          1: { 
            purpose: 'Initial review request', 
            subject_style: 'friendly ask',
            focus: 'How was your order? Quick review link'
          },
          2: { 
            purpose: 'Gentle reminder with context', 
            subject_style: 'helpful reminder',
            focus: 'Haven\'t heard from you, reviews help us grow'
          }
        },
        contentFocus: [
          'How their review helps our small family business',
          'Make it EASY - direct link, 30 seconds',
          'Thank them regardless of whether they review',
          'Optional: small thank you for leaving review'
        ],
        timingRecommendation: '7-10 days after delivery, 14 days reminder'
      },
      
      // ==================== BROWSE ABANDONMENT ====================
      browse_abandonment: {
        name: 'Browse Abandonment',
        goal: 'Re-engage browsers who didn\'t add to cart - very soft touch',
        tone: 'Super casual, helpful not creepy, soft suggestion',
        variables: [
          '{{customer.firstName}}',
          '{{browse.productName}}',
          '{{browse.productImage}}',
          '{{browse.productUrl}}',
          '{{browse.productPrice}}',
          '{{browse.categoryName}}'
        ],
        ctas: ['Take Another Look', 'Continue Browsing', 'Learn More'],
        emailTypes: {
          1: { 
            purpose: 'Soft reminder of interest', 
            subject_style: 'casual, not stalker-ish',
            focus: 'Noticed you were checking out X, here\'s more info'
          }
        },
        contentFocus: [
          'Very light touch - "saw you looking at..."',
          'More info about the product they viewed',
          'Related products they might also like',
          'NO hard sell, just helpful'
        ],
        timingRecommendation: '24 hours only (one email max)',
        bannedPhrases: ['We saw you looking!', 'Don\'t forget!', 'You left without buying!']
      },
      
      // ==================== BACK IN STOCK ====================
      back_in_stock: {
        name: 'Back in Stock',
        goal: 'Notify customers when desired products return',
        tone: 'Exciting good news, helpful notification',
        variables: [
          '{{customer.firstName}}',
          '{{product.name}}',
          '{{product.image}}',
          '{{product.url}}',
          '{{product.price}}'
        ],
        ctas: ['Get It Now', 'Shop Before It\'s Gone', 'View Product'],
        emailTypes: {
          1: { 
            purpose: 'Back in stock notification', 
            subject_style: 'exciting news',
            focus: 'Good news! The product you wanted is back'
          }
        },
        contentFocus: [
          'Exciting news - it\'s back!',
          'They asked to be notified, deliver on that',
          'Soft urgency is okay here - they wanted it',
          'Easy direct link to product'
        ],
        timingRecommendation: 'Immediately when restocked'
      }
    };
  }
  
  init() {
    if (process.env.ANTHROPIC_API_KEY) {
      this.client = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY
      });
      this.initialized = true;
      console.log('✅ AI Flow Service initialized with', Object.keys(this.flowConfigs).length, 'flow types');
    } else {
      console.warn('⚠️  AI Flow Service: No ANTHROPIC_API_KEY configured');
    }
  }
  
  // ==================== 📧 SUBJECT LINE GENERATION ====================
  
  async generateSubjectLines(options) {
    if (!this.initialized) {
      return { success: false, error: 'AI service not configured. Add ANTHROPIC_API_KEY to environment.' };
    }
    
    const {
      flowType = 'welcome',
      emailPosition = 1,
      customerSegment = 'general',
      previousSubjects = []
    } = options;
    
    const flowConfig = this.flowConfigs[flowType] || this.flowConfigs.welcome;
    const emailType = flowConfig.emailTypes[emailPosition] || flowConfig.emailTypes[1];
    
    const prompt = `You are an email marketing expert for ${this.brand.name}, an artisanal pickle and olive company from New Jersey.

═══════════════════════════════════════════════════════════════
FLOW CONTEXT - THIS IS CRITICAL
═══════════════════════════════════════════════════════════════
Flow Type: ${flowConfig.name}
Email #${emailPosition} in sequence
Purpose: ${emailType.purpose}
Subject Style: ${emailType.subject_style}
Focus: ${emailType.focus}
Overall Goal: ${flowConfig.goal}
Tone: ${flowConfig.tone}

═══════════════════════════════════════════════════════════════
AVAILABLE VARIABLES
═══════════════════════════════════════════════════════════════
${flowConfig.variables.join(', ')}

═══════════════════════════════════════════════════════════════
BRAND PERSONALITY
═══════════════════════════════════════════════════════════════
- Company: ${this.brand.name}
- Tagline: "${this.brand.tagline}"
- Tone: ${this.brand.tone}
- We're a FAMILY business at farmers markets, NOT a corporation

${previousSubjects.length ? `
═══════════════════════════════════════════════════════════════
AVOID SIMILAR TO THESE
═══════════════════════════════════════════════════════════════
${previousSubjects.join('\n')}
` : ''}

═══════════════════════════════════════════════════════════════
SUBJECT LINE RULES
═══════════════════════════════════════════════════════════════
1. Under 50 characters when possible
2. Use 🥒 emoji sparingly (max 1 in 5 subjects)
3. Match the "${emailType.subject_style}" style exactly
4. Sound like a friend, not a marketer

${flowConfig.bannedPhrases ? `
⛔ BANNED PHRASES - NEVER USE:
${flowConfig.bannedPhrases.join(', ')}
` : ''}

═══════════════════════════════════════════════════════════════
SPECIFIC GUIDANCE FOR ${flowConfig.name.toUpperCase()}
═══════════════════════════════════════════════════════════════
${this.getSubjectGuidance(flowType, emailPosition)}

Generate 5 subject lines that perfectly match email #${emailPosition} of a ${flowConfig.name}.

Respond ONLY with valid JSON:
{
  "subjectLines": [
    {
      "subject": "Subject line text",
      "predictedOpenRate": 32,
      "emotionalTrigger": "curiosity|warmth|nostalgia|appetite|exclusivity",
      "bestFor": "desktop|mobile|both",
      "explanation": "Why this works for ${flowConfig.name} email #${emailPosition}"
    }
  ],
  "recommendation": "Which one BEST fits email #${emailPosition} purpose: ${emailType.purpose}",
  "abTestSuggestion": "2 subjects to A/B test and why"
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
          flowType,
          flowName: flowConfig.name,
          emailPosition,
          purpose: emailType.purpose,
          ...result,
          tokensUsed: {
            input: response.usage.input_tokens,
            output: response.usage.output_tokens
          }
        };
      }
      
      return { success: false, error: 'Could not parse AI response' };
      
    } catch (error) {
      console.error('❌ AI Subject Generation Error:', error.message);
      return { success: false, error: error.message };
    }
  }
  
  getSubjectGuidance(flowType, emailPosition) {
    const guidance = {
      welcome: {
        1: 'First email = warm welcome. Use their name. "Welcome to the family" vibe. NOT salesy.',
        2: 'Education email = helpful. "Here\'s what you should know" or "Customers love these"',
        3: 'Community email = invitation to connect. "Join us" or "See what others say"',
        4: 'Offer email = special gift tone. "Something for you" NOT "BUY NOW SALE!!!"'
      },
      abandoned_cart: {
        1: 'GENTLE reminder. "Forgot something?" or "Still thinking it over?" NO URGENCY.',
        2: 'Value focus. "Here\'s why customers love X" or "A closer look at your cart"',
        3: 'Final + offer. Can mention discount but still friendly. "A little nudge" tone.'
      },
      post_purchase: {
        1: 'Pure gratitude. "Thank you!" with order details. Excitement about their purchase.',
        2: 'Shipping news. "On the way!" or "Your pickles are traveling to you 📦"',
        3: 'Helpful tips. "Get the most from your pickles" or "Pro tips inside"',
        4: 'Review ask. "How was everything?" or "Mind sharing your thoughts?"',
        5: 'Restock. "Running low?" or "Time for more pickles?"'
      },
      win_back: {
        1: 'Genuine miss. "Hey stranger" or "It\'s been a while" - warm not guilt-trippy.',
        2: 'Updates. "What you\'ve missed" or "New things since you visited"',
        3: 'Offer. "Welcome back gift" or "Something special for you"',
        4: 'Last try. "Still want to hear from us?" - respectful, not desperate.'
      },
      vip: {
        1: 'Celebration. "You\'re VIP!" or "Welcome to the inner circle"',
        2: 'Exclusive. "For your eyes only" or "VIP early access"',
        3: 'Preview. "First look" or "Before anyone else"',
        4: 'Celebration. "Happy [birthday/anniversary]!" with reward.'
      },
      review_request: {
        1: 'Simple ask. "How did we do?" or "Quick question about your order"',
        2: 'Gentle reminder. "Your opinion matters" or "Haven\'t heard from you"'
      },
      browse_abandonment: {
        1: 'Very casual. "Still interested in {{product}}?" or "More about what you viewed"'
      },
      back_in_stock: {
        1: 'Exciting news. "It\'s back!" or "Good news about {{product}}"'
      }
    };
    
    return guidance[flowType]?.[emailPosition] || 'Match the email purpose and flow tone.';
  }
  
  // ==================== 📧 EMAIL CONTENT GENERATION ====================
  
  async generateEmailContent(options) {
    if (!this.initialized) {
      return { success: false, error: 'AI service not configured' };
    }
    
    const {
      flowType = 'welcome',
      emailPosition = 1,
      subject = '',
      includeDiscount = false,
      discountDetails = null,
      customCta = null
    } = options;
    
    const flowConfig = this.flowConfigs[flowType] || this.flowConfigs.welcome;
    const emailType = flowConfig.emailTypes[emailPosition] || flowConfig.emailTypes[1];
    const template = this.getEmailTemplate(flowType, emailPosition);
    
    const prompt = `You are creating an email for ${this.brand.name}, an artisanal pickle and olive company.

═══════════════════════════════════════════════════════════════
THIS IS A ${flowConfig.name.toUpperCase()} - EMAIL #${emailPosition}
═══════════════════════════════════════════════════════════════
Purpose: ${emailType.purpose}
Focus: ${emailType.focus}
Subject: "${subject}"
Goal: ${flowConfig.goal}
Tone: ${flowConfig.tone}

═══════════════════════════════════════════════════════════════
CONTENT STRUCTURE FOR THIS SPECIFIC EMAIL
═══════════════════════════════════════════════════════════════
${template.structure}

═══════════════════════════════════════════════════════════════
AVAILABLE VARIABLES - USE THESE
═══════════════════════════════════════════════════════════════
${flowConfig.variables.join('\n')}

═══════════════════════════════════════════════════════════════
CTA
═══════════════════════════════════════════════════════════════
${customCta ? `"${customCta.text}" → ${customCta.url}` : `Choose appropriate from: ${flowConfig.ctas.join(', ')}`}
URL: ${customCta?.url || this.brand.website}

${includeDiscount ? `
═══════════════════════════════════════════════════════════════
DISCOUNT TO INCLUDE
═══════════════════════════════════════════════════════════════
Code: ${discountDetails?.code || 'WELCOME10'}
Value: ${discountDetails?.value || 10}${discountDetails?.type === 'percentage' ? '%' : '$'} off
Mention naturally - don't make the ENTIRE email about the discount.
` : ''}

${flowConfig.bannedPhrases ? `
═══════════════════════════════════════════════════════════════
⛔ BANNED PHRASES - NEVER USE
═══════════════════════════════════════════════════════════════
${flowConfig.bannedPhrases.join(', ')}
` : ''}

═══════════════════════════════════════════════════════════════
BRAND REQUIREMENTS
═══════════════════════════════════════════════════════════════
- Logo: ${this.brand.logo}
- Primary color (buttons, accents): ${this.brand.colors.primary}
- Website: ${this.brand.website}
- Build Your Box: ${this.brand.website}/pages/build-you-box
- Store Locator: ${this.brand.website}/pages/store-locator-2

═══════════════════════════════════════════════════════════════
HTML REQUIREMENTS - CRITICAL
═══════════════════════════════════════════════════════════════
1. Fully responsive (mobile-first)
2. Max-width: 600px centered
3. ONLY inline CSS (no <style> blocks)
4. White background header with centered logo
5. Font: Georgia for headings, Arial for body
6. Generous white space
7. Table-based layout for email clients
8. Button: ${this.brand.colors.primary} background, white text, 16px padding, border-radius 8px

═══════════════════════════════════════════════════════════════
EXAMPLE CONTENT TONE FOR ${flowConfig.name.toUpperCase()}
═══════════════════════════════════════════════════════════════
${template.exampleTone}

Generate COMPLETE HTML following this exact base:

<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${this.brand.name}</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f5f5;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f5f5f5;">
    <tr>
      <td align="center" style="padding:20px 10px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;">
          
          <!-- HEADER -->
          <tr>
            <td align="center" style="padding:32px 24px;background-color:#ffffff;border-bottom:1px solid #f0f0f0;">
              <a href="${this.brand.website}" target="_blank" style="text-decoration:none;">
                <img src="${this.brand.logo}" alt="${this.brand.name}" width="180" style="max-width:180px;height:auto;display:block;border:0;">
              </a>
            </td>
          </tr>
          
          <!-- YOUR CONTENT HERE - Follow the structure above -->
          
          <!-- FOOTER -->
          <tr>
            <td style="padding:24px 32px;background-color:#f8faf8;border-top:1px solid #e8e8e8;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td align="center" style="padding-bottom:16px;">
                    <p style="margin:0;font-size:13px;color:#666;">Made with ❤️ in New Jersey</p>
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
                      © ${new Date().getFullYear()} ${this.brand.name}. All rights reserved.<br>
                      <a href="{{unsubscribe_url}}" style="color:#999;text-decoration:underline;">Unsubscribe</a> | 
                      <a href="{{preferences_url}}" style="color:#999;text-decoration:underline;">Email Preferences</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
        </table>
      </td>
    </tr>
  </table>
</body>
</html>

Respond ONLY with valid JSON:
{
  "html": "<!DOCTYPE html>...(complete HTML)",
  "previewText": "Preheader 50-100 chars matching ${flowConfig.name} tone",
  "estimatedReadTime": "30 seconds",
  "variablesUsed": ["customer.firstName"],
  "tips": ["Tips specific to ${flowConfig.name} email #${emailPosition}"]
}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4500,
        messages: [{ role: 'user', content: prompt }]
      });
      
      const content = response.content[0].text;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        return {
          success: true,
          flowType,
          flowName: flowConfig.name,
          emailPosition,
          purpose: emailType.purpose,
          ...result,
          tokensUsed: {
            input: response.usage.input_tokens,
            output: response.usage.output_tokens
          }
        };
      }
      
      return { success: false, error: 'Could not parse AI response' };
      
    } catch (error) {
      console.error('❌ AI Email Generation Error:', error.message);
      return { success: false, error: error.message };
    }
  }
  
  // ==================== 📋 EMAIL TEMPLATES BY FLOW TYPE ====================
  
  getEmailTemplate(flowType, emailPosition) {
    const templates = {
      // ==================== WELCOME TEMPLATES ====================
      welcome: {
        1: {
          structure: `
WELCOME EMAIL #1 - BRAND STORY
1. Warm greeting: "Hey {{customer.firstName}}, welcome to the family! 🥒"
2. Who we are: 2-3 sentences about being a New Jersey family business
3. What we're about: Fresh, small-batch, artisanal pickles
4. Farmers market mention
5. Soft CTA: "Explore Our Shop" 
6. Sign-off: "Stay crunchy, The Jersey Pickles Family"`,
          exampleTone: `
"Hey Sarah, welcome to the pickle family!

We're so glad you're here. Jersey Pickles started at a small farmers market stand in Newark, 
where our family has been perfecting pickle recipes for three generations.

Every jar is made in small batches with fresh ingredients – no shortcuts, no preservatives, 
just honest-to-goodness pickles the way they should be.

We can't wait for you to taste the difference.

Stay crunchy,
The Jersey Pickles Family 🥒"`
        },
        2: {
          structure: `
WELCOME EMAIL #2 - PRODUCT EDUCATION
1. Reference welcome: "Settling in? Here's what our customers love..."
2. 2-3 bestseller highlights with brief descriptions
3. What makes our pickles different
4. Fun fact or pickle tip
5. CTA: "Build Your Perfect Box"
6. Friendly close`,
          exampleTone: `
"Now that you're part of the family, let us introduce you to the favorites...

Our Garlic Dill Spears are legendary – customers say they're addictively crunchy. 
The Cucumber Salad? Perfect for summer BBQs (or midnight snacking, we won't tell).

Pro tip: Our pickles are best enjoyed super cold. Pop them in the fridge for 
at least 2 hours before diving in.

Ready to explore? Build your own box and mix your favorites."`
        },
        3: {
          structure: `
WELCOME EMAIL #3 - COMMUNITY & SOCIAL PROOF
1. "You're part of something special..."
2. Customer testimonial or review
3. Where to find us: farmers markets, stores
4. Social media invitation
5. CTA: "Find Us Near You" or "Join Our Community"
6. Warm close`,
          exampleTone: `
"You're not just a customer – you're part of the Jersey Pickles community.

Here's what Emily from Hoboken said: 'These are the only pickles my kids will eat. 
We go through a jar a week!'

Find us at farmers markets across NJ, NY, and PA every weekend. 
Or check if we're at a store near you.

Follow along on Instagram for behind-the-scenes pickle making!"`
        },
        4: {
          structure: `
WELCOME EMAIL #4 - FIRST PURCHASE INCENTIVE
1. "A little something for you..."
2. Welcome offer (if discount enabled)
3. Build Your Box mention
4. Soft expiration
5. CTA: "Claim Your Welcome Gift"
6. Personal close`,
          exampleTone: `
"We wanted to say thanks for joining us – here's a little welcome gift.

Use code WELCOME15 for 15% off your first order. Build your perfect pickle box 
and save on your favorites.

Your code is ready whenever you are (but it expires in 7 days, just so you know).

Can't wait to pack your first order!"`
        }
      },
      
      // ==================== ABANDONED CART TEMPLATES ====================
      abandoned_cart: {
        1: {
          structure: `
ABANDONED CART EMAIL #1 - GENTLE REMINDER (1-2 hrs)
1. Casual opener: "Hey {{customer.firstName}}, quick heads up..."
2. What they left: "Your {{abandoned.firstProductName}} is still in your cart"
3. Simple, no pressure: "Just wanted to make sure you didn't forget"
4. [Optional product image placeholder]
5. CTA: "Complete My Order"
6. Help offer: "Questions? Just reply"`,
          exampleTone: `
"Hey Sarah, quick heads up...

Your Garlic Dill Spears are still hanging out in your cart. No rush – 
we just wanted to make sure they didn't slip your mind.

Your cart is saved and ready whenever you are.

Questions about anything? Just hit reply – we're here to help."`
        },
        2: {
          structure: `
ABANDONED CART EMAIL #2 - PRODUCT VALUE (24 hrs)
1. "Still thinking it over? Here's why customers love it..."
2. 2-3 product benefits or reasons
3. Brief customer review
4. Address a potential concern (freshness, shipping)
5. CTA: "Take Another Look"
6. Help available note`,
          exampleTone: `
"Still thinking about those Garlic Dill Spears?

Here's what makes them special:
• Fresh garlic in every bite (not garlic powder – the real stuff)
• Extra crunchy texture that stays crispy
• Made this week in our New Jersey kitchen

'Best pickles I've ever had. Period.' – Mike from Jersey City

Wondering about shipping? Everything ships cold and fresh, guaranteed."`
        },
        3: {
          structure: `
ABANDONED CART EMAIL #3 - FINAL + INCENTIVE (72 hrs)
1. Warm final nudge: "Your cart misses you..."
2. Show items briefly
3. Discount offer (if enabled): "Here's a little something..."
4. Soft urgency: "We can only hold your cart so long"
5. CTA: "Finish Checkout & Save"
6. Last chance feel but friendly`,
          exampleTone: `
"Your cart's been waiting patiently, {{customer.firstName}}...

We've been holding your Garlic Dill Spears, but we can't save them forever.

Here's a little nudge: use code COMEBACK10 for 10% off to finish your order.

Your pickles are ready when you are. 🥒"`
        }
      },
      
      // ==================== POST-PURCHASE TEMPLATES ====================
      post_purchase: {
        1: {
          structure: `
POST-PURCHASE EMAIL #1 - ORDER CONFIRMATION
1. Big thank you: "Thank you, {{customer.firstName}}! 🥒"
2. Order summary box with {{order.number}}
3. What's next: "We're packing your order..."
4. Timeline estimate
5. CTA: "View Your Order"
6. Personal thank you for supporting small business`,
          exampleTone: `
"Thank you so much, {{customer.firstName}}!

Your order #{{order.number}} is confirmed and we're already getting it ready.

Order Details:
{{order.items}}
Total: {{order.totalPrice}}

What's next? Our team is packing your pickles with care. 
You'll get a shipping email with tracking in 1-2 business days.

Thank you for supporting our small family business – it means the world to us."`
        },
        2: {
          structure: `
POST-PURCHASE EMAIL #2 - SHIPPING NOTIFICATION
1. Exciting news: "Your pickles are on the way! 📦"
2. Tracking info with {{order.trackingNumber}}
3. Estimated delivery
4. What to expect when it arrives
5. CTA: "Track Your Package"
6. Contact info for questions`,
          exampleTone: `
"Great news – your order is on its way! 📦

Track your package: {{order.trackingNumber}}
Estimated delivery: {{order.estimatedDelivery}}

When it arrives, pop your pickles in the fridge right away for maximum crunch.

We hope you love them!"`
        },
        3: {
          structure: `
POST-PURCHASE EMAIL #3 - TIPS & ENJOYMENT
1. Check-in: "Your pickles should be settling in!"
2. Storage tips (refrigerate, best within X days)
3. Serving suggestions (sandwiches, charcuterie, snacking)
4. Optional recipe idea
5. Soft CTA or just helpful close
6. Invitation to reach out`,
          exampleTone: `
"How's everything tasting? 🥒

A few tips to get the most out of your pickles:

Keep them cold – they're crunchiest straight from the fridge.
Best within 3 weeks of opening (but they rarely last that long!)
Try them on sandwiches, alongside charcuterie, or straight from the jar at midnight (no judgment).

Got questions or want recipe ideas? Just reply – we love talking pickles."`
        },
        4: {
          structure: `
POST-PURCHASE EMAIL #4 - REVIEW REQUEST
1. Friendly ask: "We'd love your feedback..."
2. Why reviews matter to small business
3. How easy it is (30 seconds, direct link)
4. CTA: "Leave a Quick Review"
5. Thank you regardless
6. Optional mention of thank you for reviewers`,
          exampleTone: `
"Hey {{customer.firstName}}, we'd love to hear how we did.

Your review helps other pickle lovers find us – and as a small family business, 
every review means a lot.

It only takes 30 seconds: just click below and share your thoughts.

Thank you for being part of the Jersey Pickles family!"`
        },
        5: {
          structure: `
POST-PURCHASE EMAIL #5 - REPLENISHMENT
1. Thoughtful check-in: "Running low? 🥒"
2. Reference what they ordered
3. Easy reorder suggestion
4. Maybe suggest trying something new
5. CTA: "Restock Your Favorites"
6. Build Your Box mention`,
          exampleTone: `
"Hey {{customer.firstName}}, checking in...

If you're anything like our other customers, your {{order.firstProductName}} might be 
running low by now.

Ready for more? Your favorites are just a click away.

Or try something new – our Pickled Mushrooms are a customer favorite you might love."`
        }
      },
      
      // ==================== WIN-BACK TEMPLATES ====================
      win_back: {
        1: {
          structure: `
WIN-BACK EMAIL #1 - WE MISS YOU (30 days)
1. Warm: "Hey {{customer.firstName}}, it's been a while!"
2. Simple: "We miss seeing you around"
3. Brief what's new
4. Open invitation
5. CTA: "See What's New"
6. No pressure close`,
          exampleTone: `
"Hey {{customer.firstName}}, it's been a while!

We miss seeing you around and just wanted to check in.

We've been busy – new seasonal pickles, some exciting flavors in the works, 
and farmers markets are in full swing.

Stop by whenever you're ready. We'll be here. 🥒"`
        },
        2: {
          structure: `
WIN-BACK EMAIL #2 - WHAT'S NEW (45 days)
1. "Here's what you might have missed..."
2. New products or seasonal items
3. What's popular right now
4. Light social proof
5. CTA: "Check It Out"
6. Friendly close`,
          exampleTone: `
"A few things have happened since we last saw you...

NEW: Hot Honey Pickle Chips – sweet heat that's flying off the shelves
SEASONAL: Limited batch Bread & Butter pickles for summer
POPULAR: Our Build Your Box is more popular than ever

Curious? Come see what everyone's talking about."`
        },
        3: {
          structure: `
WIN-BACK EMAIL #3 - COMEBACK OFFER (60 days)
1. "We'd love to welcome you back..."
2. Special discount code
3. Reference their favorites if known
4. Expiration (gentle)
5. CTA: "Claim Your Discount"
6. Warm close`,
          exampleTone: `
"We'd love to see you again, {{customer.firstName}}.

Here's a welcome back gift: use code MISSYOU15 for 15% off your next order.

We remember you loved our {{customer.favoriteProduct}} – it's still as good as ever.

Your code is ready when you are. (Valid through the end of the month.)"`
        },
        4: {
          structure: `
WIN-BACK EMAIL #4 - LAST ATTEMPT (90 days)
1. Honest: "We want to make sure you're getting what you want"
2. Notice: "We've noticed you haven't opened our emails"
3. Options: Preference center, less emails
4. Respect their choice
5. CTA: "Update Preferences" or "Stay Subscribed"
6. Respectful sign-off`,
          exampleTone: `
"Hey {{customer.firstName}}, we noticed you haven't opened our emails lately.

We totally get it – inboxes get overwhelming.

If you'd like to hear from us less often, or not at all, that's okay. 
Just update your preferences below.

But if you want to stay in the loop, we'd love to keep you around. 
Either way, thanks for being part of our journey."`
        }
      },
      
      // Add default for other types
      vip: {
        1: {
          structure: `VIP WELCOME: Congratulate them, explain perks, make them feel special`,
          exampleTone: `"You've officially reached VIP status! Here's what that means for you..."`
        }
      },
      review_request: {
        1: {
          structure: `REVIEW REQUEST: Ask nicely, explain why it matters, make it easy`,
          exampleTone: `"How did we do? Your review helps other pickle lovers find us..."`
        }
      },
      browse_abandonment: {
        1: {
          structure: `BROWSE ABANDONMENT: Very casual, more info about what they viewed`,
          exampleTone: `"Still curious about our Garlic Dill Spears? Here's what makes them special..."`
        }
      },
      back_in_stock: {
        1: {
          structure: `BACK IN STOCK: Exciting news, product is back, easy link`,
          exampleTone: `"Good news! The {{product.name}} you wanted is back in stock!"`
        }
      }
    };
    
    // Default template
    const defaultTemplate = {
      structure: `Standard email: greeting, message, CTA, sign-off`,
      exampleTone: `"Hey {{customer.firstName}}, [friendly message]... [CTA]... Stay crunchy!"`
    };
    
    return templates[flowType]?.[emailPosition] || defaultTemplate;
  }
  
  // ==================== 🚀 FLOW GENERATION FROM DESCRIPTION ====================
  
  async generateFlowFromDescription(description) {
    if (!this.initialized) {
      return { success: false, error: 'AI service not configured' };
    }
    
    // Include available flow types for context
    const flowTypesInfo = Object.entries(this.flowConfigs)
      .map(([key, config]) => `- ${key}: ${config.name} (${config.goal})`)
      .join('\n');
    
    const prompt = `You are an email automation expert for ${this.brand.name}, an artisanal pickle company.

Create a complete automation flow based on this request:
"${description}"

═══════════════════════════════════════════════════════════════
AVAILABLE FLOW TYPES
═══════════════════════════════════════════════════════════════
${flowTypesInfo}

═══════════════════════════════════════════════════════════════
TRIGGERS
═══════════════════════════════════════════════════════════════
- customer_created: New customer signs up
- order_placed: Order completed
- order_fulfilled: Order shipped
- cart_abandoned: Cart left (config: { abandonedAfterMinutes: 60 })
- customer_tag_added: Tag added (config: { tagName: "string" })

═══════════════════════════════════════════════════════════════
STEP TYPES
═══════════════════════════════════════════════════════════════
- send_email: { subject, htmlContent: "<p>placeholder</p>", previewText }
- wait: { delayMinutes } (60=1hr, 1440=1day, 10080=1week)
- condition: { conditionType, conditionValue, ifTrue: [], ifFalse: [] }
- add_tag: { tagName }
- create_discount: { discountCode, discountType, discountValue, expiresInDays }

═══════════════════════════════════════════════════════════════
BRAND CONTEXT
═══════════════════════════════════════════════════════════════
- Family business, artisanal, NOT aggressive marketing
- Timing: Space out more than typical e-commerce
- Tone: Warm, friendly, storytelling-focused

═══════════════════════════════════════════════════════════════
TIMING GUIDELINES
═══════════════════════════════════════════════════════════════
Welcome: Day 0, Day 3, Day 7, Day 14
Abandoned Cart: 1hr, 24hr, 72hr (gentle)
Post-Purchase: Immediate, Day 7, Day 14, Day 21
Win-Back: Day 30, Day 45, Day 60, Day 90

Respond ONLY with valid JSON:
{
  "name": "Flow name",
  "description": "What this flow does",
  "trigger": {
    "type": "trigger_type",
    "config": {}
  },
  "steps": [
    {
      "type": "send_email",
      "config": {
        "subject": "Subject line matching flow type tone",
        "htmlContent": "<p>Email content placeholder - will be generated</p>",
        "previewText": "Preheader text"
      },
      "order": 0
    }
  ],
  "estimatedRevenue": "+X% expected",
  "tips": ["Implementation tips for artisanal brands"]
}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 3500,
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
  
  // ==================== 💡 SUGGEST NEXT STEP ====================
  
  async suggestNextStep(flow, currentSteps) {
    if (!this.initialized) {
      return { success: false, error: 'AI service not configured' };
    }
    
    const flowConfig = this.flowConfigs[flow.trigger?.type] || this.flowConfigs.welcome;
    
    const prompt = `Given this ${flowConfig.name} flow:
- Current steps: ${currentSteps.length}
- Steps: ${JSON.stringify(currentSteps.map(s => ({ type: s.type, config: s.config?.subject || s.config?.delayMinutes })), null, 2)}
- Standard sequence for ${flowConfig.name}: ${Object.entries(flowConfig.emailTypes).map(([pos, e]) => `#${pos}: ${e.purpose}`).join(' → ')}

What should be next? Consider:
1. Artisanal brands = less aggressive
2. Quality over quantity
3. Follow the standard sequence

Respond ONLY with JSON:
{
  "suggestedStep": {
    "type": "step_type",
    "config": {},
    "order": ${currentSteps.length}
  },
  "reasoning": "Why this step",
  "alternatives": [{ "type": "...", "description": "..." }]
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
  
  // ==================== 📊 FLOW ANALYSIS ====================
  
  async analyzeFlowPerformance(flowId) {
    if (!this.initialized) {
      return { success: false, error: 'AI service not configured' };
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
        conversionRate: ((flow.metrics?.totalOrders || 0) / (flow.metrics?.totalTriggered || 1) * 100).toFixed(1),
        emailMetrics: {
          sent: flow.metrics?.emailsSent || 0,
          openRate: flow.metrics?.emailsSent > 0 
            ? ((flow.metrics?.opens || 0) / flow.metrics.emailsSent * 100).toFixed(1) 
            : 0,
          clickRate: flow.metrics?.emailsSent > 0 
            ? ((flow.metrics?.clicks || 0) / flow.metrics.emailsSent * 100).toFixed(1) 
            : 0
        }
      };
      
      const flowConfig = this.flowConfigs[flow.trigger?.type] || this.flowConfigs.welcome;
      
      const prompt = `Analyze this ${flowConfig.name} flow for an artisanal pickle company:

Flow: ${flow.name}
Steps: ${flow.steps.length}
Performance: ${JSON.stringify(metrics, null, 2)}

Steps:
${flow.steps.map((s, i) => `${i + 1}. ${s.type}: ${s.config?.subject || s.config?.delayMinutes + 'min' || 'config'}`).join('\n')}

Benchmarks for artisanal food:
- Welcome: 45-55% open, 8-12% click
- Abandoned cart: 40-50% open, 6-10% click
- Post-purchase: 50-60% open, 5-8% click

DO NOT recommend more emails or aggressive tactics.

Respond ONLY with JSON:
{
  "overallScore": 75,
  "scoreExplanation": "...",
  "strengths": ["..."],
  "weaknesses": ["..."],
  "recommendations": [
    { "priority": "high|medium|low", "area": "...", "issue": "...", "suggestion": "...", "expectedImpact": "+X%" }
  ],
  "quickWins": ["..."],
  "abTestIdeas": ["..."]
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
          flowType: flow.trigger?.type,
          metrics,
          analysis,
          generatedAt: new Date().toISOString()
        };
      }
      
      return { success: false, error: 'Could not parse response' };
    } catch (error) {
      console.error('❌ AI Analysis Error:', error.message);
      return { success: false, error: error.message };
    }
  }
  
  // ==================== ⏰ TIMING OPTIMIZATION ====================
  
  async optimizeTiming(flowId) {
    if (!this.initialized) {
      return { success: false, error: 'AI service not configured' };
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
      const flowConfig = this.flowConfigs[flow.trigger?.type] || this.flowConfigs.welcome;
      
      const prompt = `Optimize timing for ${flowConfig.name}.

Historical performance by hour (top 10):
${JSON.stringify(hourlyPerformance.slice(0, 10), null, 2)}

Current waits:
${flow.steps.filter(s => s.type === 'wait').map((s, i) => `Wait ${i + 1}: ${s.config.delayMinutes}min`).join('\n')}

Recommended timing for ${flowConfig.name}: ${flowConfig.timingRecommendation}

Best times for food brands: 10-11am or 6-7pm.

Respond ONLY with JSON:
{
  "currentTiming": [{ "step": 1, "currentDelay": 60 }],
  "recommendedTiming": [
    { "step": 1, "recommendedDelay": 90, "bestSendHour": 10, "bestSendDay": "Tuesday", "reasoning": "..." }
  ],
  "expectedImprovement": "+X%",
  "implementation": "How to apply"
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
  
  // ==================== 🔧 HELPERS ====================
  
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
    
    return Object.entries(hourlyData)
      .map(([hour, data]) => ({
        hour: parseInt(hour),
        openRate: data.sent > 0 ? parseFloat((data.opens / data.sent * 100).toFixed(1)) : 0,
        sampleSize: data.campaigns
      }))
      .sort((a, b) => b.openRate - a.openRate);
  }
  
  getFlowConfig(flowType) {
    return this.flowConfigs[flowType] || null;
  }
  
  getAvailableFlowTypes() {
    return Object.entries(this.flowConfigs).map(([key, config]) => ({
      type: key,
      name: config.name,
      goal: config.goal,
      emailCount: Object.keys(config.emailTypes).length,
      variables: config.variables,
      ctas: config.ctas
    }));
  }
}

module.exports = new AIFlowService();