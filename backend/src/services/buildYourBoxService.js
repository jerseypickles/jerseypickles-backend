// backend/src/services/buildYourBoxService.js
// Service para analizar demanda de productos en Build Your Box

const Order = require('../models/Order');

class BuildYourBoxService {
  constructor() {
    // Tamaños de jar válidos
    this.jarSizes = ['16OZ', '16 OZ', 'QUART', 'QUART (32oz)', 'HALF_GALLON', 'HALF GALLON'];

    // Normalizar tamaños
    this.normalizeSize = (size) => {
      if (!size) return 'UNKNOWN';
      const upper = size.toUpperCase().trim();
      if (upper.includes('16')) return '16OZ';
      if (upper.includes('QUART')) return 'QUART';
      if (upper.includes('HALF') || upper.includes('GALLON')) return 'HALF_GALLON';
      return upper;
    };
  }

  /**
   * Parsear notas de Build Your Box
   * Formato: *** Build Your Boxes ***  Box #1 (Jar: QUART) • Product (qty) • Product (qty)
   */
  parseBoxNote(note) {
    if (!note || !note.includes('Build Your Box')) return null;

    const boxes = [];

    // Regex para encontrar cada box
    // Ejemplo: Box #1 (Jar: QUART (32oz)) • Hot Pickled Green Tomatoes (1) • Sour Pickled (2)
    const boxRegex = /Box\s*#?(\d+)\s*\(Jar:\s*([^)]+)\)\s*((?:•\s*[^•]+)+)/gi;

    let match;
    while ((match = boxRegex.exec(note)) !== null) {
      const boxNumber = parseInt(match[1]);
      const jarSize = this.normalizeSize(match[2]);
      const productsStr = match[3];

      // Parsear productos
      const products = [];
      const productRegex = /•\s*([^(•]+)\s*\((\d+)\)/g;
      let productMatch;

      while ((productMatch = productRegex.exec(productsStr)) !== null) {
        const productName = productMatch[1].trim();
        const quantity = parseInt(productMatch[2]);

        if (productName && quantity > 0) {
          products.push({
            name: productName,
            quantity: quantity
          });
        }
      }

      if (products.length > 0) {
        boxes.push({
          boxNumber,
          jarSize,
          products
        });
      }
    }

    return boxes.length > 0 ? boxes : null;
  }

  /**
   * Obtener estadísticas de demanda
   * @param {number} days - Días hacia atrás (0 = desde hoy en adelante, null = todos)
   */
  async getDemandStats(days = 30) {
    const query = {
      'shopifyData.note': { $regex: /Build Your Box/i }
    };

    if (days > 0) {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      startDate.setHours(0, 0, 0, 0); // Inicio del día
      query.orderDate = { $gte: startDate };
    }

    console.log(`📦 BYB Query: days=${days}, startDate=${query.orderDate?.$gte?.toISOString() || 'all'}`);

    // Buscar órdenes con notas de Build Your Box
    const orders = await Order.find(query)
      .select('shopifyData.note orderDate totalPrice orderNumber')
      .sort({ orderDate: -1 })
      .lean();

    console.log(`📦 BYB Found ${orders.length} orders with Build Your Box notes`);

    // Agregados
    const productStats = {};
    const sizeStats = {};
    let totalBoxes = 0;
    let totalProducts = 0;
    const dailyData = {};

    for (const order of orders) {
      const note = order.shopifyData?.note;
      if (!note) continue;

      const boxes = this.parseBoxNote(note);
      if (!boxes) continue;

      // Fecha para tendencias
      const dateKey = new Date(order.orderDate).toISOString().split('T')[0];
      if (!dailyData[dateKey]) {
        dailyData[dateKey] = { boxes: 0, products: 0, orders: 0 };
      }
      dailyData[dateKey].orders++;

      for (const box of boxes) {
        totalBoxes++;
        dailyData[dateKey].boxes++;

        // Stats por tamaño
        if (!sizeStats[box.jarSize]) {
          sizeStats[box.jarSize] = { count: 0, products: 0 };
        }
        sizeStats[box.jarSize].count++;

        for (const product of box.products) {
          totalProducts += product.quantity;
          dailyData[dateKey].products += product.quantity;
          sizeStats[box.jarSize].products += product.quantity;

          // Stats por producto
          if (!productStats[product.name]) {
            productStats[product.name] = {
              name: product.name,
              totalQuantity: 0,
              orderCount: 0,
              bySizes: {}
            };
          }
          productStats[product.name].totalQuantity += product.quantity;
          productStats[product.name].orderCount++;

          // Por tamaño de jar
          if (!productStats[product.name].bySizes[box.jarSize]) {
            productStats[product.name].bySizes[box.jarSize] = 0;
          }
          productStats[product.name].bySizes[box.jarSize] += product.quantity;
        }
      }
    }

    // Convertir a arrays ordenados
    const topProducts = Object.values(productStats)
      .sort((a, b) => b.totalQuantity - a.totalQuantity);

    const sizeDistribution = Object.entries(sizeStats)
      .map(([size, data]) => ({
        size,
        count: data.count,
        products: data.products,
        percentage: totalBoxes > 0 ? Math.round((data.count / totalBoxes) * 100) : 0
      }))
      .sort((a, b) => b.count - a.count);

    // Tendencias diarias (últimos 14 días)
    const trends = Object.entries(dailyData)
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(-14);

    return {
      summary: {
        totalOrders: orders.length,
        totalBoxes,
        totalProducts,
        avgProductsPerBox: totalBoxes > 0 ? Math.round((totalProducts / totalBoxes) * 10) / 10 : 0,
        period: { days }
      },
      topProducts: topProducts.slice(0, 20),
      sizeDistribution,
      trends
    };
  }

  /**
   * Obtener productos más populares
   */
  async getTopProducts(days = 30, limit = 20) {
    const stats = await this.getDemandStats(days);
    return stats.topProducts.slice(0, limit);
  }

  /**
   * Obtener distribución de tamaños
   */
  async getSizeDistribution(days = 30) {
    const stats = await this.getDemandStats(days);
    return stats.sizeDistribution;
  }

  /**
   * Obtener tendencias diarias
   */
  async getDailyTrends(days = 30) {
    const stats = await this.getDemandStats(days);
    return stats.trends;
  }

  /**
   * Obtener combos frecuentes (productos que se piden juntos)
   */
  async getFrequentCombos(days = 30, minSupport = 3) {
    const query = {};

    if (days > 0) {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      query.orderDate = { $gte: startDate };
    }

    const orders = await Order.find({
      ...query,
      'shopifyData.note': { $regex: /Build Your Box/i }
    }).select('shopifyData.note').lean();

    // Contar pares de productos
    const pairCounts = {};

    for (const order of orders) {
      const boxes = this.parseBoxNote(order.shopifyData?.note);
      if (!boxes) continue;

      for (const box of boxes) {
        const productNames = box.products.map(p => p.name).sort();

        // Generar pares
        for (let i = 0; i < productNames.length; i++) {
          for (let j = i + 1; j < productNames.length; j++) {
            const pairKey = `${productNames[i]}|||${productNames[j]}`;
            pairCounts[pairKey] = (pairCounts[pairKey] || 0) + 1;
          }
        }
      }
    }

    // Filtrar y ordenar
    const combos = Object.entries(pairCounts)
      .filter(([, count]) => count >= minSupport)
      .map(([key, count]) => {
        const [product1, product2] = key.split('|||');
        return { product1, product2, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return combos;
  }

  /**
   * Obtener overview completo para dashboard
   */
  async getOverview(days = 30) {
    const [stats, combos] = await Promise.all([
      this.getDemandStats(days),
      this.getFrequentCombos(days)
    ]);

    return {
      ...stats,
      frequentCombos: combos
    };
  }

  /**
   * Generar AI Insights para escalar Build Your Box
   * Usa Claude para analizar patrones y dar recomendaciones
   */
  async generateAiInsights(days = 30) {
    // Obtener datos para análisis
    const [stats, combos] = await Promise.all([
      this.getDemandStats(days),
      this.getFrequentCombos(days, 2)
    ]);

    // Preparar datos para Claude
    const analysisData = {
      summary: stats.summary,
      topProducts: stats.topProducts.slice(0, 15),
      sizeDistribution: stats.sizeDistribution,
      frequentCombos: combos,
      trends: stats.trends
    };

    // Intentar usar Claude si está disponible
    let claudeService = null;
    try {
      claudeService = require('./claudeService');
      if (!claudeService.isAvailable()) {
        claudeService = null;
      }
    } catch (e) {
      console.log('⚠️ Claude service not available for BYB insights');
    }

    if (claudeService) {
      return this.generateClaudeInsights(claudeService, analysisData);
    }

    // Fallback sin Claude
    return this.generateFallbackInsights(analysisData);
  }

  /**
   * Generar insights usando Claude AI
   */
  async generateClaudeInsights(claudeService, data) {
    const prompt = `Eres un experto en desarrollo de productos para Jersey Pickles, una empresa artesanal de pickles y olives gourmet de New Jersey.

CONTEXTO DEL NEGOCIO:
- Jersey Pickles vende pickles artesanales (pepinos, tomates, etc.) y olives gourmet
- El "Build Your Box" permite a clientes elegir: Tipo de jar (Quart 32oz o Half Gallon) → Tamaño de box (4, 6, 8, 12 jars) → Productos individuales
- Los clientes mezclan pickles y olives según su gusto
- Es un negocio familiar artesanal, no industrial

DATOS DE DEMANDA DE LOS ÚLTIMOS ${data.summary.period?.days || 30} DÍAS:

📊 RESUMEN:
• Boxes vendidos: ${data.summary.totalBoxes}
• Pedidos: ${data.summary.totalOrders}
• Productos elegidos: ${data.summary.totalProducts} unidades
• Promedio por box: ${data.summary.avgProductsPerBox} productos

🏆 TOP PRODUCTOS MÁS ELEGIDOS:
${data.topProducts.map((p, i) => `${i + 1}. ${p.name}: ${p.totalQuantity} unidades (${p.orderCount} pedidos)`).join('\n')}

📦 TAMAÑOS DE JAR:
${data.sizeDistribution.map(s => `• ${s.size}: ${s.count} boxes (${s.percentage}%)`).join('\n')}

🤝 PRODUCTOS QUE SE PIDEN JUNTOS:
${data.frequentCombos.length > 0 ? data.frequentCombos.map((c, i) => `${i + 1}. "${c.product1}" + "${c.product2}" → ${c.count} veces`).join('\n') : 'Sin datos suficientes'}

═══════════════════════════════════════════════════════════
🎯 GENERA RECOMENDACIONES EN ESTAS CATEGORÍAS:
═══════════════════════════════════════════════════════════

1. **IDEAS DE NUEVOS PRODUCTOS** (newProductIdeas)
   - Basándote en los productos populares, sugiere RECETAS ESPECÍFICAS de nuevos productos
   - Ejemplo: Si "Garlic Dill Pickles" es popular → "Roasted Garlic & Black Pepper Pickles"
   - Ejemplo: Si "Hot Green Tomatoes" es popular → "Sweet Heat Green Tomatoes con miel y habanero"
   - Piensa en: variaciones de sabor (más dulce, más picante, sabores únicos), productos de temporada, fusiones de sabores
   - Incluye descripción del perfil de sabor

2. **MEJORAS AL BUILD YOUR BOX** (bybImprovements)
   - Ideas para mejorar la experiencia de Build Your Box
   - Ejemplo: "Agregar tamaño 16oz Sampler para clientes nuevos"
   - Ejemplo: "Opción 'Mystery Jar' donde Jersey Pickles elige una sorpresa"
   - Ejemplo: "Categoría 'Staff Picks' con los favoritos del equipo"
   - Ejemplo: "Auto-sugerir productos complementarios basado en selección"

3. **ESTRATEGIAS DE ESCALADO** (scalingStrategies)
   - Cómo aumentar ventas del Build Your Box
   - Basado en los datos: qué tamaños promover, qué productos destacar
   - Ideas de upsell dentro del flujo de Build Your Box

4. **IDEAS DE MARKETING** (marketingIdeas)
   - Campañas SMS/Email específicas usando los productos más populares
   - Ejemplo: "Campaña 'Garlic Lovers Week' destacando todos los productos con ajo"

5. **QUICK WINS** (quickWins)
   - 3-5 acciones que se pueden implementar esta semana

Responde SOLO con JSON válido (sin markdown, sin backticks):
{
  "executiveSummary": "2-3 oraciones: insight principal y oportunidad más grande basada en los datos",
  "newProductIdeas": [
    {
      "name": "Nombre comercial del producto (ej: Honey Habanero Green Tomatoes)",
      "description": "Descripción del producto y perfil de sabor",
      "whyItWorks": "Por qué funcionaría basado en los datos de demanda",
      "basedOn": ["Producto existente que inspira esta idea"],
      "category": "pickle o olive",
      "flavorProfile": "dulce/picante/ácido/savory/etc"
    }
  ],
  "bybImprovements": [
    {
      "idea": "Título de la mejora",
      "description": "Descripción detallada de la implementación",
      "benefit": "Beneficio esperado para el negocio",
      "effort": "low/medium/high"
    }
  ],
  "scalingStrategies": [
    {
      "title": "Título de la estrategia",
      "description": "Descripción detallada",
      "expectedImpact": "Impacto esperado (ej: +15% ticket promedio)",
      "effort": "low/medium/high"
    }
  ],
  "marketingIdeas": [
    {
      "channel": "SMS o Email",
      "campaignName": "Nombre de la campaña",
      "message": "Ejemplo del mensaje o subject line",
      "targetProduct": "Producto a destacar",
      "timing": "Cuándo enviar"
    }
  ],
  "quickWins": ["Acción inmediata 1", "Acción inmediata 2", "Acción inmediata 3"],
  "dataInsights": {
    "surprising": "Algo interesante o inesperado en los datos",
    "opportunity": "Oportunidad no obvia que detectas"
  }
}`;

    try {
      console.log('🧠 Generating BYB AI insights with Claude...');
      const startTime = Date.now();

      const response = await claudeService.client.messages.create({
        model: claudeService.model,
        max_tokens: 2500,
        messages: [{ role: 'user', content: prompt }]
      });

      const duration = Date.now() - startTime;
      console.log(`✅ Claude responded in ${duration}ms`);

      const content = response.content[0]?.text;
      if (!content) {
        console.error('❌ Claude returned empty response');
        return this.generateFallbackInsights(data);
      }

      // Parse JSON response
      let parsed;
      try {
        let jsonStr = content.trim();
        if (jsonStr.includes('```')) {
          const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (match) jsonStr = match[1];
        }
        if (!jsonStr.startsWith('{')) {
          const start = jsonStr.indexOf('{');
          if (start !== -1) jsonStr = jsonStr.substring(start);
        }
        if (!jsonStr.endsWith('}')) {
          const end = jsonStr.lastIndexOf('}');
          if (end !== -1) jsonStr = jsonStr.substring(0, end + 1);
        }
        parsed = JSON.parse(jsonStr);

        // Log para debug - ver qué retorna Claude
        console.log('📦 Claude BYB parsed response keys:', Object.keys(parsed));
        if (parsed.newProductIdeas?.length > 0) {
          console.log('📦 Sample newProductIdea:', JSON.stringify(parsed.newProductIdeas[0]));
        }
        if (parsed.marketingIdeas?.length > 0) {
          console.log('📦 Sample marketingIdea:', JSON.stringify(parsed.marketingIdeas[0]));
        }
      } catch (parseError) {
        console.error('❌ Error parsing Claude response:', parseError.message);
        return this.generateFallbackInsights(data);
      }

      return {
        success: true,
        ...parsed,
        generatedAt: new Date().toISOString(),
        model: claudeService.model,
        tokensUsed: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0
        },
        duration,
        dataSnapshot: {
          totalBoxes: data.summary.totalBoxes,
          topProduct: data.topProducts[0]?.name,
          period: data.summary.period
        }
      };

    } catch (error) {
      console.error('❌ Error calling Claude for BYB insights:', error.message);
      return this.generateFallbackInsights(data);
    }
  }

  /**
   * Fallback insights cuando Claude no está disponible
   */
  generateFallbackInsights(data) {
    const topProducts = data.topProducts || [];
    const combos = data.frequentCombos || [];
    const sizes = data.sizeDistribution || [];

    // Análisis básico
    const topProduct = topProducts[0];
    const dominantSize = sizes[0];

    const scalingStrategies = [];
    const quickWins = [];

    // Estrategia 1: Aumentar ticket con upgrades
    if (sizes.length > 1) {
      const smallestSize = sizes[sizes.length - 1];
      if (smallestSize && smallestSize.percentage > 20) {
        scalingStrategies.push({
          title: 'Incentivar upgrades de tamaño',
          description: `${smallestSize.percentage}% de clientes eligen ${smallestSize.size}. Ofrece un descuento para upgrade al tamaño siguiente.`,
          expectedImpact: '+10-15% ticket promedio',
          effort: 'low',
          priority: 1
        });
      }
    }

    // Estrategia 2: Bundles pre-armados
    if (combos.length > 0) {
      scalingStrategies.push({
        title: 'Crear bundles pre-armados',
        description: `Basado en los combos frecuentes, crea opciones "ready to buy" para reducir fricción.`,
        expectedImpact: '+20% conversión en página de producto',
        effort: 'medium',
        priority: 2
      });
    }

    // Quick wins
    if (topProduct) {
      quickWins.push(`Destacar "${topProduct.name}" en la página principal del Build Your Box`);
    }
    quickWins.push('Agregar fotos de boxes armados por otros clientes (social proof)');
    quickWins.push('Mostrar "Más popular" badge en los top 3 productos');

    // Bundle suggestions basados en combos
    const bundleSuggestions = combos.slice(0, 2).map((combo, i) => ({
      name: i === 0 ? 'The Classics Duo' : 'Fan Favorites Pack',
      products: [combo.product1, combo.product2],
      size: 'QUART',
      rationale: `Estos productos se piden juntos ${combo.count} veces`,
      suggestedPrice: '$35-45'
    }));

    return {
      success: true,
      executiveSummary: topProduct
        ? `"${topProduct.name}" es tu producto estrella con ${topProduct.totalQuantity} unidades vendidas. ${combos.length > 0 ? `Los clientes frecuentemente lo combinan con "${combos[0]?.product2}".` : ''} Oportunidad: crear bundles pre-armados basados en estos patrones.`
        : 'Necesitas más datos para generar insights significativos. Sigue vendiendo Build Your Boxes para acumular información.',
      scalingStrategies,
      newProductIdeas: topProducts.length > 3 ? [
        {
          product: `${topProducts[0]?.name?.split(' ')[0]} Extra Spicy`,
          rationale: 'Variante más picante del producto más popular',
          basedOn: [topProducts[0]?.name]
        }
      ] : [],
      bundleSuggestions,
      sizeOptimization: {
        analysis: dominantSize
          ? `${dominantSize.size} es el tamaño más popular (${dominantSize.percentage}%)`
          : 'Sin datos suficientes de tamaños',
        recommendation: 'Considera ofrecer un descuento por elegir el tamaño más grande'
      },
      marketingIdeas: topProduct ? [
        {
          channel: 'SMS',
          idea: `"${topProduct.name}" is flying off shelves! Build your box before it's gone 🥒`,
          targetProduct: topProduct.name,
          timing: 'Viernes por la mañana'
        }
      ] : [],
      quickWins,
      dataInsights: {
        surprising: topProducts.length > 5
          ? `Hay ${topProducts.length} productos diferentes siendo elegidos - buena variedad`
          : 'Pocos productos dominan las elecciones',
        concern: data.summary.avgProductsPerBox < 3
          ? 'Los clientes eligen pocos productos por box - considera incentivos para agregar más'
          : null,
        opportunity: combos.length > 0
          ? 'Los patrones de combo sugieren oportunidades de bundles pre-armados'
          : 'Necesitas más datos para identificar patrones'
      },
      generatedAt: new Date().toISOString(),
      model: 'fallback-analysis',
      isFallback: true,
      dataSnapshot: {
        totalBoxes: data.summary.totalBoxes,
        topProduct: topProduct?.name,
        period: data.summary.period
      }
    };
  }
}

module.exports = new BuildYourBoxService();
