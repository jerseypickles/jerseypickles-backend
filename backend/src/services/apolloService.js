// backend/src/services/apolloService.js
// 🏛️ APOLLO - Creative Agent for Email Campaign Visuals
// God of art and beauty - generates promotional images with Gemini

const { GoogleGenAI } = require('@google/genai');
const cloudinary = require('../config/cloudinary');
const ApolloConfig = require('../models/ApolloConfig');
const axios = require('axios');

class ApolloService {
  constructor() {
    this.client = null;
    this.initialized = false;
  }

  // ==================== INITIALIZATION ====================

  init() {
    if (this.initialized) return;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.log('🏛️ Apollo: GEMINI_API_KEY not configured');
      return;
    }

    try {
      this.client = new GoogleGenAI({ apiKey });
      this.initialized = true;
      console.log('🏛️ Apollo: Initialized (Gemini 3 Pro)');
    } catch (error) {
      console.error('🏛️ Apollo: Init error:', error.message);
    }
  }

  isAvailable() {
    return this.initialized && this.client !== null;
  }

  // ==================== MAIN: GENERATE CREATIVE ====================

  /**
   * Generate a promotional creative image for a campaign
   * Called by Maximus with a brief
   *
   * @param {object} brief - Campaign brief from Maximus
   * @param {string} brief.product - Product slug (e.g., 'hot-tomatoes')
   * @param {string} brief.discount - Discount text (e.g., '25% OFF TODAY ONLY')
   * @param {string} brief.code - Discount code (e.g., 'TOMATO')
   * @param {string} brief.headline - Campaign headline
   * @param {string} brief.productName - Full product name (e.g., 'Hot Tomatoes')
   * @returns {object} { success, imageUrl, cloudinaryId, generationTime }
   */
  async generateCreative(brief) {
    if (!this.isAvailable()) {
      return { success: false, error: 'Gemini API not available' };
    }

    const config = await ApolloConfig.getConfig();
    const startTime = Date.now();

    console.log('\n🏛️ ═══════════════════════════════════════');
    console.log('   APOLLO - Generating Creative');
    console.log('═══════════════════════════════════════\n');
    console.log(`   Product: ${brief.product}`);
    console.log(`   Discount: ${brief.discount}`);
    console.log(`   Code: ${brief.code}`);
    console.log(`   Headline: ${brief.headline}`);

    // 1. Get product from bank
    const product = config.getProduct(brief.product);
    if (!product) {
      console.error(`🏛️ Apollo: Product "${brief.product}" not found in bank`);
      return { success: false, error: `Product "${brief.product}" not found` };
    }

    try {
      // 2. Build the mega-prompt
      const prompt = this.buildPrompt(brief, product);
      console.log(`   Prompt length: ${prompt.length} chars`);

      // 3. Call Gemini 3 Pro
      console.log(`   Calling Gemini (${config.geminiModel})...`);
      const imageBase64 = await this.callGemini(prompt, config.geminiModel);

      if (!imageBase64) {
        return { success: false, error: 'Gemini returned no image' };
      }

      console.log(`   Image generated (${Math.round(imageBase64.length / 1024)}KB base64)`);

      // 4. Upload to Cloudinary
      console.log('   Uploading to Cloudinary...');
      const uploadResult = await this.uploadToCloudinary(imageBase64, brief, config.cloudinaryFolder);

      const generationTime = Date.now() - startTime;

      // 5. Update stats
      config.stats.totalGenerated += 1;
      config.stats.lastGeneratedAt = new Date();
      config.stats.averageGenerationTime = Math.round(
        (config.stats.averageGenerationTime * (config.stats.totalGenerated - 1) + generationTime) /
        config.stats.totalGenerated
      );
      await config.save();

      console.log(`\n🏛️ Apollo: ✅ Creative generated in ${(generationTime / 1000).toFixed(1)}s`);
      console.log(`   URL: ${uploadResult.secure_url}`);

      return {
        success: true,
        imageUrl: uploadResult.secure_url,
        cloudinaryId: uploadResult.public_id,
        generationTime,
        width: uploadResult.width,
        height: uploadResult.height
      };

    } catch (error) {
      console.error('🏛️ Apollo: Generation error:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ==================== GEMINI API CALL ====================

  /**
   * Call Gemini 3 Pro to generate image from prompt
   */
  async callGemini(prompt, model = 'gemini-3-pro-image-preview') {
    const response = await this.client.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseModalities: ['image', 'text'],
      }
    });

    // Extract image from response
    if (response.candidates && response.candidates.length > 0) {
      const parts = response.candidates[0].content?.parts || [];
      for (const part of parts) {
        if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
          return part.inlineData.data;
        }
      }
    }

    return null;
  }

  // ==================== PROMPT BUILDER ====================

  /**
   * Build the mega-prompt for Gemini
   * Template-based with variable injection from Maximus brief
   */
  buildPrompt(brief, product) {
    const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'long' });

    return `ASPECT RATIO: 9:16 vertical portrait, designed for email marketing.

A single Jersey Pickles ${product.name} jar — one jar only, no duplicates — stands upright as the dominant foreground subject on a rustic wooden kitchen counter or weeknight dinner table. Surrounded by complementary fresh ingredients that match the product. Warm amber evening light from a low kitchen window, candle glow suggesting a cozy ${dayOfWeek} night dinner at home. Shallow depth of field with soft bokeh on a blurred warm kitchen interior in the background. The jar is front-lit with label perfectly sharp and readable. Hyper-detailed glass texture with warm candlelight refracting through the brine. Premium lifestyle food photography, hyperrealistic, 8K, 9:16 vertical portrait.

${product.promptHints || ''}

TOP OVERLAY TEXT (warm white bold serif):
"${brief.headline}"
Below, small italic white text: "Jersey Pickles — ${product.name}"

BOTTOM THIRD: Semi-transparent dark green gradient overlay.
Bold large white text: "${brief.discount}"
Small white text: "USE CODE AT CHECKOUT:"
Rounded dark green rectangle with bright gold border and glow, centered, bold gold uppercase text: ${brief.code}
Small italic white text below: "Cannot be combined with other offers."
Bright green rounded pill button: "SHOP NOW"

FOOTER: Dark green bar. "www.jerseypickles.com" small pickle icons on each side.

RULES: Single jar only, no duplicates, no text outside overlay zones, hyperrealistic premium lifestyle food photography, 8K, 9:16 vertical.`;
  }

  // ==================== CLOUDINARY UPLOAD ====================

  /**
   * Upload generated image to Cloudinary
   */
  async uploadToCloudinary(base64Image, brief, folder) {
    const dataUri = `data:image/png;base64,${base64Image}`;
    const timestamp = Date.now();
    const publicId = `${folder}/${brief.product}-${brief.code}-${timestamp}`;

    const result = await cloudinary.uploader.upload(dataUri, {
      public_id: publicId,
      folder: undefined,
      resource_type: 'image',
      tags: ['apollo', 'agent-generated', brief.product, brief.code]
    });

    return result;
  }

  // ==================== EMAIL HTML BUILDER ====================

  /**
   * Build simple email HTML with the generated image
   * Full-width image + CTA button + unsubscribe footer
   */
  buildEmailHtml(imageUrl, brief) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${brief.headline}</title>
