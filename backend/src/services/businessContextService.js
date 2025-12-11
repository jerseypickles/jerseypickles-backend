// backend/src/services/businessContextService.js
// 🎯 Business Context Service - Integra todos los datos de negocio para Claude
// ⚠️ FIXED: Safe model access without static method dependencies
const mongoose = require('mongoose');

// Safe model getters
const getModel = (name) => {
  try {
    return mongoose.model(name);
  } catch (e) {
    console.warn(`Model ${name} not available`);
    return null;
  }
};

// Lazy service loading to avoid circular deps
let _productService = null;
let _businessCalendarService = null;

const getProductService = () => {
  if (!_productService) {
    try { _productService = require('./productService'); } catch (e) { }
  }
  return _productService;
};

const getBusinessCalendarService = () => {
  if (!_businessCalendarService) {
    try { _businessCalendarService = require('./businessCalendarService'); } catch (e) { }
  }
  return _businessCalendarService;
};

class BusinessContextService {

  /**
   * Obtener contexto completo de negocio para Claude
   */
  async getFullBusinessContext() {
    try {
      const productService = getProductService();
      const businessCalendarService = getBusinessCalendarService();
      
      const [
        productData,
        calendarContext,
        listProductAnalysis
      ] = await Promise.all([
        productService?.prepareProductDataForClaude().catch(e => {
          console.warn('Error preparing product data:', e.message);
          return null;
        }),
        businessCalendarService?.getBusinessContextForClaude().catch(e => {
          console.warn('Error getting calendar context:', e.message);
          return null;
        }),
        this.getProductsByListAnalysis().catch(e => {
          console.warn('Error analyzing list products:', e.message);
          return null;
        })
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
      const List = getModel('List');
      if (!List) return [];
      
      const lists = await List.find({ isActive: true })
        .select('_id name memberCount')
        .lean();
      
      if (lists.length === 0) return [];
      
      const listAnalysis = [];
      
      for (const list of lists.slice(0, 5)) {
        const topProducts = await this.getTopProductsForList(list._id, list.name);
        
        if (topProducts.length > 0) {
          listAnalysis.push({
            listName: list.name,
            memberCount: list.memberCount,
            topProducts: topProducts.slice(0, 3).map(p => ({
              title: p.title,
              revenue: `$${(p.revenue || 0).toFixed(0)}`,
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
    const Product = getModel('Product');
    if (!Product) return [];
    
    try {
      const products = await Product.find({
        'listPerformance.listId': listId,
        status: 'active'
      })
      .select('title listPerformance categories')
      .lean();
      
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
    } catch (e) {
      console.warn('Error getting top products for list:', e.message);
      return [];
    }
  }

  /**
   * Detectar categoría preferida basada en compras
   */
  detectPreferredCategory(products) {
    const categories = {
      gift_sets: 0,
      seasonal: 0,
      regular: 0
    };
    
    for (const p of products) {
      if (p.categories?.isGiftSet) categories.gift_sets += p.revenue || 0;
      else if (p.categories?.isSeasonal) categories.seasonal += p.revenue || 0;
      else categories.regular += p.revenue || 0;
    }
    
    const max = Math.max(categories.gift_sets, categories.seasonal, categories.regular);
    
    if (max === categories.gift_sets && categories.gift_sets > 0) return 'gift_sets';
    if (max === categories.seasonal && categories.seasonal > 0) return 'seasonal';
    return 'regular';
  }

  /**
   * Formatear contexto de negocio para el prompt de Claude
   */
  formatBusinessContextForPrompt(context) {
    if (!context) return '';
    
    const sections = [];
    
    // === PRODUCTOS ===
    if (context.products) {
      const p = context.products;
      
      // Top selling
      if (p.topSellingProducts?.length > 0) {
        sections.push(`🛒 TOP PRODUCTOS (últimos 30 días):`);
        p.topSellingProducts.forEach((prod, i) => {
          const stockWarning = prod.isOutOfStock ? '❌ AGOTADO' : (prod.isLowStock ? '⚠️ BAJO' : '');
          sections.push(`${i + 1}. ${prod.title}: ${prod.revenue} | ${prod.unitsSold} vendidos | Stock: ${prod.inventory} ${stockWarning}`);
        });
        sections.push('');
      }
      
      // Low stock
      if (p.lowStockAlert?.length > 0) {
        sections.push(`⚠️ PRODUCTOS CON BAJO STOCK (necesitan atención):`);
        p.lowStockAlert.forEach(prod => {
          sections.push(`• ${prod.title}: ${prod.currentStock} unidades (vendió ${prod.recentSales} en 30 días)`);
        });
        sections.push('');
      }
      
      // Out of stock
      if (p.outOfStockProducts?.length > 0) {
        sections.push(`❌ PRODUCTOS AGOTADOS (NO PROMOCIONAR):`);
        p.outOfStockProducts.forEach(prod => {
          sections.push(`• ${prod.title} - Revenue previo: $${prod.previousRevenue}`);
        });
        sections.push('');
      }
      
      // Gift sets
      if (p.giftSetsAvailable?.length > 0) {
        sections.push(`🎁 GIFT SETS DISPONIBLES (buenos para promociones):`);
        p.giftSetsAvailable.forEach(prod => {
          sections.push(`• ${prod.title}: ${prod.inventory} unidades @ $${prod.price}`);
        });
        sections.push('');
      }
      
      // Bundles
      if (p.frequentlyBoughtTogether?.length > 0) {
        sections.push(`🔗 PRODUCTOS QUE SE COMPRAN JUNTOS (ideas para bundles):`);
        p.frequentlyBoughtTogether.forEach(pair => {
          sections.push(`• ${pair.products.join(' + ')} (${pair.timesBoughtTogether} veces)`);
        });
        sections.push('');
      }
      
      // Inventory summary
      if (p.inventorySummary) {
        sections.push(`📦 RESUMEN DE INVENTARIO:`);
        sections.push(`• Total productos activos: ${p.inventorySummary.totalProducts}`);
        sections.push(`• Total unidades: ${p.inventorySummary.totalUnits}`);
        sections.push(`• Valor estimado: ${p.inventorySummary.estimatedValue}`);
        sections.push(`• Productos con bajo stock: ${p.inventorySummary.lowStockCount}`);
        sections.push(`• Productos agotados: ${p.inventorySummary.outOfStockCount}`);
        sections.push('');
      }
    }
    
    // === CALENDARIO / GOALS ===
    if (context.calendar) {
      const c = context.calendar;
      
      // Revenue goal
      if (c.revenueGoal?.hasGoal) {
        const g = c.revenueGoal;
        sections.push(`🎯 OBJETIVO DE REVENUE MENSUAL:`);
        sections.push(`• Meta: $${g.targetAmount.toLocaleString()}`);
        sections.push(`• Actual: $${g.currentAmount.toLocaleString()} (${g.percentComplete}%)`);
        sections.push(`• Restante: $${g.remaining.toLocaleString()}`);
        sections.push(`• Días restantes: ${g.daysRemaining}`);
        sections.push(`• Necesitas: $${g.dailyNeeded.toLocaleString()}/día`);
        sections.push(`• Estado: ${g.status === 'achieved' ? '✅ ALCANZADO' : g.status === 'on_track' ? '📈 EN CAMINO' : '⚠️ ' + g.status.toUpperCase()}`);
        sections.push('');
      }
      
      // Active promotions
      if (c.activePromotions?.length > 0) {
        sections.push(`🎟️ PROMOCIONES ACTIVAS:`);
        c.activePromotions.forEach(promo => {
          sections.push(`• ${promo.name} (código: ${promo.discountCode})`);
          sections.push(`  Termina en: ${promo.daysRemaining} días | Canjes: ${promo.redemptionCount} | Revenue: $${promo.revenueGenerated}`);
        });
        sections.push('');
      }
      
      // Upcoming events
      if (c.upcomingEvents?.length > 0) {
        sections.push(`📆 EVENTOS PRÓXIMOS:`);
        c.upcomingEvents.forEach(event => {
          sections.push(`• ${event.name}: ${event.date} (en ${event.daysUntil} días)`);
          if (event.keywords?.length > 0) {
            sections.push(`  Keywords: ${event.keywords.join(', ')}`);
          }
        });
        sections.push('');
      }
    }
    
    // === PREFERENCIAS POR LISTA ===
    if (context.listProductPreferences?.length > 0) {
      sections.push(`👥 QUÉ COMPRA CADA LISTA:`);
      context.listProductPreferences.forEach(list => {
        sections.push(`📋 ${list.listName} (${list.memberCount} miembros):`);
        sections.push(`   Preferencia: ${list.preferredCategory}`);
        sections.push(`   Top productos: ${list.topProducts.map(p => p.title).join(', ')}`);
      });
      sections.push('');
    }
    
    return sections.join('\n');
  }

  /**
   * Obtener insights rápidos para widget
   */
  async getQuickInsights() {
    try {
      const businessCalendarService = getBusinessCalendarService();
      const productService = getProductService();
      
      const [revenueGoal, lowStock, upcomingEvents] = await Promise.all([
        businessCalendarService?.getCurrentGoalProgress().catch(() => null),
        productService?.getLowStock(5).catch(() => []),
        businessCalendarService?.getUpcomingEvents(7).catch(() => [])
      ]);
      
      const insights = [];
      
      // Alerta de revenue goal
      if (revenueGoal?.hasGoal) {
        if (revenueGoal.status === 'critical') {
          insights.push({
            type: 'warning',
            icon: '🚨',
            message: `Meta mensual en riesgo: ${revenueGoal.percentComplete}% alcanzado, necesitas $${revenueGoal.dailyNeeded}/día`
          });
        } else if (revenueGoal.status === 'achieved') {
          insights.push({
            type: 'success',
            icon: '🎉',
            message: `¡Meta mensual alcanzada! $${revenueGoal.currentAmount.toLocaleString()} de $${revenueGoal.targetAmount.toLocaleString()}`
          });
        }
      }
      
      // Alerta de bajo stock
      if (lowStock?.length > 0) {
        insights.push({
          type: 'warning',
          icon: '📦',
          message: `${lowStock.length} productos con bajo stock - revisar inventario`
        });
      }
      
      // Eventos próximos
      if (upcomingEvents?.length > 0) {
        const nextEvent = upcomingEvents[0];
        insights.push({
          type: 'info',
          icon: '📅',
          message: `Próximo evento: ${nextEvent.name} en ${nextEvent.daysUntil} días`
        });
      }
      
      return insights;
    } catch (error) {
      console.error('Error getting quick insights:', error);
      return [];
    }
  }
}

// Singleton export
module.exports = new BusinessContextService();