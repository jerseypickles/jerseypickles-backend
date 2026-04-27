// backend/src/services/apolloService.js
// 🏛️ APOLLO - Creative Agent for Email Campaign Visuals
// God of art and beauty - generates promotional images with GPT-Image-2

const OpenAI = require('openai');
const { toFile } = require('openai');
const cloudinary = require('../config/cloudinary');
const ApolloConfig = require('../models/ApolloConfig');
const axios = require('axios');

class ApolloService {
  constructor() {
    this.openaiClient = null;
    this.initialized = false;
  }

  // ==================== INITIALIZATION ====================

  init() {
    if (this.initialized) return;

    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      try {
        this.openaiClient = new OpenAI({ apiKey: openaiKey });
        console.log('🏛️ Apollo: OpenAI initialized');
      } catch (error) {
        console.error('🏛️ Apollo: OpenAI init error:', error.message);
      }
    } else {
      console.log('🏛️ Apollo: OPENAI_API_KEY not configured');
    }

    this.initialized = true;
  }

  isAvailable() {
    return this.openaiClient !== null;
  }

  // Per-engine hard cap so a hung provider can't stall the whole weekly plan
  static ENGINE_TIMEOUT_MS = 90000;

  _withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // ==================== MAIN: GENERATE CREATIVE ====================

  /**
   * Generate promotional creative image for a campaign with GPT-Image-2.
   *
   * Returns the dual-engine shape `{ success, creatives: [...] }` where the
   * creatives array always has a single entry. The shape is preserved so
   * Maximus and the frontend keep working unchanged after the Gemini removal.
   *
   * @param {object} brief - Campaign brief from Maximus
   * @param {string} brief.product - Product slug (e.g., 'hot-tomatoes')
   * @returns {object} { success, creatives: [{engine, model, imageUrl, cloudinaryId, generationTime, success, error}] }
   */
  async generateCreative(brief) {
    if (!this.isAvailable()) {
      return { success: false, error: 'OpenAI not configured', creatives: [] };
    }

    const config = await ApolloConfig.getConfig();

    console.log('\n🏛️ ═══════════════════════════════════════');
    console.log('   APOLLO - Generating Creative (GPT-Image-2)');
    console.log('═══════════════════════════════════════\n');
    console.log(`   Product: ${brief.product}`);

    const product = config.getProduct(brief.product);
    if (!product) {
      console.error(`🏛️ Apollo: Product "${brief.product}" not found in bank`);
      return { success: false, error: `Product "${brief.product}" not found`, creatives: [] };
    }

    const promptText = this.buildPrompt(brief, product);
    console.log(`   Prompt length: ${promptText.length} chars`);

    let bankImageData = null;
    if (product.bankImageUrl) {
      try {
        const imgResponse = await axios.get(product.bankImageUrl, { responseType: 'arraybuffer', timeout: 15000 });
        const base64 = Buffer.from(imgResponse.data).toString('base64');
        const mimeType = imgResponse.headers['content-type'] || 'image/jpeg';
        bankImageData = { base64, mimeType, buffer: Buffer.from(imgResponse.data) };
        console.log(`   Bank image downloaded (${Math.round(imgResponse.data.length / 1024)}KB)`);
      } catch (imgErr) {
        console.warn(`   Could not download bank image: ${imgErr.message}`);
      }
    }

    const startTime = Date.now();
    const model = config.openaiModel;
    let creative;

    try {
      const imageBase64 = await this._withTimeout(
        this.callGpt(promptText, model, bankImageData),
        ApolloService.ENGINE_TIMEOUT_MS,
        'gpt'
      );

      if (!imageBase64) {
        creative = { engine: 'gpt', model, success: false, error: 'gpt returned no image', generationTime: Date.now() - startTime };
      } else {
        const uploadResult = await this.uploadToCloudinary(imageBase64, brief, config.cloudinaryFolder, 'gpt');
        creative = {
          engine: 'gpt',
          model,
          success: true,
          imageUrl: uploadResult.secure_url,
          cloudinaryId: uploadResult.public_id,
          generationTime: Date.now() - startTime,
          width: uploadResult.width,
          height: uploadResult.height
        };
      }
    } catch (err) {
      creative = { engine: 'gpt', model, success: false, error: err.message, generationTime: Date.now() - startTime };
    }

    if (creative.success) {
      // Atomic stats update so concurrent calls don't race on save()
      await ApolloConfig.updateOne(
        { _id: config._id },
        [{
          $set: {
            'stats.totalGenerated': { $add: [{ $ifNull: ['$stats.totalGenerated', 0] }, 1] },
            'stats.lastGeneratedAt': new Date(),
            'stats.averageGenerationTime': {
              $round: [{
                $divide: [
                  { $add: [
                    { $multiply: [{ $ifNull: ['$stats.averageGenerationTime', 0] }, { $ifNull: ['$stats.totalGenerated', 0] }] },
                    creative.generationTime
                  ]},
                  { $max: [1, { $add: [{ $ifNull: ['$stats.totalGenerated', 0] }, 1] }] }
                ]
              }, 0]
            }
          }
        }]
      );
      console.log(`   ✅ gpt (${(creative.generationTime / 1000).toFixed(1)}s) → ${creative.imageUrl}`);
    } else {
      console.log(`   ❌ gpt: ${creative.error}`);
    }

    return { success: creative.success, creatives: [creative] };
  }

  // ==================== OPENAI (GPT-IMAGE-2) API CALL ====================

  /**
   * Call GPT-Image-2 via the /v1/images/edits endpoint, using the bank image as reference.
   * Returns base64 PNG.
   * @param {string} prompt - Text prompt
   * @param {string} model - OpenAI image model (default 'gpt-image-2')
   * @param {object|null} bankImage - { buffer, mimeType } reference product photo
   */
  async callGpt(prompt, model = 'gpt-image-2', bankImage = null) {
    if (!this.openaiClient) throw new Error('OpenAI not initialized');

    const finalPrompt = bankImage
      ? `REFERENCE PRODUCT PHOTO: The attached image is the EXACT product jar you must reproduce. Match its label, shape, color, and proportions precisely. Do NOT invent a different jar.\n\n${prompt}`
      : prompt;

    let response;
    if (bankImage && bankImage.buffer) {
      const fileExt = (bankImage.mimeType || 'image/jpeg').split('/')[1] || 'jpg';
      const refFile = await toFile(bankImage.buffer, `reference.${fileExt}`, { type: bankImage.mimeType || 'image/jpeg' });
      response = await this.openaiClient.images.edit({
        model,
        image: [refFile],
        prompt: finalPrompt
      });
    } else {
      response = await this.openaiClient.images.generate({
        model,
        prompt: finalPrompt
      });
    }

    return response.data?.[0]?.b64_json || null;
  }

  // ==================== PROMPT BUILDER ====================

  /**
   * Build the mega-prompt for GPT-Image-2.
   * Template-based with variable injection from Maximus brief.
   */
  buildPrompt(brief, product) {
    const dayOfWeek = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    const type = brief.campaignType || 'promotional';

    // Scene variety — randomize across many different settings to avoid monotony
    const scenes = [
      // Kitchen / counter
      'rustic wooden kitchen counter with exposed beams above',
      'marble kitchen countertop with white tile backsplash',
      'butcher block counter with copper cookware hanging nearby',
      'concrete countertop in a modern industrial kitchen',
      // Outdoor / picnic
      'sunlit backyard picnic table with wildflowers in a mason jar',
      'beach picnic on driftwood with sand-textured linen and pebbles',
      'rooftop terrace table at golden hour with city skyline blurred behind',
      'wooden deck dinner table at dusk with hanging Edison bulbs',
      'campfire side log with cast iron skillet warming nearby',
      // Markets / artisan
      'farmers market stall with chalkboard signs and produce crates',
      'artisanal pantry shelf with neighboring jars and burlap sacks',
      'old-world delicatessen counter with brown paper and twine',
      // Studio / editorial
      'seamless minimalist studio backdrop with one soft shadow, label-forward',
      'dark moody backdrop with a single dramatic spotlight on the jar',
      'high-contrast pure-black backdrop, jar floating with rim-light',
      // Pantry / domestic
      'open pantry shelf next to ceramic crocks and folded linen',
      'kitchen windowsill with potted herbs and morning sun',
      'dining table mid-meal with napkins and half-eaten plates around it',
      // Travel / Mediterranean
      'Tuscan stone wall ledge with terracotta pots and olive branches',
      'French countryside outdoor table beside a stone farmhouse wall',
      // Action / process
      'cutting board mid-prep with a wooden spoon hovering over the open jar',
      'jar tipped slightly with contents pouring across rustic bread',
      "craftsman's hands in apron arranging a cheese board around the jar",
      'spice-stained workbench with the jar mid-recipe and ingredient debris'
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
      'twinkling string lights and candles, festive dinner vibes',
      'hard noon sun with crisp graphic shadows, contemporary feel',
      'blue-hour twilight with single warm interior light, cinematic',
      'studio rim-light with falloff into shadow, product-photography precision',
      'overcast outdoor light filtering through trees, natural and soft',
      'firelight from below casting flickering warmth, primal and rustic'
    ];

    const colorPalettes = [
      'warm earth tones — terracotta, olive green, cream, burnt orange',
      'fresh garden tones — sage green, ivory, pale yellow, soft pink',
      'moody deep tones — forest green, burgundy, charcoal, gold accents',
      'bright farmhouse tones — red gingham, white, fresh greens, natural wood',
      'minimalist tones — muted greys, white, black, single pop of color from the product',
      'autumn harvest tones — rust, mustard, cream, deep brown',
      'coastal tones — soft blues, white, sand, driftwood grey',
      'Mediterranean tones — terracotta, olive, ochre, stone',
      'high-contrast tones — pure black, off-white, single bold accent',
      'jewel tones — emerald, ruby, deep teal, brushed gold',
      'desaturated film tones — faded olive, dusty pink, tea-stained beige',
      'fresh produce tones — lime green, cherry red, lemon yellow, leaf green'
    ];

    const compositions = [
      'jar centered in lower third with ingredients fanning out behind',
      'jar slightly off-center right with props balancing left',
      'overhead three-quarter angle showing jar and surrounding scene',
      'jar in sharp foreground with blurred lifestyle scene behind',
      'jar on a wooden board with fresh ingredients styled around it',
      'jar with a linen napkin draped casually beside it',
      'jar next to a small stack of vintage cookbooks and a wooden spoon',
      'jar with cutting board, knife, and prepped ingredients nearby',
      'jar at the edge of frame with deep negative space on the opposite side',
      'jar surrounded by spilled product and crumbs, mid-action storytelling',
      'jar elevated on a small wooden riser with ingredients at base level',
      'jar framed through out-of-focus foreground props (herbs, glassware)'
    ];

    // Camera/framing variety — orthogonal axis to scene/composition
    const cameraStyles = [
      'tight macro close-up emphasizing label texture and glass condensation',
      'wide editorial shot capturing surrounding context and breathing room',
      'eye-level tabletop POV at the height of the jar itself',
      'top-down 90-degree flat lay perspective',
      'three-quarter 30-45 degree lifestyle angle',
      "dramatic worm's-eye low angle making the jar feel monumental",
      'documentary candid framing with a partial human element entering frame',
      'in-motion shutter with a subtle pour or sprinkle blur',
      'rule-of-thirds asymmetric composition with strong negative space',
      'over-the-shoulder cooking POV with hands and product in soft focus'
    ];

    // Use Director brief (from Opus/Sonnet via Maximus) when available; fall back to random pools.
    const d = brief.director || {};
    const scene = d.scene || scenes[Math.floor(Math.random() * scenes.length)];
    const lighting = d.lighting || lightingMoods[Math.floor(Math.random() * lightingMoods.length)];
    const palette = d.palette || colorPalettes[Math.floor(Math.random() * colorPalettes.length)];
    const composition = d.composition || compositions[Math.floor(Math.random() * compositions.length)];
    const cameraStyle = d.cameraStyle || cameraStyles[Math.floor(Math.random() * cameraStyles.length)];
    const directorExtras = d.extras ? `\nEXTRAS: ${d.extras}.` : '';
    if (brief.director) console.log('   🎬 Using Director brief (bespoke)');

    const baseScene = `ASPECT RATIO: 9:16 vertical portrait, designed for email marketing.

CRITICAL: You MUST use the reference product photo provided above as the EXACT jar in this image. Reproduce the jar's label, shape, glass color, lid, and proportions with 100% fidelity. Do NOT create a different jar or modify the label design.

SCENE: ${scene}.
LIGHTING: ${lighting}.
COLOR PALETTE: ${palette}.
COMPOSITION: ${composition}.
CAMERA: ${cameraStyle}.${directorExtras}

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
CAMERA: ${cameraStyle}.

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
CAMERA: ${cameraStyle}.

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
CAMERA: ${cameraStyle}.

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
CAMERA: ${cameraStyle}.

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
   * Upload generated image to Cloudinary, tagging by engine so admin can filter.
   */
  async uploadToCloudinary(base64Image, brief, folder, engine = 'gpt') {
    const dataUri = `data:image/png;base64,${base64Image}`;
    const timestamp = Date.now();
    const publicId = `${folder}/${brief.product}-${brief.code}-${engine}-${timestamp}`;

    const result = await cloudinary.uploader.upload(dataUri, {
      public_id: publicId,
      folder: undefined,
      resource_type: 'image',
      tags: ['apollo', 'agent-generated', engine, brief.product, brief.code]
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
    const ctaUrl = 'https://jerseypickles.com/';

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
    const productName = brief.productName || brief.product || 'our pickles';
    const ctaUrl = 'https://jerseypickles.com/';
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
    const productName = brief.productName || brief.product || 'our pickles';
    const ctaUrl = 'https://jerseypickles.com/';
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
    const productName = brief.productName || brief.product || 'our pickles';
    const ctaUrl = 'https://jerseypickles.com/';
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
    const productName = brief.productName || brief.product || 'our pickles';
    const ctaUrl = 'https://jerseypickles.com/';

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
    const gptAvailable = this.isAvailable();

    return {
      agent: 'Apollo',
      active: config.active,
      engines: {
        available: gptAvailable ? ['gpt'] : [],
        gpt: { available: gptAvailable, model: config.openaiModel }
      },
      openaiAvailable: gptAvailable,
      openaiModel: config.openaiModel,
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
