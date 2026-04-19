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
    const allSlugs = config.products.map(p => `"${p.slug}" (active: ${p.active})`);
    console.log(`   Available products: ${allSlugs.join(', ') || 'NONE'}`);
    console.log(`   Looking for slug: "${brief.product}"`);
    const product = config.getProduct(brief.product);
    if (!product) {
      console.error(`🏛️ Apollo: Product "${brief.product}" not found in bank`);
      return { success: false, error: `Product "${brief.product}" not found` };
    }

    try {
      // 2. Build the mega-prompt
      const promptText = this.buildPrompt(brief, product);
      console.log(`   Prompt length: ${promptText.length} chars`);

      // 3. Download bank image to send as reference
      let bankImageData = null;
      if (product.bankImageUrl) {
        try {
          console.log(`   Downloading bank image: ${product.bankImageUrl}`);
          const imgResponse = await axios.get(product.bankImageUrl, { responseType: 'arraybuffer', timeout: 15000 });
          bankImageData = Buffer.from(imgResponse.data).toString('base64');
          const mimeType = imgResponse.headers['content-type'] || 'image/jpeg';
          bankImageData = { base64: bankImageData, mimeType };
          console.log(`   Bank image downloaded (${Math.round(imgResponse.data.length / 1024)}KB)`);
        } catch (imgErr) {
          console.warn(`   Could not download bank image: ${imgErr.message}`);
        }
      }

      // 4. Call Gemini 3 Pro with text + reference image
      console.log(`   Calling Gemini (${config.geminiModel})...`);
      const imageBase64 = await this.callGemini(promptText, config.geminiModel, bankImageData);

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
   * Call Gemini 3 Pro to generate image from prompt + optional reference image
   * @param {string} prompt - Text prompt
   * @param {string} model - Gemini model
   * @param {object|null} bankImage - { base64, mimeType } reference product photo
   */
  async callGemini(prompt, model = 'gemini-3-pro-image-preview', bankImage = null) {
    // Build contents: reference image first, then text prompt
    const parts = [];

    if (bankImage) {
      parts.push({
        inlineData: {
          mimeType: bankImage.mimeType,
          data: bankImage.base64
        }
      });
      parts.push({
        text: `REFERENCE PRODUCT PHOTO: The image above is the EXACT product jar you must reproduce in the final image. Match its label, shape, color, and proportions precisely. Do NOT invent a different jar.\n\n${prompt}`
      });
    } else {
      parts.push({ text: prompt });
    }

    const response = await this.client.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
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
    const type = brief.campaignType || 'promotional';

    // Scene variety — randomize to avoid monotony
    const scenes = [
      'rustic wooden kitchen counter with exposed beams above',
      'marble kitchen countertop with white tile backsplash',
      'reclaimed barn wood table in a farmhouse kitchen',
      'butcher block counter with copper cookware hanging nearby',
      'concrete countertop in a modern industrial kitchen',
      'vintage enamel table with floral tablecloth',
      'dark walnut dinner table set for a casual meal',
      'outdoor wooden picnic table with string lights above',
      'stone kitchen island with open shelving behind',
      'antique oak farm table with linen runner'
    ];

    const lightingMoods = [
      'warm amber golden-hour sunlight streaming through a window',
      'soft morning daylight through linen curtains, bright and fresh',
      'cozy candlelight with dim ambient glow, intimate mood',
      'cool northern window light, clean and editorial',
      'dramatic side-light with strong shadows, moody chiaroscuro',
      'bright overhead natural light, airy and modern',
      'warm fireplace glow in the background, rustic and cozy',
      'late afternoon sun with long golden shadows',
      'diffused overcast daylight, muted and elegant',
      'twinkling string lights and candles, festive dinner vibes'
    ];

    const colorPalettes = [
      'warm earth tones — terracotta, olive green, cream, burnt orange',
      'fresh garden tones — sage green, ivory, pale yellow, soft pink',
      'moody deep tones — forest green, burgundy, charcoal, gold accents',
      'bright farmhouse tones — red gingham, white, fresh greens, natural wood',
      'minimalist tones — muted greys, white, black, single pop of color from the product',
      'autumn harvest tones — rust, mustard, cream, deep brown',
      'coastal tones — soft blues, white, sand, driftwood grey',
      'Mediterranean tones — terracotta, olive, ochre, stone'
    ];

    const compositions = [
      'jar centered in lower third with ingredients fanning out behind',
      'jar slightly off-center right with props balancing left',
      'overhead three-quarter angle showing jar and surrounding scene',
      'jar in sharp foreground with blurred lifestyle scene behind',
      'jar on a wooden board with fresh ingredients styled around it',
      'jar with a linen napkin draped casually beside it',
      'jar next to a small stack of vintage cookbooks and a wooden spoon',
      'jar with cutting board, knife, and prepped ingredients nearby'
    ];

    // Pick one of each randomly
    const scene = scenes[Math.floor(Math.random() * scenes.length)];
    const lighting = lightingMoods[Math.floor(Math.random() * lightingMoods.length)];
    const palette = colorPalettes[Math.floor(Math.random() * colorPalettes.length)];
    const composition = compositions[Math.floor(Math.random() * compositions.length)];

    const baseScene = `ASPECT RATIO: 9:16 vertical portrait, designed for email marketing.

CRITICAL: You MUST use the reference product photo provided above as the EXACT jar in this image. Reproduce the jar's label, shape, glass color, lid, and proportions with 100% fidelity. Do NOT create a different jar or modify the label design.

SCENE: ${scene}.
LIGHTING: ${lighting}.
COLOR PALETTE: ${palette}.
COMPOSITION: ${composition}.

Place the EXACT jar from the reference photo as described. Surround it with complementary fresh ingredients that match the product. Premium lifestyle food photography, hyperrealistic, 8K, 9:16 vertical portrait.

${product.promptHints || ''}`;

    if (type === 'recipe') {
      // Recipe: overhead flat lay of the finished dish + jar of product
      const recipe = brief.recipe || {};
      return `ASPECT RATIO: 9:16 vertical portrait for a recipe email hero.

CRITICAL: Use the reference product photo above as the EXACT jar that must appear in the scene. Match label, shape, glass, lid precisely.

SCENE: Overhead flat-lay photograph of a finished dish featuring the product. The dish is "${recipe.dishName || brief.headline}".
Surround the hero plate with tasteful cooking props: a linen napkin, wooden spoon, a few of the raw ingredients (${(recipe.ingredients || []).slice(0, 3).join(', ') || 'fresh herbs, citrus, olive oil'}), a small ceramic bowl, maybe a sprig of herbs.
The jar from the reference photo is prominently placed beside the dish, lid slightly loose or a spoon resting on the rim — suggesting "just used in the recipe".
LIGHTING: ${lighting}.
COLOR PALETTE: ${palette}.
SURFACE: ${scene}.

NO OVERLAY TEXT, NO BUTTONS, NO LOGOS. Pure editorial food photography — Bon Appétit / NYT Cooking style. The recipe text lives in the email body.

${product.promptHints || ''}

RULES: Overhead angle (80-90°), shallow depth with everything in focus, hyperrealistic premium food photography, 8K, 9:16 vertical. Single hero jar (the reference one), no duplicates.`;
    }

    if (type === 'pairing') {
      // Pairing: two items side by side on a shared surface
      const pairing = brief.pairing || {};
      const leftItem = pairing.leftItem?.name || product.name;
      const rightItem = pairing.rightItem?.name || 'an artisanal cheese';
      return `ASPECT RATIO: 9:16 vertical portrait for a pairing guide email hero.

CRITICAL: Use the reference product photo above as the EXACT jar that must appear in the scene. Match label, shape, glass, lid precisely.

SCENE: Two artisanal items photographed side by side on a shared surface — a wooden charcuterie board or slate serving platter.
LEFT: the EXACT jar from the reference photo (${leftItem}) with some of its contents spilled on the board.
RIGHT: ${rightItem}, styled beautifully — if cheese, a wedge with a knife; if bread, a torn rustic chunk; if meat, thin slices fanned; if another product, its own presentation.
Between them: a small sprig of fresh herbs, a few crackers or slices, suggesting the pairing in action.
LIGHTING: ${lighting}.
COLOR PALETTE: ${palette}.
SURFACE: ${scene}.

NO OVERLAY TEXT, NO BUTTONS, NO LOGOS. Pure editorial pairing photography — think wine magazine, gourmet guide.

${product.promptHints || ''}

RULES: Slightly elevated angle (30-45°), both items equally prominent, premium food photography, hyperrealistic, 8K, 9:16 vertical. Single jar only from reference, no duplicates.`;
    }

    if (type === 'customer_love') {
      // Customer love: lifestyle scene suggesting the product is being enjoyed
      return `ASPECT RATIO: 9:16 vertical portrait for a customer testimonials email hero.

CRITICAL: Use the reference product photo above as the EXACT jar that must appear in the scene. Match label, shape, glass, lid precisely.

SCENE: A warm lived-in kitchen moment — the jar from the reference photo is open on a wooden cutting board, a slice of bread with the product on it in the foreground, a small bowl of the product nearby, a coffee cup or glass of wine off to the side. Maybe a hand reaching for it (partial, tasteful). A "mid-meal, mid-family" feeling — not staged, lived-in.
LIGHTING: ${lighting}, with a golden hour feel suggesting "everyday joy".
COLOR PALETTE: ${palette}.
SURFACE: ${scene}.

NO OVERLAY TEXT, NO BUTTONS, NO LOGOS. Pure lifestyle photography — the testimonials will render in the email body.

${product.promptHints || ''}

RULES: Candid lifestyle feel, warm and inviting, hyperrealistic premium editorial photography, 8K, 9:16 vertical. Single jar (reference), no duplicates.`;
    }

    if (type === 'promotional') {
      return `${baseScene}

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

RULES: Single jar only (the EXACT one from the reference photo), no duplicates, no text outside overlay zones, hyperrealistic premium lifestyle food photography, 8K, 9:16 vertical.`;

    } else if (type === 'content') {
      // Editorial content style — TALL 9:21 aspect ratio, NO overlay text, NO buttons
      // The image is pure editorial photography. The story text lives in the email HTML body.
      return `ASPECT RATIO: 9:21 ultra-tall vertical portrait, editorial magazine cover style.

CRITICAL: You MUST use the reference product photo provided above as the EXACT jar in this image. Reproduce the jar's label, shape, glass color, lid, and proportions with 100% fidelity. Do NOT create a different jar or modify the label design.

EDITORIAL STORYTELLING SHOT for a food magazine cover. NO text overlays, NO buttons, NO discount labels, NO logos, NO words anywhere on the image. Pure photography only.

SCENE: ${scene}.
LIGHTING: ${lighting}.
COLOR PALETTE: ${palette}.
COMPOSITION: ${composition}, with negative space and breathing room. Vertical scroll-style framing — tall and immersive.

VISUAL STORY: The EXACT jar from the reference photo as the hero, surrounded by complementary fresh ingredients that suggest the product's story (origin, craft, ingredients, kitchen ritual). Hands of a craftsman or natural human elements may appear subtly. Evoke a sense of place — a New Jersey artisan kitchen, slow food, multi-generational tradition. Premium editorial food photography, magazine-cover quality, hyperrealistic, 8K.

${product.promptHints || ''}

ABSOLUTELY NO TEXT IN THE IMAGE. No headlines, no captions, no logos, no buttons, no overlays. The story will be told in the email body text — your job is to create the visual hero only.

RULES: Single jar only (the EXACT one from the reference photo), no duplicates, no text of any kind anywhere on the canvas, ultra-tall 9:21 editorial format, hyperrealistic premium food magazine photography, 8K.`;

    } else {
      // product_spotlight
      return `${baseScene}

TOP OVERLAY TEXT (warm white bold serif):
"${brief.headline}"
Below, small italic white text: "Jersey Pickles — ${product.name}"

MIDDLE: Hero the product beautifully. Close attention to the jar, the ingredients visible through the glass, the quality of the label. Make it look premium and irresistible. No discount text.

BOTTOM: Semi-transparent dark green gradient overlay.
Elegant white text: "Handcrafted • Small Batch • New Jersey"
Bright green rounded pill button: "SHOP NOW"

FOOTER: Dark green bar. "www.jerseypickles.com" small pickle icons on each side.

RULES: Single jar only (the EXACT one from the reference photo), no duplicates, premium product photography feel, NO discount text, NO codes, hyperrealistic, 8K, 9:16 vertical.`;
    }
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
    const type = brief.campaignType || 'promotional';

    if (type === 'content') return this.buildContentEmailHtml(imageUrl, brief);
    if (type === 'recipe') return this.buildRecipeEmailHtml(imageUrl, brief);
    if (type === 'pairing') return this.buildPairingEmailHtml(imageUrl, brief);
    if (type === 'customer_love') return this.buildCustomerLoveEmailHtml(imageUrl, brief);

    // Promo and spotlight share the simple image + CTA layout
    const ctaText = 'SHOP NOW';
    const ctaUrl = brief.product
      ? `https://jerseypickles.com/products/${brief.product}`
      : 'https://jerseypickles.com';

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
        <a href="${ctaUrl}" target="_blank" style="display:block;">
          <img src="${imageUrl}" alt="${brief.headline}" width="600" style="display:block;width:100%;height:auto;border:0;" />
        </a>
      </td>
    </tr>
    <tr>
      <td style="padding:20px 24px;text-align:center;background-color:#1a3d17;">
        <a href="${ctaUrl}" target="_blank" style="display:inline-block;background-color:#34d399;color:#0a0e17;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:bold;letter-spacing:0.5px;">${ctaText}</a>
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

  /**
   * Editorial HTML layout for content-type campaigns
   * Tall image hero + headline + story body + pull quote + soft CTA to product page
   */
  buildContentEmailHtml(imageUrl, brief) {
    const productSlug = brief.product || '';
    const productName = brief.productName || brief.product || 'our pickles';
    const ctaUrl = productSlug
      ? `https://jerseypickles.com/products/${productSlug}`
      : 'https://jerseypickles.com';
    const ctaText = `Shop ${productName}`;

    // Format story body — split paragraphs by double newline or single newline
    const storyParagraphs = (brief.storyBody || '')
      .split(/\n\n+|\n/)
      .map(p => p.trim())
      .filter(p => p.length > 0);

    const storyHtml = storyParagraphs
      .map(p => `<p style="margin:0 0 18px;font-family:Georgia,'Times New Roman',serif;font-size:17px;line-height:1.7;color:#3a3a3a;">${p}</p>`)
      .join('\n          ');

    const pullQuoteHtml = brief.pullQuote ? `
        <tr>
          <td style="padding:8px 32px 32px;">
            <blockquote style="margin:0;padding:24px 28px;border-left:4px solid #d4a843;background-color:#fdf8ef;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-style:italic;line-height:1.5;color:#1a3d17;">
              "${brief.pullQuote}"
            </blockquote>
          </td>
        </tr>` : '';

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${brief.headline}</title>
</head>
<body style="margin:0;padding:0;background-color:#f5f1e8;font-family:Georgia,'Times New Roman',serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;margin:0 auto;background-color:#ffffff;">

    <!-- HERO TALL IMAGE -->
    <tr>
      <td style="padding:0;background-color:#0a0e17;">
        <img src="${imageUrl}" alt="${brief.headline}" width="600" style="display:block;width:100%;height:auto;border:0;" />
      </td>
    </tr>

    <!-- HEADLINE -->
    <tr>
      <td style="padding:36px 32px 8px;">
        <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:30px;line-height:1.25;font-weight:700;color:#1a3d17;letter-spacing:-0.01em;">
          ${brief.headline}
        </h1>
      </td>
    </tr>

    <!-- KICKER / DATELINE -->
    <tr>
      <td style="padding:0 32px 24px;">
        <p style="margin:0;font-family:Arial,sans-serif;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#a67c1e;font-weight:700;">
          Jersey Pickles · ${productName}
        </p>
      </td>
    </tr>

    <!-- STORY BODY -->
    <tr>
      <td style="padding:0 32px 8px;">
        ${storyHtml || '<p style="font-family:Georgia,serif;font-size:17px;color:#3a3a3a;">A story worth telling — handcrafted with love in New Jersey.</p>'}
      </td>
    </tr>
    ${pullQuoteHtml}

    <!-- CTA -->
    <tr>
      <td style="padding:8px 32px 40px;text-align:center;">
        <a href="${ctaUrl}" target="_blank" style="display:inline-block;background-color:#1a3d17;color:#ffffff;text-decoration:none;padding:16px 40px;border-radius:4px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;">
          ${ctaText} →
        </a>
      </td>
    </tr>

    <!-- FOOTER -->
    <tr>
      <td style="padding:24px 32px;text-align:center;background-color:#122016;color:#a2b6aa;font-family:Arial,sans-serif;font-size:11px;line-height:1.6;">
        <p style="margin:0 0 8px;">Jersey Pickles — Handcrafted in New Jersey since 2014</p>
        <p style="margin:0;">
          <a href="{{unsubscribeLink}}" style="color:#6eb489;text-decoration:underline;">Unsubscribe</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  // ==================== RECIPE EMAIL ====================

  buildRecipeEmailHtml(imageUrl, brief) {
    const recipe = brief.recipe || {};
    const productSlug = brief.product || '';
    const productName = brief.productName || brief.product || 'our pickles';
    const ctaUrl = productSlug ? `https://jerseypickles.com/products/${productSlug}` : 'https://jerseypickles.com';
    const dishName = recipe.dishName || brief.headline;
    const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
    const steps = Array.isArray(recipe.steps) ? recipe.steps : [];
    const prepTime = recipe.prepTime || '';

    const ingredientsHtml = ingredients.length > 0
      ? ingredients.map(i => `<li style="margin:0 0 8px;font-family:Georgia,serif;font-size:16px;color:#3a3a3a;line-height:1.5;">${i}</li>`).join('\n          ')
      : '<li style="color:#999;font-style:italic;">Ingredients coming soon</li>';

    const stepsHtml = steps.length > 0
      ? steps.map((s, i) => `<li style="margin:0 0 14px;font-family:Georgia,serif;font-size:16px;color:#3a3a3a;line-height:1.6;"><strong style="color:#1a3d17;">${i + 1}.</strong> ${s}</li>`).join('\n          ')
      : '<li style="color:#999;font-style:italic;">Steps coming soon</li>';

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${dishName}</title></head>
<body style="margin:0;padding:0;background-color:#f5f1e8;font-family:Georgia,serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;margin:0 auto;background-color:#ffffff;">
    <tr><td style="padding:0;background-color:#0a0e17;">
      <img src="${imageUrl}" alt="${dishName}" width="600" style="display:block;width:100%;height:auto;border:0;" />
    </td></tr>
    <tr><td style="padding:36px 32px 8px;">
      <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#a67c1e;font-weight:700;">Recipe · ${productName}${prepTime ? ' · ⏱ ' + prepTime : ''}</p>
      <h1 style="margin:0;font-family:Georgia,serif;font-size:30px;line-height:1.25;font-weight:700;color:#1a3d17;">${dishName}</h1>
    </td></tr>
    <tr><td style="padding:24px 32px 8px;">
      <h3 style="margin:0 0 12px;font-family:Arial,sans-serif;font-size:12px;letter-spacing:0.15em;text-transform:uppercase;color:#1a3d17;font-weight:700;">Ingredients</h3>
      <ul style="margin:0;padding-left:20px;">
          ${ingredientsHtml}
      </ul>
    </td></tr>
    <tr><td style="padding:24px 32px 8px;">
      <h3 style="margin:0 0 14px;font-family:Arial,sans-serif;font-size:12px;letter-spacing:0.15em;text-transform:uppercase;color:#1a3d17;font-weight:700;">Method</h3>
      <ol style="margin:0;padding:0;list-style:none;">
          ${stepsHtml}
      </ol>
    </td></tr>
    <tr><td style="padding:24px 32px 40px;text-align:center;">
      <a href="${ctaUrl}" target="_blank" style="display:inline-block;background-color:#1a3d17;color:#ffffff;text-decoration:none;padding:16px 40px;border-radius:4px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;">Shop ${productName} →</a>
    </td></tr>
    <tr><td style="padding:24px 32px;text-align:center;background-color:#122016;color:#a2b6aa;font-family:Arial,sans-serif;font-size:11px;line-height:1.6;">
      <p style="margin:0 0 8px;">Jersey Pickles — Handcrafted in New Jersey since 2014</p>
      <p style="margin:0;"><a href="{{unsubscribeLink}}" style="color:#6eb489;text-decoration:underline;">Unsubscribe</a></p>
    </td></tr>
  </table>
</body></html>`;
  }

  // ==================== PAIRING EMAIL ====================

  buildPairingEmailHtml(imageUrl, brief) {
    const pairing = brief.pairing || {};
    const productSlug = brief.product || '';
    const productName = brief.productName || brief.product || 'our pickles';
    const ctaUrl = productSlug ? `https://jerseypickles.com/products/${productSlug}` : 'https://jerseypickles.com';
    const left = pairing.leftItem || { name: productName, description: 'Bold, bright, handcrafted' };
    const right = pairing.rightItem || { name: 'A classic pairing', description: 'Balance and contrast' };
    const note = pairing.pairingNote || 'A perfect match.';

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${brief.headline}</title></head>
<body style="margin:0;padding:0;background-color:#f5f1e8;font-family:Georgia,serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;margin:0 auto;background-color:#ffffff;">
    <tr><td style="padding:0;background-color:#0a0e17;">
      <img src="${imageUrl}" alt="${brief.headline}" width="600" style="display:block;width:100%;height:auto;border:0;" />
    </td></tr>
    <tr><td style="padding:36px 32px 8px;">
      <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#a67c1e;font-weight:700;">Pairing Guide</p>
      <h1 style="margin:0;font-family:Georgia,serif;font-size:30px;line-height:1.25;font-weight:700;color:#1a3d17;">${brief.headline}</h1>
    </td></tr>
    <tr><td style="padding:28px 32px 8px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr>
          <td width="48%" valign="top" style="padding:16px;background-color:#fdf8ef;border-radius:8px;border-left:4px solid #1a3d17;">
            <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:#1a3d17;font-weight:700;">This</p>
            <h3 style="margin:0 0 8px;font-family:Georgia,serif;font-size:20px;color:#1a3d17;">${left.name}</h3>
            <p style="margin:0;font-family:Georgia,serif;font-size:14px;line-height:1.5;color:#3a3a3a;">${left.description}</p>
          </td>
          <td width="4%"></td>
          <td width="48%" valign="top" style="padding:16px;background-color:#fdf8ef;border-radius:8px;border-left:4px solid #a67c1e;">
            <p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:#a67c1e;font-weight:700;">Meets</p>
            <h3 style="margin:0 0 8px;font-family:Georgia,serif;font-size:20px;color:#1a3d17;">${right.name}</h3>
            <p style="margin:0;font-family:Georgia,serif;font-size:14px;line-height:1.5;color:#3a3a3a;">${right.description}</p>
          </td>
        </tr>
      </table>
    </td></tr>
    <tr><td style="padding:24px 32px 8px;text-align:center;">
      <blockquote style="margin:0;padding:20px 28px;font-family:Georgia,serif;font-size:22px;font-style:italic;line-height:1.4;color:#1a3d17;">"${note}"</blockquote>
    </td></tr>
    <tr><td style="padding:16px 32px 40px;text-align:center;">
      <a href="${ctaUrl}" target="_blank" style="display:inline-block;background-color:#1a3d17;color:#ffffff;text-decoration:none;padding:16px 40px;border-radius:4px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;">Build Your Board →</a>
    </td></tr>
    <tr><td style="padding:24px 32px;text-align:center;background-color:#122016;color:#a2b6aa;font-family:Arial,sans-serif;font-size:11px;line-height:1.6;">
      <p style="margin:0 0 8px;">Jersey Pickles — Handcrafted in New Jersey since 2014</p>
      <p style="margin:0;"><a href="{{unsubscribeLink}}" style="color:#6eb489;text-decoration:underline;">Unsubscribe</a></p>
    </td></tr>
  </table>
</body></html>`;
  }

  // ==================== CUSTOMER LOVE EMAIL ====================

  buildCustomerLoveEmailHtml(imageUrl, brief) {
    const cl = brief.customerLove || {};
    const quotes = Array.isArray(cl.quotes) ? cl.quotes.slice(0, 3) : [];
    const productSlug = brief.product || '';
    const productName = brief.productName || brief.product || 'our pickles';
    const ctaUrl = productSlug ? `https://jerseypickles.com/products/${productSlug}` : 'https://jerseypickles.com';

    const stars = (n) => '★'.repeat(Math.max(1, Math.min(5, n || 5)));

    const quotesHtml = quotes.length > 0 ? quotes.map(q => `
      <tr><td style="padding:20px 32px;border-top:1px solid #eee7d4;">
        <p style="margin:0 0 10px;color:#d4a843;font-size:18px;letter-spacing:2px;">${stars(q.rating || 5)}</p>
        <p style="margin:0 0 12px;font-family:Georgia,serif;font-size:18px;line-height:1.55;color:#1a3d17;font-style:italic;">"${(q.text || '').replace(/"/g, '&quot;')}"</p>
        <p style="margin:0;font-family:Arial,sans-serif;font-size:13px;color:#6b6b6b;">— ${q.author || 'A happy fan'}${q.location ? ', ' + q.location : ''}</p>
      </td></tr>
    `).join('\n') : `
      <tr><td style="padding:20px 32px;text-align:center;color:#999;font-style:italic;">Reviews loading...</td></tr>`;

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${brief.headline}</title></head>
<body style="margin:0;padding:0;background-color:#f5f1e8;font-family:Georgia,serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;margin:0 auto;background-color:#ffffff;">
    <tr><td style="padding:0;background-color:#0a0e17;">
      <img src="${imageUrl}" alt="${brief.headline}" width="600" style="display:block;width:100%;height:auto;border:0;" />
    </td></tr>
    <tr><td style="padding:36px 32px 8px;text-align:center;">
      <p style="margin:0 0 8px;font-family:Arial,sans-serif;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#a67c1e;font-weight:700;">What Our Fans Say</p>
      <h1 style="margin:0;font-family:Georgia,serif;font-size:30px;line-height:1.25;font-weight:700;color:#1a3d17;">${brief.headline}</h1>
    </td></tr>
    ${quotesHtml}
    <tr><td style="padding:32px;text-align:center;border-top:1px solid #eee7d4;">
      <a href="${ctaUrl}" target="_blank" style="display:inline-block;background-color:#1a3d17;color:#ffffff;text-decoration:none;padding:16px 40px;border-radius:4px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;">Join the fans →</a>
    </td></tr>
    <tr><td style="padding:24px 32px;text-align:center;background-color:#122016;color:#a2b6aa;font-family:Arial,sans-serif;font-size:11px;line-height:1.6;">
      <p style="margin:0 0 8px;">Jersey Pickles — Handcrafted in New Jersey since 2014</p>
      <p style="margin:0;"><a href="{{unsubscribeLink}}" style="color:#6eb489;text-decoration:underline;">Unsubscribe</a></p>
    </td></tr>
  </table>
</body></html>`;
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
