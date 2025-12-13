// backend/src/services/gpt52Service.js
// 🧠 Servicio para integración con OpenAI API (GPT-5.2)
// 🔧 Migrado desde ClaudeService manteniendo la MISMA estructura
// ✅ Incluye: businessContextService + timeout + fallback + JSON schema output

const OpenAI = require("openai");

// 🆕 Importar servicios de contexto de negocio
let businessContextService = null;
try {
  businessContextService = require("./businessContextService");
} catch (error) {
  console.log("⚠️  businessContextService no disponible:", error.message);
}

class GPT52Service {
  constructor() {
    this.client = null;
    this.initialized = false;

    // Puedes sobreescribir por env:
    // OPENAI_MODEL=gpt-5.2-YYYY-MM-DD (si tienes snapshot)
    this.model = process.env.OPENAI_MODEL || "gpt-5.2";
  }

  init() {
    if (this.initialized) return;

    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      console.log("⚠️  OPENAI_API_KEY no configurada - GPT deshabilitado");
      return;
    }

    try {
      this.client = new OpenAI({ apiKey });
      this.initialized = true;
      console.log("✅ OpenAI API inicializada");
    } catch (error) {
      console.error("❌ Error inicializando OpenAI API:", error.message);
    }
  }

  isAvailable() {
    return this.initialized && this.client !== null;
  }

  /**
   * Generar análisis profundo de email marketing
   */
  async generateEmailInsights(metricsData) {
    if (!this.isAvailable()) {
      console.log("⚠️  OpenAI API no disponible, usando insights básicos");
      return this.getFallbackInsights(metricsData);
    }

    // 🆕 Obtener contexto de negocio (productos, goals, promociones)
    let businessContextPrompt = "";

    if (businessContextService) {
      try {
        console.log("📦 Obteniendo contexto de negocio para GPT...");
        const businessContext = await businessContextService.getFullBusinessContext();
        businessContextPrompt =
          businessContextService.formatBusinessContextForPrompt(businessContext);
        console.log("✅ Contexto de negocio obtenido");
      } catch (error) {
        console.log("⚠️  Error obteniendo contexto de negocio:", error.message);
      }
    }

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(metricsData, businessContextPrompt);

    try {
      console.log("🧠 Llamando a OpenAI API (GPT) para análisis profundo...");
      console.log(`   Model: ${this.model}`);
      console.log(`   System prompt length: ${systemPrompt.length} chars`);
      console.log(`   User prompt length: ${userPrompt.length} chars`);
      console.log(`   Business context: ${businessContextPrompt ? "Incluido" : "No disponible"}`);

      const startTime = Date.now();

      // Timeout 60s
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("OpenAI API timeout (60s)")), 60000);
      });

      // JSON Schema (Structured Output)
      const jsonSchema = this.getInsightsJsonSchema();

      const apiPromise = this.client.responses.create({
        model: this.model,
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        // ✅ Forzar JSON estructurado
        text: {
          format: {
            type: "json_schema",
            json_schema: jsonSchema,
          },
        },
      });

      const response = await Promise.race([apiPromise, timeoutPromise]);

      const duration = Date.now() - startTime;

      // Tokens (depende del SDK; no siempre viene igual)
      const inputTokens =
        response?.usage?.input_tokens ??
        response?.usage?.input ??
        response?.usage?.prompt_tokens ??
        0;

      const outputTokens =
        response?.usage?.output_tokens ??
        response?.usage?.output ??
        response?.usage?.completion_tokens ??
        0;

      console.log(`✅ OpenAI respondió en ${duration}ms`);
      console.log(`   Input tokens: ${inputTokens || "N/A"}`);
      console.log(`   Output tokens: ${outputTokens || "N/A"}`);

      // Normalmente viene aquí
      const content =
        response?.output_text ||
        this.extractTextFromResponse(response) ||
        "";

      if (!content) {
        console.error("❌ OpenAI devolvió respuesta vacía");
        return this.getFallbackInsights(metricsData);
      }

      console.log(`   Response length: ${content.length} chars`);
      console.log(`   Response preview: ${content.substring(0, 100)}...`);

      const analysis = this.parseResponse(content);

      if (!analysis || analysis.parseError) {
        console.error("❌ Error parseando respuesta de OpenAI, usando fallback");
        return this.getFallbackInsights(metricsData);
      }

      console.log("✅ Análisis parseado correctamente");
      console.log(`   - Executive summary: ${analysis.executiveSummary ? "Sí" : "No"}`);
      console.log(`   - Deep analysis sections: ${Object.keys(analysis.deepAnalysis || {}).length}`);
      console.log(`   - Action plan items: ${analysis.actionPlan?.length || 0}`);
      console.log(`   - Quick wins: ${analysis.quickWins?.length || 0}`);
      console.log(`   - Product recommendations: ${analysis.productRecommendations ? "Sí" : "No"}`);

      return {
        success: true,
        ...analysis,
        generatedAt: new Date().toISOString(),
        model: this.model,
        tokensUsed: {
          input: inputTokens || 0,
          output: outputTokens || 0,
        },
        duration,
        hasBusinessContext: !!businessContextPrompt,
      };
    } catch (error) {
      console.error("❌ Error llamando a OpenAI API:", error.message);
      console.error("   Stack:", error.stack?.substring(0, 300));

      if (error.status) {
        console.error(`   Status: ${error.status}`);
        console.error(`   Type: ${error.type || "unknown"}`);
      }

      return this.getFallbackInsights(metricsData);
    }
  }

  /**
   * System prompt optimizado para análisis profundo CON PRODUCTOS
   */
  buildSystemPrompt() {
    // 👇 Copiado desde tu ClaudeService (idéntico)
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
  buildUserPrompt(data, businessContextPrompt = "") {
    // 👇 Copiado de tu ClaudeService (idéntico) con helpers iguales
    const strategicSection = data.strategicContext
      ? `
═══════════════════════════════════════════════════════════
🎯 CONTEXTO ESTRATÉGICO (IMPORTANTE)
═══════════════════════════════════════════════════════════
Fase actual: ${data.strategicContext.strategicPhase || "normal"}
${data.strategicContext.dominantEvent ? `Evento detectado: ${data.strategicContext.dominantEvent}` : ""}
Descripción: ${data.strategicContext.phaseDescription || "Operación normal"}

Tipos de campaña detectados:
• Build-up/Anticipación: ${data.strategicContext.summary?.buildupCampaigns || 0} campañas
• Promocionales: ${data.strategicContext.summary?.promoCampaigns || 0} campañas
• Contenido/Newsletter: ${data.strategicContext.summary?.contentCampaigns || 0} campañas

${data.strategicContext.interpretation ? `Interpretación: ${data.strategicContext.interpretation}` : ""}

⚠️ IMPORTANTE: Analiza las métricas en CONTEXTO de la fase actual:
- Si estamos en "buildup": alto engagement + bajo revenue es NORMAL (la audiencia espera la oferta)
- Si estamos en "event_active" o "sales_push": se espera conversión directa
- Si estamos en "nurturing": el foco es engagement, no revenue inmediato
`
      : "";

    return `Analiza estos datos de email marketing de Jersey Pickles de los ÚLTIMOS 15 DÍAS:
${strategicSection}
═══════════════════════════════════════════════════════════
📊 MÉTRICAS DE SALUD
═══════════════════════════════════════════════════════════
• Open Rate: ${data.health?.openRate || 0}% ${this.getRateBenchmark("open", data.health?.openRate)}
• Click Rate: ${data.health?.clickRate || 0}% ${this.getRateBenchmark("click", data.health?.clickRate)}
• Bounce Rate: ${data.health?.bounceRate || 0}% ${this.getRateBenchmark("bounce", data.health?.bounceRate)}
• Unsubscribe Rate: ${data.health?.unsubRate || 0}% ${this.getRateBenchmark("unsub", data.health?.unsubRate)}
• Delivery Rate: ${data.health?.deliveryRate || 0}%
• Health Score: ${data.health?.healthScore || 0}/100
• Total Campañas: ${data.health?.campaignsSent || 0}
• Total Emails Enviados: ${data.health?.totalSent?.toLocaleString() || 0}

═══════════════════════════════════════════════════════════
📧 ANÁLISIS DE SUBJECT LINES
═══════════════════════════════════════════════════════════
🏆 MEJOR PERFORMER:
   Subject: "${data.subjects?.top?.subject || "N/A"}"
   Open Rate: ${data.subjects?.top?.openRate || 0}%
   ${data.subjects?.top?.context?.type ? `Tipo: ${data.subjects.top.context.type}${data.subjects.top.context.event ? ` (${data.subjects.top.context.event})` : ""}` : ""}

💀 PEOR PERFORMER:
   Subject: "${data.subjects?.bottom?.subject || "N/A"}"
   Open Rate: ${data.subjects?.bottom?.openRate || 0}%
   ${data.subjects?.bottom?.context?.type ? `Tipo: ${data.subjects.bottom.context.type}${data.subjects.bottom.context.event ? ` (${data.subjects.bottom.context.event})` : ""}` : ""}

📈 PATRONES DETECTADOS:
   • Emojis: ${data.subjects?.patterns?.emoji || "sin datos suficientes"}
   • Números/Descuentos: ${data.subjects?.patterns?.numbers || "sin datos suficientes"}
   • Palabras de Urgencia: ${data.subjects?.patterns?.urgency || "sin datos suficientes"}
   • Preguntas: ${data.subjects?.patterns?.questions || "sin datos suficientes"}

═══════════════════════════════════════════════════════════
📋 PERFORMANCE POR LISTA
═══════════════════════════════════════════════════════════
${
  data.lists?.length > 0
    ? data.lists
        .map(
          (l, i) => `
${i + 1}. "${l.name}"
   • Opens: ${l.openRate}% | Clicks: ${l.clickRate}%
   • Revenue: $${(l.revenue || 0).toLocaleString()} | Campañas: ${l.campaigns || 0}
   • Unsubs: ${l.unsubRate || 0}%`
        )
        .join("\n")
    : "⚠️ Sin datos de listas disponibles"
}

═══════════════════════════════════════════════════════════
⏰ ANÁLISIS DE TIMING
═══════════════════════════════════════════════════════════
🏆 Mejor momento para enviar: ${data.timing?.best || "Sin datos suficientes"}
💀 Peor momento: ${data.timing?.worst || "Sin datos suficientes"}

Top 3 horarios por engagement:
${
  data.timing?.topHours?.length > 0
    ? data.timing.topHours
        .map((t, i) => `${i + 1}. ${t.day} a las ${t.hour} → ${t.score}% engagement`)
        .join("\n")
    : "Sin datos suficientes"
}

═══════════════════════════════════════════════════════════
💰 REVENUE ATTRIBUTION
═══════════════════════════════════════════════════════════
• Revenue Total Atribuido: $${(data.revenue?.total || 0).toLocaleString()}
• Revenue por Email: $${data.revenue?.perEmail || 0}
• Órdenes Atribuidas: ${data.revenue?.orders || 0}
${
  data.revenue?.total > 0 && data.health?.totalSent > 0
    ? `• RPM (Revenue per Mille): $${((data.revenue.total / data.health.totalSent) * 1000).toFixed(2)}`
    : ""
}

═══════════════════════════════════════════════════════════
🚨 ALERTAS ACTIVAS
═══════════════════════════════════════════════════════════
${
  data.alerts?.length > 0
    ? data.alerts
        .map((a) => `[${a.severity?.toUpperCase()}] ${a.message}`)
        .join("\n")
    : "✅ Sin alertas activas"
}

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
   * Schema “más flexible” (evita que falle por campos opcionales)
   * Si quieres ultra estricto, lo hacemos más cerrado.
   */
  getInsightsJsonSchema() {
    return {
      name: "jersey_pickles_email_insights",
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          executiveSummary: { type: "string" },
          deepAnalysis: { type: "object" },
          actionPlan: { type: "array" },
          quickWins: { type: "array" },
          warnings: { type: "array" },
          opportunities: { type: "array" },
          productRecommendations: { type: ["object", "null"] },
          revenueGoalStrategy: { type: ["object", "null"] },
          nextCampaignSuggestion: { type: ["object", "null"] },
        },
        required: ["executiveSummary", "deepAnalysis", "actionPlan", "quickWins", "warnings", "opportunities"],
      },
    };
  }

  /**
   * Helper para agregar contexto de benchmarks
   */
  getRateBenchmark(type, value) {
    if (!value) return "";

    const benchmarks = {
      open: { good: 25, avg: 18, bad: 12 },
      click: { good: 3.5, avg: 2.5, bad: 1.5 },
      bounce: { good: 0.5, avg: 2, bad: 5 },
      unsub: { good: 0.2, avg: 0.5, bad: 1 },
    };

    const b = benchmarks[type];
    if (!b) return "";

    if (type === "bounce" || type === "unsub") {
      if (value <= b.good) return "(✅ Excelente)";
      if (value <= b.avg) return "(👍 Aceptable)";
      if (value <= b.bad) return "(⚠️ Necesita atención)";
      return "(🚨 Crítico)";
    } else {
      if (value >= b.good) return "(✅ Excelente)";
      if (value >= b.avg) return "(👍 Aceptable)";
      if (value >= b.bad) return "(⚠️ Por debajo del promedio)";
      return "(🚨 Crítico)";
    }
  }

  /**
   * Parsear respuesta JSON (debería venir limpia por schema)
   */
  parseResponse(content) {
    try {
      let jsonStr = content.trim();

      // Limpieza defensiva por si viene “algo raro”
      if (jsonStr.includes("```")) {
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) jsonStr = jsonMatch[1].trim();
      }

      if (!jsonStr.startsWith("{")) {
        const start = jsonStr.indexOf("{");
        if (start !== -1) jsonStr = jsonStr.substring(start);
      }

      if (!jsonStr.endsWith("}")) {
        const end = jsonStr.lastIndexOf("}");
        if (end !== -1) jsonStr = jsonStr.substring(0, end + 1);
      }

      const parsed = JSON.parse(jsonStr);
      return parsed;
    } catch (error) {
      console.error("⚠️  Error parseando JSON:", error.message);
      return {
        executiveSummary: "Error procesando análisis de AI. Revisa los logs.",
        deepAnalysis: {
          health: {
            status: "unknown",
            analysis:
              "No se pudo procesar la respuesta correctamente. El sistema usará el análisis de fallback.",
          },
        },
        actionPlan: [],
        quickWins: ["Revisar configuración de OpenAI", "Verificar logs del servidor"],
        warnings: [],
        opportunities: [],
        parseError: true,
        rawContent: content.substring(0, 500),
      };
    }
  }

  /**
   * Fallback (copiado de tu ClaudeService con mínimos ajustes)
   */
  getFallbackInsights(data) {
    // 👇 puedes pegar tu fallback exacto aquí (lo dejé breve pero funcional)
    const actionPlan = [];
    const warnings = [];
    const quickWins = [];
    const opportunities = [];

    let healthStatus = "unknown";
    let healthAnalysis = "Sin datos suficientes para análisis de salud.";

    if (data.health) {
      const h = data.health;
      healthStatus = h.healthScore >= 80 ? "healthy" : h.healthScore >= 60 ? "warning" : "critical";

      healthAnalysis = `Tu email marketing tiene un health score de ${h.healthScore}/100. `;

      if (h.openRate) {
        healthAnalysis += `El open rate de ${h.openRate}% está ${
          h.openRate >= 20 ? "en buen rango para la industria de alimentos" : "por debajo del promedio"
        }. `;
      }

      if (h.bounceRate > 2) {
        warnings.push({
          severity: "critical",
          issue: `Bounce rate de ${h.bounceRate}% está muy alto`,
          consequence: "Daña tu reputación de sender y puede llevar a spam",
          solution: "Elimina bounced emails antes del próximo envío",
        });

        actionPlan.push({
          priority: 1,
          title: "Limpiar lista de bounces",
          what: "Eliminar emails que han bounceado",
          why: `Con ${h.bounceRate}% bounce rate estás en riesgo`,
          how: "1) Filtrar bounced 2) Exportar 3) Eliminar o desactivar",
          expectedImpact: "Mejor deliverability en 1-2 semanas",
        });
      }

      if (h.openRate < 15) {
        quickWins.push("Añade 🥒 o 🫒 al inicio del subject para subir opens");
      }
    }

    let executiveSummary =
      healthStatus === "healthy"
        ? "Tu email marketing está en buen estado general. "
        : healthStatus === "warning"
        ? "Tu email marketing necesita atención en algunas áreas. "
        : healthStatus === "critical"
        ? "⚠️ Tu email marketing tiene problemas críticos que requieren acción inmediata. "
        : "Resumen no disponible. ";

    if (actionPlan.length > 0) executiveSummary += `Prioridad #1: ${actionPlan[0].title}.`;

    return {
      success: true,
      executiveSummary,
      deepAnalysis: {
        health: { status: healthStatus, analysis: healthAnalysis },
        subjects: { analysis: "Sin datos suficientes." },
        lists: { analysis: "Sin datos suficientes." },
        timing: { analysis: "Sin datos suficientes." },
        revenue: { analysis: "Sin datos suficientes." },
        inventory: { analysis: "Datos de inventario no disponibles." },
      },
      actionPlan,
      quickWins,
      warnings,
      opportunities,
      productRecommendations: null,
      revenueGoalStrategy: null,
      nextCampaignSuggestion: null,
      generatedAt: new Date().toISOString(),
      model: "fallback-analysis",
      tokensUsed: { input: 0, output: 0 },
      isFallback: true,
      hasBusinessContext: false,
    };
  }

  /**
   * Generar sugerencias de subject line CON PRODUCTOS
   */
  async suggestSubjectLines(context) {
    if (!this.isAvailable()) {
      return {
        success: false,
        message: "OpenAI API no disponible",
        suggestions: [
          { subject: "🥒 Fresh pickles just landed", reason: "Emoji + novedad" },
          { subject: "Your favorites are back in stock", reason: "Personalización + urgencia suave" },
          { subject: "15% OFF this weekend only", reason: "Descuento + tiempo limitado" },
        ],
      };
    }

    let productContext = "";
    if (businessContextService) {
      try {
        const businessContext = await businessContextService.getFullBusinessContext();
        if (businessContext.products?.topSellingProducts?.length > 0) {
          productContext = `\nProductos más vendidos: ${businessContext.products.topSellingProducts
            .slice(0, 3)
            .map((p) => p.title)
            .join(", ")}`;
        }
        if (businessContext.products?.giftSetsAvailable?.length > 0) {
          productContext += `\nGift sets disponibles: ${businessContext.products.giftSetsAvailable
            .slice(0, 2)
            .map((p) => p.title)
            .join(", ")}`;
        }
      } catch (error) {
        console.log("⚠️  No se pudieron obtener productos para subjects");
      }
    }

    const prompt = `Genera 5 subject lines para un email de Jersey Pickles (pickles y olives gourmet de New Jersey).

Contexto:
- Tipo: ${context.campaignType || "promocional"}
- Audiencia: ${context.audience || "clientes generales"}
- Objetivo: ${context.objective || "engagement y ventas"}
- Lo que funciona: emojis (🥒🫒), números/descuentos, urgencia
${productContext}

${context.products?.length > 0 ? `Productos a destacar: ${context.products.join(", ")}` : ""}

Responde SOLO con JSON válido:
{
  "suggestions": [
    {
      "subject": "Subject completo",
      "reason": "Por qué funcionaría",
      "expectedOpenRate": "Ej: 22-28%"
    }
  ]
}`;

    try {
      const schema = {
        name: "subject_suggestions",
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            suggestions: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: true,
                properties: {
                  subject: { type: "string" },
                  reason: { type: "string" },
                  expectedOpenRate: { type: "string" },
                },
                required: ["subject", "reason", "expectedOpenRate"],
              },
            },
          },
          required: ["suggestions"],
        },
      };

      const resp = await this.client.responses.create({
        model: this.model,
        input: [{ role: "user", content: prompt }],
        text: {
          format: { type: "json_schema", json_schema: schema },
        },
      });

      const content = resp.output_text || this.extractTextFromResponse(resp) || "";
      const parsed = this.parseResponse(content);

      return {
        success: true,
        suggestions: parsed.suggestions || [],
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      console.error("Error generando subjects:", error.message);
      return { success: false, message: error.message, suggestions: [] };
    }
  }

  /**
   * 🆕 Análisis rápido de un producto específico
   */
  async analyzeProductForCampaign(productName, listName = null) {
    if (!this.isAvailable()) {
      return { success: false, message: "OpenAI API no disponible" };
    }

    let productData = "";
    if (businessContextService) {
      try {
        const context = await businessContextService.getFullBusinessContext();
        const product = context.products?.topSellingProducts?.find((p) =>
          p.title.toLowerCase().includes(productName.toLowerCase())
        );
        if (product) {
          productData = `\nDatos del producto:
- Revenue últimos 30 días: ${product.revenue}
- Unidades vendidas: ${product.unitsSold}
- Stock actual: ${product.inventory}
- Estado: ${product.isLowStock ? "BAJO STOCK" : product.isOutOfStock ? "AGOTADO" : "Disponible"}`;
        }
      } catch (error) {
        console.log("⚠️  No se pudieron obtener datos del producto");
      }
    }

    const prompt = `Analiza brevemente si "${productName}" es buen candidato para una campaña de email${
      listName ? ` a la lista "${listName}"` : ""
    }.
${productData}

Responde SOLO en JSON:
{
  "recommendation": "promote o avoid o caution",
  "reason": "Explicación breve",
  "suggestedAngle": "Ángulo de venta sugerido",
  "subjectIdea": "Una idea de subject line"
}`;

    try {
      const schema = {
        name: "product_campaign_analysis",
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            recommendation: { type: "string" },
            reason: { type: "string" },
            suggestedAngle: { type: "string" },
            subjectIdea: { type: "string" },
          },
          required: ["recommendation", "reason", "suggestedAngle", "subjectIdea"],
        },
      };

      const resp = await this.client.responses.create({
        model: this.model,
        input: [{ role: "user", content: prompt }],
        text: { format: { type: "json_schema", json_schema: schema } },
      });

      const content = resp.output_text || this.extractTextFromResponse(resp) || "";
      const parsed = this.parseResponse(content);

      return { success: true, ...parsed, generatedAt: new Date().toISOString() };
    } catch (error) {
      console.error("Error analizando producto:", error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Por si el SDK cambia la forma de respuesta
   */
  extractTextFromResponse(response) {
    try {
      // Algunos SDKs devuelven output como array con content parts
      const out = response?.output;
      if (!Array.isArray(out)) return "";

      for (const item of out) {
        const content = item?.content;
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (part?.type === "output_text" && typeof part?.text === "string") {
            return part.text;
          }
          if (typeof part?.text === "string") return part.text;
        }
      }
      return "";
    } catch {
      return "";
    }
  }
}

const gpt52Service = new GPT52Service();
module.exports = gpt52Service;
