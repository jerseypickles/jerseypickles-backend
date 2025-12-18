// backend/src/controllers/popupController.js
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const List = require('../models/List');
const shopifyService = require('../services/shopifyService');

// Configuración de la lista del popup
const POPUP_LIST_CONFIG = {
  id: process.env.POPUP_LIST_ID || '691ea301906f6e3d4cfc95b7',
  name: 'Clientes nuevos Jersey Pickles'
};

// ═══════════════════════════════════════════════════════════
// DISCOUNT CONFIGURATION - BUILD YOUR BOX / SHIPPING POPUP
// ═══════════════════════════════════════════════════════════
const DISCOUNT_CONFIG = {
  percentage: '-15.0',            // 15% OFF máximo
  fallbackCode: 'PICKLE15',       // Código genérico de fallback
  codePrefix: 'JP',               // Jersey Pickles prefix
  campaignName: 'Build Your Box', // Nombre de la campaña
  expirationDays: 30              // Días hasta que expire el código
};

// Función para generar código único
function generateUniqueCode(email) {
  const timestamp = Date.now().toString(36).toUpperCase();
  const randomStr = Math.random().toString(36).substring(2, 6).toUpperCase();
  const emailPrefix = email.split('@')[0].substring(0, 3).toUpperCase().replace(/[^A-Z]/g, 'X');
  return `${DISCOUNT_CONFIG.codePrefix}${emailPrefix}${randomStr}${timestamp}`.substring(0, 15);
}

class PopupController {
  
  constructor() {
    this.subscribe = this.subscribe.bind(this);
    this.createShopifyDiscount = this.createShopifyDiscount.bind(this);
    this.getStats = this.getStats.bind(this);
    this.getRevenue = this.getRevenue.bind(this);
  }
  
  // Suscribir email desde popup
  async subscribe(req, res) {
    try {
      const { email, firstName, source = 'website-popup' } = req.body;
      
      // Validar email
      if (!email || !email.includes('@')) {
        return res.status(400).json({ 
          success: false,
          error: 'Invalid email address' 
        });
      }
      
      console.log(`📧 Nueva suscripción desde popup: ${email} (source: ${source})`);
      
      const emailLower = email.toLowerCase().trim();
      
      // Buscar si el cliente ya existe
      let customer = await Customer.findOne({ email: emailLower });
      
      let isNew = false;
      let discountCode = null;
      
      if (customer) {
        // Cliente existe - verificar si ya tiene código
        if (customer.popupDiscountCode) {
          discountCode = customer.popupDiscountCode;
          console.log(`⏭️  Cliente ya tiene código: ${discountCode}`);
        } else {
          // Actualizar y crear código
          if (!customer.acceptsMarketing) {
            customer.acceptsMarketing = true;
            if (!customer.tags) customer.tags = [];
            if (!customer.tags.includes('popup-subscriber')) {
              customer.tags.push('popup-subscriber');
            }
          }
          
          // Agregar tag basado en source
          if (source.includes('shipping') || source.includes('byb')) {
            if (!customer.tags.includes('byb-subscriber')) {
              customer.tags.push('byb-subscriber');
            }
          }
          
          discountCode = await this.createShopifyDiscount(emailLower);
          customer.popupDiscountCode = discountCode;
          customer.source = source;
          await customer.save();
          
          console.log(`✅ Cliente existente actualizado con código: ${discountCode}`);
        }
      } else {
        // Cliente nuevo
        discountCode = await this.createShopifyDiscount(emailLower);
        
        // Determinar tags basado en source
        const tags = ['popup-subscriber', 'newsletter'];
        if (source.includes('shipping') || source.includes('byb')) {
          tags.push('byb-subscriber');
        }
        
        customer = await Customer.create({
          email: emailLower,
          firstName: firstName?.trim() || '',
          acceptsMarketing: true,
          source: source,
          tags: tags,
          popupDiscountCode: discountCode
        });
        
        isNew = true;
        console.log(`✨ Nuevo cliente creado con código: ${discountCode}`);
      }
      
      // Agregar a lista del popup
      let list = await List.findById(POPUP_LIST_CONFIG.id);
      
      if (!list) {
        console.log('⚠️  Lista de popup no encontrada, creando nueva...');
        list = await List.create({
          name: POPUP_LIST_CONFIG.name,
          description: 'Pop ups - suscriptores del sitio web',
          tags: ['popup', 'website']
        });
        console.log(`✅ Lista creada: ${list.name}`);
      }
      
      // Verificar si ya está en la lista
      const alreadyInList = list.members.some(
        memberId => memberId.toString() === customer._id.toString()
      );
      
      if (!alreadyInList) {
        await list.addMember(customer._id);
        console.log(`📋 Cliente agregado a lista "${list.name}" (${list.memberCount} miembros)`);
      }
      
      res.json({
        success: true,
        message: isNew ? 'Thanks for subscribing!' : 'You\'re already subscribed!',
        isNew,
        discountCode: discountCode
      });
      
    } catch (error) {
      console.error('❌ Error en suscripción desde popup:', error);
      console.error('Stack:', error.stack);
      
      // Manejar error de email duplicado
      if (error.code === 11000 && error.keyPattern?.email) {
        return res.status(200).json({
          success: true,
          message: 'You\'re already subscribed!',
          isNew: false,
          discountCode: DISCOUNT_CONFIG.fallbackCode
        });
      }
      
      res.status(500).json({ 
        success: false,
        error: 'Error processing subscription. Please try again.'
      });
    }
  }
  
