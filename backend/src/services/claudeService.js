// backend/src/services/claudeService.js
// 🧠 Servicio para integración con Claude API (Anthropic)
// 🔧 UPDATED: Análisis profundo y narrativo en lugar de bullets genéricos

const Anthropic = require('@anthropic-ai/sdk');

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

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(metricsData);

    try {
      console.log('🧠 Llamando a Claude API para análisis profundo...');
      console.log(`   Model: ${this.model}`);
      console.log(`   System prompt length: ${systemPrompt.length} chars`);
      console.log(`   User prompt length: ${userPrompt.length} chars`);
      
      const startTime = Date.now();

      // Agregar timeout de 60 segundos
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Claude API timeout (60s)')), 60000);
      });

      const apiPromise = this.client.messages.create({
        model: this.model,
        max_tokens: 2500,
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

      return {
        success: true,
        ...analysis,
        generatedAt: new Date().toISOString(),
        model: this.model,
        tokensUsed: {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0
        },
        duration
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
   * System prompt optimizado para análisis profundo
   */
  buildSystemPrompt() {
    return `Eres el consultor de email marketing de Jersey Pickles, un e-commerce de pickles artesanales y olives gourmet en New Jersey.

TU ROL: Analizar datos y dar recomendaciones ESPECÍFICAS y ACCIONABLES, no genéricas.

CONTEXTO DEL NEGOCIO:
- Productos: Pickles artesanales, olives marinadas, productos gourmet
- Clientes: Consumidores D2C, restaurantes, delis, wholesale
- Ticket promedio: $35-50 por orden
- Estacionalidad: Picos en BBQ season (Mayo-Sept) y holidays (Nov-Dic)

BENCHMARKS INDUSTRIA FOOD & BEVERAGE:
- Open Rate bueno: 20-25%
- Click Rate bueno: 2-4%
- Bounce Rate saludable: <2%
- Unsub Rate saludable: <0.5%

INSTRUCCIONES:
1. Responde SOLO con JSON válido (sin markdown, sin \`\`\`)
2. Todo en ESPAÑOL
3. Sé específico - menciona datos reales del input
4. Prioriza acciones por impacto en revenue

FORMATO JSON REQUERIDO:
{
  "executiveSummary": "2-3 oraciones con el estado general y la acción más importante a tomar",
  "deepAnalysis": {
    "health": {
      "status": "healthy o warning o critical",
      "analysis": "Párrafo analizando las métricas vs benchmarks"
    },
    "subjects": {
      "analysis": "Párrafo sobre qué funciona en subjects y qué evitar"
    },
    "lists": {
      "analysis": "Párrafo sobre performance de listas y oportunidades"
    },
    "timing": {
      "analysis": "Párrafo sobre mejores horarios"
    },
    "revenue": {
      "analysis": "Párrafo sobre efectividad de email como canal de revenue"
    }
  },
  "actionPlan": [
    {
      "priority": 1,
      "title": "Título corto",
      "what": "Qué hacer específicamente",
      "why": "Por qué importa basado en los datos",
      "how": "Pasos concretos",
      "expectedImpact": "Resultado esperado"
    }
  ],
  "quickWins": ["Acción rápida 1", "Acción rápida 2"],
  "warnings": [
    {
      "severity": "critical o warning",
      "issue": "Problema",
      "consequence": "Qué pasa si no se arregla",
      "solution": "Cómo arreglarlo"
    }
  ],
  "opportunities": [
    {
      "opportunity": "Oportunidad identificada",
      "potential": "Impacto potencial",
      "effort": "low o medium o high"
    }
  ],
  "nextCampaignSuggestion": {
    "type": "Tipo de campaña",
    "targetList": "Lista recomendada",
    "subjectIdeas": ["Idea 1", "Idea 2", "Idea 3"],
    "bestTime": "Día y hora recomendados",
    "rationale": "Por qué esta campaña ahora"
  }
}`;
  }

  /**
   * User prompt con datos detallados
   */
  buildUserPrompt(data) {
    return `Analiza estos datos de email marketing de Jersey Pickles del ${data.period || 'último mes'}:

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

💀 PEOR PERFORMER:
   Subject: "${data.subjects?.bottom?.subject || 'N/A'}"
   Open Rate: ${data.subjects?.bottom?.openRate || 0}%

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

═══════════════════════════════════════════════════════════

Genera un análisis profundo y accionable. Recuerda:
- Sé específico con números y nombres de los datos
- Conecta insights con el negocio de pickles/gourmet
- Prioriza por impacto en revenue
- Da acciones concretas, no genéricas`;
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
        revenue: { analysis: revenueAnalysis }
      },
      actionPlan,
      quickWins,
      warnings,
      opportunities,
      nextCampaignSuggestion: data.timing?.best ? {
        type: 'Promocional',
        targetList: data.lists?.[0]?.name || 'Lista principal',
        subjectIdeas: [
          '🥒 Fresh batch just dropped - limited quantity',
          'Your pickle craving called... we answered',
          '15% OFF weekend special (ends Sunday)'
        ],
        bestTime: data.timing.best,
        rationale: 'Basado en tus mejores horarios históricos'
      } : null,
      generatedAt: new Date().toISOString(),
      model: 'fallback-analysis',
      tokensUsed: { input: 0, output: 0 },
      isFallback: true
    };
  }

  /**
   * Generar sugerencias de subject line
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

    const prompt = `Genera 5 subject lines para un email de Jersey Pickles (pickles y olives gourmet de New Jersey).

Contexto:
- Tipo: ${context.campaignType || 'promocional'}
- Audiencia: ${context.audience || 'clientes generales'}
- Objetivo: ${context.objective || 'engagement y ventas'}
- Lo que funciona para este negocio: ${context.patterns || 'emojis (especialmente 🥒🫒), números/descuentos, urgencia'}

Responde SOLO con JSON válido:
{
  "suggestions": [
    { 
      "subject": "El subject line completo", 
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
}

const claudeService = new ClaudeService();
module.exports = claudeService;