</head>
<body style="margin:0;padding:0;background-color:#0a0e17;font-family:Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;margin:0 auto;background-color:#ffffff;">
    <tr>
      <td style="padding:0;">
        <a href="https://jerseypickles.com" target="_blank" style="display:block;">
          <img src="${imageUrl}" alt="${brief.headline}" width="600" style="display:block;width:100%;height:auto;border:0;" />
        </a>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 24px;text-align:center;background-color:#1a3d17;">
        <a href="https://jerseypickles.com" target="_blank" style="display:inline-block;background-color:#34d399;color:#0a0e17;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:bold;letter-spacing:0.5px;">SHOP NOW</a>
      </td>
    </tr>
    <tr>
      <td style="padding:16px 24px;text-align:center;background-color:#122016;color:#a2b6aa;font-size:11px;line-height:1.5;">
        <p style="margin:0 0 8px;">Jersey Pickles — Fresh, bold, and stadium-ready</p>
        <p style="margin:0;">
          <a href="{{unsubscribeLink}}" style="color:#6eb489;text-decoration:underline;">Unsubscribe</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  // ==================== STATUS ====================

  async getStatus() {
    const config = await ApolloConfig.getConfig();

    return {
      agent: 'Apollo',
      active: config.active,
      geminiAvailable: this.isAvailable(),
      geminiModel: config.geminiModel,
      aspectRatio: config.aspectRatio,
      productBank: {
        total: config.products.length,
        active: config.getActiveProducts().length,
        products: config.getActiveProducts().map(p => ({
          slug: p.slug,
          name: p.name,
          category: p.category,
          hasImage: !!p.bankImageUrl
        }))
      },
      stats: config.stats,
      cloudinaryFolder: config.cloudinaryFolder
    };
  }
}

const apolloService = new ApolloService();
module.exports = apolloService;