  // Crear código de descuento en Shopify
  async createShopifyDiscount(email) {
    const generatedCode = generateUniqueCode(email);
    
    try {
      console.log(`💰 Creando código de descuento ${DISCOUNT_CONFIG.percentage}%: ${generatedCode}`);
      
      if (!process.env.SHOPIFY_STORE_URL || !process.env.SHOPIFY_ACCESS_TOKEN) {
        console.warn('⚠️  Credenciales de Shopify no configuradas, usando código genérico');
        return DISCOUNT_CONFIG.fallbackCode;
      }
      
      const now = new Date();
      const expiryDate = new Date(now.getTime() + (DISCOUNT_CONFIG.expirationDays * 24 * 60 * 60 * 1000));
      
      const priceRuleData = {
        title: `${DISCOUNT_CONFIG.campaignName} Popup - ${generatedCode}`,
        target_type: 'line_item',
        target_selection: 'all',
        allocation_method: 'across',
        value_type: 'percentage',
        value: DISCOUNT_CONFIG.percentage,  // ← 15% OFF
        customer_selection: 'all',
        once_per_customer: true,
        usage_limit: 1,
        starts_at: now.toISOString(),
        ends_at: expiryDate.toISOString()
      };
      
      const priceRule = await shopifyService.createPriceRule(priceRuleData);
      
      if (!priceRule || !priceRule.id) {
        throw new Error('Price rule creation failed');
      }
      
      await shopifyService.createDiscountCode(priceRule.id, generatedCode);
      
      console.log(`✅ Código de descuento creado exitosamente: ${generatedCode} (${DISCOUNT_CONFIG.percentage}% OFF)`);
      
      return generatedCode;
      
    } catch (error) {
      console.error('❌ Error creando código de descuento:', error.message);
      
      if (error.response?.status === 403 || error.response?.status === 401) {
        console.error('⚠️  Error de permisos en Shopify API');
      }
      
      if (error.response?.data) {
        console.error('   Respuesta:', JSON.stringify(error.response.data, null, 2));
      }
      
      console.log(`⚠️  Usando código genérico como fallback: ${DISCOUNT_CONFIG.fallbackCode}`);
      return DISCOUNT_CONFIG.fallbackCode;
    }
  }
  
