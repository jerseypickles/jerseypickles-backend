// backend/src/services/claudeService.js
// 🧠 Servicio para integración con Claude API (Anthropic)

const Anthropic = require('@anthropic-ai/sdk');

class ClaudeService {
  constructor() {
    this.client = null;
    this.initialized = false;
    this.model = 'claude-sonnet-4-20250514'; // Modelo optimizado costo/calidad
  }

  /**
   * Inicializar cliente de Anthropic
   */
  init() {
    if (this.initialized) return;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    
    if (!apiKey) {
      console.log('⚠️  ANTHROPIC_API_KEY no configurada - Claude AI deshabilitado');
      return;
    }

    try {
      this.client = new Anthropic({
        apiKey: apiKey
      });
      this.initialized = true;
      console.log('✅ Claude API inicializada');
    } catch (error) {
      console.error('❌ Error inicializando Claude API:', error.message);
    }
  }

  /**
   * Verificar si el servicio está disponible
   */
  isAvailable() {
    return this.initialized && this.client !== null;
  }

  /**
   * Generar insights de email marketing basados en métricas
   * @param {Object} metricsData - Datos compactos de métricas
   * @returns {Object} Insights generados por Claude
   */
  async generateEmailInsights(metricsData) {
    if (!this.isAvailable()) {
      console.log('⚠️  Claude API no disponible, usando insights básicos');
      return this.getFallbackInsights(metricsData);
    }

    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(metricsData);

    try {
      console.log('🧠 Llamando a Claude API para generar insights...');
      const startTime = Date.now();

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1500,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt }
        ]
      });

      const duration = Date.now() - startTime;
      console.log(`✅ Claude respondió en ${duration}ms`);

      // Parsear respuesta JSON
      const content = response.content[0].text;
      const insights = this.parseResponse(content);

      return {
        success: true,
        insights: insights.insights || [],
        summary: insights.summary || '',
        recommendations: insights.recommendations || [],
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
      return this.getFallbackInsights(metricsData);
    }
  }

  /**
   * System prompt con contexto del negocio
   */
  buildSystemPrompt() {
    return `Eres un experto en email marketing para Jersey Pickles, un e-commerce de pickles y olives gourmet basado en New Jersey.

CONTEXTO DEL NEGOCIO:
- Venden pickles artesanales, olives, y productos gourmet
- Clientes: restaurantes, delis, consumidores directos, wholesale
- Tono de marca: fresco, artesanal, familiar, calidad premium
- Ubicación: New Jersey, envían a todo USA

TU TAREA:
Analizar las métricas de email marketing y generar insights ACCIONABLES y ESPECÍFICOS para este negocio.

REGLAS:
1. Responde SOLO en JSON válido, sin markdown ni explicaciones
2. Máximo 5 insights, priorizados por impacto
3. Cada insight debe ser específico y accionable
4. Usa lenguaje directo, sin fluff
5. Relaciona los insights con el negocio de pickles/olives cuando sea relevante
6. Los insights deben estar en ESPAÑOL

FORMATO DE RESPUESTA (JSON):
{
  "insights": [
    {
      "priority": "high|medium|low",
      "category": "Health|Subjects|Timing|Lists|Revenue",
      "insight": "Observación específica basada en los datos",
      "action": "Acción concreta a tomar",
      "impact": "Impacto esperado si se implementa"
    }
  ],
  "summary": "Resumen ejecutivo de 1-2 oraciones del estado general",
  "recommendations": [
    "Recomendación prioritaria 1",
    "Recomendación prioritaria 2",
    "Recomendación prioritaria 3"
  ]
}`;
  }

  /**
   * Construir prompt con métricas
   */
  buildUserPrompt(data) {
    return `Analiza estas métricas de email marketing de Jersey Pickles (${data.period || 'últimos 30 días'}):

## SALUD GENERAL
- Open Rate: ${data.health?.openRate || 0}%
- Click Rate: ${data.health?.clickRate || 0}%
- Bounce Rate: ${data.health?.bounceRate || 0}%
- Unsubscribe Rate: ${data.health?.unsubRate || 0}%
- Delivery Rate: ${data.health?.deliveryRate || 0}%
- Campañas enviadas: ${data.health?.campaignsSent || 0}
- Total emails: ${data.health?.totalSent || 0}

## SUBJECTS (Top/Bottom performers)
Top performer: "${data.subjects?.top?.subject || 'N/A'}" - ${data.subjects?.top?.openRate || 0}% opens
Peor performer: "${data.subjects?.bottom?.subject || 'N/A'}" - ${data.subjects?.bottom?.openRate || 0}% opens
Patrones detectados:
- Emojis: ${data.subjects?.patterns?.emoji || 'sin datos'}
- Números: ${data.subjects?.patterns?.numbers || 'sin datos'}
- Urgencia: ${data.subjects?.patterns?.urgency || 'sin datos'}
- Preguntas: ${data.subjects?.patterns?.questions || 'sin datos'}

## LISTAS (Performance)
${data.lists?.length > 0 ? data.lists.map(l => 
  `- "${l.name}": ${l.openRate}% opens, ${l.clickRate}% clicks, $${l.revenue || 0} revenue, ${l.unsubRate || 0}% unsubs`
).join('\n') : 'Sin datos de listas'}

## TIMING
Mejor momento: ${data.timing?.best || 'N/A'}
Peor momento: ${data.timing?.worst || 'N/A'}
Horarios por engagement:
${data.timing?.topHours?.map(t => `- ${t.day} ${t.hour}: ${t.score}% engagement`).join('\n') || 'Sin datos'}

## REVENUE
Total atribuido: $${data.revenue?.total || 0}
Revenue por email: $${data.revenue?.perEmail || 0}
Órdenes atribuidas: ${data.revenue?.orders || 0}

## ALERTAS ACTUALES
${data.alerts?.length > 0 ? data.alerts.map(a => `- [${a.severity}] ${a.message}`).join('\n') : 'Sin alertas'}

Genera insights accionables basados en estos datos.`;
  }

  /**
   * Parsear respuesta de Claude
   */
  parseResponse(content) {
    try {
      // Intentar extraer JSON de la respuesta
      let jsonStr = content;
      
      // Si viene envuelto en markdown code blocks, extraer
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }
      
      // Limpiar y parsear
      jsonStr = jsonStr.trim();
      const parsed = JSON.parse(jsonStr);
      
      return parsed;
    } catch (error) {
      console.error('⚠️  Error parseando respuesta de Claude:', error.message);
      console.log('Respuesta raw:', content.substring(0, 500));
      
      // Intentar extraer insights básicos del texto
      return {
        insights: [{
          priority: 'medium',
          category: 'General',
          insight: 'No se pudo procesar la respuesta de AI correctamente',
          action: 'Revisa los logs del servidor'
        }],
        summary: content.substring(0, 200)
      };
    }
  }

  /**
   * Insights de fallback cuando Claude no está disponible
   */
  getFallbackInsights(data) {
    const insights = [];
    
    // Analizar health
    if (data.health) {
      if (data.health.bounceRate > 2) {
        insights.push({
          priority: 'high',
          category: 'Health',
          insight: `Tu bounce rate de ${data.health.bounceRate}% está por encima del umbral recomendado (2%)`,
          action: 'Limpia tu lista de emails bounced antes del próximo envío',
          impact: 'Mejorar deliverability y reputación de sender'
        });
      }
      
      if (data.health.openRate < 15) {
        insights.push({
          priority: 'high',
          category: 'Health',
          insight: `Tu open rate de ${data.health.openRate}% está por debajo del promedio de la industria`,
          action: 'Experimenta con diferentes subject lines y horarios de envío',
          impact: 'Aumentar engagement general'
        });
      }
    }
    
    // Analizar subjects
    if (data.subjects?.patterns) {
      const patterns = data.subjects.patterns;
      if (patterns.emoji && parseFloat(patterns.emoji) > 10) {
        insights.push({
          priority: 'medium',
          category: 'Subjects',
          insight: `Los emojis aumentan tus opens en ${patterns.emoji}`,
          action: 'Incluye emojis relevantes (🥒🫒) en tus próximos subjects',
          impact: 'Mayor visibilidad en inbox'
        });
      }
    }
    
    // Analizar listas
    if (data.lists?.length > 0) {
      const worstList = data.lists.reduce((worst, current) => 
        (!worst || current.openRate < worst.openRate) ? current : worst
      , null);
      
      if (worstList && worstList.openRate < 10) {
        insights.push({
          priority: 'medium',
          category: 'Lists',
          insight: `La lista "${worstList.name}" tiene solo ${worstList.openRate}% opens`,
          action: 'Considera una campaña de re-engagement o limpieza',
          impact: 'Mejorar métricas generales'
        });
      }
    }

    return {
      success: true,
      insights,
      summary: 'Insights generados por análisis básico (Claude API no disponible)',
      recommendations: [
        'Configura ANTHROPIC_API_KEY para insights más detallados',
        'Mantén tu lista limpia de bounces',
        'Experimenta con subject lines'
      ],
      generatedAt: new Date().toISOString(),
      model: 'fallback',
      tokensUsed: { input: 0, output: 0 }
    };
  }

  /**
   * Generar sugerencias de subject line
   */
  async suggestSubjectLines(context) {
    if (!this.isAvailable()) {
      return {
        success: false,
        message: 'Claude API no disponible'
      };
    }

    const prompt = `Genera 5 subject lines para un email de Jersey Pickles (pickles y olives gourmet).

Contexto:
- Tipo de campaña: ${context.campaignType || 'promocional'}
- Audiencia: ${context.audience || 'clientes generales'}
- Objetivo: ${context.objective || 'engagement'}
- Patrones que funcionan: ${context.patterns || 'emojis, números'}

Responde SOLO con JSON:
{
  "subjects": [
    { "subject": "...", "reason": "Por qué funcionaría" }
  ]
}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      });

      const content = response.content[0].text;
      return {
        success: true,
        ...this.parseResponse(content)
      };

    } catch (error) {
      console.error('Error generando subjects:', error.message);
      return {
        success: false,
        message: error.message
      };
    }
  }
}

// Singleton
const claudeService = new ClaudeService();

module.exports = claudeService;