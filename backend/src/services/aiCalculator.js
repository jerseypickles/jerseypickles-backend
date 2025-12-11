// backend/src/services/aiCalculator.js
// 🧠 AI Calculator - Lógica de cálculo de insights
// 🔧 UPDATED: Enfocado en últimos 15 días + Detección de contexto con fecha actual

const Campaign = require('../models/Campaign');
const Customer = require('../models/Customer');
const EmailEvent = require('../models/EmailEvent');
const Order = require('../models/Order');
const Segment = require('../models/Segment');
const mongoose = require('mongoose');

class AICalculator {

  // ==================== CAMPAIGN CONTEXT DETECTION ====================
  
  /**
   * Obtener el contexto temporal actual (qué época/evento es relevante AHORA)
   */
  getCurrentSeasonalContext() {
    const now = new Date();
    const month = now.getMonth(); // 0-11
    const day = now.getDate();
    
    // Determinar la temporada/evento actual
    const contexts = [];
    
    // Diciembre: Pre-Holiday / Holiday Season
    if (month === 11) { // Diciembre
      if (day <= 15) {
        contexts.push({ event: 'Pre-Holiday Season', type: 'seasonal', priority: 1 });
        contexts.push({ event: 'Holiday Shopping', type: 'seasonal', priority: 2 });
      } else if (day <= 24) {
        contexts.push({ event: 'Last-Minute Holiday Shopping', type: 'seasonal', priority: 1 });
        contexts.push({ event: 'Christmas', type: 'holiday', priority: 2 });
      } else {
        contexts.push({ event: 'Post-Christmas Sales', type: 'seasonal', priority: 1 });
        contexts.push({ event: 'New Year', type: 'holiday', priority: 2 });
      }
    }
    
    // Noviembre: Thanksgiving / Black Friday / Cyber Monday
    if (month === 10) { // Noviembre
      if (day >= 20 && day <= 30) {
        contexts.push({ event: 'Black Friday/Cyber Monday', type: 'major_event', priority: 1 });
        contexts.push({ event: 'Thanksgiving', type: 'holiday', priority: 2 });
      } else if (day < 20) {
        contexts.push({ event: 'Pre-Black Friday', type: 'buildup', priority: 1 });
      }
    }
    
    // Enero: New Year / Post-Holiday
    if (month === 0) {
      if (day <= 7) {
        contexts.push({ event: 'New Year', type: 'holiday', priority: 1 });
      } else {
        contexts.push({ event: 'Post-Holiday', type: 'seasonal', priority: 1 });
      }
    }
    
    // Febrero: Valentine's Day
    if (month === 1) {
      if (day <= 14) {
        contexts.push({ event: 'Valentine\'s Day', type: 'holiday', priority: 1 });
      }
    }
    
    // Mayo-Septiembre: BBQ Season (importante para pickles!)
    if (month >= 4 && month <= 8) {
      contexts.push({ event: 'BBQ Season', type: 'seasonal', priority: 2 });
      contexts.push({ event: 'Grilling Season', type: 'seasonal', priority: 3 });
    }
    
    // Memorial Day (último lunes de mayo)
    if (month === 4 && day >= 25) {
      contexts.push({ event: 'Memorial Day', type: 'holiday', priority: 1 });
    }
    
    // July 4th
    if (month === 6 && day <= 7) {
      contexts.push({ event: 'July 4th', type: 'holiday', priority: 1 });
    }
    
    // Labor Day (primer lunes de septiembre)
    if (month === 8 && day <= 7) {
      contexts.push({ event: 'Labor Day', type: 'holiday', priority: 1 });
    }
    
    // Halloween
    if (month === 9 && day >= 15) {
      contexts.push({ event: 'Halloween', type: 'holiday', priority: 1 });
    }
    
    // National Pickle Day (14 de noviembre)
    if (month === 10 && day >= 10 && day <= 18) {
      contexts.push({ event: 'National Pickle Day', type: 'brand_event', priority: 1 });
    }
    
    return contexts.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Detecta el contexto/propósito de una campaña basado en su subject
   * Ahora considera la fecha actual para ser más inteligente
   */
  detectCampaignContext(subject, campaignName = '', campaignDate = null) {
    const subjectLower = (subject || '').toLowerCase();
    const nameLower = (campaignName || '').toLowerCase();
    const combined = `${subjectLower} ${nameLower}`;
    
    // Obtener contexto temporal actual
    const currentSeasonalContexts = this.getCurrentSeasonalContext();
    const currentEvent = currentSeasonalContexts[0]?.event || null;

    // === EVENTOS/FECHAS IMPORTANTES (ordenados por especificidad) ===
    const eventKeywords = {
      // Específicos primero
      'national pickle': { type: 'brand_event', event: 'National Pickle Day', expectation: 'high_engagement' },
      'pickle day': { type: 'brand_event', event: 'National Pickle Day', expectation: 'high_engagement' },
      'pickle week': { type: 'brand_event', event: 'Pickle Week', expectation: 'high_engagement' },
      
      // Major sales events
      'black friday': { type: 'major_event', event: 'Black Friday', expectation: 'high_revenue' },
      'cyber monday': { type: 'major_event', event: 'Cyber Monday', expectation: 'high_revenue' },
      
      // Holidays - Winter
      'christmas': { type: 'holiday', event: 'Christmas', expectation: 'high_revenue' },
      'navidad': { type: 'holiday', event: 'Navidad', expectation: 'high_revenue' },
      'holiday': { type: 'holiday', event: 'Holiday Season', expectation: 'high_revenue' },
      'holidays': { type: 'holiday', event: 'Holiday Season', expectation: 'high_revenue' },
      'festive': { type: 'holiday', event: 'Holiday Season', expectation: 'high_revenue' },
      'gift': { type: 'holiday', event: 'Gift-Giving Season', expectation: 'high_revenue' },
      'regalo': { type: 'holiday', event: 'Gift-Giving Season', expectation: 'high_revenue' },
      'new year': { type: 'holiday', event: 'New Year', expectation: 'moderate_revenue' },
      'año nuevo': { type: 'holiday', event: 'Año Nuevo', expectation: 'moderate_revenue' },
      
      // Other holidays
      'thanksgiving': { type: 'holiday', event: 'Thanksgiving', expectation: 'moderate_revenue' },
      'valentine': { type: 'holiday', event: 'Valentine\'s Day', expectation: 'moderate_revenue' },
      'san valentin': { type: 'holiday', event: 'San Valentín', expectation: 'moderate_revenue' },
      'mother\'s day': { type: 'holiday', event: 'Mother\'s Day', expectation: 'moderate_revenue' },
      'dia de la madre': { type: 'holiday', event: 'Día de la Madre', expectation: 'moderate_revenue' },
      'father\'s day': { type: 'holiday', event: 'Father\'s Day', expectation: 'moderate_revenue' },
      'dia del padre': { type: 'holiday', event: 'Día del Padre', expectation: 'moderate_revenue' },
      'july 4': { type: 'holiday', event: 'July 4th', expectation: 'moderate_revenue' },
      '4th of july': { type: 'holiday', event: 'July 4th', expectation: 'moderate_revenue' },
      'independence day': { type: 'holiday', event: 'July 4th', expectation: 'moderate_revenue' },
      'memorial day': { type: 'holiday', event: 'Memorial Day', expectation: 'moderate_revenue' },
      'labor day': { type: 'holiday', event: 'Labor Day', expectation: 'moderate_revenue' },
      'halloween': { type: 'holiday', event: 'Halloween', expectation: 'moderate_revenue' },
      'easter': { type: 'holiday', event: 'Easter', expectation: 'low_revenue' },
      'super bowl': { type: 'event', event: 'Super Bowl', expectation: 'moderate_revenue' },
      
      // Seasons (para pickles: BBQ es clave)
      'summer': { type: 'seasonal', event: 'Summer Season', expectation: 'bbq_season' },
      'verano': { type: 'seasonal', event: 'Summer Season', expectation: 'bbq_season' },
      'bbq': { type: 'seasonal', event: 'BBQ Season', expectation: 'bbq_season' },
      'barbecue': { type: 'seasonal', event: 'BBQ Season', expectation: 'bbq_season' },
      'grilling': { type: 'seasonal', event: 'Grilling Season', expectation: 'bbq_season' },
      'grill': { type: 'seasonal', event: 'Grilling Season', expectation: 'bbq_season' },
      'cookout': { type: 'seasonal', event: 'Cookout Season', expectation: 'bbq_season' },
      'picnic': { type: 'seasonal', event: 'Picnic Season', expectation: 'bbq_season' },
      'spring': { type: 'seasonal', event: 'Spring', expectation: 'moderate_revenue' },
      'primavera': { type: 'seasonal', event: 'Spring', expectation: 'moderate_revenue' },
      'fall': { type: 'seasonal', event: 'Fall Season', expectation: 'moderate_revenue' },
      'otoño': { type: 'seasonal', event: 'Fall Season', expectation: 'moderate_revenue' },
      'winter': { type: 'seasonal', event: 'Winter', expectation: 'moderate_revenue' },
      'invierno': { type: 'seasonal', event: 'Winter', expectation: 'moderate_revenue' }
    };

    // === BUILD-UP / ANTICIPACIÓN ===
    const buildupKeywords = [
      'coming soon', 'próximamente', 'get ready', 'prepárate', 'mark your calendar',
      'save the date', 'don\'t miss', 'no te pierdas', 'countdown', 'cuenta regresiva',
      'sneak peek', 'preview', 'adelanto', 'early access', 'acceso anticipado',
      'be the first', 'sé el primero', 'launching soon', 'coming', 'arrives',
      'announcement', 'anuncio', 'exciting news', 'big news', 'wait for it',
      'something special', 'algo especial', 'get excited', 'stay tuned',
      'almost here', 'ya casi', 'preparing', 'preparando'
    ];

    // === PROMOCIONES DIRECTAS ===
    const promoKeywords = [
      '% off', '%off', 'discount', 'descuento', 'sale', 'oferta', 'deal',
      'save $', 'ahorra', 'free shipping', 'envío gratis', 'bogo', 'buy one',
      'clearance', 'liquidación', 'flash sale', 'limited time', 'tiempo limitado',
      'expires', 'vence', 'last chance', 'última oportunidad', 'final hours',
      'ending soon', 'termina pronto', 'act now', 'actúa ahora', 'hurry',
      'exclusive offer', 'oferta exclusiva', 'special price', 'precio especial',
      'code:', 'código:', 'use code', 'usa el código', 'coupon', 'cupón',
      'promo', 'promoción'
    ];

    // === LANZAMIENTOS ===
    const launchKeywords = [
      'new', 'nuevo', 'nueva', 'just arrived', 'recién llegado', 'introducing', 'presentamos',
      'meet', 'conoce', 'fresh', 'fresco', 'now available', 'ya disponible',
      'just dropped', 'launch', 'lanzamiento', 'debut', 'first time', 'primera vez',
      'never before', 'brand new', 'hot off', 'just in'
    ];

    // === NEWSLETTER / CONTENIDO ===
    const contentKeywords = [
      'recipe', 'receta', 'how to', 'cómo', 'tips', 'consejos', 'guide', 'guía',
      'story', 'historia', 'behind', 'detrás', 'meet the', 'conoce a',
      'learn', 'aprende', 'discover', 'descubre', 'did you know', 'sabías',
      'weekly', 'semanal', 'monthly', 'mensual', 'newsletter', 'digest',
      'update', 'actualización'
    ];

    // === REENGAGEMENT ===
    const reengageKeywords = [
      'miss you', 'te extrañamos', 'come back', 'vuelve', 'haven\'t seen',
      'it\'s been', 'ha pasado', 'still there', 'sigues ahí', 'we miss',
      'return', 'regresa', 'where have you', 'dónde has estado'
    ];

    // === URGENCIA ===
    const urgencyKeywords = [
      'today only', 'solo hoy', 'ends tonight', 'termina esta noche',
      'last day', 'último día', 'hours left', 'horas restantes', 'almost gone',
      'selling fast', 'se agota', 'limited stock', 'stock limitado',
      'don\'t wait', 'no esperes', 'now or never', 'ahora o nunca',
      'ending', 'final', 'last'
    ];

    // Detectar contexto
    let context = {
      type: 'general',
      subType: null,
      event: null,
      expectation: 'standard',
      isBuildup: false,
      isPromo: false,
      isLaunch: false,
      isContent: false,
      isReengage: false,
      hasUrgency: false,
      detectedKeywords: [],
      currentSeasonalContext: currentEvent // 🔧 NUEVO: contexto temporal actual
    };

    // Check for events first (highest priority)
    for (const [keyword, data] of Object.entries(eventKeywords)) {
      if (combined.includes(keyword)) {
        context.type = data.type;
        context.event = data.event;
        context.expectation = data.expectation;
        context.detectedKeywords.push(keyword);
        break;
      }
    }

    // Check for build-up
    for (const keyword of buildupKeywords) {
      if (combined.includes(keyword)) {
        context.isBuildup = true;
        if (!context.subType) context.subType = 'buildup';
        if (!context.event && currentEvent) {
          // Si no detectamos evento específico pero hay contexto temporal, usarlo
          context.event = `Pre-${currentEvent}`;
          context.type = 'buildup';
        }
        context.expectation = 'engagement_focus';
        context.detectedKeywords.push(keyword);
        break;
      }
    }

    // Check for promo
    for (const keyword of promoKeywords) {
      if (combined.includes(keyword)) {
        context.isPromo = true;
        if (!context.subType) context.subType = 'promotional';
        context.detectedKeywords.push(keyword);
        break;
      }
    }

    // Check for launch
    for (const keyword of launchKeywords) {
      if (combined.includes(keyword)) {
        context.isLaunch = true;
        if (!context.subType) context.subType = 'launch';
        context.detectedKeywords.push(keyword);
        break;
      }
    }

    // Check for content
    for (const keyword of contentKeywords) {
      if (combined.includes(keyword)) {
        context.isContent = true;
        if (!context.subType) context.subType = 'content';
        context.expectation = 'engagement_focus';
        context.detectedKeywords.push(keyword);
        break;
      }
    }

    // Check for reengage
    for (const keyword of reengageKeywords) {
      if (combined.includes(keyword)) {
        context.isReengage = true;
        if (!context.subType) context.subType = 'reengagement';
        context.detectedKeywords.push(keyword);
        break;
      }
    }

    // Check for urgency
    for (const keyword of urgencyKeywords) {
      if (combined.includes(keyword)) {
        context.hasUrgency = true;
        context.detectedKeywords.push(keyword);
        break;
      }
    }

    // 🔧 Si no detectamos nada específico, usar contexto temporal actual
    if (context.type === 'general' && !context.event && currentEvent) {
      // Solo si hay señales de que es relevante al contexto actual
      if (context.isBuildup || context.isPromo) {
        context.event = currentEvent;
        context.type = 'seasonal';
      }
    }

    // Determine final type if still general
    if (context.type === 'general' && context.subType) {
      context.type = context.subType;
    }

    return context;
  }

  /**
   * Analiza el contexto estratégico de todas las campañas recientes
   * Detecta si estamos en período de build-up hacia algo importante
   * 🔧 PRIORIZA la fecha actual sobre menciones en subjects antiguos
   */
  analyzeStrategicContext(campaigns) {
    // Obtener contexto temporal actual - ESTO TIENE PRIORIDAD
    const currentSeasonalContexts = this.getCurrentSeasonalContext();
    const currentEvent = currentSeasonalContexts[0]?.event || null;
    const currentEventType = currentSeasonalContexts[0]?.type || null;
    
    const contexts = campaigns.map(c => ({
      ...this.detectCampaignContext(c.subject, c.name, c.sentAt),
      campaign: c.name,
      subject: c.subject,
      sentAt: c.sentAt,
      openRate: Math.min(c.stats?.openRate || 0, 100), // 🔧 Cap at 100%
      clickRate: Math.min(c.stats?.clickRate || 0, 100), // 🔧 Cap at 100%
      revenue: c.stats?.totalRevenue || 0,
      conversionRate: c.stats?.conversionRate || 0
    }));

    // Contar tipos
    const typeCounts = {};
    const eventMentions = {};
    let buildupCount = 0;
    let promoCount = 0;
    let contentCount = 0;

    // 🔧 Fecha límite para considerar eventos pasados como "actuales"
    // Si Black Friday fue hace más de 14 días, no lo consideramos relevante
    const now = new Date();
    const twoWeeksAgo = new Date(now);
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    contexts.forEach(ctx => {
      typeCounts[ctx.type] = (typeCounts[ctx.type] || 0) + 1;
      
      // 🔧 Solo contar eventos si son del contexto temporal actual
      // o si la campaña es reciente (últimos 7 días)
      if (ctx.event) {
        const campaignDate = new Date(ctx.sentAt);
        const isRecentCampaign = campaignDate >= twoWeeksAgo;
        
        // 🔧 Filtrar eventos pasados que ya no son relevantes
        const pastEvents = ['Black Friday', 'Cyber Monday', 'Thanksgiving'];
        const isPastEvent = pastEvents.includes(ctx.event);
        
        // Solo contar si:
        // - No es un evento pasado, O
        // - Es el evento actual del calendario, O
        // - La campaña es muy reciente (últimos 7 días)
        const sevenDaysAgo = new Date(now);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const isVeryRecent = campaignDate >= sevenDaysAgo;
        
        if (!isPastEvent || ctx.event === currentEvent || isVeryRecent) {
          eventMentions[ctx.event] = (eventMentions[ctx.event] || 0) + 1;
        }
      }
      
      if (ctx.isBuildup) buildupCount++;
      if (ctx.isPromo) promoCount++;
      if (ctx.isContent) contentCount++;
    });

    // 🔧 PRIORIDAD: Usar contexto temporal actual si existe
    let dominantEvent = currentEvent; // Empezar con el evento actual del calendario
    
    // Solo sobrescribir si hay un evento MUY mencionado en campañas recientes
    // Y ese evento coincide con el contexto actual
    let maxEventCount = 0;
    for (const [event, count] of Object.entries(eventMentions)) {
      if (count > maxEventCount && count >= 3) {
        // Solo usar este evento si es relevante al contexto actual
        if (event === currentEvent || !currentEvent) {
          dominantEvent = event;
          maxEventCount = count;
        }
      }
    }
    
    // 🔧 Si no hay evento dominante, usar el contexto temporal
    if (!dominantEvent) {
      dominantEvent = currentEvent;
    }

    // Determinar fase estratégica basada en FECHA ACTUAL primero
    let strategicPhase = 'normal';
    let phaseDescription = 'Operación normal de email marketing';

    // 🔧 Lógica mejorada: La fecha actual tiene PRIORIDAD
    if (currentEventType === 'major_event' || currentEventType === 'holiday' || currentEventType === 'seasonal') {
      // Estamos en una temporada importante según el calendario
      if (buildupCount >= 2 || (buildupCount >= 1 && promoCount === 0)) {
        strategicPhase = 'buildup';
        phaseDescription = `Período de anticipación hacia ${dominantEvent}. Alto engagement esperado, el revenue principal vendrá con las promociones.`;
      } else if (promoCount >= 2) {
        strategicPhase = 'event_active';
        phaseDescription = `${dominantEvent} activo. Momento de máximo revenue esperado.`;
      } else if (buildupCount > 0 && promoCount > 0) {
        strategicPhase = 'transition';
        phaseDescription = `Transición de build-up a ventas para ${dominantEvent}. Mix de engagement y conversión.`;
      } else {
        strategicPhase = 'pre_event';
        phaseDescription = `Preparándose para ${dominantEvent}. Buen momento para calentar a la audiencia.`;
      }
    } else if (buildupCount > promoCount && buildupCount >= 2) {
      strategicPhase = 'anticipation';
      phaseDescription = 'Construyendo anticipación. Normal ver alto engagement con bajo revenue.';
    } else if (contentCount > promoCount) {
      strategicPhase = 'nurturing';
      phaseDescription = 'Fase de nurturing/contenido. El foco es engagement, no revenue inmediato.';
    } else if (promoCount >= 3) {
      strategicPhase = 'sales_push';
      phaseDescription = 'Push de ventas activo. Se espera conversión directa.';
    }

    // 🔧 Calcular métricas con valores válidos (capped at 100%)
    const validOpenRates = contexts.map(c => c.openRate).filter(r => r <= 100);
    const validClickRates = contexts.map(c => c.clickRate).filter(r => r <= 100);
    
    const avgOpenRate = validOpenRates.length > 0 
      ? validOpenRates.reduce((sum, r) => sum + r, 0) / validOpenRates.length 
      : 0;
    const avgClickRate = validClickRates.length > 0 
      ? validClickRates.reduce((sum, r) => sum + r, 0) / validClickRates.length 
      : 0;
    const totalRevenue = contexts.reduce((sum, c) => sum + c.revenue, 0);
    const avgRevenue = totalRevenue / contexts.length || 0;

    // Interpretación contextual
    let metricsInterpretation = '';
    let isHealthy = true;

    if (strategicPhase === 'buildup' || strategicPhase === 'anticipation' || strategicPhase === 'pre_event') {
      if (avgOpenRate > 20 && avgRevenue < 50) {
        metricsInterpretation = `✅ NORMAL para fase de ${strategicPhase}: Alto engagement (${avgOpenRate.toFixed(1)}%) con bajo revenue es esperado. Tu audiencia está atenta y lista para ${dominantEvent || 'la oferta principal'}.`;
        isHealthy = true;
      } else if (avgOpenRate < 15) {
        metricsInterpretation = `⚠️ El engagement (${avgOpenRate.toFixed(1)}%) está bajo para una fase de anticipación. Considera subjects más intrigantes para calentar a tu audiencia antes de ${dominantEvent || 'las promociones'}.`;
        isHealthy = false;
      } else {
        metricsInterpretation = `✅ Buen engagement en fase de build-up hacia ${dominantEvent || 'próximo evento'}.`;
        isHealthy = true;
      }
    } else if (strategicPhase === 'event_active' || strategicPhase === 'sales_push') {
      if (avgOpenRate > 20 && avgRevenue < 100) {
        metricsInterpretation = `⚠️ Alto engagement (${avgOpenRate.toFixed(1)}%) pero bajo revenue durante ${dominantEvent || 'promoción activa'}. Revisa: ofertas, landing pages, proceso de checkout.`;
        isHealthy = false;
      } else if (avgOpenRate > 20 && avgRevenue > 200) {
        metricsInterpretation = `✅ Excelente! Alto engagement (${avgOpenRate.toFixed(1)}%) convirtiendo en $${totalRevenue.toFixed(0)} revenue. ${dominantEvent || 'La promoción'} está funcionando.`;
        isHealthy = true;
      } else {
        metricsInterpretation = `📊 Performance mixto durante ${dominantEvent || 'promoción'}. Monitorea conversión.`;
        isHealthy = true;
      }
    } else if (strategicPhase === 'nurturing') {
      if (avgOpenRate > 18) {
        metricsInterpretation = `✅ Buen engagement (${avgOpenRate.toFixed(1)}%) en contenido. Estás construyendo relación con tu audiencia.`;
        isHealthy = true;
      } else {
        metricsInterpretation = `📊 Engagement moderado en fase de nurturing. Prueba contenido más relevante.`;
        isHealthy = true;
      }
    } else {
      if (avgOpenRate > 20) {
        metricsInterpretation = `✅ Buen engagement general (${avgOpenRate.toFixed(1)}%).`;
        isHealthy = true;
      } else if (avgOpenRate > 15) {
        metricsInterpretation = `📊 Engagement aceptable (${avgOpenRate.toFixed(1)}%). Hay espacio para mejorar subjects.`;
        isHealthy = true;
      } else {
        metricsInterpretation = `⚠️ Engagement bajo (${avgOpenRate.toFixed(1)}%). Revisa subjects y timing de envío.`;
        isHealthy = false;
      }
    }

    return {
      campaigns: contexts,
      summary: {
        totalCampaigns: campaigns.length,
        typeCounts,
        eventMentions,
        buildupCampaigns: buildupCount,
        promoCampaigns: promoCount,
        contentCampaigns: contentCount
      },
      // 🔧 Info temporal actual
      currentDate: new Date().toISOString(),
      currentSeasonalContext: currentSeasonalContexts[0] || null,
      strategicPhase,
      phaseDescription,
      dominantEvent,
      metrics: {
        avgOpenRate: parseFloat(Math.min(avgOpenRate, 100).toFixed(2)), // 🔧 Capped
        avgClickRate: parseFloat(Math.min(avgClickRate, 100).toFixed(2)), // 🔧 Capped
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        avgRevenuePerCampaign: parseFloat(avgRevenue.toFixed(2))
      },
      interpretation: metricsInterpretation,
      isHealthyForPhase: isHealthy
    };
  }

  // ==================== HELPERS ====================
  
  getDateRange(days, endDate = new Date()) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    
    const start = new Date(end);
    start.setDate(start.getDate() - days);
    start.setHours(0, 0, 0, 0);
    
    return { start, end };
  }