  // Obtener estadísticas básicas del popup
  async getStats(req, res) {
    try {
      const list = await List.findById(POPUP_LIST_CONFIG.id);
      
      if (!list) {
        return res.status(404).json({ error: 'Lista no encontrada' });
      }
      
      const total = list.memberCount;
      
      const thisMonth = await Customer.countDocuments({
        _id: { $in: list.members },
        createdAt: { 
          $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) 
        }
      });
      
      const today = await Customer.countDocuments({
        _id: { $in: list.members },
        createdAt: { 
          $gte: new Date(new Date().setHours(0, 0, 0, 0)) 
        }
      });
      
      // Contar por campaña BYB
      const bybSubscribers = await Customer.countDocuments({
        _id: { $in: list.members },
        tags: 'byb-subscriber'
      });
      
      const uniqueCodes = await Customer.countDocuments({
        _id: { $in: list.members },
        popupDiscountCode: { 
          $exists: true, 
          $ne: null, 
          $nin: ['WELCOME15', 'PICKLE15'] // Excluir códigos genéricos
        }
      });
      
      const customersWithCodes = await Customer.find({
        _id: { $in: list.members },
        popupDiscountCode: { $exists: true, $ne: null }
      }).select('popupDiscountCode');
      
      const discountCodes = customersWithCodes.map(c => c.popupDiscountCode);
      
      const ordersWithCodes = await Order.find({
        discountCodes: { $in: discountCodes }
      });
      
      const usedCodesSet = new Set();
      ordersWithCodes.forEach(order => {
        if (order.discountCodes && Array.isArray(order.discountCodes)) {
          order.discountCodes.forEach(code => {
            if (discountCodes.includes(code)) {
              usedCodesSet.add(code);
            }
          });
        }
      });
      
      const totalRevenue = ordersWithCodes.reduce((sum, order) => {
        return sum + parseFloat(order.totalPrice || 0);
      }, 0);
      
      res.json({
        listId: list._id,
        listName: list.name,
        total,
        thisMonth,
        today,
        bybSubscribers,
        uniqueCodes,
        genericCodes: total - uniqueCodes,
        codesUsed: usedCodesSet.size,
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        currentCampaign: DISCOUNT_CONFIG.campaignName,
        currentDiscount: DISCOUNT_CONFIG.percentage
      });
      
    } catch (error) {
      console.error('Error obteniendo stats del popup:', error);
      res.status(500).json({ error: error.message });
    }
  }
  
  // Obtener revenue detallado del popup
  async getRevenue(req, res) {
    try {
      const { timeRange = 'all', campaign = 'all' } = req.query;
      
      const list = await List.findById(POPUP_LIST_CONFIG.id);
      
      if (!list) {
        return res.status(404).json({ error: 'Lista no encontrada' });
      }
      
      let dateFilter = {};
      const now = new Date();
      
      if (timeRange === '7days') {
        dateFilter = {
          createdAt: { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) }
        };
      } else if (timeRange === '30days') {
        dateFilter = {
          createdAt: { $gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) }
        };
      }
      
      // Filtro por campaña
      let campaignFilter = {};
      if (campaign === 'byb') {
        campaignFilter = { tags: 'byb-subscriber' };
      } else if (campaign === 'shipping') {
        campaignFilter = { source: { $regex: /shipping/i } };
      }
      
      const customers = await Customer.find({
        _id: { $in: list.members },
        popupDiscountCode: { $exists: true, $ne: null },
        ...dateFilter,
        ...campaignFilter
      }).sort({ createdAt: -1 });
      
      const total = customers.length;
      
      const uniqueCodes = customers.filter(
        c => c.popupDiscountCode && !['WELCOME15', 'PICKLE15'].includes(c.popupDiscountCode)
      ).length;
      
      const allCodes = customers.map(c => c.popupDiscountCode).filter(Boolean);
      
      const orders = await Order.find({
        discountCodes: { $in: allCodes }
      });
      
      const codeRevenueMap = new Map();
      const codesUsedSet = new Set();
      
      orders.forEach(order => {
        if (order.discountCodes && Array.isArray(order.discountCodes)) {
          order.discountCodes.forEach(code => {
            if (allCodes.includes(code)) {
              codesUsedSet.add(code);
              const currentRevenue = codeRevenueMap.get(code) || 0;
              codeRevenueMap.set(code, currentRevenue + parseFloat(order.totalPrice || 0));
            }
          });
        }
      });
      
      const totalRevenue = Array.from(codeRevenueMap.values()).reduce((sum, val) => sum + val, 0);
      
      const customersWithRevenue = customers.map(customer => ({
        _id: customer._id,
        email: customer.email,
        firstName: customer.firstName,
        lastName: customer.lastName,
        popupDiscountCode: customer.popupDiscountCode,
        source: customer.source,
        tags: customer.tags,
        createdAt: customer.createdAt,
        codeUsed: codesUsedSet.has(customer.popupDiscountCode),
        revenue: codeRevenueMap.get(customer.popupDiscountCode) || 0
      }));
      
      customersWithRevenue.sort((a, b) => b.revenue - a.revenue);
      
      res.json({
        stats: {
          total,
          uniqueCodes,
          codesUsed: codesUsedSet.size,
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          campaign: campaign,
          timeRange: timeRange
        },
        customers: customersWithRevenue
      });
      
    } catch (error) {
      console.error('Error obteniendo revenue del popup:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = new PopupController();