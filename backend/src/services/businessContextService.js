// backend/src/services/businessContextService.js
// 🎯 Business Context Service - Integra todos los datos de negocio para Claude
const productService = require('./productService');
const businessCalendarService = require('./businessCalendarService');
const Product = require('../models/Product');
const BusinessCalendar = require('../models/BusinessCalendar');
const Order = require('../models/Order');
const List = require('../models/List');

class BusinessContextService {

  /**
   * Obtener contexto completo de negocio para Claude
   * Combina: Productos, Calendario, Goals, Promociones
   */
  async getFullBusinessContext() {
    try {
      const [
        productData,
        calendarContext,
        listProductAnalysis
      ] = await Promise.all([
        productService.prepareProductDataForClaude(),
        businessCalendarService.getBusinessContextForClaude(),
        this.getProductsByListAnalysis()
      ]);
      
      return {
        products: productData,
        calendar: calendarContext,
        listProductPreferences: listProductAnalysis
      };
    } catch (error) {
      console.error('Error getting business context:', error);
      return {
        products: null,
        calendar: null,
        listProductPreferences: null,
        error: error.message
      };
    }
  }

  /**
   * Analizar qué productos prefiere cada lista
   */
  async getProductsByListAnalysis() {
    try {
      // Obtener listas activas
      const lists = await List.find({ isActive: true })
        .select('_id name memberCount')
        .lean();
      
      if (lists.length === 0) return [];
      
      // Para cada lista, obtener top productos comprados por sus miembros
      const listAnalysis = [];
      
      for (const list of lists.slice(0, 5)) { // Max 5 listas
        const topProducts = await this.getTopProductsForList(list._id, list.name);
        
        if (topProducts.length > 0) {
          listAnalysis.push({
            listName: list.name,
            memberCount: list.memberCount,
            topProducts: topProducts.slice(0, 3).map(p => ({
              title: p.title,
              revenue: `$${p.revenue.toFixed(0)}`,
              unitsSold: p.unitsSold
            })),
            preferredCategory: this.detectPreferredCategory(topProducts)
          });
        }
      }
      
      return listAnalysis;
    } catch (error) {
      console.error('Error analyzing products by list:', error);
      return [];
    }
  }

  /**
   * Obtener top productos para una lista específica
   */
  async getTopProductsForList(listId, listName) {
    // Buscar en Product.listPerformance
    const products = await Product.find({
      'listPerformance.listId': listId,
      status: 'active'
    })
    .select('title listPerformance categories')
    .lean();
    
    // Extraer y ordenar por revenue
    const productStats = products.map(p => {
      const listStats = p.listPerformance.find(
        lp => lp.listId?.toString() === listId.toString()
      );
      return {
        title: p.title,
        revenue: listStats?.revenue || 0,
        unitsSold: listStats?.unitsSold || 0,
        categories: p.categories
      };
    });
    
    return productStats.sort((a, b) => b.revenue - a.revenue);
  }

  /**
   * Detectar categoría preferida de una lista
   */
  detectPreferredCategory(products) {
    if (!products || products.length === 0) return 'general';
    
    let giftSets = 0;
    let seasonal = 0;
    let regular = 0;
    
    for (const p of products) {
      if (p.categories?.isGiftSet) giftSets++;
      else if (p.categories?.isSeasonal) seasonal++;
      else regular++;
    }
    
    if (giftSets > seasonal && giftSets > regular) return 'gift_sets';
    if (seasonal > regular) return 'seasonal';
    return 'regular';
  }

