// backend/src/services/claudeService.js
// 🧠 Servicio para integración con Claude API (Anthropic)
// 🔧 UPDATED: Integración con datos de productos y calendario de negocio

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

  /**
   * Generar análisis profundo de email marketing
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