  // ==================== 1. HEALTH CHECK (últimos 7 días) ====================

  async calculateHealthCheck(options = {}) {
    const { alertThresholds = {} } = options;
    
    const thresholds = {
      bounceRate: alertThresholds.bounceRate || 5,
      unsubRate: alertThresholds.unsubRate || 1,
      openRateMin: alertThresholds.openRateMin || 15,
      complaintRateMax: alertThresholds.complaintRateMax || 0.1
    };

    // Últimos 7 días
    const { start: currentStart } = this.getDateRange(7);
    
    // 7-14 días atrás (para comparación)
    const { start: prevStart, end: prevEnd } = this.getDateRange(14);

    // Stats actuales
    const currentStats = await EmailEvent.aggregate([
      { $match: { eventDate: { $gte: currentStart } } },
      { $group: { _id: '$eventType', count: { $sum: 1 } } }
    ]);

    // Stats anteriores
    const previousStats = await EmailEvent.aggregate([
      { $match: { eventDate: { $gte: prevStart, $lt: currentStart } } },
      { $group: { _id: '$eventType', count: { $sum: 1 } } }
    ]);

    const getCount = (stats, type) => stats.find(s => s._id === type)?.count || 0;

    const current = {
      sent: getCount(currentStats, 'sent'),
      delivered: getCount(currentStats, 'delivered'),
      opened: getCount(currentStats, 'opened'),
      clicked: getCount(currentStats, 'clicked'),
      bounced: getCount(currentStats, 'bounced'),
      complained: getCount(currentStats, 'complained'),
      unsubscribed: getCount(currentStats, 'unsubscribed')
    };

    const previous = {
      sent: getCount(previousStats, 'sent'),
      opened: getCount(previousStats, 'opened'),
      bounced: getCount(previousStats, 'bounced'),
      unsubscribed: getCount(previousStats, 'unsubscribed')
    };

    // Calcular rates
    const rates = {
      deliveryRate: current.sent > 0 ? ((current.delivered || current.sent - current.bounced) / current.sent) * 100 : 0,
      bounceRate: current.sent > 0 ? (current.bounced / current.sent) * 100 : 0,
      openRate: current.sent > 0 ? (current.opened / current.sent) * 100 : 0,
      clickRate: current.opened > 0 ? (current.clicked / current.opened) * 100 : 0,
      unsubRate: current.sent > 0 ? (current.unsubscribed / current.sent) * 100 : 0,
      complaintRate: current.sent > 0 ? (current.complained / current.sent) * 100 : 0
    };

    const prevRates = {
      bounceRate: previous.sent > 0 ? (previous.bounced / previous.sent) * 100 : 0,
      openRate: previous.sent > 0 ? (previous.opened / previous.sent) * 100 : 0,
      unsubRate: previous.sent > 0 ? (previous.unsubscribed / previous.sent) * 100 : 0
    };

    // Generar alertas
    const alerts = [];

    if (rates.bounceRate > thresholds.bounceRate) {
      alerts.push({
        type: 'bounce_rate',
        severity: rates.bounceRate > thresholds.bounceRate * 2 ? 'critical' : 'warning',
        message: `Bounce rate alto: ${rates.bounceRate.toFixed(2)}%`,
        action: 'Revisa la lista de bounces y limpia emails inválidos',
        threshold: thresholds.bounceRate,
        currentValue: rates.bounceRate
      });
    }

    if (rates.unsubRate > thresholds.unsubRate) {
      alerts.push({
        type: 'unsub_rate',
        severity: 'warning',
        message: `Unsubscribe rate elevado: ${rates.unsubRate.toFixed(2)}%`,
        action: 'Revisa frecuencia de envío y relevancia del contenido',
        threshold: thresholds.unsubRate,
        currentValue: rates.unsubRate
      });
    }

    if (rates.openRate < thresholds.openRateMin && current.sent > 100) {
      alerts.push({
        type: 'open_rate',
        severity: 'warning',
        message: `Open rate bajo: ${rates.openRate.toFixed(2)}%`,
        action: 'Mejora tus subject lines y revisa horarios de envío',
        threshold: thresholds.openRateMin,
        currentValue: rates.openRate
      });
    }

    if (rates.complaintRate > thresholds.complaintRateMax) {
      alerts.push({
        type: 'complaint_rate',
        severity: 'critical',
        message: `Complaint rate alto: ${rates.complaintRate.toFixed(3)}%`,
        action: 'URGENTE: Revisa tu proceso de opt-in y contenido',
        threshold: thresholds.complaintRateMax,
        currentValue: rates.complaintRate
      });
    }

    // Calcular health score
    let healthScore = 100;
    if (rates.bounceRate > thresholds.bounceRate) healthScore -= 20;
    if (rates.bounceRate > thresholds.bounceRate * 2) healthScore -= 15;
    if (rates.unsubRate > thresholds.unsubRate) healthScore -= 10;
    if (rates.unsubRate > thresholds.unsubRate * 2) healthScore -= 10;
    if (rates.openRate < thresholds.openRateMin) healthScore -= 15;
    if (rates.complaintRate > 0.05) healthScore -= 20;
    if (rates.complaintRate > 0.1) healthScore -= 20;
    healthScore = Math.max(0, healthScore);

    const status = healthScore >= 80 ? 'healthy' : healthScore >= 60 ? 'warning' : 'critical';

    // Bounce stats
    const bounceStats = await Customer.getBounceStats();

    // Contar campañas recientes
    const recentCampaigns = await Campaign.countDocuments({
      status: 'sent',
      sentAt: { $gte: currentStart }
    });

    return {
      success: true,
      period: { days: 7, start: currentStart, end: new Date() },
      health: {
        score: healthScore,
        status,
        message: status === 'healthy' ? '✅ Tu email marketing está saludable' :
                 status === 'warning' ? '⚠️ Hay métricas que requieren atención' :
                 '🚨 Problemas críticos detectados'
      },
      summary: {
        score: healthScore,
        status,
        primaryMetric: { name: 'healthScore', value: healthScore },
        alertsCount: alerts.length
      },
      metrics: {
        current,
        campaigns: { sent: recentCampaigns },
        totals: { sent: current.sent },
        rates: {
          deliveryRate: rates.deliveryRate.toFixed(2),
          bounceRate: rates.bounceRate.toFixed(2),
          openRate: rates.openRate.toFixed(2),
          clickRate: rates.clickRate.toFixed(2),
          unsubRate: rates.unsubRate.toFixed(2),
          complaintRate: rates.complaintRate.toFixed(3)
        },
        changes: {
          openRateChange: (rates.openRate - prevRates.openRate).toFixed(2),
          bounceRateChange: (rates.bounceRate - prevRates.bounceRate).toFixed(2)
        }
      },
      bounceBreakdown: bounceStats,
      alerts,
      thresholds
    };
  }