  /**
   * Formatear contexto de negocio para el prompt de Claude
   */
  formatBusinessContextForPrompt(businessContext) {
    if (!businessContext) return '';
    
    const { products, calendar, listProductPreferences } = businessContext;
    
    let prompt = '';
    
    // === SECCIÓN DE PRODUCTOS ===
    if (products) {
      prompt += `
═══════════════════════════════════════════════════════════
🛒 DATOS DE PRODUCTOS (IMPORTANTE PARA RECOMENDACIONES)
═══════════════════════════════════════════════════════════

📊 TOP PRODUCTOS (últimos 30 días):
`;
      if (products.topSellingProducts?.length > 0) {
        products.topSellingProducts.forEach((p, i) => {
          prompt += `${i + 1}. ${p.title}
   Revenue: ${p.revenue} | Vendidos: ${p.unitsSold} | Stock: ${p.inventory}${p.isLowStock ? ' ⚠️ BAJO' : ''}${p.isOutOfStock ? ' ❌ AGOTADO' : ''}
`;
        });
      } else {
        prompt += `   No hay datos de ventas recientes\n`;
      }
      
      // Alertas de inventario
      if (products.lowStockAlert?.length > 0) {
        prompt += `
⚠️ PRODUCTOS CON BAJO STOCK (se están vendiendo):
`;
        products.lowStockAlert.forEach(p => {
          prompt += `• ${p.title}: ${p.currentStock} unidades (vendió ${p.recentSales} en 30 días)
`;
        });
      }
      
      // Gift sets disponibles
      if (products.giftSetsAvailable?.length > 0) {
        prompt += `
🎁 GIFT SETS DISPONIBLES (importantes para holidays):
`;
        products.giftSetsAvailable.forEach(p => {
          prompt += `• ${p.title}: ${p.inventory} unidades @ $${p.price}
`;
        });
      }
      
      // Resumen de inventario
      if (products.inventorySummary) {
        prompt += `
📦 RESUMEN DE INVENTARIO:
• Total productos: ${products.inventorySummary.totalProducts}
• Unidades totales: ${products.inventorySummary.totalUnits}
• Valor estimado: ${products.inventorySummary.estimatedValue}
• Con bajo stock: ${products.inventorySummary.lowStockCount}
• Agotados: ${products.inventorySummary.outOfStockCount}
`;
      }
      
      // Bundles naturales
      if (products.frequentlyBoughtTogether?.length > 0) {
        prompt += `
🔗 PRODUCTOS QUE SE COMPRAN JUNTOS (oportunidad de bundle):
`;
        products.frequentlyBoughtTogether.forEach(pair => {
          prompt += `• ${pair.products.join(' + ')} (${pair.timesBoughtTogether} veces)
`;
        });
      }
    }
    
    // === SECCIÓN DE CALENDARIO/OBJETIVOS ===
    if (calendar) {
      prompt += `
═══════════════════════════════════════════════════════════
📅 OBJETIVOS Y CALENDARIO DE NEGOCIO
═══════════════════════════════════════════════════════════
`;
      
      // Revenue Goal
      if (calendar.revenueGoal) {
        const goal = calendar.revenueGoal;
        const statusEmoji = {
          'achieved': '🏆',
          'on_track': '✅',
          'slightly_behind': '📊',
          'behind': '⚠️',
          'critical': '🚨'
        };
        
        prompt += `
🎯 OBJETIVO DE REVENUE MENSUAL:
• Meta: ${goal.target}
• Actual: ${goal.current} (${goal.percentComplete})
• Restante: ${goal.remaining}
• Días restantes: ${goal.daysRemaining}
• Necesitas: ${goal.dailyNeeded}/día
• Estado: ${statusEmoji[goal.status] || '📊'} ${goal.status.replace('_', ' ').toUpperCase()}

`;
        if (goal.status === 'behind' || goal.status === 'critical') {
          prompt += `⚠️ ACCIÓN REQUERIDA: El objetivo está en riesgo. Considera campañas adicionales o promociones para acelerar ventas.\n`;
        }
      } else {
        prompt += `
ℹ️ No hay objetivo de revenue configurado para este mes.
`;
      }
      
      // Promociones activas
      if (calendar.activePromotions?.length > 0) {
        prompt += `
🎟️ PROMOCIONES ACTIVAS:
`;
        calendar.activePromotions.forEach(p => {
          prompt += `• ${p.name}: ${p.discount} OFF (código: ${p.code})
  Termina en: ${p.endsIn} | Canjes: ${p.redemptions} | Revenue: ${p.revenue}
`;
        });
      }
      
      // Eventos próximos
      if (calendar.upcomingEvents?.length > 0) {
        prompt += `
📆 EVENTOS PRÓXIMOS (oportunidades de campaña):
`;
        calendar.upcomingEvents.forEach(e => {
          prompt += `• ${e.name}: ${e.date} (en ${e.daysUntil} días) - Tipo: ${e.type}
`;
        });
      }
    }
    
    // === PREFERENCIAS POR LISTA ===
    if (listProductPreferences?.length > 0) {
      prompt += `
═══════════════════════════════════════════════════════════
👥 QUÉ COMPRA CADA LISTA (para personalización)
═══════════════════════════════════════════════════════════
`;
      listProductPreferences.forEach(list => {
        prompt += `
📋 ${list.listName} (${list.memberCount} miembros):
   Preferencia: ${list.preferredCategory}
   Top productos: ${list.topProducts.map(p => p.title).join(', ')}
`;
      });
    }
    
    // === INSTRUCCIONES PARA CLAUDE ===
    prompt += `
═══════════════════════════════════════════════════════════
⚠️ USA ESTOS DATOS PARA:
═══════════════════════════════════════════════════════════
1. Recomendar QUÉ PRODUCTOS promocionar (los que tienen stock y se venden)
2. ALERTAR si un producto popular tiene bajo stock
3. Sugerir BUNDLES basados en productos comprados juntos
4. Ajustar recomendaciones según el OBJETIVO DE REVENUE
5. Sugerir campañas para EVENTOS PRÓXIMOS
6. Personalizar sugerencias según QUÉ COMPRA CADA LISTA
7. NO promocionar productos AGOTADOS

`;
    
    return prompt;
  }
}

module.exports = new BusinessContextService();