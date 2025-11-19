// backend/src/controllers/listsController.js
const List = require('../models/List');
const Customer = require('../models/Customer');
const csv = require('csv-parser');
const { Readable } = require('stream');

class ListsController {
  
  // Listar todas las listas
  async list(req, res) {
    try {
      const { 
        page = 1, 
        limit = 20,
        search 
      } = req.query;
      
      const query = {};
      
      if (search) {
        query.$or = [
          { name: { $regex: search, $options: 'i' } },
          { description: { $regex: search, $options: 'i' } }
        ];
      }
      
      const lists = await List.find(query)
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit)
        .select('name description memberCount tags isActive createdAt updatedAt');
      
      const total = await List.countDocuments(query);
      
      res.json({
        lists,
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      });
      
    } catch (error) {
      console.error('Error listando listas:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Obtener una lista específica
  async getOne(req, res) {
    try {
      const list = await List.findById(req.params.id)
        .populate('members', 'email firstName lastName phone createdAt');
      
      if (!list) {
        return res.status(404).json({ error: 'Lista no encontrada' });
      }
      
      res.json(list);
      
    } catch (error) {
      console.error('Error obteniendo lista:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Crear lista manual
  async create(req, res) {
    try {
      const {
        name,
        description,
        tags
      } = req.body;
      
      // Verificar si ya existe
      const existing = await List.findOne({ name });
      if (existing) {
        return res.status(400).json({ 
          error: 'Ya existe una lista con ese nombre' 
        });
      }
      
      const list = await List.create({
        name,
        description,
        tags: tags || [],
        members: [],
        memberCount: 0
      });
      
      console.log(`✅ Lista creada: ${name}`);
      
      res.status(201).json(list);
      
    } catch (error) {
      console.error('Error creando lista:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Actualizar lista
  async update(req, res) {
    try {
      const list = await List.findById(req.params.id);
      
      if (!list) {
        return res.status(404).json({ error: 'Lista no encontrada' });
      }
      
      const { name, description, tags, isActive } = req.body;
      
      if (name && name !== list.name) {
        const existing = await List.findOne({ name });
        if (existing) {
          return res.status(400).json({ 
            error: 'Ya existe una lista con ese nombre' 
          });
        }
        list.name = name;
      }
      
      if (description !== undefined) list.description = description;
      if (tags) list.tags = tags;
      if (isActive !== undefined) list.isActive = isActive;
      
      await list.save();
      
      console.log(`✅ Lista actualizada: ${list.name}`);
      
      res.json(list);
      
    } catch (error) {
      console.error('Error actualizando lista:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Eliminar lista
  async delete(req, res) {
    try {
      const list = await List.findById(req.params.id);
      
      if (!list) {
        return res.status(404).json({ error: 'Lista no encontrada' });
      }
      
      await List.findByIdAndDelete(req.params.id);
      
      console.log(`🗑️  Lista eliminada: ${list.name}`);
      
      res.json({ 
        success: true, 
        message: 'Lista eliminada correctamente' 
      });
      
    } catch (error) {
      console.error('Error eliminando lista:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Agregar miembro a lista
  async addMember(req, res) {
    try {
      const list = await List.findById(req.params.id);
      
      if (!list) {
        return res.status(404).json({ error: 'Lista no encontrada' });
      }
      
      const { customerId, email } = req.body;
      
      let customer;
      if (customerId) {
        customer = await Customer.findById(customerId);
      } else if (email) {
        customer = await Customer.findOne({ email });
      }
      
      if (!customer) {
        return res.status(404).json({ error: 'Cliente no encontrado' });
      }
      
      await list.addMember(customer._id);
      
      res.json({
        success: true,
        memberCount: list.memberCount,
        list
      });
      
    } catch (error) {
      console.error('Error agregando miembro:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Remover miembro de lista
  async removeMember(req, res) {
    try {
      const list = await List.findById(req.params.id);
      
      if (!list) {
        return res.status(404).json({ error: 'Lista no encontrada' });
      }
      
      const { customerId } = req.params;
      
      await list.removeMember(customerId);
      
      res.json({
        success: true,
        memberCount: list.memberCount,
        list
      });
      
    } catch (error) {
      console.error('Error removiendo miembro:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ==================== IMPORTAR CSV ====================

  // Importar lista desde CSV
  async importCSV(req, res) {
    try {
      const { name, description, csvData } = req.body;
      
      if (!csvData) {
        return res.status(400).json({ error: 'csvData es requerido' });
      }
      
      console.log(`\n📥 Importando lista desde CSV: ${name}`);
      
      // Parsear CSV
      const rows = [];
      const stream = Readable.from(csvData);
      
      await new Promise((resolve, reject) => {
        stream
          .pipe(csv())
          .on('data', (row) => {
            rows.push(row);
          })
          .on('end', resolve)
          .on('error', reject);
      });
      
      console.log(`📄 ${rows.length} filas parseadas del CSV`);
      
      if (rows.length === 0) {
        return res.status(400).json({ 
          error: 'El CSV está vacío o no tiene el formato correcto' 
        });
      }
      
      // Procesar filas y crear/encontrar customers
      const customerIds = [];
      const stats = {
        created: 0,
        found: 0,
        errors: 0,
        total: rows.length
      };
      
      for (const row of rows) {
        try {
          // El CSV debe tener al menos "email"
          const email = row.email || row.Email || row.EMAIL;
          
          if (!email) {
            stats.errors++;
            continue;
          }
          
          const firstName = row.firstName || row.first_name || row.FirstName || '';
          const lastName = row.lastName || row.last_name || row.LastName || '';
          const phone = row.phone || row.Phone || row.PHONE || '';
          
          let customer = await Customer.findOne({ email: email.toLowerCase().trim() });
          
          if (!customer) {
            customer = await Customer.create({
              email: email.toLowerCase().trim(),
              firstName: firstName.trim(),
              lastName: lastName.trim(),
              phone: phone.trim(),
              source: 'csv_import'
            });
            stats.created++;
          } else {
            stats.found++;
          }
          
          customerIds.push(customer._id);
          
        } catch (error) {
          console.error('Error procesando fila:', error.message);
          stats.errors++;
        }
      }
      
      console.log(`✅ Clientes: ${stats.created} creados, ${stats.found} encontrados, ${stats.errors} errores`);
      
      // Crear o actualizar lista
      let list = await List.findOne({ name });
      
      if (list) {
        // Actualizar lista existente
        await list.addMembers(customerIds);
        console.log(`🔄 Lista actualizada: ${list.name} (${list.memberCount} miembros)`);
      } else {
        // Crear nueva lista
        list = await List.create({
          name,
          description: description || `Importada desde CSV`,
          members: [],
          memberCount: 0
        });
        
        await list.addMembers(customerIds);
        console.log(`✅ Lista creada: ${list.name} (${list.memberCount} miembros)`);
      }
      
      res.json({
        success: true,
        list,
        stats: {
          ...stats,
          totalMembers: list.memberCount
        }
      });
      
    } catch (error) {
      console.error('Error importando CSV:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Agregar múltiples miembros por email (bulk)
  async addMembersByEmail(req, res) {
    try {
      const list = await List.findById(req.params.id);
      
      if (!list) {
        return res.status(404).json({ error: 'Lista no encontrada' });
      }
      
      const { emails } = req.body;
      
      if (!Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ error: 'Se requiere un array de emails' });
      }
      
      // Buscar clientes por email
      const customers = await Customer.find({ 
        email: { $in: emails.map(e => e.toLowerCase().trim()) } 
      });
      
      if (customers.length === 0) {
        return res.status(404).json({ 
          error: 'No se encontraron clientes con esos emails' 
        });
      }
      
      await list.addMembers(customers.map(c => c._id));
      
      res.json({
        success: true,
        added: customers.length,
        notFound: emails.length - customers.length,
        totalMembers: list.memberCount,
        list
      });
      
    } catch (error) {
      console.error('Error agregando miembros:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Obtener miembros de una lista (paginado)
  async getMembers(req, res) {
    try {
      const { page = 1, limit = 50 } = req.query;
      
      const list = await List.findById(req.params.id)
        .populate({
          path: 'members',
          select: 'email firstName lastName phone createdAt',
          options: {
            limit: parseInt(limit),
            skip: (parseInt(page) - 1) * parseInt(limit)
          }
        });
      
      if (!list) {
        return res.status(404).json({ error: 'Lista no encontrada' });
      }
      
      res.json({
        members: list.members,
        total: list.memberCount,
        page: parseInt(page),
        pages: Math.ceil(list.memberCount / parseInt(limit))
      });
      
    } catch (error) {
      console.error('Error obteniendo miembros:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = new ListsController();