  // ==================== 2. SUBJECT LINE ANALYSIS (últimos 15 días) ====================

  async calculateSubjectAnalysis(options = {}) {
    const { days = 15, minSent = 50 } = options;
    
    const { start } = this.getDateRange(days);

    const campaigns = await Campaign.find({
      status: 'sent',
      sentAt: { $gte: start },
      'stats.sent': { $gte: minSent }
    }).select('name subject stats sentAt').sort({ sentAt: -1 }).lean();

    if (campaigns.length < 3) {
      return {
        success: false,
        message: `Necesitas al menos 3 campañas con +${minSent} envíos en los últimos ${days} días para análisis`,
        summary: { status: 'insufficient_data', campaignsAnalyzed: campaigns.length }
      };
    }

    // 🔧 SANITIZAR DATOS: Corregir open rates imposibles
    const sanitizedCampaigns = campaigns.map(c => {
      const sent = c.stats?.sent || 0;
      const opened = c.stats?.opened || 0;
      const clicked = c.stats?.clicked || 0;
      
      // Recalcular rates para evitar datos corruptos
      // Open rate no puede ser > 100%
      let openRate = c.stats?.openRate || 0;
      if (openRate > 100 || openRate < 0) {
        // Recalcular desde los números base
        openRate = sent > 0 ? Math.min((opened / sent) * 100, 100) : 0;
        console.log(`⚠️ Corrigiendo open rate corrupto en "${c.name}": ${c.stats?.openRate}% → ${openRate.toFixed(2)}%`);
      }
      
      let clickRate = c.stats?.clickRate || 0;
      if (clickRate > 100 || clickRate < 0) {
        clickRate = opened > 0 ? Math.min((clicked / opened) * 100, 100) : 0;
      }
      
      return {
        ...c,
        stats: {
          ...c.stats,
          openRate: Math.min(Math.max(openRate, 0), 100),
          clickRate: Math.min(Math.max(clickRate, 0), 100)
        }
      };
    });

    // === AGREGAR CONTEXTO A CADA CAMPAÑA ===
    const campaignsWithContext = sanitizedCampaigns.map(c => ({
      ...c,
      context: this.detectCampaignContext(c.subject, c.name)
    }));

    // Patterns a analizar
    const urgencyWords = ['hoy', 'ahora', 'último', 'última', 'urgente', 'limitado', 
                          'today', 'now', 'last', 'urgent', 'limited', 'ends', 'flash',
                          'only', 'solo', 'ending', 'final'];
    
    const patterns = {
      length: { short: [], medium: [], long: [] },
      hasEmoji: { yes: [], no: [] },
      hasNumber: { yes: [], no: [] },
      hasUrgency: { yes: [], no: [] },
      hasQuestion: { yes: [], no: [] }
    };

    campaignsWithContext.forEach(campaign => {
      const subject = campaign.subject || '';
      const openRate = campaign.stats?.openRate || 0;
      const data = { 
        subject, 
        openRate, 
        sent: campaign.stats?.sent || 0,
        sentAt: campaign.sentAt,
        name: campaign.name,
        context: campaign.context
      };

      // Length
      if (subject.length <= 30) patterns.length.short.push(data);
      else if (subject.length <= 50) patterns.length.medium.push(data);
      else patterns.length.long.push(data);

      // Emoji
      const hasEmoji = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/u.test(subject);
      patterns.hasEmoji[hasEmoji ? 'yes' : 'no'].push(data);

      // Number
      const hasNumber = /\d+%?/.test(subject);
      patterns.hasNumber[hasNumber ? 'yes' : 'no'].push(data);

      // Urgency
      const hasUrgency = urgencyWords.some(w => subject.toLowerCase().includes(w));
      patterns.hasUrgency[hasUrgency ? 'yes' : 'no'].push(data);

      // Question
      patterns.hasQuestion[subject.includes('?') ? 'yes' : 'no'].push(data);
    });

    // Calcular promedios
    const calcAvg = (arr) => arr.length > 0 
      ? arr.reduce((sum, i) => sum + i.openRate, 0) / arr.length 
      : 0;

    const insights = {};

    // Length insights
    insights.length = {
      short: { count: patterns.length.short.length, avgOpenRate: calcAvg(patterns.length.short) },
      medium: { count: patterns.length.medium.length, avgOpenRate: calcAvg(patterns.length.medium) },
      long: { count: patterns.length.long.length, avgOpenRate: calcAvg(patterns.length.long) }
    };

    // Boolean patterns
    ['hasEmoji', 'hasNumber', 'hasUrgency', 'hasQuestion'].forEach(pattern => {
      const withRate = calcAvg(patterns[pattern].yes);
      const withoutRate = calcAvg(patterns[pattern].no);
      const lift = withoutRate > 0 ? ((withRate - withoutRate) / withoutRate * 100) : 0;

      insights[pattern] = {
        withPattern: { count: patterns[pattern].yes.length, avgOpenRate: withRate },
        withoutPattern: { count: patterns[pattern].no.length, avgOpenRate: withoutRate },
        lift: lift.toFixed(1)
      };
    });

    // Top/Low performers (ya sanitizados)
    const sorted = [...campaignsWithContext].sort((a, b) => (b.stats?.openRate || 0) - (a.stats?.openRate || 0));
    const topPerformers = sorted.slice(0, 5).map(c => ({
      subject: c.subject,
      openRate: parseFloat((c.stats?.openRate || 0).toFixed(2)),
      clickRate: parseFloat((c.stats?.clickRate || 0).toFixed(2)),
      sent: c.stats?.sent || 0,
      sentAt: c.sentAt,
      name: c.name,
      context: c.context
    }));
    const lowPerformers = sorted.slice(-5).reverse().map(c => ({
      subject: c.subject,
      openRate: parseFloat((c.stats?.openRate || 0).toFixed(2)),
      clickRate: parseFloat((c.stats?.clickRate || 0).toFixed(2)),
      sent: c.stats?.sent || 0,
      sentAt: c.sentAt,
      name: c.name,
      context: c.context
    }));

    const avgOpenRate = calcAvg(campaignsWithContext.map(c => ({ openRate: c.stats?.openRate || 0 })));

    // === ANÁLISIS ESTRATÉGICO ===
    const strategicContext = this.analyzeStrategicContext(sanitizedCampaigns);

    // Generar recomendaciones
    const recommendations = [];
    const patternLabels = {
      hasEmoji: 'emojis',
      hasNumber: 'números/porcentajes',
      hasUrgency: 'palabras de urgencia',
      hasQuestion: 'preguntas'
    };

    ['hasEmoji', 'hasNumber', 'hasUrgency', 'hasQuestion'].forEach(pattern => {
      const lift = parseFloat(insights[pattern].lift);
      if (Math.abs(lift) > 10 && insights[pattern].withPattern.count >= 2) {
        recommendations.push({
          type: pattern,
          priority: lift > 20 ? 'high' : lift > 0 ? 'medium' : 'low',
          insight: lift > 0 
            ? `Usar ${patternLabels[pattern]} aumenta open rate en +${lift.toFixed(0)}%`
            : `Los ${patternLabels[pattern]} reducen open rate en ${lift.toFixed(0)}%`,
          action: lift > 0 
            ? `Incluye ${patternLabels[pattern]} en tus subjects`
            : `Evita ${patternLabels[pattern]} en tus subjects`
        });
      }
    });

    // Best length recommendation
    const bestLength = Object.entries(insights.length)
      .filter(([_, v]) => v.count >= 2)
      .sort((a, b) => b[1].avgOpenRate - a[1].avgOpenRate)[0];
    
    if (bestLength) {
      const labels = { short: '≤30 chars', medium: '31-50 chars', long: '>50 chars' };
      recommendations.unshift({
        type: 'length',
        priority: 'high',
        insight: `Subjects ${labels[bestLength[0]]} tienen ${bestLength[1].avgOpenRate.toFixed(1)}% open rate`,
        action: `Mantén tus subjects en el rango ${labels[bestLength[0]]}`
      });
    }

    recommendations.sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return order[a.priority] - order[b.priority];
    });

    return {
      success: true,
      period: { days, start, end: new Date() },
      summary: {
        campaignsAnalyzed: campaigns.length,
        avgOpenRate: parseFloat(Math.min(avgOpenRate, 100).toFixed(2)), // 🔧 Capped
        bestOpenRate: parseFloat(Math.min(topPerformers[0]?.openRate || 0, 100).toFixed(2)),
        worstOpenRate: parseFloat(Math.min(lowPerformers[0]?.openRate || 0, 100).toFixed(2)),
        score: Math.round(Math.min(avgOpenRate, 100) * 3),
        status: avgOpenRate > 25 ? 'healthy' : avgOpenRate > 15 ? 'warning' : 'critical',
        primaryMetric: { name: 'avgOpenRate', value: Math.min(avgOpenRate, 100) }
      },
      // === NUEVO: Contexto estratégico ===
      strategicContext,
      insights,
      topPerformers,
      lowPerformers,
      topInsights: recommendations.slice(0, 5),
      rawPatternCounts: {
        withEmoji: patterns.hasEmoji.yes.length,
        withNumber: patterns.hasNumber.yes.length,
        withUrgency: patterns.hasUrgency.yes.length,
        withQuestion: patterns.hasQuestion.yes.length
      }
    };
  }

  // ==================== 3. SEND TIMING (últimos 15 días) ====================

  async calculateSendTiming(options = {}) {
    const { days = 15, segmentId = null, metric = 'opened' } = options;
    
    const { start } = this.getDateRange(days);

    const matchStage = {
      eventDate: { $gte: start },
      eventType: { $in: ['sent', 'opened', 'clicked'] }
    };

    if (segmentId) {
      const segmentCampaigns = await Campaign.find({ segment: segmentId }).select('_id');
      matchStage.campaign = { $in: segmentCampaigns.map(c => c._id) };
    }

    const events = await EmailEvent.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: {
            dayOfWeek: { $dayOfWeek: '$eventDate' },
            hour: { $hour: '$eventDate' },
            type: '$eventType'
          },
          count: { $sum: 1 }
        }
      }
    ]);

    const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const heatmap = [];

    for (let day = 1; day <= 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const sent = events.find(e => e._id.dayOfWeek === day && e._id.hour === hour && e._id.type === 'sent')?.count || 0;
        const opened = events.find(e => e._id.dayOfWeek === day && e._id.hour === hour && e._id.type === 'opened')?.count || 0;
        const clicked = events.find(e => e._id.dayOfWeek === day && e._id.hour === hour && e._id.type === 'clicked')?.count || 0;

        const openRate = sent > 0 ? (opened / sent) * 100 : 0;
        const clickRate = sent > 0 ? (clicked / sent) * 100 : 0;

        heatmap.push({
          day: day - 1,
          dayName: dayNames[day - 1],
          hour,
          hourLabel: `${hour.toString().padStart(2, '0')}:00`,
          sent,
          opened,
          clicked,
          openRate: parseFloat(openRate.toFixed(2)),
          clickRate: parseFloat(clickRate.toFixed(2)),
          score: metric === 'clicked' ? clickRate : openRate
        });
      }
    }

    // Best times
    const significant = heatmap.filter(h => h.sent >= 20);
    const sorted = [...significant].sort((a, b) => b.score - a.score);

    const bestTimes = sorted.slice(0, 5).map(t => ({
      day: t.dayName,
      hour: t.hourLabel,
      score: t.score.toFixed(2) + '%',
      sampleSize: t.sent,
      opens: t.opened,
      clicks: t.clicked
    }));

    const worstTimes = sorted.slice(-3).reverse().map(t => ({
      day: t.dayName,
      hour: t.hourLabel,
      score: t.score.toFixed(2) + '%',
      sampleSize: t.sent
    }));

    // Day averages
    const dayAverages = dayNames.map((name, idx) => {
      const daySlots = heatmap.filter(h => h.day === idx && h.sent >= 5);
      const avgScore = daySlots.length > 0 
        ? daySlots.reduce((sum, s) => sum + s.score, 0) / daySlots.length 
        : 0;
      const totalSent = daySlots.reduce((sum, s) => sum + s.sent, 0);
      const bestSlot = daySlots.sort((a, b) => b.score - a.score)[0];
      
      return {
        day: name,
        avgScore: avgScore.toFixed(2),
        totalSent,
        bestHour: bestSlot?.hourLabel || 'N/A'
      };
    });

    const recommendation = bestTimes.length > 0
      ? `Mejor momento: ${bestTimes[0].day} a las ${bestTimes[0].hour} (${bestTimes[0].score} ${metric} rate)`
      : 'No hay suficientes datos para una recomendación';

    return {
      success: true,
      period: { days, start, end: new Date() },
      metric,
      segmentId: segmentId || 'all',
      summary: {
        score: bestTimes.length > 0 ? Math.round(parseFloat(bestTimes[0].score)) : 0,
        status: bestTimes.length >= 3 ? 'healthy' : 'insufficient_data',
        primaryMetric: { name: 'bestOpenRate', value: bestTimes[0]?.score || '0%' }
      },
      recommendation,
      bestTimes,
      worstTimes,
      dayAverages,
      heatmap,
      totalEventsAnalyzed: events.reduce((sum, e) => sum + e.count, 0),
      topInsights: bestTimes.length > 0 ? [{
        category: 'Send Timing',
        priority: 'high',
        insight: recommendation,
        action: 'Programa tus campañas importantes para este horario'
      }] : []
    };
  }

  // ==================== 4. LIST PERFORMANCE (últimos 15 días) ====================

  async calculateListPerformance(options = {}) {
    const { days = 15 } = options;
    
    const { start } = this.getDateRange(days);

    const campaignData = await Campaign.aggregate([
      {
        $match: {
          status: 'sent',
          sentAt: { $gte: start },
          targetType: 'list',
          list: { $exists: true, $ne: null }
        }
      },
      {
        $lookup: {
          from: 'lists',
          localField: 'list',
          foreignField: '_id',
          as: 'listData'
        }
      },
      { $unwind: '$listData' },
      {
        $group: {
          _id: '$list',
          listName: { $first: '$listData.name' },
          listMemberCount: { $first: '$listData.memberCount' },
          campaigns: { $sum: 1 },
          campaignNames: { $push: '$name' },
          totalSent: { $sum: '$stats.sent' },
          totalOpened: { $sum: '$stats.opened' },
          totalClicked: { $sum: '$stats.clicked' },
          totalBounced: { $sum: '$stats.bounced' },
          totalUnsubscribed: { $sum: '$stats.unsubscribed' },
          totalRevenue: { $sum: '$stats.totalRevenue' },
          totalPurchased: { $sum: '$stats.purchased' }
        }
      },
      { $sort: { totalRevenue: -1 } }
    ]);

    if (campaignData.length === 0) {
      return {
        success: false,
        message: `No hay suficientes datos de campañas por lista en los últimos ${days} días`,
        summary: { status: 'insufficient_data' }
      };
    }

    const lists = campaignData.map(list => {
      const openRate = list.totalSent > 0 ? (list.totalOpened / list.totalSent) * 100 : 0;
      const clickRate = list.totalSent > 0 ? (list.totalClicked / list.totalSent) * 100 : 0;
      const conversionRate = list.totalSent > 0 ? (list.totalPurchased / list.totalSent) * 100 : 0;
      const revenuePerEmail = list.totalSent > 0 ? list.totalRevenue / list.totalSent : 0;
      const bounceRate = list.totalSent > 0 ? (list.totalBounced / list.totalSent) * 100 : 0;
      const unsubRate = list.totalSent > 0 ? (list.totalUnsubscribed / list.totalSent) * 100 : 0;

      return {
        listId: list._id,
        name: list.listName,
        memberCount: list.listMemberCount,
        campaigns: list.campaigns,
        recentCampaigns: list.campaignNames?.slice(0, 3) || [],
        metrics: {
          sent: list.totalSent,
          opened: list.totalOpened,
          clicked: list.totalClicked,
          purchased: list.totalPurchased,
          bounced: list.totalBounced,
          unsubscribed: list.totalUnsubscribed
        },
        rates: {
          openRate: parseFloat(openRate.toFixed(2)),
          clickRate: parseFloat(clickRate.toFixed(2)),
          conversionRate: parseFloat(conversionRate.toFixed(3)),
          bounceRate: parseFloat(bounceRate.toFixed(2)),
          unsubRate: parseFloat(unsubRate.toFixed(2))
        },
        revenue: {
          total: parseFloat((list.totalRevenue || 0).toFixed(2)),
          perEmail: parseFloat(revenuePerEmail.toFixed(3)),
          avgOrderValue: list.totalPurchased > 0 
            ? parseFloat((list.totalRevenue / list.totalPurchased).toFixed(2))
            : 0
        },
        score: parseFloat((openRate * 0.3 + clickRate * 0.3 + conversionRate * 10 + revenuePerEmail * 2).toFixed(2))
      };
    });

    lists.sort((a, b) => b.score - a.score);

    const avgOpenRate = lists.reduce((sum, l) => sum + l.rates.openRate, 0) / lists.length;
    const avgClickRate = lists.reduce((sum, l) => sum + l.rates.clickRate, 0) / lists.length;
    const avgRevenue = lists.reduce((sum, l) => sum + l.revenue.perEmail, 0) / lists.length;
    const totalRevenue = lists.reduce((sum, l) => sum + l.revenue.total, 0);

    // Generar insights
    const topInsights = [];

    if (lists[0]) {
      topInsights.push({
        category: 'Lists',
        priority: 'high',
        list: lists[0].name,
        insight: `"${lists[0].name}" es tu lista más valiosa con $${lists[0].revenue.perEmail.toFixed(3)}/email`,
        action: 'Prioriza esta lista para campañas importantes'
      });
    }

    // High engagement, low conversion
    const opportunity = lists.find(l => 
      l.rates.openRate > avgOpenRate * 1.2 && l.rates.conversionRate < 0.1
    );
    if (opportunity) {
      topInsights.push({
        category: 'Lists',
        priority: 'high',
        list: opportunity.name,
        insight: `"${opportunity.name}" tiene alto engagement (${opportunity.rates.openRate}%) pero baja conversión`,
        action: 'Prueba ofertas más agresivas para esta lista'
      });
    }

    // High unsub
    const highUnsub = lists.find(l => l.rates.unsubRate > 1);
    if (highUnsub) {
      topInsights.push({
        category: 'Lists',
        priority: 'medium',
        list: highUnsub.name,
        insight: `"${highUnsub.name}" tiene ${highUnsub.rates.unsubRate}% unsubscribe rate`,
        action: 'Reduce frecuencia de envío para esta lista'
      });
    }

    return {
      success: true,
      period: { days, start, end: new Date() },
      summary: {
        totalLists: lists.length,
        avgOpenRate: parseFloat(avgOpenRate.toFixed(2)),
        avgClickRate: parseFloat(avgClickRate.toFixed(2)),
        avgRevenuePerEmail: parseFloat(avgRevenue.toFixed(3)),
        totalRevenue: totalRevenue.toFixed(2),
        score: Math.round(avgOpenRate * 2 + avgRevenue * 100),
        status: lists.length >= 1 ? 'healthy' : 'warning',
        primaryMetric: { name: 'totalRevenue', value: totalRevenue }
      },
      lists,
      topInsights,
      rankings: {
        byRevenue: lists.slice(0, 5).map(l => ({ name: l.name, value: l.revenue.total })),
        byOpenRate: [...lists].sort((a, b) => b.rates.openRate - a.rates.openRate).slice(0, 5).map(l => ({ name: l.name, value: l.rates.openRate })),
        byConversion: [...lists].sort((a, b) => b.rates.conversionRate - a.rates.conversionRate).slice(0, 5).map(l => ({ name: l.name, value: l.rates.conversionRate }))
      }
    };
  }

  // ==================== 5. COMPREHENSIVE REPORT ====================

  async calculateComprehensiveReport(options = {}) {
    const { days = 15 } = options;

    const [healthCheck, subjectAnalysis, sendTiming, listPerf] = await Promise.all([
      this.calculateHealthCheck(),
      this.calculateSubjectAnalysis({ days }),
      this.calculateSendTiming({ days }),
      this.calculateListPerformance({ days })
    ]);

    // Consolidar top insights
    const allInsights = [];

    if (subjectAnalysis.success && subjectAnalysis.topInsights) {
      subjectAnalysis.topInsights.slice(0, 2).forEach(i => {
        allInsights.push({ ...i, category: 'Subject Lines' });
      });
    }

    if (sendTiming.success && sendTiming.topInsights) {
      sendTiming.topInsights.slice(0, 1).forEach(i => {
        allInsights.push({ ...i, category: 'Send Timing' });
      });
    }

    if (listPerf.success && listPerf.topInsights) {
      listPerf.topInsights.slice(0, 2).forEach(i => {
        allInsights.push({ ...i, category: 'Lists' });
      });
    }

    if (healthCheck.alerts) {
      healthCheck.alerts.slice(0, 2).forEach(alert => {
        allInsights.push({
          category: 'Health',
          priority: alert.severity === 'critical' ? 'high' : 'medium',
          insight: alert.message,
          action: alert.action
        });
      });
    }

    // Sort by priority
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    allInsights.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    return {
      success: true,
      generatedAt: new Date().toISOString(),
      period: { days },
      // === NUEVO: Contexto estratégico del comprehensive report ===
      strategicContext: subjectAnalysis.strategicContext || null,
      summary: {
        healthScore: healthCheck.health?.score || 0,
        healthStatus: healthCheck.health?.status || 'unknown',
        campaignsAnalyzed: subjectAnalysis.summary?.campaignsAnalyzed || 0,
        listsAnalyzed: listPerf.summary?.totalLists || 0,
        topInsightsCount: allInsights.length,
        score: healthCheck.health?.score || 0,
        status: healthCheck.health?.status || 'unknown',
        primaryMetric: { name: 'healthScore', value: healthCheck.health?.score || 0 }
      },
      topInsights: allInsights.slice(0, 8),
      alerts: healthCheck.alerts || [],
      details: {
        subjectAnalysis: {
          avgOpenRate: subjectAnalysis.summary?.avgOpenRate,
          topPerformers: subjectAnalysis.topPerformers?.slice(0, 3),
          keyPatterns: subjectAnalysis.topInsights?.slice(0, 3)
        },
        sendTiming: {
          bestTime: sendTiming.bestTimes?.[0],
          recommendation: sendTiming.recommendation
        },
        lists: {
          topByRevenue: listPerf.rankings?.byRevenue?.slice(0, 3),
          topByOpenRate: listPerf.rankings?.byOpenRate?.slice(0, 3)
        },
        health: {
          score: healthCheck.health?.score,
          status: healthCheck.health?.status,
          alerts: healthCheck.alerts?.length || 0
        }
      }
    };
  }

  // ==================== 6. PREPARE DATA FOR CLAUDE (últimos 15 días) ====================

  /**
   * Helper para sanitizar rates (máx 100%, mín 0%)
   */
  sanitizeRate(rate) {
    const num = parseFloat(rate) || 0;
    return parseFloat(Math.min(Math.max(num, 0), 100).toFixed(2));
  }

  prepareDataForClaude(analysisResults) {
    const { healthCheck, subjectAnalysis, sendTiming, listPerformance } = analysisResults;

    // === HEALTH (sanitizado) ===
    const health = {
      openRate: this.sanitizeRate(healthCheck?.metrics?.rates?.openRate),
      clickRate: this.sanitizeRate(healthCheck?.metrics?.rates?.clickRate),
      bounceRate: this.sanitizeRate(healthCheck?.metrics?.rates?.bounceRate),
      unsubRate: this.sanitizeRate(healthCheck?.metrics?.rates?.unsubRate),
      deliveryRate: this.sanitizeRate(healthCheck?.metrics?.rates?.deliveryRate),
      campaignsSent: healthCheck?.metrics?.campaigns?.sent || 0,
      totalSent: healthCheck?.metrics?.totals?.sent || 0,
      healthScore: Math.min(healthCheck?.health?.score || 0, 100),
      status: healthCheck?.health?.status || 'unknown'
    };

    // === SUBJECTS (sanitizado) ===
    const subjects = {
      top: subjectAnalysis?.topPerformers?.[0] ? {
        subject: subjectAnalysis.topPerformers[0].subject,
        openRate: this.sanitizeRate(subjectAnalysis.topPerformers[0].openRate),
        clickRate: this.sanitizeRate(subjectAnalysis.topPerformers[0].clickRate),
        sentAt: subjectAnalysis.topPerformers[0].sentAt,
        context: subjectAnalysis.topPerformers[0].context
      } : null,
      bottom: subjectAnalysis?.lowPerformers?.[0] ? {
        subject: subjectAnalysis.lowPerformers[0].subject,
        openRate: this.sanitizeRate(subjectAnalysis.lowPerformers[0].openRate),
        sentAt: subjectAnalysis.lowPerformers[0].sentAt,
        context: subjectAnalysis.lowPerformers[0].context
      } : null,
      patterns: {},
      campaignsAnalyzed: subjectAnalysis?.summary?.campaignsAnalyzed || 0
    };

    // Extraer patrones de subjects (sanitizando lifts imposibles)
    if (subjectAnalysis?.insights) {
      const ins = subjectAnalysis.insights;
      // Limitar lift a rangos razonables (-100% a +200%)
      const sanitizeLift = (lift) => {
        const num = parseFloat(lift) || 0;
        return Math.min(Math.max(num, -100), 200).toFixed(1) + '% lift';
      };
      if (ins.hasEmoji) subjects.patterns.emoji = sanitizeLift(ins.hasEmoji.lift);
      if (ins.hasNumber) subjects.patterns.numbers = sanitizeLift(ins.hasNumber.lift);
      if (ins.hasUrgency) subjects.patterns.urgency = sanitizeLift(ins.hasUrgency.lift);
      if (ins.hasQuestion) subjects.patterns.questions = sanitizeLift(ins.hasQuestion.lift);
    }

    // === CONTEXTO ESTRATÉGICO ===
    const strategicContext = subjectAnalysis?.strategicContext || null;

    // === LISTS (sanitizado) ===
    const lists = (listPerformance?.lists || []).slice(0, 5).map(list => ({
      name: list.name,
      openRate: this.sanitizeRate(list.rates?.openRate),
      clickRate: this.sanitizeRate(list.rates?.clickRate),
      revenue: Math.max(list.revenue?.total || 0, 0),
      revenuePerEmail: Math.max(list.revenue?.perEmail || 0, 0),
      unsubRate: this.sanitizeRate(list.rates?.unsubRate),
      campaigns: list.campaigns || 0,
      recentCampaigns: list.recentCampaigns || []
    }));

    // === TIMING ===
    const timing = {
      best: sendTiming?.bestTimes?.[0] ? 
        `${sendTiming.bestTimes[0].day} ${sendTiming.bestTimes[0].hour}` : null,
      worst: sendTiming?.worstTimes?.[0] ?
        `${sendTiming.worstTimes[0].day} ${sendTiming.worstTimes[0].hour}` : null,
      topHours: (sendTiming?.bestTimes || []).slice(0, 3).map(t => ({
        day: t.day,
        hour: t.hour,
        score: this.sanitizeRate(t.score) + '%'
      }))
    };

    // === REVENUE ===
    const revenue = {
      total: Math.max(parseFloat(listPerformance?.summary?.totalRevenue) || 0, 0),
      perEmail: Math.max(listPerformance?.summary?.avgRevenuePerEmail || 0, 0),
      orders: 0
    };

    // Calcular órdenes totales
    if (listPerformance?.lists) {
      revenue.orders = listPerformance.lists.reduce((sum, l) => 
        sum + (l.metrics?.purchased || 0), 0
      );
    }

    // === ALERTAS ===
    const alerts = (healthCheck?.alerts || []).map(a => ({
      severity: a.severity,
      message: a.message
    }));

    return {
      period: `últimos 15 días`,
      generatedAt: new Date().toISOString(),
      health,
      subjects,
      strategicContext,
      lists,
      timing,
      revenue,
      alerts
    };
  }
}

module.exports = new AICalculator();