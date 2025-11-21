// backend/src/controllers/popupController.js
const Customer = require('../models/Customer');
const List = require('../models/List');
const shopifyService = require('../services/shopifyService');

// Configuración de la lista del popup
const POPUP_LIST_CONFIG = {
  id: process.env.POPUP_LIST_ID || '691ea301906f6e3d4cfc95b7',
  name: 'Clientes nuevos Jersey Pickles'
};

// Función para generar código único
function generateUniqueCode(email) {
  const timestamp = Date.now().toString(36).toUpperCase();
  const randomStr = Math.random().toString(36).substring(2, 6).toUpperCase();
  const emailPrefix = email.split('@')[0].substring(0, 3).toUpperCase().replace(/[^A-Z]/g, 'X');
  return `JP${emailPrefix}${randomStr}${timestamp}`.substring(0, 15);
}

class PopupController {
  
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
      
      console.log(`📧 Nueva suscripción desde popup: ${email}`);
      
      const emailLower = email.toLowerCase().trim();
      
      // Buscar si el cliente ya existe
      let customer = await Customer.findOne({ email: emailLower });
      
      let isNew = false;
      let discountCode = null;
      
      if (customer) {
        // Cliente existe - verificar si ya tiene código
        if (customer.popupDiscountCode) {
          // Ya tiene código, retornarlo
          discountCode = customer.popupDiscountCode;
          console.log(`⏭️  Cliente ya tiene código: ${discountCode}`);
        } else {
          // Actualizar acceptsMarketing y crear código
          if (!customer.acceptsMarketing) {
            customer.acceptsMarketing = true;
            
            // Agregar tag si no lo tiene
            if (!customer.tags) customer.tags = [];
            if (!customer.tags.includes('popup-subscriber')) {
              customer.tags.push('popup-subscriber');
            }
          }
          
          // Intentar generar y guardar código
          discountCode = await this.createShopifyDiscount(emailLower);
          customer.popupDiscountCode = discountCode;
          await customer.save();
          
          console.log(`✅ Cliente existente actualizado con código: ${discountCode}`);
        }
      } else {
        // Crear código primero
        discountCode = await this.createShopifyDiscount(emailLower);
        
        // Crear nuevo cliente
        customer = await Customer.create({
          email: emailLower,
          firstName: firstName?.trim() || '',
          acceptsMarketing: true,
          source: source,
          tags: ['popup-subscriber', 'newsletter'],
          popupDiscountCode: discountCode
        });
        
        isNew = true;
        console.log(`✨ Nuevo cliente creado con código: ${discountCode}`);
      }
      
      // Buscar la lista del popup
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
      if (error.code === 11000) {
        return res.status(200).json({
          success: true,
          message: 'You\'re already subscribed!',
          isNew: false,
          discountCode: 'WELCOME15' // Código genérico
        });
      }
      
      res.status(500).json({ 
        success: false,
        error: 'Error processing subscription. Please try again.'
      });
    }
  }
  
  // Crear código de descuento en Shopify (con fallback robusto)
  async createShopifyDiscount(email) {
    const generatedCode = generateUniqueCode(email);
    
    try {
      console.log(`💰 Intentando crear código de descuento: ${generatedCode}`);
      
      // Verificar que tenemos credenciales de Shopify
      if (!process.env.SHOPIFY_STORE_URL || !process.env.SHOPIFY_ACCESS_TOKEN) {
        console.warn('⚠️  Credenciales de Shopify no configuradas, usando código genérico');
        return 'WELCOME15';
      }
      
      // Calcular fechas
      const now = new Date();
      const expiryDate = new Date(now.getTime() + (90 * 24 * 60 * 60 * 1000)); // 90 días
      
      // Crear precio rule en Shopify
      const priceRuleData = {
        title: `Newsletter Popup - ${generatedCode}`,
        target_type: 'line_item',
        target_selection: 'all',
        allocation_method: 'across',
        value_type: 'percentage',
        value: '-15.0',
        customer_selection: 'all',
        once_per_customer: true,
        usage_limit: 1,
        starts_at: now.toISOString(),
        ends_at: expiryDate.toISOString()
      };
      
      const priceRule = await shopifyService.createPriceRule(priceRuleData);
      
      if (!priceRule || !priceRule.id) {
        throw new Error('Price rule creation failed - no ID returned');
      }
      
      // Crear discount code
      await shopifyService.createDiscountCode(priceRule.id, generatedCode);
      
      console.log(`✅ Código de descuento creado exitosamente: ${generatedCode}`);
      
      return generatedCode;
      
    } catch (error) {
      console.error('❌ Error creando código de descuento en Shopify:', error.message);
      
      // Si hay error específico de permisos
      if (error.response?.status === 403 || error.response?.status === 401) {
        console.error('⚠️  Error de permisos en Shopify API');
        console.error('   Verifica que el Access Token tenga permisos: write_price_rules');
      }
      
      // Si hay error de API
      if (error.response?.data) {
        console.error('   Respuesta de Shopify:', JSON.stringify(error.response.data, null, 2));
      }
      
      // Fallback: usar código genérico
      console.log('⚠️  Usando código genérico como fallback: WELCOME15');
      return 'WELCOME15';
    }
  }
  
  // Obtener estadísticas del popup
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
      
      // Contar cuántos códigos únicos se han generado
      const uniqueCodes = await Customer.countDocuments({
        _id: { $in: list.members },
        popupDiscountCode: { $exists: true, $ne: null, $ne: 'WELCOME15' }
      });
      
      res.json({
        listId: list._id,
        listName: list.name,
        total,
        thisMonth,
        today,
        uniqueCodes,
        genericCodes: total - uniqueCodes
      });
      
    } catch (error) {
      console.error('Error obteniendo stats del popup:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = new PopupController();