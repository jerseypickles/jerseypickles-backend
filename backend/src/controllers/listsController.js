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
        .select('name description memberCount tags isActive createdAt updatedAt');
      
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

  // ==================== GESTIÓN DE MIEMBROS ====================

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

  // Obtener miembros de una lista (paginado) - ARREGLADO
  async getMembers(req, res) {
    try {
      const { page = 1, limit = 50 } = req.query;
      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      // Obtener la lista sin populate
      const list = await List.findById(req.params.id);
      
      if (!list) {
        return res.status(404).json({ error: 'Lista no encontrada' });
      }
      
      // Obtener el slice de IDs para esta página
      const memberIdsPage = list.members.slice(skip, skip + parseInt(limit));
      
      // Buscar los customers con esos IDs específicos
      const members = await Customer.find({
        _id: { $in: memberIdsPage }
      })
      .select('email firstName lastName phone createdAt')
      .lean();
      
      // Mantener el orden original del array
      const orderedMembers = memberIdsPage.map(id => 
        members.find(m => m._id.toString() === id.toString())
      ).filter(Boolean);
      
      console.log(`📄 Página ${page}: mostrando ${orderedMembers.length} de ${list.memberCount} miembros`);
      
      res.json({
        members: orderedMembers,
        total: list.memberCount,
        page: parseInt(page),
        pages: Math.ceil(list.memberCount / parseInt(limit))
      });
      
    } catch (error) {
      console.error('Error obteniendo miembros:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ==================== IMPORTAR CSV ====================

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
      
      // Detectar columnas de email (case-insensitive y variaciones)
      const firstRow = rows[0];
      const emailColumn = Object.keys(firstRow).find(key => 
        /^e-?mail$/i.test(key.trim()) || /^correo$/i.test(key.trim())
      );
      
      if (!emailColumn) {
        return res.status(400).json({ 
          error: 'El CSV debe tener al menos una columna "email"',
          columnsFound: Object.keys(firstRow).join(', ')
        });
      }
      
      console.log(`✅ Columna de email detectada: "${emailColumn}"`);
      console.log(`📋 Columnas disponibles: ${Object.keys(firstRow).join(', ')}`);
      
      // Función helper para buscar columnas con variaciones
      const findColumn = (row, variations) => {
        const key = Object.keys(row).find(k => 
          variations.some(v => new RegExp(`^${v}$`, 'i').test(k.trim()))
        );
        return key ? row[key] : '';
      };
      
      // Procesar filas y crear/encontrar customers
      const customerIds = [];
      const emailsImported = []; // Para mostrar en resultado
      const stats = {
        created: 0,
        found: 0,
        errors: 0,
        skipped: 0,
        total: rows.length
      };
      
      for (const row of rows) {
        try {
          // Buscar email con variaciones
          const email = row[emailColumn]?.trim();
          
          if (!email) {
            stats.skipped++;
            continue;
          }
          
          // Validar formato de email básico
          if (!email.includes('@') || !email.includes('.')) {
            console.log(`⚠️  Email inválido: ${email}`);
            stats.errors++;
            continue;
          }
          
          // Buscar otros campos opcionales con variaciones
          const firstName = findColumn(row, [
            'firstName', 'first_name', 'FirstName', 'First Name', 
            'nombre', 'Nombre', 'name', 'Name'
          ]);
          
          const lastName = findColumn(row, [
            'lastName', 'last_name', 'LastName', 'Last Name',
            'apellido', 'Apellido', 'surname', 'Surname'
          ]);
          
          const phone = findColumn(row, [
            'phone', 'Phone', 'PHONE', 'telefono', 'teléfono', 
            'Telefono', 'Teléfono', 'mobile', 'cel', 'celular'
          ]);
          
          // Buscar o crear customer
          let customer = await Customer.findOne({ 
            email: email.toLowerCase().trim() 
          });
          
          if (!customer) {
            customer = await Customer.create({
              email: email.toLowerCase().trim(),
              firstName: firstName.trim(),
              lastName: lastName.trim(),
              phone: phone.trim(),
              source: 'csv_import'
            });
            stats.created++;
            console.log(`✨ Cliente creado: ${email}`);
          } else {
            // Actualizar campos si están vacíos y vienen en el CSV
            let updated = false;
            if (!customer.firstName && firstName) {
              customer.firstName = firstName.trim();
              updated = true;
            }
            if (!customer.lastName && lastName) {
              customer.lastName = lastName.trim();
              updated = true;
            }
            if (!customer.phone && phone) {
              customer.phone = phone.trim();
              updated = true;
            }
            if (updated) {
              await customer.save();
              console.log(`🔄 Cliente actualizado: ${email}`);
            }
            stats.found++;
          }
          
          customerIds.push(customer._id);
          emailsImported.push({
            email: customer.email,
            name: `${customer.firstName || ''} ${customer.lastName || ''}`.trim()
          });
          
        } catch (error) {
          console.error('Error procesando fila:', error.message);
          stats.errors++;
        }
      }
      
      console.log(`✅ Procesamiento completado:`);
      console.log(`   - Creados: ${stats.created}`);
      console.log(`   - Encontrados: ${stats.found}`);
      console.log(`   - Errores: ${stats.errors}`);
      console.log(`   - Saltados (sin email): ${stats.skipped}`);
      
      if (customerIds.length === 0) {
        return res.status(400).json({ 
          error: 'No se pudieron procesar emails del CSV',
          stats
        });
      }
      
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
        },
        // Enviar muestra de emails (primeros 10)
        emailsSample: emailsImported.slice(0, 10)
      });
      
    } catch (error) {
      console.error('Error importando CSV:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = new ListsController();