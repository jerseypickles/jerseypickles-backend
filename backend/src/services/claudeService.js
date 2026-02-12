// backend/src/services/claudeService.js
// 🧠 Servicio para integración con Claude API (Anthropic)
// 🔧 UPDATED: Ahora enfocado en SMS Marketing (no email)

const Anthropic = require('@anthropic-ai/sdk');

// 🆕 Importar servicios de contexto de negocio
let businessContextService = null;
try {
  businessContextService = require('./businessContextService');
} catch (error) {
  console.log('⚠️  businessContextService no disponible:', error.message);
}

class ClaudeService {
  constructor() {
    this.client = null;
    this.initialized = false;
    this.model = 'claude-sonnet-4-20250514';
  }

  init() {
    if (this.initialized) return;

    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      console.log('⚠️  ANTHROPIC_API_KEY no configurada - Claude AI deshabilitado');
      return;
    }

    try {
      this.client = new Anthropic({ apiKey });
      this.initialized = true;
      console.log('✅ Claude API inicializada');
    } catch (error) {
      console.error('❌ Error inicializando Claude API:', error.message);
    }
  }

  isAvailable() {
    return this.initialized && this.client !== null;
  }

  // ==================== SMS MARKETING INSIGHTS (NUEVO) ====================

  /**
   * Generar análisis profundo de SMS marketing
   * Este es el método principal para el nuevo enfoque 100% SMS
   */
  async generateSmsInsights(metricsData) {
    if (!this.isAvailable()) {
      console.log('⚠️  Claude API no disponible, usando insights básicos');
      return this.getSmsFallbackInsights(metricsData);
    }

    // Obtener contexto de negocio si está disponible
    let businessContext = null;
    let businessContextPrompt = '';

    if (businessContextService) {
      try {
        console.log('📦 Obteniendo contexto de negocio para Claude...');
        businessContext = await businessContextService.getFullBusinessContext();
        businessContextPrompt = businessContextService.formatBusinessContextForPrompt(businessContext);
        console.log('✅ Contexto de negocio obtenido');
      } catch (error) {
        console.log('⚠️  Error obteniendo contexto de negocio:', error.message);
      }
    }

    const systemPrompt = this.buildSmsSystemPrompt();
    const userPrompt = this.buildSmsUserPrompt(metricsData, businessContextPrompt);

    try {
      console.log('🧠 Llamando a Claude API para análisis de SMS...');
      console.log(`   Model: ${this.model}`);
      console.log(`   System prompt length: ${systemPrompt.length} chars`);
      console.log(`   User prompt length: ${userPrompt.length} chars`);

      const startTime = Date.now();

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Claude API timeout (60s)')), 60000);
      });

      const apiPromise = this.client.messages.create({
        model: this.model,
        max_tokens: 3500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });

      const response = await Promise.race([apiPromise, timeoutPromise]);

      const duration = Date.now() - startTime;
      console.log(`✅ Claude respondió en ${duration}ms`);
      console.log(`   Input tokens: ${response.usage?.input_tokens || 'N/A'}`);
      console.log(`   Output tokens: ${response.usage?.output_tokens || 'N/A'}`);

      const content = response.content[0]?.text;

      if (!content) {
        console.error('❌ Claude devolvió respuesta vacía');
        return this.getSmsFallbackInsights(metricsData);
      }

      const analysis = this.parseResponse(content);

      if (!analysis || analysis.parseError) {
        console.error('❌ Error parseando respuesta de Claude, usando fallback');
        return this.getSmsFallbackInsights(metricsData);
      }

      console.log(`✅ Análisis SMS parseado correctamente`);
      console.log(`   - Executive summary: ${analysis.executiveSummary ? 'Sí' : 'No'}`);
      console.log(`   - Action plan items: ${analysis.actionPlan?.length || 0}`);
      console.log(`   - Quick wins: ${analysis.quickWins?.length || 0}`);

      return {
        success: true,
        ...analysis,
        generatedAt: new Date().toISOString(),
        model: this.model,
        tokensUsed: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0
        },
        duration,
        hasBusinessContext: !!businessContextPrompt,
        analysisType: 'sms'
      };

    } catch (error) {
      console.error('❌ Error llamando a Claude API:', error.message);
      return this.getSmsFallbackInsights(metricsData);
    }
  }

  /**
   * System prompt para análisis de SMS Marketing
   */
  buildSmsSystemPrompt() {
    return `Eres el consultor de SMS marketing de Jersey Pickles, un e-commerce de pickles artesanales y olives gourmet en New Jersey.

TU ROL: Analizar datos de SMS marketing y dar recomendaciones ESPECÍFICAS y ACCIONABLES.

CONTEXTO DEL NEGOCIO:
- Productos: Pickles artesanales, olives marinadas, productos gourmet, gift sets
- Estrategia SMS: Welcome SMS (15% OFF) → Second Chance SMS (20% OFF, 6-8h después)
- El Second Chance SMS es CRÍTICO para recuperar clientes que no convierten inicialmente
- Ticket promedio: $35-50 por orden
- Estacionalidad: Picos en BBQ season (Mayo-Sept) y holidays (Nov-Dic)

BENCHMARKS SMS MARKETING:
- Delivery Rate bueno: >95%
- Conversion Rate bueno (15% OFF): 8-15%
- Second Chance Recovery Rate bueno: 15-25%
- Unsubscribe Rate saludable: <3%
- Time to Convert óptimo: <2 horas

MÉTRICAS CLAVE A ANALIZAR:
1. Funnel de conversión: Suscripción → Welcome SMS → Conversión 15% → Second Chance → Conversión 20%
2. ROI del Second Chance (cada $ en SMS cuánto genera)
3. Oportunidades perdidas (elegibles que no recibieron Second Chance)
4. Timing óptimo para envíos

INSTRUCCIONES:
1. Responde SOLO con JSON válido (sin markdown, sin \`\`\`)
2. Todo en ESPAÑOL
3. Sé específico - menciona datos reales del input
4. Prioriza acciones por impacto en revenue

FORMATO JSON REQUERIDO:
{
  "executiveSummary": "2-3 oraciones con el estado general del SMS marketing y la acción más importante",
  "deepAnalysis": {
    "health": {
      "status": "healthy o warning o critical",
      "analysis": "Análisis de métricas de salud (delivery, conversion, unsubs)"
    },
    "funnel": {
      "analysis": "Análisis del funnel de conversión completo"
    },
    "secondChance": {
      "analysis": "Análisis específico del Second Chance SMS y su efectividad"
    },
    "timing": {
      "analysis": "Análisis de timing y ventanas de conversión"
    },
    "revenue": {
      "analysis": "Análisis de revenue y ROI del SMS marketing"
    }
  },
  "actionPlan": [
    {
      "priority": 1,
      "title": "Título corto",
      "what": "Qué hacer específicamente",
      "why": "Por qué importa basado en los datos",
      "how": "Pasos concretos",
      "expectedImpact": "Resultado esperado en $ o % si es posible"
    }
  ],
  "quickWins": ["Acción rápida 1", "Acción rápida 2", "Acción rápida 3"],
  "warnings": [
    {
      "severity": "critical o warning",
      "issue": "Problema detectado",
      "consequence": "Qué pasa si no se arregla",
      "solution": "Cómo arreglarlo"
    }
  ],
  "opportunities": [
    {
      "opportunity": "Oportunidad identificada",
      "potential": "Impacto potencial en $ o conversiones",
      "effort": "low o medium o high"
    }
  ],
  "secondChanceStrategy": {
    "currentPerformance": "Resumen del performance actual",
    "optimizations": ["Optimización 1", "Optimización 2"],
    "idealTiming": "Recomendación de timing",
    "copyRecommendations": ["Sugerencia de copy 1", "Sugerencia 2"]
  },
  "smsTemplateRecommendations": {
    "welcomeSms": {
      "currentEffectiveness": "Bueno/Regular/Malo basado en conversión",
      "suggestions": ["Mejora 1", "Mejora 2"]
    },
    "secondChanceSms": {
      "currentEffectiveness": "Bueno/Regular/Malo basado en recovery",
      "suggestions": ["Mejora 1", "Mejora 2"]
    }
  },
  "revenueGoalStrategy": {
    "currentStatus": "Resumen del revenue actual",
    "projectedMonthly": "Proyección basada en tendencias",
    "recommendedActions": ["Acción 1", "Acción 2"],
    "riskLevel": "low o medium o high"
  }
}`;
  }

  /**
   * User prompt con datos de SMS
   */
  buildSmsUserPrompt(data, businessContextPrompt = '') {
    const seasonalContext = data.seasonalContext ? `
═══════════════════════════════════════════════════════════
🗓️ CONTEXTO TEMPORAL
═══════════════════════════════════════════════════════════
Evento/Temporada actual: ${data.seasonalContext.event || 'Normal'}
Tipo: ${data.seasonalContext.type || 'standard'}
` : '';

    return `Analiza estos datos de SMS marketing de Jersey Pickles de los ÚLTIMOS 30 DÍAS:
${seasonalContext}
═══════════════════════════════════════════════════════════
📊 MÉTRICAS DE SALUD
═══════════════════════════════════════════════════════════
• Health Score: ${data.health?.score || 0}/100
• Delivery Rate: ${data.health?.deliveryRate || 0}%
• Conversion Rate: ${data.health?.conversionRate || 0}%
• Unsubscribe Rate: ${data.health?.unsubRate || 0}%
• Total Suscriptores: ${data.health?.totalSubscribers || 0}
• Total Convertidos: ${data.health?.totalConverted || 0}
• Revenue Total: $${data.health?.totalRevenue || 0}

═══════════════════════════════════════════════════════════
📱 FUNNEL DE CONVERSIÓN
═══════════════════════════════════════════════════════════
Overall Conversion Rate: ${data.funnel?.overallConversionRate || '0%'}

FIRST SMS (15% OFF):
• Conversiones: ${data.funnel?.firstConversions || 0}
• Revenue: $${data.funnel?.firstRevenue || 0}

SECOND CHANCE SMS (20% OFF):
• Conversiones: ${data.funnel?.secondConversions || 0}
• Revenue: $${data.funnel?.secondRevenue || 0}
• Recovery Rate: ${data.funnel?.secondRecoveryRate || '0%'}

═══════════════════════════════════════════════════════════
🔄 SECOND CHANCE SMS (DETALLE)
═══════════════════════════════════════════════════════════
• Enviados: ${data.secondChance?.sent || 0}
• Entregados: ${data.secondChance?.delivered || 0}
• Convertidos: ${data.secondChance?.converted || 0}
• Revenue: $${data.secondChance?.revenue || 0}
• Conversion Rate: ${data.secondChance?.conversionRate || '0%'}
• ROI: ${data.secondChance?.roi || '0%'}
• Mejor hora de envío: ${data.secondChance?.bestHour || 'N/A'}

⚠️ OPORTUNIDAD PERDIDA:
• Elegibles que NO recibieron Second Chance: ${data.secondChance?.eligibleNotSent || 0}
• Revenue potencial perdido: $${data.secondChance?.potentialRevenue || 0}

═══════════════════════════════════════════════════════════
⏱️ TIEMPO HASTA CONVERSIÓN
═══════════════════════════════════════════════════════════
• Tiempo promedio: ${data.timing?.avgTimeToConvert || 'N/A'}
• Conversión más rápida: ${data.timing?.fastestConversion || 'N/A'}

Distribución:
${data.timing?.distribution?.map(d => `   ${d.range}: ${d.count} conversiones ($${d.revenue || 0})`).join('\n') || '   Sin datos'}

═══════════════════════════════════════════════════════════
📢 CAMPAÑAS SMS
═══════════════════════════════════════════════════════════
• Total campañas: ${data.campaigns?.total || 0}
• Conversion Rate promedio: ${data.campaigns?.avgConversionRate || '0%'}
• Revenue total: $${data.campaigns?.totalRevenue || 0}
${data.campaigns?.topCampaign ? `• Top campaña: "${data.campaigns.topCampaign.name}" ($${data.campaigns.topCampaign.revenue})` : ''}

═══════════════════════════════════════════════════════════
🚨 ALERTAS ACTIVAS
═══════════════════════════════════════════════════════════
${data.alerts?.length > 0 ? data.alerts.map(a =>
  `[${a.severity?.toUpperCase()}] ${a.message}`
).join('\n') : '✅ Sin alertas activas'}

${businessContextPrompt}

═══════════════════════════════════════════════════════════
📝 TU TAREA
═══════════════════════════════════════════════════════════

Basándote en TODOS los datos anteriores, proporciona:

1. RESUMEN EJECUTIVO (2-3 oraciones)
   - Estado general del SMS marketing
   - Oportunidad o problema principal

2. ANÁLISIS PROFUNDO
   - Health: Estado de métricas clave
   - Funnel: Dónde se pierden conversiones
   - Second Chance: Efectividad de la recuperación
   - Timing: Ventanas de conversión
   - Revenue: ROI y tendencias

3. PLAN DE ACCIÓN (3-4 acciones priorizadas)
   - Enfócate en maximizar conversiones y revenue
   - Si hay elegibles sin Second Chance, eso es CRÍTICO

4. ESTRATEGIA SECOND CHANCE
   - Cómo optimizar esta funcionalidad clave
   - Timing ideal
   - Ideas de copy

5. RECOMENDACIONES DE TEMPLATES SMS
   - Welcome SMS: qué mejorar
   - Second Chance SMS: qué mejorar

6. ALERTAS Y OPORTUNIDADES
   - Problemas urgentes
   - Revenue que se está dejando en la mesa

IMPORTANTE:
- Sé ESPECÍFICO con números y recomendaciones
- Si hay elegibles sin Second Chance, es la oportunidad #1
- Considera la temporada actual para timing
- El ROI del Second Chance es clave para justificar la inversión`;
  }

  /**
   * Fallback cuando Claude no está disponible (SMS version)
   */
  getSmsFallbackInsights(data) {
    const actionPlan = [];
    const warnings = [];
    const quickWins = [];
    const opportunities = [];

    let healthAnalysis = 'Sin datos suficientes para análisis de salud.';
    let healthStatus = 'unknown';

    if (data.health) {
      const h = data.health;
      const score = h.score || 0;
      healthStatus = score >= 80 ? 'healthy' : score >= 60 ? 'warning' : 'critical';

      healthAnalysis = `Tu SMS marketing tiene un health score de ${score}/100. `;

      const convRate = parseFloat(h.conversionRate) || 0;
      if (convRate >= 10) {
        healthAnalysis += `El conversion rate de ${convRate}% es excelente para SMS. `;
      } else if (convRate >= 5) {
        healthAnalysis += `El conversion rate de ${convRate}% es aceptable pero hay espacio para mejorar. `;
      } else {
        healthAnalysis += `El conversion rate de ${convRate}% está bajo - revisa el copy y el descuento. `;
      }
    }

    // Second Chance opportunities
    if (data.secondChance?.eligibleNotSent > 0) {
      const eligible = data.secondChance.eligibleNotSent;
      const potential = data.secondChance.potentialRevenue || 0;

      warnings.push({
        severity: 'critical',
        issue: `${eligible} suscriptores elegibles NO han recibido Second Chance SMS`,
        consequence: `Estás perdiendo aproximadamente $${potential} en revenue potencial`,
        solution: 'Verifica que el job de Second Chance esté corriendo correctamente'
      });

      actionPlan.push({
        priority: 1,
        title: 'Activar Second Chance para elegibles',
        what: `Enviar Second Chance SMS a los ${eligible} suscriptores elegibles`,
        why: `Revenue potencial de $${potential} que se está perdiendo`,
        how: '1. Verificar el cron job. 2. Revisar logs de errores. 3. Trigger manual si es necesario.',
        expectedImpact: `Recuperar ~$${potential} en revenue`
      });
    }

    // Conversion rate insights
    const convRate = parseFloat(data.health?.conversionRate) || 0;
    if (convRate < 8) {
      quickWins.push('Prueba aumentar el descuento inicial de 15% a 20% por una semana');
      quickWins.push('Añade urgencia al mensaje: "Válido solo hoy" o "Próximas 2 horas"');
    }

    // ROI insight
    const roi = parseFloat(data.secondChance?.roi) || 0;
    if (roi > 500) {
      opportunities.push({
        opportunity: `Second Chance tiene ROI de ${roi}%`,
        potential: 'Muy rentable - considera enviar más agresivamente',
        effort: 'low'
      });
    }

    // Executive summary
    let executiveSummary = '';
    if (healthStatus === 'healthy') {
      executiveSummary = 'Tu SMS marketing está funcionando bien. ';
    } else if (healthStatus === 'warning') {
      executiveSummary = 'Tu SMS marketing necesita atención en algunas áreas. ';
    } else {
      executiveSummary = '⚠️ Tu SMS marketing tiene problemas que requieren acción inmediata. ';
    }

    if (actionPlan.length > 0) {
      executiveSummary += `Prioridad #1: ${actionPlan[0].title}. `;
    }

    const totalRevenue = data.health?.totalRevenue || 0;
    if (totalRevenue > 0) {
      executiveSummary += `Has generado $${totalRevenue} en revenue via SMS.`;
    }

    return {
      success: true,
      executiveSummary,
      deepAnalysis: {
        health: { status: healthStatus, analysis: healthAnalysis },
        funnel: { analysis: 'Revisa el funnel de conversión para identificar puntos de fuga.' },
        secondChance: {
          analysis: data.secondChance?.conversionRate
            ? `Second Chance convierte al ${data.secondChance.conversionRate} de los destinatarios.`
            : 'Sin datos suficientes de Second Chance.'
        },
        timing: {
          analysis: data.timing?.avgTimeToConvert
            ? `El tiempo promedio hasta conversión es ${data.timing.avgTimeToConvert}.`
            : 'Sin datos de timing disponibles.'
        },
        revenue: {
          analysis: `Revenue total: $${data.health?.totalRevenue || 0}. ${roi > 0 ? `ROI de Second Chance: ${roi}%` : ''}`
        }
      },
      actionPlan,
      quickWins: quickWins.length > 0 ? quickWins : ['Revisa el copy de tus SMS', 'Optimiza el timing de envío'],
      warnings,
      opportunities,
      secondChanceStrategy: {
        currentPerformance: data.secondChance?.conversionRate
          ? `Recovery rate: ${data.secondChance.conversionRate}`
          : 'Sin datos',
        optimizations: ['Ajustar timing a 6 horas', 'Probar diferentes copies'],
        idealTiming: data.secondChance?.bestHour || '9:00-11:00 AM',
        copyRecommendations: [
          'Usa urgencia: "Solo 2 horas para usar tu 20% OFF"',
          'Personaliza con el producto más popular'
        ]
      },
      smsTemplateRecommendations: {
        welcomeSms: {
          currentEffectiveness: convRate >= 10 ? 'Bueno' : convRate >= 5 ? 'Regular' : 'Malo',
          suggestions: ['Incluye el nombre del producto más vendido', 'Añade un emoji relevante 🥒']
        },
        secondChanceSms: {
          currentEffectiveness: parseFloat(data.secondChance?.conversionRate) >= 15 ? 'Bueno' : 'Regular',
          suggestions: ['Enfatiza que es la ÚLTIMA oportunidad', 'Menciona que el descuento expira en 2 horas']
        }
      },
      revenueGoalStrategy: null,
      generatedAt: new Date().toISOString(),
      model: 'fallback-analysis',
      tokensUsed: { input: 0, output: 0 },
      isFallback: true,
      hasBusinessContext: false,
      analysisType: 'sms'
    };
  }

  // ==================== IA BUSINESS - DAILY REPORT ====================

  /**
   * Generar reporte diario de negocio basado en snapshot
   */
  async generateDailyBusinessReport(snapshot) {
    if (!this.isAvailable()) {
      console.log('Claude API not available, using fallback business report');
      return this.getBusinessReportFallback(snapshot);
    }

    const systemPrompt = this.buildBusinessSystemPrompt();
    const userPrompt = this.buildBusinessUserPrompt(snapshot);

    try {
      console.log('Generating daily business report with Claude...');

      const startTime = Date.now();

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Claude API timeout (90s)')), 90000);
      });

      const apiPromise = this.client.messages.create({
        model: this.model,
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });

      const response = await Promise.race([apiPromise, timeoutPromise]);
      const duration = Date.now() - startTime;

      console.log(`Claude business report generated in ${duration}ms`);

      const content = response.content[0]?.text;
      if (!content) {
        return this.getBusinessReportFallback(snapshot);
      }

      const analysis = this.parseResponse(content);
      if (!analysis || analysis.parseError) {
        return this.getBusinessReportFallback(snapshot);
      }

      return {
        success: true,
        ...analysis,
        generatedAt: new Date().toISOString(),
        model: this.model,
        tokensUsed: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0
        },
        duration,
        snapshotSources: snapshot.sources,
        analysisType: 'business_daily'
      };

    } catch (error) {
      console.error('Error generating business report:', error.message);
      return this.getBusinessReportFallback(snapshot);
    }
  }

  /**
   * System prompt para IA Business
   */
  buildBusinessSystemPrompt() {
    return `Eres el analista de negocio de Jersey Pickles, una tienda online de pickles artesanales y olives gourmet en New Jersey, USA.

TU ROL: Analizar datos REALES del negocio y dar un reporte diario con recomendaciones accionables.

CONTEXTO DEL NEGOCIO:
- E-commerce D2C de productos gourmet (pickles, olives, gift sets)
- Canal principal de marketing: SMS (welcome 15% OFF, second chance 20% OFF)
- El negocio NUNCA se queda sin stock - suministro continuo
- Producto estrella: Build-your-Box (cajas personalizadas)
- Ticket promedio: $65-70 por orden
- Clientes en todo USA, concentrados en Texas, Florida, Pennsylvania, California

REGLAS IMPORTANTES:
- NUNCA menciones stock, inventario agotado, o problemas de suministro
- Enfocate en: crecimiento de revenue, optimizacion del funnel SMS, adquisicion de clientes, rendimiento de descuentos
- Se ESPECIFICO con numeros reales del snapshot
- Todo en ESPANOL
- Responde SOLO con JSON valido (sin markdown, sin backticks)

FORMATO JSON REQUERIDO:
{
  "dailySummary": "3-4 oraciones resumiendo el estado del negocio hoy, comparando con periodos anteriores",
  "kpis": {
    "revenueToday": "Analisis del revenue de hoy vs tendencia",
    "ordersToday": "Analisis de pedidos",
    "smsPerformance": "Estado del canal SMS",
    "customerAcquisition": "Nuevos clientes y fuentes"
  },
  "recommendations": [
    {
      "priority": 1,
      "title": "Titulo corto",
      "description": "Que hacer y por que, con datos de soporte",
      "impact": "high o medium o low",
      "category": "revenue o sms o customers o campaigns"
    }
  ],
  "smsFunnel": {
    "analysis": "Analisis del funnel completo con numeros",
    "bottleneck": "Donde se pierden mas conversiones",
    "optimization": "Que optimizar primero"
  },
  "trends": {
    "positive": ["Tendencia positiva 1", "Tendencia positiva 2"],
    "concerning": ["Tendencia preocupante 1"],
    "opportunities": ["Oportunidad 1", "Oportunidad 2"]
  },
  "topProductsAnalysis": "Analisis de los productos mas vendidos y que significan para el negocio",
  "nextActions": [
    "Accion concreta 1 para hoy/esta semana",
    "Accion concreta 2",
    "Accion concreta 3"
  ]
}`;
  }

  /**
   * User prompt con datos del snapshot
   */
  buildBusinessUserPrompt(snapshot) {
    const biz = snapshot.business;
    const sms = snapshot.sms;
    const products = snapshot.products;
    const customers = snapshot.customers;

    let shopifySection = '';
    if (biz.shopifyRealtime) {
      const sr = biz.shopifyRealtime;
      shopifySection = `
DATOS SHOPIFY EN VIVO:
- Pedidos recientes (24h): ${sr.recentOrders?.count || 0} pedidos, $${sr.recentOrders?.revenue || 0} revenue
- Pedidos sin enviar: ${sr.unfulfilled?.count || 0} pendientes
${sr.recentOrders?.topProducts?.length > 0 ? `- Top productos hoy: ${sr.recentOrders.topProducts.map(p => `${p.name} ($${Math.round(p.revenue)})`).join(', ')}` : ''}
`;
    }

    let smsSection = '';
    if (sms) {
      smsSection = `
CANAL SMS:
- Suscriptores: ${sms.subscribers?.total || 0} total, ${sms.subscribers?.active || 0} activos
- Convertidos: ${sms.subscribers?.converted || 0} (${sms.subscribers?.conversionRate || 0}%)
- Revenue SMS total: $${sms.subscribers?.totalRevenue || 0}
- Revenue promedio por conversion: $${sms.subscribers?.avgRevenuePerConversion || 0}

FUNNEL SMS (ultimos 30 dias):
- Welcome SMS enviados: ${sms.funnel?.welcomeSent || 0}
- Convertidos desde Welcome: ${sms.funnel?.welcomeConverted || 0} (${sms.funnel?.welcomeRate || 0}%)
- Second Chance enviados: ${sms.funnel?.secondChanceSent || 0}
- Convertidos desde Second Chance: ${sms.funnel?.secondChanceConverted || 0} (${sms.funnel?.secondChanceRate || 0}%)

CAMPANAS SMS:
${sms.campaigns?.campaigns?.length > 0
  ? sms.campaigns.campaigns.map(c => `- "${c.name}": ${c.sent} enviados, ${c.converted} convertidos, $${c.revenue} revenue`).join('\n')
  : '- Sin campanas recientes'}

BAJAS SMS:
- Total desuscritos: ${sms.unsubscribes?.total || 0}
- Recientes (30d): ${sms.unsubscribes?.recentUnsubscribes || 0}
- Tasa de baja: ${sms.unsubscribes?.rate || 0}%

TOP ESTADOS:
${sms.topStates?.slice(0, 5).map(s => `- ${s.state}: ${s.subscribers} suscriptores, ${s.converted} convertidos (${s.conversionRate}%)`).join('\n') || '- Sin datos'}
`;
    }

    return `Analiza estos datos REALES de Jersey Pickles:

METRICAS DE NEGOCIO:
- HOY: ${biz.today?.orders || 0} pedidos, $${biz.today?.revenue || 0} revenue, ticket promedio $${biz.today?.avgTicket || 0}
- ULTIMOS 7 DIAS: ${biz.last7d?.orders || 0} pedidos, $${biz.last7d?.revenue || 0} revenue, ticket promedio $${biz.last7d?.avgTicket || 0}
- ULTIMOS 30 DIAS: ${biz.last30d?.orders || 0} pedidos, $${biz.last30d?.revenue || 0} revenue, ticket promedio $${biz.last30d?.avgTicket || 0}
${shopifySection}
${smsSection}
TOP PRODUCTOS (30 dias):
${products?.topSelling?.slice(0, 8).map((p, i) => `${i + 1}. ${p.name}: $${p.revenue} revenue, ${p.unitsSold} unidades, ${p.orders} pedidos`).join('\n') || 'Sin datos'}

USO DE DESCUENTOS:
- Welcome (JP codes): ${products?.discountUsage?.welcome || 0} usados
- Second Chance (SC codes): ${products?.discountUsage?.secondChance || 0} usados
- Dinamicos (JPC codes): ${products?.discountUsage?.dynamic || 0} usados
- Otros: ${products?.discountUsage?.other || 0}
- Total redimidos: ${products?.discountUsage?.totalRedeemed || 0}

CLIENTES:
- Total: ${customers?.total || 0}
- Nuevos hoy: ${customers?.newToday || 0}
- Nuevos este mes: ${customers?.newThisMonth || 0}
- Clientes via SMS: ${customers?.fromSms || 0}

Genera tu reporte diario de IA Business con recomendaciones accionables.`;
  }

  /**
   * Fallback para business report
   */
  getBusinessReportFallback(snapshot) {
    const biz = snapshot.business;
    const sms = snapshot.sms;

    const todayRevenue = biz?.today?.revenue || 0;
    const last30dRevenue = biz?.last30d?.revenue || 0;
    const dailyAvg = last30dRevenue / 30;

    let summaryText = `Hoy el negocio ha generado $${todayRevenue} en revenue. `;
    if (dailyAvg > 0) {
      const pct = Math.round((todayRevenue / dailyAvg) * 100);
      summaryText += `Esto representa ${pct}% del promedio diario de $${Math.round(dailyAvg)}. `;
    }
    if (sms?.subscribers?.conversionRate) {
      summaryText += `El canal SMS mantiene una tasa de conversion de ${sms.subscribers.conversionRate}%.`;
    }

    const recommendations = [];

    if (sms?.funnel?.secondChanceRate < 5) {
      recommendations.push({
        priority: 1,
        title: 'Optimizar Second Chance SMS',
        description: `La tasa de conversion del Second Chance es ${sms.funnel.secondChanceRate}%. Considera ajustar el timing o el copy del mensaje.`,
        impact: 'high',
        category: 'sms'
      });
    }

    if (sms?.unsubscribes?.rate > 5) {
      recommendations.push({
        priority: 2,
        title: 'Revisar tasa de bajas',
        description: `La tasa de bajas es ${sms.unsubscribes.rate}%, por encima del 3% recomendado.`,
        impact: 'high',
        category: 'sms'
      });
    }

    recommendations.push({
      priority: recommendations.length + 1,
      title: 'Considerar campana SMS',
      description: 'Evalua lanzar una campana SMS segmentada para los estados con mayor conversion.',
      impact: 'medium',
      category: 'campaigns'
    });

    return {
      success: true,
      dailySummary: summaryText,
      kpis: {
        revenueToday: `$${todayRevenue} en revenue hoy`,
        ordersToday: `${biz?.today?.orders || 0} pedidos hoy`,
        smsPerformance: `${sms?.subscribers?.conversionRate || 0}% tasa de conversion SMS`,
        customerAcquisition: `${snapshot.customers?.newToday || 0} clientes nuevos hoy`
      },
      recommendations,
      smsFunnel: {
        analysis: 'Analisis basico - Claude AI no disponible para analisis profundo.',
        bottleneck: 'Requiere Claude AI para identificar cuellos de botella.',
        optimization: 'Revisar timing del Second Chance SMS.'
      },
      trends: {
        positive: ['Revenue activo'],
        concerning: [],
        opportunities: ['Expandir campanas SMS a estados con alta conversion']
      },
      topProductsAnalysis: 'Analisis basico - requiere Claude AI para insights profundos.',
      nextActions: [
        'Revisar metricas del funnel SMS',
        'Evaluar campana para top estados',
        'Monitorear tasa de bajas'
      ],
      generatedAt: new Date().toISOString(),
      model: 'fallback-analysis',
      tokensUsed: { input: 0, output: 0 },
      isFallback: true,
      analysisType: 'business_daily'
    };
  }

  // ==================== SMS MESSAGE SUGGESTIONS ====================

  /**
   * Generar sugerencias de mensajes SMS optimizados
   * POST /api/ai/subjects/suggest
   */
  async suggestSmsMessages(context) {
    const { baseMessage, campaignType, audienceType, objective, historicalData } = context;

    // Fallback si Claude no está disponible
    if (!this.isAvailable()) {
      return this.getSmsSuggestionsFallback(baseMessage, campaignType);
    }

    const prompt = `Genera 5 variaciones optimizadas de un mensaje SMS para Jersey Pickles (pickles y olives gourmet de New Jersey).

MENSAJE BASE: "${baseMessage || 'Mensaje promocional de descuento'}"

CONTEXTO:
- Tipo de campaña: ${campaignType || 'promocional'}
- Audiencia: ${audienceType || 'todos los suscriptores'}
- Objetivo: ${objective || 'conversión'}
${historicalData ? `
DATOS HISTÓRICOS:
- Click rate promedio: ${historicalData.avgClickRate || 'N/A'}%
- Mejor horario: ${historicalData.bestHour || 'N/A'}
- Mensajes con emoji funcionan: ${historicalData.emojiPerformance || 'N/A'}
` : ''}

REGLAS PARA SMS:
1. Máximo 160 caracteres para evitar segmentación
2. Incluir call-to-action claro
3. Urgencia aumenta conversión
4. Emojis relevantes (🥒🫒) aumentan engagement
5. Personalización con nombre si es posible
6. Incluir el descuento/oferta claramente

Responde SOLO con JSON válido:
{
  "suggestions": [
    {
      "message": "El mensaje SMS completo (máx 160 chars)",
      "score": 85,
      "reason": "Por qué funcionaría bien",
      "techniques": ["urgencia", "emoji", "descuento"],
      "charCount": 145,
      "estimatedClickRate": "8-12%"
    }
  ],
  "bestPractices": ["Consejo 1", "Consejo 2"],
  "avoidList": ["Qué evitar 1", "Qué evitar 2"]
}`;

    try {
      console.log('🧠 Generando sugerencias de SMS con Claude...');

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      });

      const content = response.content[0]?.text;
      const parsed = this.parseResponse(content);

      return {
        success: true,
        ...parsed,
        generatedAt: new Date().toISOString(),
        model: this.model,
        tokensUsed: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0
        }
      };

    } catch (error) {
      console.error('Error generando sugerencias SMS:', error.message);
      return this.getSmsSuggestionsFallback(baseMessage, campaignType);
    }
  }

  /**
   * Fallback para sugerencias de SMS
   */
  getSmsSuggestionsFallback(baseMessage, campaignType) {
    const suggestions = [
      {
        message: `🥒 ${baseMessage || '15% OFF'} en Jersey Pickles! Usa código SMS15. Solo hoy → jerseypickles.com`,
        score: 82,
        reason: 'Emoji + urgencia + código claro + CTA',
        techniques: ['emoji', 'urgencia', 'descuento', 'cta'],
        charCount: 85,
        estimatedClickRate: '6-9%'
      },
      {
        message: `Tu descuento exclusivo: ${baseMessage || '15% OFF'}! 🫒 Expira en 2h. No te lo pierdas → jerseypickles.com`,
        score: 80,
        reason: 'Exclusividad + emoji + tiempo limitado',
        techniques: ['exclusividad', 'emoji', 'urgencia'],
        charCount: 98,
        estimatedClickRate: '5-8%'
      },
      {
        message: `Hey! ${baseMessage || '15% OFF'} en pickles artesanales 🥒 Solo para ti. Código: SMS15 → jerseypickles.com`,
        score: 78,
        reason: 'Tono casual + personalización + emoji',
        techniques: ['personalización', 'emoji', 'descuento'],
        charCount: 95,
        estimatedClickRate: '5-7%'
      },
      {
        message: `ÚLTIMA OPORTUNIDAD: ${baseMessage || '15% OFF'} termina HOY 🥒 Usa SMS15 → jerseypickles.com`,
        score: 85,
        reason: 'Urgencia máxima + mayúsculas para atención',
        techniques: ['urgencia', 'escasez', 'emoji'],
        charCount: 82,
        estimatedClickRate: '7-10%'
      },
      {
        message: `Jersey Pickles: ${baseMessage || '15% OFF'} en tu próxima orden! 🫒 Código SMS15. Shop now!`,
        score: 75,
        reason: 'Directo y claro + marca visible',
        techniques: ['branding', 'emoji', 'descuento'],
        charCount: 78,
        estimatedClickRate: '4-6%'
      }
    ];

    return {
      success: true,
      suggestions: suggestions.sort((a, b) => b.score - a.score),
      bestPractices: [
        'Mantén el mensaje bajo 160 caracteres',
        'Incluye siempre un CTA claro',
        'Usa emojis relevantes (🥒🫒) para destacar',
        'Añade urgencia con tiempo limitado'
      ],
      avoidList: [
        'Mensajes genéricos sin personalización',
        'Demasiados emojis (máx 2)',
        'Enlaces largos sin acortar',
        'Mayúsculas excesivas (spam)'
      ],
      generatedAt: new Date().toISOString(),
      model: 'fallback-analysis',
      isFallback: true
    };
  }

  // ==================== SMS CAMPAIGN TEMPLATE GENERATION ====================

  /**
   * Generate SMS campaign templates using AI
   * Returns 6 ready-to-use templates based on context
   */
  async generateSmsTemplates(context = {}) {
    const { discountType, discountPercent, dynamicMin, dynamicMax, audienceType, campaignGoal } = context;

    const discountInfo = discountType === 'dynamic'
      ? `Descuento DINÁMICO: cada suscriptor recibe un % aleatorio entre ${dynamicMin || 25}% y ${dynamicMax || 30}%. Usa {discount} como placeholder para el porcentaje y {code} para el código.`
      : `Descuento FIJO: ${discountPercent || 15}%. Usa {discount} para el porcentaje y {code} para el código.`;

    // Get upcoming events for seasonal context
    let upcomingContext = '';
    try {
      const BusinessCalendar = require('../models/BusinessCalendar');
      const upcoming = await BusinessCalendar.getUpcomingEvents(30);
      if (upcoming && upcoming.length > 0) {
        const eventsList = upcoming.map(e => {
          const daysUntil = Math.ceil((new Date(e.startDate) - new Date()) / (1000 * 60 * 60 * 24));
          return `${e.name} (en ${daysUntil} días)`;
        }).join(', ');
        upcomingContext = `\n- Eventos próximos: ${eventsList}. Si algún evento está a menos de 14 días, genera 1-2 plantillas temáticas para ese evento.`;
      }
    } catch (e) {
      // Calendar not available
    }

    const prompt = `Genera 6 plantillas de mensajes SMS para una campaña de Jersey Pickles (pickles artesanales y olives gourmet de New Jersey).

CONTEXTO:
- ${discountInfo}
- Audiencia: ${audienceType || 'todos los suscriptores'}
- Objetivo: ${campaignGoal || 'conversión'}${upcomingContext}
- Variables disponibles: {discount} (%), {code} (código descuento), {link} (se reemplaza auto)
- NO tenemos el nombre del suscriptor. NO uses {name} ni ninguna variable de nombre.

REGLAS:
1. Cada mensaje DEBE incluir "Reply STOP to opt-out" al final
2. Usa SOLO {discount}, {code} y {link} como variables. NUNCA {name}.
3. Tono: casual, directo, amigable (como un amigo que te recomienda algo)
4. Máximo 300 caracteres por mensaje (2 segmentos SMS)
5. Varía los estilos: urgencia, exclusividad, casual, humor, FOMO, gratitud
6. NO uses "Dear", "Hey [name]" ni lenguaje formal
7. Incluye emojis relevantes (🥒🫒✨👀🔥💚) con moderación
8. Comienza los mensajes directamente sin saludar con nombre (ej: "Fresh batch just dropped", "Your pickle craving called")

IMPORTANTE: Genera plantillas VARIADAS con diferentes enfoques:
- 1 plantilla de urgencia/escasez
- 1 plantilla casual/amigable
- 1 plantilla de exclusividad/VIP
- 1 plantilla con humor
- 1 plantilla de restock/novedades
- 1 plantilla de gratitud/loyalty
(Si hay un evento próximo a menos de 14 días, reemplaza 1-2 plantillas por versiones temáticas del evento)

Responde SOLO con JSON válido:
{
  "templates": [
    {
      "id": "unique_id",
      "name": "Nombre corto (2-3 palabras)",
      "icon": "emoji representativo",
      "category": "Categoría (Urgencia, Casual, VIP, Humor, Restock, Loyalty, Seasonal)",
      "message": "El mensaje completo con variables {discount}, {code}, {link}. SIN {name}."
    }
  ]
}`;

    if (!this.isAvailable()) {
      return this.getSmsTemplatesFallback(context);
    }

    try {
      console.log('🧠 Generando plantillas SMS con Claude...');

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      });

      const content = response.content[0]?.text;
      const parsed = this.parseResponse(content);

      if (!parsed?.templates || parsed.templates.length === 0) {
        return this.getSmsTemplatesFallback(context);
      }

      return {
        success: true,
        templates: parsed.templates,
        generatedAt: new Date().toISOString(),
        model: this.model,
        tokensUsed: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0
        }
      };

    } catch (error) {
      console.error('Error generando plantillas SMS:', error.message);
      return this.getSmsTemplatesFallback(context);
    }
  }

  /**
   * Fallback templates when Claude is unavailable
   */
  getSmsTemplatesFallback(context = {}) {
    const pct = context.discountType === 'dynamic' ? '{discount}' : (context.discountPercent || '15');

    return {
      success: true,
      templates: [
        {
          id: 'urgency_1',
          name: 'Going Fast',
          icon: '🔥',
          category: 'Urgencia',
          message: `Heads up - this batch is going FAST 🥒 ${pct}% off with code {code} before it's gone!\n\n{link}\n\nReply STOP to opt-out`
        },
        {
          id: 'casual_1',
          name: 'Quick Hey',
          icon: '👋',
          category: 'Casual',
          message: `Hey! Just restocked your favorites 🥒 Thought you'd want first dibs - here's ${pct}% off: {code}\n\n{link}\n\nReply STOP to opt-out`
        },
        {
          id: 'vip_1',
          name: 'VIP Access',
          icon: '🤫',
          category: 'VIP',
          message: `Shhh... friends & family sale 🤫 ${pct}% off, code's {code}. Don't tell everyone ;)\n\n{link}\n\nReply STOP to opt-out`
        },
        {
          id: 'humor_1',
          name: 'Pickle Craving',
          icon: '😏',
          category: 'Humor',
          message: `Your pickle craving called... we answered 🥒 ${pct}% off today with {code}. You're welcome.\n\n{link}\n\nReply STOP to opt-out`
        },
        {
          id: 'restock_1',
          name: 'Fresh Batch',
          icon: '✨',
          category: 'Restock',
          message: `Fresh batch just came out of the brine ✨ Grab ${pct}% off with {code} while it's fresh!\n\n{link}\n\nReply STOP to opt-out`
        },
        {
          id: 'loyalty_1',
          name: 'Thank You',
          icon: '💚',
          category: 'Loyalty',
          message: `Just wanted to say thanks for being part of the pickle fam 💚 Here's ${pct}% off as a little thank you: {code}\n\n{link}\n\nReply STOP to opt-out`
        }
      ],
      generatedAt: new Date().toISOString(),
      model: 'fallback-templates',
      isFallback: true
    };
  }

  /**
   * Predecir performance de campaña SMS con Claude
   * POST /api/ai/campaigns/predict
   */
  async predictCampaignPerformance(campaignData, historicalStats) {
    if (!this.isAvailable()) {
      return null; // El caller usará cálculo basado en reglas
    }

    const prompt = `Analiza este mensaje SMS y predice su performance basándote en datos históricos.

MENSAJE A ANALIZAR:
"${campaignData.message}"

CARACTERÍSTICAS:
- Longitud: ${campaignData.message?.length || 0} caracteres
- Tiene emoji: ${/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/u.test(campaignData.message) ? 'Sí' : 'No'}
- Tiene descuento: ${/\d+%|off|descuento/i.test(campaignData.message) ? 'Sí' : 'No'}
- Tiene urgencia: ${/hoy|ahora|última|expira|limitado/i.test(campaignData.message) ? 'Sí' : 'No'}

AUDIENCIA: ${campaignData.audienceType || 'all_delivered'}
TAMAÑO ESTIMADO: ${campaignData.estimatedAudience || 'N/A'} suscriptores

DATOS HISTÓRICOS:
- Delivery rate promedio: ${historicalStats?.avgDeliveryRate || 95}%
- Click rate promedio: ${historicalStats?.avgClickRate || 5}%
- Conversion rate promedio: ${historicalStats?.avgConversionRate || 8}%
- Mejor campaña: ${historicalStats?.topCampaign?.name || 'N/A'} (${historicalStats?.topCampaign?.conversionRate || 'N/A'}%)

Responde SOLO con JSON válido:
{
  "prediction": {
    "deliveryRate": { "min": 93, "max": 97, "expected": 95 },
    "clickRate": { "min": 4, "max": 8, "expected": 6 },
    "conversionRate": { "min": 6, "max": 12, "expected": 9 },
    "estimatedRevenue": { "min": 500, "max": 1200, "expected": 800 }
  },
  "messageScore": 82,
  "strengths": ["Punto fuerte 1", "Punto fuerte 2"],
  "weaknesses": ["Área de mejora 1"],
  "recommendations": ["Sugerencia para mejorar 1", "Sugerencia 2"],
  "comparisonToAverage": "above_average o average o below_average",
  "confidence": "high o medium o low"
}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      });

      const content = response.content[0]?.text;
      return this.parseResponse(content);

    } catch (error) {
      console.error('Error prediciendo campaign:', error.message);
      return null;
    }
  }

  // ==================== EMAIL MARKETING INSIGHTS (LEGACY) ====================

  /**
   * Generar análisis profundo de email marketing
   * @deprecated Usar generateSmsInsights en su lugar
   */
  async generateEmailInsights(metricsData) {
    if (!this.isAvailable()) {
      console.log('⚠️  Claude API no disponible, usando insights básicos');
      return this.getFallbackInsights(metricsData);
    }

    // 🆕 Obtener contexto de negocio (productos, goals, promociones)
    let businessContext = null;
    let businessContextPrompt = '';
    
    if (businessContextService) {
      try {
        console.log('📦 Obteniendo contexto de negocio para Claude...');
        businessContext = await businessContextService.getFullBusinessContext();
        businessContextPrompt = businessContextService.formatBusinessContextForPrompt(businessContext);
        console.log('✅ Contexto de negocio obtenido');
      } catch (error) {
        console.log('⚠️  Error obteniendo contexto de negocio:', error.message);
      }
    }

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(metricsData, businessContextPrompt);

    try {
      console.log('🧠 Llamando a Claude API para análisis profundo...');
      console.log(`   Model: ${this.model}`);
      console.log(`   System prompt length: ${systemPrompt.length} chars`);
      console.log(`   User prompt length: ${userPrompt.length} chars`);
      console.log(`   Business context: ${businessContextPrompt ? 'Incluido' : 'No disponible'}`);
      
      const startTime = Date.now();

      // Agregar timeout de 60 segundos
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Claude API timeout (60s)')), 60000);
      });

      const apiPromise = this.client.messages.create({
        model: this.model,
        max_tokens: 3500, // 🆕 Aumentado para incluir análisis de productos
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });

      const response = await Promise.race([apiPromise, timeoutPromise]);

      const duration = Date.now() - startTime;
      console.log(`✅ Claude respondió en ${duration}ms`);
      console.log(`   Input tokens: ${response.usage?.input_tokens || 'N/A'}`);
      console.log(`   Output tokens: ${response.usage?.output_tokens || 'N/A'}`);

      const content = response.content[0]?.text;
      
      if (!content) {
        console.error('❌ Claude devolvió respuesta vacía');
        return this.getFallbackInsights(metricsData);
      }

      console.log(`   Response length: ${content.length} chars`);
      console.log(`   Response preview: ${content.substring(0, 100)}...`);

      const analysis = this.parseResponse(content);
      
      if (!analysis || analysis.parseError) {
        console.error('❌ Error parseando respuesta de Claude, usando fallback');
        return this.getFallbackInsights(metricsData);
      }

      console.log(`✅ Análisis parseado correctamente`);
      console.log(`   - Executive summary: ${analysis.executiveSummary ? 'Sí' : 'No'}`);
      console.log(`   - Deep analysis sections: ${Object.keys(analysis.deepAnalysis || {}).length}`);
      console.log(`   - Action plan items: ${analysis.actionPlan?.length || 0}`);
      console.log(`   - Quick wins: ${analysis.quickWins?.length || 0}`);
      console.log(`   - Product recommendations: ${analysis.productRecommendations ? 'Sí' : 'No'}`);

      return {
        success: true,
        ...analysis,
        generatedAt: new Date().toISOString(),
        model: this.model,
        tokensUsed: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0
        },
        duration,
        hasBusinessContext: !!businessContextPrompt
      };

    } catch (error) {
      console.error('❌ Error llamando a Claude API:', error.message);
      console.error('   Stack:', error.stack?.substring(0, 300));
      
      // Log más detalles si es un error de API
      if (error.status) {
        console.error(`   Status: ${error.status}`);
        console.error(`   Type: ${error.type || 'unknown'}`);
      }
      
      return this.getFallbackInsights(metricsData);
    }
  }

  /**
   * System prompt optimizado para análisis profundo CON PRODUCTOS
   */
  buildSystemPrompt() {
    return `Eres el consultor de email marketing de Jersey Pickles, un e-commerce de pickles artesanales y olives gourmet en New Jersey.

TU ROL: Analizar datos y dar recomendaciones ESPECÍFICAS y ACCIONABLES, no genéricas.

CONTEXTO DEL NEGOCIO:
- Productos: Pickles artesanales, olives marinadas, productos gourmet, gift sets
- Clientes: Consumidores D2C, restaurantes, delis, wholesale
- Ticket promedio: $35-50 por orden
- Estacionalidad: Picos en BBQ season (Mayo-Sept) y holidays (Nov-Dic)

BENCHMARKS INDUSTRIA FOOD & BEVERAGE:
- Open Rate bueno: 20-25%
- Click Rate bueno: 2-4%
- Bounce Rate saludable: <2%
- Unsub Rate saludable: <0.5%

🆕 IMPORTANTE - DATOS DE PRODUCTOS Y OBJETIVOS:
Cuando recibas datos de productos, inventario y objetivos de revenue:
1. MENCIONA productos específicos por nombre en tus recomendaciones
2. NO recomiendes promocionar productos AGOTADOS o con stock crítico
3. PRIORIZA productos con buen stock y alta demanda
4. AJUSTA urgencia de recomendaciones según el progreso del objetivo de revenue
5. CONSIDERA eventos próximos para timing de campañas
6. USA los datos de "qué compra cada lista" para personalizar sugerencias

INSTRUCCIONES:
1. Responde SOLO con JSON válido (sin markdown, sin \`\`\`)
2. Todo en ESPAÑOL
3. Sé específico - menciona datos reales del input, INCLUYENDO NOMBRES DE PRODUCTOS
4. Prioriza acciones por impacto en revenue

FORMATO JSON REQUERIDO:
{
  "executiveSummary": "2-3 oraciones con el estado general, mención de objetivo de revenue si existe, y la acción más importante",
  "deepAnalysis": {
    "health": {
      "status": "healthy o warning o critical",
      "analysis": "Párrafo analizando las métricas vs benchmarks"
    },
    "subjects": {
      "analysis": "Párrafo sobre qué funciona en subjects y qué evitar"
    },
    "lists": {
      "analysis": "Párrafo sobre performance de listas, QUÉ PRODUCTOS prefiere cada una"
    },
    "timing": {
      "analysis": "Párrafo sobre mejores horarios"
    },
    "revenue": {
      "analysis": "Párrafo sobre efectividad de email, progreso hacia objetivo mensual si existe"
    },
    "inventory": {
      "analysis": "Párrafo sobre estado de inventario y productos a promocionar/evitar"
    }
  },
  "actionPlan": [
    {
      "priority": 1,
      "title": "Título corto",
      "what": "Qué hacer específicamente, MENCIONANDO PRODUCTOS por nombre",
      "why": "Por qué importa basado en los datos",
      "how": "Pasos concretos",
      "expectedImpact": "Resultado esperado en $ si es posible",
      "products": ["Producto 1", "Producto 2"]
    }
  ],
  "quickWins": ["Acción rápida 1 con producto específico", "Acción rápida 2"],
  "warnings": [
    {
      "severity": "critical o warning",
      "issue": "Problema (incluir producto si aplica)",
      "consequence": "Qué pasa si no se arregla",
      "solution": "Cómo arreglarlo"
    }
  ],
  "opportunities": [
    {
      "opportunity": "Oportunidad identificada",
      "potential": "Impacto potencial en $",
      "effort": "low o medium o high",
      "products": ["Productos relacionados"]
    }
  ],
  "productRecommendations": {
    "toPromote": [
      {
        "product": "Nombre del producto",
        "reason": "Por qué promocionarlo ahora",
        "suggestedDiscount": "Sugerencia de descuento si aplica",
        "targetList": "Lista ideal para este producto"
      }
    ],
    "toAvoid": [
      {
        "product": "Nombre del producto",
        "reason": "Por qué NO promocionar (agotado, bajo stock, etc.)"
      }
    ],
    "bundles": [
      {
        "products": ["Producto 1", "Producto 2"],
        "reason": "Por qué funcionan juntos",
        "suggestedName": "Nombre sugerido para el bundle"
      }
    ]
  },
  "revenueGoalStrategy": {
    "currentStatus": "Resumen del progreso hacia el objetivo",
    "daysRemaining": 0,
    "dailyTarget": "$X necesario por día",
    "recommendedActions": ["Acción 1 para alcanzar objetivo", "Acción 2"],
    "riskLevel": "low o medium o high"
  },
  "nextCampaignSuggestion": {
    "type": "Tipo de campaña",
    "targetList": "Lista recomendada",
    "subjectIdeas": ["Idea 1 con producto", "Idea 2", "Idea 3"],
    "bestTime": "Día y hora recomendados",
    "products": ["Producto 1 a destacar", "Producto 2"],
    "rationale": "Por qué esta campaña ahora, conectando datos de email + productos + objetivo"
  }
}`;
  }

  /**
   * User prompt con datos detallados, contexto estratégico Y PRODUCTOS
   */
  buildUserPrompt(data, businessContextPrompt = '') {
    // Sección de contexto estratégico si está disponible
    const strategicSection = data.strategicContext ? `
═══════════════════════════════════════════════════════════
🎯 CONTEXTO ESTRATÉGICO (IMPORTANTE)
═══════════════════════════════════════════════════════════
Fase actual: ${data.strategicContext.strategicPhase || 'normal'}
${data.strategicContext.dominantEvent ? `Evento detectado: ${data.strategicContext.dominantEvent}` : ''}
Descripción: ${data.strategicContext.phaseDescription || 'Operación normal'}

Tipos de campaña detectados:
• Build-up/Anticipación: ${data.strategicContext.summary?.buildupCampaigns || 0} campañas
• Promocionales: ${data.strategicContext.summary?.promoCampaigns || 0} campañas
• Contenido/Newsletter: ${data.strategicContext.summary?.contentCampaigns || 0} campañas

${data.strategicContext.interpretation ? `Interpretación: ${data.strategicContext.interpretation}` : ''}

⚠️ IMPORTANTE: Analiza las métricas en CONTEXTO de la fase actual:
- Si estamos en "buildup": alto engagement + bajo revenue es NORMAL (la audiencia espera la oferta)
- Si estamos en "event_active" o "sales_push": se espera conversión directa
- Si estamos en "nurturing": el foco es engagement, no revenue inmediato
` : '';

    return `Analiza estos datos de email marketing de Jersey Pickles de los ÚLTIMOS 15 DÍAS:
${strategicSection}
═══════════════════════════════════════════════════════════
📊 MÉTRICAS DE SALUD
═══════════════════════════════════════════════════════════
• Open Rate: ${data.health?.openRate || 0}% ${this.getRateBenchmark('open', data.health?.openRate)}
• Click Rate: ${data.health?.clickRate || 0}% ${this.getRateBenchmark('click', data.health?.clickRate)}
• Bounce Rate: ${data.health?.bounceRate || 0}% ${this.getRateBenchmark('bounce', data.health?.bounceRate)}
• Unsubscribe Rate: ${data.health?.unsubRate || 0}% ${this.getRateBenchmark('unsub', data.health?.unsubRate)}
• Delivery Rate: ${data.health?.deliveryRate || 0}%
• Health Score: ${data.health?.healthScore || 0}/100
• Total Campañas: ${data.health?.campaignsSent || 0}
• Total Emails Enviados: ${data.health?.totalSent?.toLocaleString() || 0}

═══════════════════════════════════════════════════════════
📧 ANÁLISIS DE SUBJECT LINES
═══════════════════════════════════════════════════════════
🏆 MEJOR PERFORMER:
   Subject: "${data.subjects?.top?.subject || 'N/A'}"
   Open Rate: ${data.subjects?.top?.openRate || 0}%
   ${data.subjects?.top?.context?.type ? `Tipo: ${data.subjects.top.context.type}${data.subjects.top.context.event ? ` (${data.subjects.top.context.event})` : ''}` : ''}

💀 PEOR PERFORMER:
   Subject: "${data.subjects?.bottom?.subject || 'N/A'}"
   Open Rate: ${data.subjects?.bottom?.openRate || 0}%
   ${data.subjects?.bottom?.context?.type ? `Tipo: ${data.subjects.bottom.context.type}${data.subjects.bottom.context.event ? ` (${data.subjects.bottom.context.event})` : ''}` : ''}

📈 PATRONES DETECTADOS:
   • Emojis: ${data.subjects?.patterns?.emoji || 'sin datos suficientes'}
   • Números/Descuentos: ${data.subjects?.patterns?.numbers || 'sin datos suficientes'}
   • Palabras de Urgencia: ${data.subjects?.patterns?.urgency || 'sin datos suficientes'}
   • Preguntas: ${data.subjects?.patterns?.questions || 'sin datos suficientes'}

═══════════════════════════════════════════════════════════
📋 PERFORMANCE POR LISTA
═══════════════════════════════════════════════════════════
${data.lists?.length > 0 ? data.lists.map((l, i) => `
${i + 1}. "${l.name}"
   • Opens: ${l.openRate}% | Clicks: ${l.clickRate}%
   • Revenue: $${(l.revenue || 0).toLocaleString()} | Campañas: ${l.campaigns || 0}
   • Unsubs: ${l.unsubRate || 0}%`).join('\n') : '⚠️ Sin datos de listas disponibles'}

═══════════════════════════════════════════════════════════
⏰ ANÁLISIS DE TIMING
═══════════════════════════════════════════════════════════
🏆 Mejor momento para enviar: ${data.timing?.best || 'Sin datos suficientes'}
💀 Peor momento: ${data.timing?.worst || 'Sin datos suficientes'}

Top 3 horarios por engagement:
${data.timing?.topHours?.length > 0 ? data.timing.topHours.map((t, i) => 
  `${i + 1}. ${t.day} a las ${t.hour} → ${t.score}% engagement`
).join('\n') : 'Sin datos suficientes'}

═══════════════════════════════════════════════════════════
💰 REVENUE ATTRIBUTION
═══════════════════════════════════════════════════════════
• Revenue Total Atribuido: $${(data.revenue?.total || 0).toLocaleString()}
• Revenue por Email: $${data.revenue?.perEmail || 0}
• Órdenes Atribuidas: ${data.revenue?.orders || 0}
${data.revenue?.total > 0 && data.health?.totalSent > 0 ? 
  `• RPM (Revenue per Mille): $${((data.revenue.total / data.health.totalSent) * 1000).toFixed(2)}` : ''}

═══════════════════════════════════════════════════════════
🚨 ALERTAS ACTIVAS
═══════════════════════════════════════════════════════════
${data.alerts?.length > 0 ? data.alerts.map(a => 
  `[${a.severity?.toUpperCase()}] ${a.message}`
).join('\n') : '✅ Sin alertas activas'}

${businessContextPrompt}

═══════════════════════════════════════════════════════════
📝 TU TAREA
═══════════════════════════════════════════════════════════

Basándote en TODOS los datos anteriores (email + productos + objetivos), proporciona:

1. RESUMEN EJECUTIVO (2-3 oraciones)
   - Estado general
   - Progreso hacia objetivo de revenue (si existe)
   - Oportunidad principal con PRODUCTO específico

2. ANÁLISIS PROFUNDO
   - Incluye sección de "inventory" si hay datos de productos
   - Conecta performance de listas con productos que prefieren

3. PLAN DE ACCIÓN (3-4 acciones priorizadas)
   - NOMBRA productos específicos en cada acción
   - Calcula impacto en $ cuando sea posible

4. RECOMENDACIONES DE PRODUCTOS
   - Qué promocionar (con stock disponible)
   - Qué evitar (agotados o bajo stock)
   - Bundles naturales basados en compras juntas

5. ESTRATEGIA PARA OBJETIVO DE REVENUE (si existe)
   - Status actual
   - Acciones para alcanzarlo

6. PRÓXIMA CAMPAÑA SUGERIDA
   - Con productos específicos a destacar
   - Subject lines que mencionen esos productos

IMPORTANTE:
- Sé ESPECÍFICO: menciona PRODUCTOS, listas, y números concretos
- NO recomiendes productos AGOTADOS
- Considera el OBJETIVO DE REVENUE para urgencia
- Aprovecha EVENTOS PRÓXIMOS
- Personaliza según lo que COMPRA CADA LISTA`;
  }

  /**
   * Helper para agregar contexto de benchmarks
   */
  getRateBenchmark(type, value) {
    if (!value) return '';
    
    const benchmarks = {
      open: { good: 25, avg: 18, bad: 12, industry: 'Food & Beverage: 18-25%' },
      click: { good: 3.5, avg: 2.5, bad: 1.5, industry: 'Food & Beverage: 2-4%' },
      bounce: { good: 0.5, avg: 2, bad: 5, industry: 'Saludable: <2%' },
      unsub: { good: 0.2, avg: 0.5, bad: 1, industry: 'Saludable: <0.5%' }
    };
    
    const b = benchmarks[type];
    if (!b) return '';
    
    if (type === 'bounce' || type === 'unsub') {
      // Para estas métricas, menor es mejor
      if (value <= b.good) return '(✅ Excelente)';
      if (value <= b.avg) return '(👍 Aceptable)';
      if (value <= b.bad) return '(⚠️ Necesita atención)';
      return '(🚨 Crítico)';
    } else {
      // Para open y click, mayor es mejor
      if (value >= b.good) return '(✅ Excelente)';
      if (value >= b.avg) return '(👍 Aceptable)';
      if (value >= b.bad) return '(⚠️ Por debajo del promedio)';
      return '(🚨 Crítico)';
    }
  }

  /**
   * Parsear respuesta de Claude con mejor manejo de errores
   */
  parseResponse(content) {
    try {
      let jsonStr = content;
      
      // Limpiar posibles wrappers de markdown
      if (jsonStr.includes('```')) {
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
          jsonStr = jsonMatch[1];
        }
      }
      
      // Limpiar espacios y newlines extras
      jsonStr = jsonStr.trim();
      
      // Si empieza con texto antes del JSON, intentar encontrar el inicio
      if (!jsonStr.startsWith('{')) {
        const jsonStart = jsonStr.indexOf('{');
        if (jsonStart !== -1) {
          jsonStr = jsonStr.substring(jsonStart);
        }
      }
      
      // Si termina con texto después del JSON, intentar encontrar el final
      if (!jsonStr.endsWith('}')) {
        const jsonEnd = jsonStr.lastIndexOf('}');
        if (jsonEnd !== -1) {
          jsonStr = jsonStr.substring(0, jsonEnd + 1);
        }
      }
      
      console.log(`   Parsing JSON of ${jsonStr.length} chars`);
      
      const parsed = JSON.parse(jsonStr);
      
      // Validar estructura mínima
      if (!parsed.executiveSummary && !parsed.deepAnalysis && !parsed.actionPlan) {
        console.warn('⚠️  Respuesta parseada pero sin estructura esperada');
        console.log('   Keys encontrados:', Object.keys(parsed));
      }
      
      return parsed;
      
    } catch (error) {
      console.error('⚠️  Error parseando JSON:', error.message);
      console.log('   Content preview:', content.substring(0, 300));
      console.log('   Content end:', content.substring(Math.max(0, content.length - 100)));
      
      // Intentar extraer al menos el executive summary del texto
      const summaryMatch = content.match(/"executiveSummary"\s*:\s*"([^"]+)"/);
      
      return {
        executiveSummary: summaryMatch ? summaryMatch[1] : 'Error procesando análisis de AI. Revisa los logs.',
        deepAnalysis: {
          health: { 
            status: 'unknown', 
            analysis: 'No se pudo procesar la respuesta de Claude correctamente. El sistema usará el análisis de fallback.' 
          }
        },
        actionPlan: [],
        quickWins: ['Revisar configuración de Claude API', 'Verificar logs del servidor'],
        warnings: [],
        opportunities: [],
        parseError: true,
        rawContent: content.substring(0, 500)
      };
    }
  }

  /**
   * Fallback mejorado cuando Claude no está disponible
   */
  getFallbackInsights(data) {
    const actionPlan = [];
    const warnings = [];
    const quickWins = [];
    const opportunities = [];
    
    // Análisis de health
    let healthAnalysis = 'Sin datos suficientes para análisis de salud.';
    let healthStatus = 'unknown';
    
    if (data.health) {
      const h = data.health;
      healthStatus = h.healthScore >= 80 ? 'healthy' : h.healthScore >= 60 ? 'warning' : 'critical';
      
      healthAnalysis = `Tu email marketing tiene un health score de ${h.healthScore}/100. `;
      
      if (h.openRate) {
        healthAnalysis += `El open rate de ${h.openRate}% está ${h.openRate >= 20 ? 'en buen rango para la industria de alimentos' : 'por debajo del promedio de 18-25% para food & beverage'}. `;
      }
      
      if (h.bounceRate > 2) {
        warnings.push({
          severity: 'critical',
          issue: `Bounce rate de ${h.bounceRate}% está muy alto`,
          consequence: 'Esto daña tu reputación de sender y puede llevar a que tus emails caigan en spam',
          solution: 'Exporta la lista de bounced emails y elimínalos antes del próximo envío'
        });
        
        actionPlan.push({
          priority: 1,
          title: 'Limpiar lista de bounces',
          what: 'Eliminar todos los emails que han bounceado',
          why: `Con ${h.bounceRate}% bounce rate estás en riesgo de ser marcado como spam`,
          how: '1. Ve a Customers > Filtrar por bounced. 2. Exportar lista. 3. Eliminar o marcar como inactivos.',
          expectedImpact: 'Mejorar deliverability en 1-2 semanas'
        });
      }
      
      if (h.openRate < 15) {
        quickWins.push('Prueba enviar tu próxima campaña a las 10am EST - históricamente mejor horario para food emails');
        quickWins.push('Añade un emoji al inicio del subject (🥒 o 🫒) - aumenta opens en promedio 10-15%');
      }
    }
    
    // Análisis de subjects
    let subjectsAnalysis = 'Sin datos suficientes para análisis de subjects.';
    if (data.subjects?.top?.subject) {
      subjectsAnalysis = `Tu mejor subject "${data.subjects.top.subject}" logró ${data.subjects.top.openRate}% opens. `;
      
      if (data.subjects.bottom?.subject) {
        subjectsAnalysis += `En contraste, "${data.subjects.bottom.subject}" solo tuvo ${data.subjects.bottom.openRate}% opens. `;
        
        // Analizar diferencias
        const topHasEmoji = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/u.test(data.subjects.top.subject);
        const bottomHasEmoji = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/u.test(data.subjects.bottom.subject);
        
        if (topHasEmoji && !bottomHasEmoji) {
          subjectsAnalysis += 'El top performer tiene emoji y el peor no - considera usar emojis consistentemente. ';
        }
      }
    }
    
    // Análisis de listas
    let listsAnalysis = 'Sin datos de listas disponibles.';
    if (data.lists?.length > 0) {
      const sortedByRevenue = [...data.lists].sort((a, b) => (b.revenue || 0) - (a.revenue || 0));
      const topList = sortedByRevenue[0];
      
      listsAnalysis = `Tienes ${data.lists.length} listas activas. `;
      
      if (topList) {
        listsAnalysis += `"${topList.name}" es tu lista más valiosa con $${(topList.revenue || 0).toLocaleString()} en revenue. `;
        
        // Buscar oportunidades
        const highEngagementLowRevenue = data.lists.find(l => 
          l.openRate > 25 && (l.revenue || 0) < 100
        );
        
        if (highEngagementLowRevenue) {
          opportunities.push({
            opportunity: `"${highEngagementLowRevenue.name}" tiene ${highEngagementLowRevenue.openRate}% opens pero bajo revenue`,
            potential: 'Alto - audiencia engaged pero no convirtiendo',
            effort: 'medium'
          });
        }
      }
    }
    
    // Análisis de timing
    let timingAnalysis = 'Sin datos suficientes para análisis de timing.';
    if (data.timing?.best) {
      timingAnalysis = `Tu mejor momento para enviar es ${data.timing.best}. `;
      
      if (data.timing.topHours?.length > 0) {
        timingAnalysis += `Los horarios con mejor engagement son: ${data.timing.topHours.map(t => `${t.day} ${t.hour}`).join(', ')}. `;
      }
      
      quickWins.push(`Programa tu próxima campaña importante para ${data.timing.best}`);
    }
    
    // Análisis de revenue
    let revenueAnalysis = 'Sin datos de revenue atribuido.';
    if (data.revenue?.total > 0) {
      revenueAnalysis = `Has generado $${data.revenue.total.toLocaleString()} en revenue atribuido a email. `;
      
      if (data.revenue.perEmail > 0) {
        revenueAnalysis += `Cada email enviado genera en promedio $${data.revenue.perEmail}. `;
        
        if (data.revenue.perEmail < 0.05) {
          opportunities.push({
            opportunity: 'Revenue per email está bajo ($' + data.revenue.perEmail + ')',
            potential: 'Aumentar AOV con bundles o upsells en emails',
            effort: 'low'
          });
        }
      }
    }
    
    // Executive summary
    let executiveSummary = '';
    if (healthStatus === 'healthy') {
      executiveSummary = 'Tu email marketing está en buen estado general. ';
    } else if (healthStatus === 'warning') {
      executiveSummary = 'Tu email marketing necesita atención en algunas áreas. ';
    } else if (healthStatus === 'critical') {
      executiveSummary = '⚠️ Tu email marketing tiene problemas críticos que requieren acción inmediata. ';
    }
    
    if (actionPlan.length > 0) {
      executiveSummary += `Prioridad #1: ${actionPlan[0].title}. `;
    } else if (quickWins.length > 0) {
      executiveSummary += `Quick win: ${quickWins[0]}`;
    }

    return {
      success: true,
      executiveSummary,
      deepAnalysis: {
        health: { status: healthStatus, analysis: healthAnalysis },
        subjects: { analysis: subjectsAnalysis },
        lists: { analysis: listsAnalysis },
        timing: { analysis: timingAnalysis },
        revenue: { analysis: revenueAnalysis },
        inventory: { analysis: 'Datos de inventario no disponibles. Sincroniza productos desde Shopify para ver análisis de stock.' }
      },
      actionPlan,
      quickWins,
      warnings,
      opportunities,
      productRecommendations: null,
      revenueGoalStrategy: null,
      nextCampaignSuggestion: data.timing?.best ? {
        type: 'Promocional',
        targetList: data.lists?.[0]?.name || 'Lista principal',
        subjectIdeas: [
          '🥒 Fresh batch just dropped - limited quantity',
          'Your pickle craving called... we answered',
          '15% OFF weekend special (ends Sunday)'
        ],
        bestTime: data.timing.best,
        products: [],
        rationale: 'Basado en tus mejores horarios históricos'
      } : null,
      generatedAt: new Date().toISOString(),
      model: 'fallback-analysis',
      tokensUsed: { input: 0, output: 0 },
      isFallback: true,
      hasBusinessContext: false
    };
  }

  /**
   * Generar sugerencias de subject line CON PRODUCTOS
   */
  async suggestSubjectLines(context) {
    if (!this.isAvailable()) {
      return {
        success: false,
        message: 'Claude API no disponible',
        suggestions: [
          { subject: '🥒 Fresh pickles just landed', reason: 'Emoji + novedad' },
          { subject: 'Your favorites are back in stock', reason: 'Personalización + urgencia suave' },
          { subject: '15% OFF this weekend only', reason: 'Descuento + tiempo limitado' }
        ]
      };
    }

    // 🆕 Obtener productos top si están disponibles
    let productContext = '';
    if (businessContextService) {
      try {
        const businessContext = await businessContextService.getFullBusinessContext();
        if (businessContext.products?.topSellingProducts?.length > 0) {
          productContext = `\nProductos más vendidos para mencionar: ${businessContext.products.topSellingProducts.slice(0, 3).map(p => p.title).join(', ')}`;
        }
        if (businessContext.products?.giftSetsAvailable?.length > 0) {
          productContext += `\nGift sets disponibles: ${businessContext.products.giftSetsAvailable.slice(0, 2).map(p => p.title).join(', ')}`;
        }
      } catch (error) {
        console.log('⚠️  No se pudieron obtener productos para subjects');
      }
    }

    const prompt = `Genera 5 subject lines para un email de Jersey Pickles (pickles y olives gourmet de New Jersey).

Contexto:
- Tipo: ${context.campaignType || 'promocional'}
- Audiencia: ${context.audience || 'clientes generales'}
- Objetivo: ${context.objective || 'engagement y ventas'}
- Lo que funciona para este negocio: ${context.patterns || 'emojis (especialmente 🥒🫒), números/descuentos, urgencia'}
${productContext}

${context.products?.length > 0 ? `Productos a destacar en esta campaña: ${context.products.join(', ')}` : ''}

Responde SOLO con JSON válido:
{
  "suggestions": [
    { 
      "subject": "El subject line completo (puede mencionar producto específico)", 
      "reason": "Por qué funcionaría para este negocio específico",
      "expectedOpenRate": "Estimado basado en patrones (ej: 22-28%)"
    }
  ]
}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      });

      const content = response.content[0].text;
      const parsed = this.parseResponse(content);
      
      return {
        success: true,
        suggestions: parsed.suggestions || [],
        generatedAt: new Date().toISOString()
      };

    } catch (error) {
      console.error('Error generando subjects:', error.message);
      return {
        success: false,
        message: error.message,
        suggestions: []
      };
    }
  }

  /**
   * 🆕 Generar análisis rápido de un producto específico
   */
  async analyzeProductForCampaign(productName, listName = null) {
    if (!this.isAvailable()) {
      return {
        success: false,
        message: 'Claude API no disponible'
      };
    }

    let productData = '';
    if (businessContextService) {
      try {
        const context = await businessContextService.getFullBusinessContext();
        const product = context.products?.topSellingProducts?.find(
          p => p.title.toLowerCase().includes(productName.toLowerCase())
        );
        if (product) {
          productData = `\nDatos del producto:
- Revenue últimos 30 días: ${product.revenue}
- Unidades vendidas: ${product.unitsSold}
- Stock actual: ${product.inventory}
- Estado: ${product.isLowStock ? 'BAJO STOCK' : product.isOutOfStock ? 'AGOTADO' : 'Disponible'}`;
        }
      } catch (error) {
        console.log('⚠️  No se pudieron obtener datos del producto');
      }
    }

    const prompt = `Analiza brevemente si "${productName}" es buen candidato para una campaña de email${listName ? ` a la lista "${listName}"` : ''}.
${productData}

Responde en JSON:
{
  "recommendation": "promote o avoid o caution",
  "reason": "Explicación breve",
  "suggestedAngle": "Ángulo de venta sugerido",
  "subjectIdea": "Una idea de subject line"
}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      });

      const content = response.content[0].text;
      const parsed = this.parseResponse(content);
      
      return {
        success: true,
        ...parsed,
        generatedAt: new Date().toISOString()
      };

    } catch (error) {
      console.error('Error analizando producto:', error.message);
      return {
        success: false,
        message: error.message
      };
    }
  }
}

const claudeService = new ClaudeService();
module.exports = claudeService;