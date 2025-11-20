// backend/src/controllers/listsController.js
const List = require('../models/List');
const Customer = require('../models/Customer');
const Campaign = require('../models/Campaign');
const EmailEvent = require('../models/EmailEvent');
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

  // Obtener miembros de una lista (paginado)
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
      const emailsImported = [];
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
            const customerData = {
              email: email.toLowerCase().trim(),
              firstName: firstName?.trim() || '',
              lastName: lastName?.trim() || '',
              phone: phone?.trim() || null,
              source: 'csv-import',
              tags: ['imported-from-csv']
            };
            
            customer = await Customer.create(customerData);
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
            
            // Agregar tag si no lo tiene
            if (!customer.tags) customer.tags = [];
            if (!customer.tags.includes('imported-from-csv')) {
              customer.tags.push('imported-from-csv');
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
      
      console.log(`\n✅ Procesamiento completado:`);
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
          description: description || `Importada desde CSV el ${new Date().toLocaleDateString()}`,
          members: [],
          memberCount: 0,
          tags: ['csv-import']
        });
        
        await list.addMembers(customerIds);
        console.log(`✅ Lista creada: ${list.name} (${list.memberCount} miembros)\n`);
      }
      
      res.json({
        success: true,
        list,
        stats: {
          ...stats,
          totalMembers: list.memberCount
        },
        emailsSample: emailsImported.slice(0, 10)
      });
      
    } catch (error) {
      console.error('❌ Error importando CSV:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ==================== ANÁLISIS DE ENGAGEMENT ====================

  // Analizar engagement de los miembros de una lista
  async analyzeEngagement(req, res) {
    try {
      const list = await List.findById(req.params.id);
      
      if (!list) {
        return res.status(404).json({ error: 'Lista no encontrada' });
      }
      
      console.log(`📊 Analizando engagement de lista: ${list.name}`);
      
      // Obtener todas las campañas enviadas a esta lista
      const campaigns = await Campaign.find({
        targetType: 'list',
        list: list._id,
        status: 'sent'
      }).select('_id name sentAt');
      
      if (campaigns.length === 0) {
        return res.json({
          list: {
            id: list._id,
            name: list.name,
            memberCount: list.memberCount
          },
          campaignsSent: 0,
          message: 'No hay campañas enviadas a esta lista aún',
          members: []
        });
      }
      
      console.log(`📧 Analizando ${campaigns.length} campañas enviadas`);
      
      const campaignIds = campaigns.map(c => c._id);
      
      // Obtener todos los eventos de estas campañas
      const events = await EmailEvent.find({
        campaign: { $in: campaignIds }
      }).populate('customer', 'email firstName lastName');
      
      console.log(`📈 ${events.length} eventos encontrados`);
      
      // Analizar engagement por customer
      const memberEngagement = {};
      
      // Inicializar todos los miembros de la lista
      for (const memberId of list.members) {
        memberEngagement[memberId.toString()] = {
          customerId: memberId,
          campaignsSent: 0,
          opens: 0,
          clicks: 0,
          bounces: 0,
          lastOpenDate: null,
          engagementScore: 0,
          status: 'no-activity'
        };
      }
      
      // Contar eventos por customer - ✅ VALIDACIÓN SEGURA
      const validEvents = events.filter(event => 
        event.customer && event.customer._id
      );
      
      validEvents.forEach(event => {
        const customerId = event.customer._id.toString();
        
        if (!memberEngagement[customerId]) {
          memberEngagement[customerId] = {
            customerId: event.customer._id,
            customer: event.customer,
            campaignsSent: 0,
            opens: 0,
            clicks: 0,
            bounces: 0,
            lastOpenDate: null,
            engagementScore: 0
          };
        }
        
        const engagement = memberEngagement[customerId];
        
        switch (event.eventType) {
          case 'sent':
            engagement.campaignsSent++;
            break;
          case 'opened':
            engagement.opens++;
            if (!engagement.lastOpenDate || new Date(event.eventDate) > new Date(engagement.lastOpenDate)) {
              engagement.lastOpenDate = event.eventDate;
            }
            break;
          case 'clicked':
            engagement.clicks++;
            break;
          case 'bounced':
            engagement.bounces++;
            break;
        }
      });
      
      // Cargar información de customers
      const customerIds = Object.keys(memberEngagement);
      const customers = await Customer.find({
        _id: { $in: customerIds }
      }).select('email firstName lastName').lean();
      
      const customersMap = {};
      customers.forEach(c => {
        customersMap[c._id.toString()] = c;
      });
      
      // Calcular engagement score y clasificar
      const members = Object.values(memberEngagement).map(engagement => {
        const customer = customersMap[engagement.customerId.toString()];
        
        if (!customer) return null;
        
        // Calcular score: opens (5pts) + clicks (10pts) - bounces (20pts)
        const score = (engagement.opens * 5) + (engagement.clicks * 10) - (engagement.bounces * 20);
        engagement.engagementScore = score;
        
        // Clasificar engagement
        if (engagement.bounces > 0) {
          engagement.status = 'bounced';
        } else if (engagement.campaignsSent === 0) {
          engagement.status = 'never-sent';
        } else if (engagement.opens === 0) {
          engagement.status = 'never-opened';
        } else if (engagement.clicks > 0) {
          engagement.status = 'highly-engaged';
        } else if (engagement.opens >= engagement.campaignsSent * 0.5) {
          engagement.status = 'engaged';
        } else {
          engagement.status = 'low-engagement';
        }
        
        // Calcular open rate
        engagement.openRate = engagement.campaignsSent > 0 
          ? ((engagement.opens / engagement.campaignsSent) * 100).toFixed(1)
          : 0;
        
        engagement.customer = customer;
        
        return engagement;
      }).filter(Boolean);
      
      // Calcular estadísticas
      const stats = {
        total: members.length,
        highlyEngaged: members.filter(m => m.status === 'highly-engaged').length,
        engaged: members.filter(m => m.status === 'engaged').length,
        lowEngagement: members.filter(m => m.status === 'low-engagement').length,
        neverOpened: members.filter(m => m.status === 'never-opened').length,
        bounced: members.filter(m => m.status === 'bounced').length,
        neverSent: members.filter(m => m.status === 'never-sent').length
      };
      
      // Calcular porcentajes
      stats.engagedPercent = stats.total > 0 
        ? (((stats.highlyEngaged + stats.engaged) / stats.total) * 100).toFixed(1)
        : 0;
      
      console.log(`✅ Análisis completado: ${stats.engagedPercent}% engaged`);
      
      res.json({
        list: {
          id: list._id,
          name: list.name,
          memberCount: list.memberCount
        },
        campaignsSent: campaigns.length,
        campaigns: campaigns.map(c => ({
          id: c._id,
          name: c.name,
          sentAt: c.sentAt
        })),
        stats,
        members: members.sort((a, b) => b.engagementScore - a.engagementScore)
      });
      
    } catch (error) {
      console.error('Error analizando engagement:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Limpiar miembros inactivos de una lista
  async cleanMembers(req, res) {
    try {
      const list = await List.findById(req.params.id);
      
      if (!list) {
        return res.status(404).json({ error: 'Lista no encontrada' });
      }
      
      const { criteria, dryRun = true } = req.body;
      
      if (!criteria) {
        return res.status(400).json({ 
          error: 'Debes especificar un criterio de limpieza' 
        });
      }
      
      console.log(`🧹 Limpiando lista: ${list.name} (${dryRun ? 'simulación' : 'real'})`);
      console.log(`📋 Criterio: ${criteria}`);
      
      let customersToRemove = [];
      
      if (criteria === 'custom' && req.body.customerIds) {
        customersToRemove = req.body.customerIds;
      } else {
        // Obtener análisis de engagement
        const campaigns = await Campaign.find({
          targetType: 'list',
          list: list._id,
          status: 'sent'
        }).select('_id');
        
        if (campaigns.length === 0) {
          return res.status(400).json({ 
            error: 'No hay campañas enviadas para analizar engagement' 
          });
        }
        
        const campaignIds = campaigns.map(c => c._id);
        const events = await EmailEvent.find({
          campaign: { $in: campaignIds }
        });
        
        // Analizar por customer
        const customerActivity = {};
        
        events.forEach(event => {
          if (!event.customer) return;
          
          const customerId = event.customer.toString();
          
          if (!customerActivity[customerId]) {
            customerActivity[customerId] = {
              sent: 0,
              opens: 0,
              bounces: 0,
              lastOpen: null
            };
          }
          
          switch (event.eventType) {
            case 'sent':
              customerActivity[customerId].sent++;
              break;
            case 'opened':
              customerActivity[customerId].opens++;
              customerActivity[customerId].lastOpen = event.eventDate;
              break;
            case 'bounced':
              customerActivity[customerId].bounces++;
              break;
          }
        });
        
        // Filtrar según criterio
        const now = new Date();
        const ninetyDaysAgo = new Date(now.getTime() - (90 * 24 * 60 * 60 * 1000));
        
        for (const memberId of list.members) {
          const memberIdStr = memberId.toString();
          const activity = customerActivity[memberIdStr];
          
          let shouldRemove = false;
          
          switch (criteria) {
            case 'never-opened':
              shouldRemove = activity && activity.sent > 0 && activity.opens === 0;
              break;
              
            case 'bounced':
              shouldRemove = activity && activity.bounces > 0;
              break;
              
            case 'low-engagement':
              if (activity && activity.sent > 0) {
                const openRate = (activity.opens / activity.sent) * 100;
                shouldRemove = openRate < 25;
              }
              break;
              
            case 'inactive-90-days':
              if (activity && activity.lastOpen) {
                const lastOpen = new Date(activity.lastOpen);
                shouldRemove = lastOpen < ninetyDaysAgo;
              } else if (activity && activity.sent > 0) {
                shouldRemove = true;
              }
              break;
          }
          
          if (shouldRemove) {
            customersToRemove.push(memberId);
          }
        }
      }
      
      console.log(`🔍 Encontrados ${customersToRemove.length} miembros para remover`);
      
      // Si es dry run, solo retornar la simulación
      if (dryRun) {
        const customersInfo = await Customer.find({
          _id: { $in: customersToRemove }
        }).select('email firstName lastName').limit(20);
        
        return res.json({
          dryRun: true,
          toRemove: customersToRemove.length,
          currentMembers: list.memberCount,
          afterClean: list.memberCount - customersToRemove.length,
          preview: customersInfo,
          message: 'Esta es una simulación. Usa dryRun=false para ejecutar.'
        });
      }
      
      // Ejecutar limpieza real
      const originalCount = list.memberCount;
      
      for (const customerId of customersToRemove) {
        await list.removeMember(customerId);
      }
      
      console.log(`✅ Limpieza completada: ${customersToRemove.length} miembros removidos`);
      
      res.json({
        success: true,
        removed: customersToRemove.length,
        before: originalCount,
        after: list.memberCount,
        list
      });
      
    } catch (error) {
      console.error('Error limpiando lista:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = new ListsController();