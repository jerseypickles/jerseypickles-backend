// backend/src/controllers/popupController.js
const Customer = require('../models/Customer');
const List = require('../models/List');

// Configuración de la lista del popup
const POPUP_LIST_CONFIG = {
  id: process.env.POPUP_LIST_ID || '691ea301906f6e3d4cfc95b7',
  name: 'Clientes nuevos Jersey Pickles' // Fallback si no existe
};

class PopupController {
  
  // Suscribir email desde popup
  async subscribe(req, res) {
    try {
      const { email, firstName, source = 'website-popup' } = req.body;
      
      // Validar email
      if (!email || !email.includes('@')) {
        return res.status(400).json({ 
          success: false,
          error: 'Email inválido' 
        });
      }
      
      console.log(`📧 Nueva suscripción desde popup: ${email}`);
      
      const emailLower = email.toLowerCase().trim();
      
      // Buscar si el cliente ya existe
      let customer = await Customer.findOne({ email: emailLower });
      
      let isNew = false;
      
      if (customer) {
        // Cliente existe - actualizar acceptsMarketing
        if (!customer.acceptsMarketing) {
          customer.acceptsMarketing = true;
          
          // Agregar tag si no lo tiene
          if (!customer.tags) customer.tags = [];
          if (!customer.tags.includes('popup-subscriber')) {
            customer.tags.push('popup-subscriber');
          }
          
          await customer.save();
          console.log(`✅ Cliente existente actualizado: ${email}`);
        } else {
          console.log(`⏭️  Cliente ya estaba suscrito: ${email}`);
        }
      } else {
        // Crear nuevo cliente
        customer = await Customer.create({
          email: emailLower,
          firstName: firstName?.trim() || '',
          acceptsMarketing: true,
          source: source,
          tags: ['popup-subscriber', 'newsletter']
        });
        
        isNew = true;
        console.log(`✨ Nuevo cliente creado: ${email}`);
      }
      
      // ✅ BUSCAR LA LISTA DEL POPUP
      let list = await List.findById(POPUP_LIST_CONFIG.id);
      
      // Si no existe la lista, crearla
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
      } else {
        console.log(`⏭️  Cliente ya estaba en la lista`);
      }
      
      res.json({
        success: true,
        message: isNew ? '¡Gracias por suscribirte!' : '¡Ya estás suscrito!',
        isNew
      });
      
    } catch (error) {
      console.error('❌ Error en suscripción desde popup:', error);
      
      // Manejar error de email duplicado
      if (error.code === 11000) {
        return res.status(200).json({
          success: true,
          message: '¡Ya estás suscrito!',
          isNew: false
        });
      }
      
      res.status(500).json({ 
        success: false,
        error: 'Error al procesar suscripción' 
      });
    }
  }
  
  // Obtener estadísticas del popup
  async getStats(req, res) {
    try {
      const list = await List.findById(POPUP_LIST_CONFIG.id);
      
      if (!list) {
        return res.status(404).json({ error: 'Lista no encontrada' });
      }
      
      // Stats generales
      const total = list.memberCount;
      
      // Subscribers de este mes
      const thisMonth = await Customer.countDocuments({
        _id: { $in: list.members },
        createdAt: { 
          $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) 
        }
      });
      
      // Subscribers de hoy
      const today = await Customer.countDocuments({
        _id: { $in: list.members },
        createdAt: { 
          $gte: new Date(new Date().setHours(0, 0, 0, 0)) 
        }
      });
      
      res.json({
        listId: list._id,
        listName: list.name,
        total,
        thisMonth,
        today
      });
      
    } catch (error) {
      console.error('Error obteniendo stats del popup:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = new PopupController();