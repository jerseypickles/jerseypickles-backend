// backend/src/controllers/segmentsController.js
const Segment = require('../models/Segment');
const segmentationService = require('../services/segmentationService');

class SegmentsController {
  
  // Listar todos los segmentos
  async list(req, res) {
    try {
      const segments = await Segment.find()
        .sort({ createdAt: -1 });
      
      res.json({
        segments,
        total: segments.length
      });
      
    } catch (error) {
      console.error('Error listando segmentos:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Obtener un segmento
  async getOne(req, res) {
    try {
      const segment = await Segment.findById(req.params.id);
      
      if (!segment) {
        return res.status(404).json({ error: 'Segmento no encontrado' });
      }
      
      res.json(segment);
      
    } catch (error) {
      console.error('Error obteniendo segmento:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Crear segmento
  async create(req, res) {
    try {
      const { name, description, conditions } = req.body;
      
      // Validar que tenga al menos una condición
      if (!conditions || conditions.length === 0) {
        return res.status(400).json({ 
          error: 'El segmento debe tener al menos una condición' 
        });
      }
      
      // Calcular cantidad de clientes
      const customerCount = await segmentationService.countSegment(conditions);
      
      const segment = await Segment.create({
        name,
        description,
        conditions,
        customerCount,
        lastCalculated: new Date()
      });
      
      console.log(`✅ Segmento creado: ${name} (${customerCount} clientes)`);
      
      res.status(201).json(segment);
      
    } catch (error) {
      console.error('Error creando segmento:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Actualizar segmento
  async update(req, res) {
    try {
      const { name, description, conditions, isActive } = req.body;
      
      const segment = await Segment.findById(req.params.id);
      
      if (!segment) {
        return res.status(404).json({ error: 'Segmento no encontrado' });
      }
      
      // Si cambiaron las condiciones, recalcular
      if (conditions && JSON.stringify(conditions) !== JSON.stringify(segment.conditions)) {
        const customerCount = await segmentationService.countSegment(conditions);
        segment.customerCount = customerCount;
        segment.conditions = conditions;
        segment.lastCalculated = new Date();
      }
      
      if (name) segment.name = name;
      if (description !== undefined) segment.description = description;
      if (isActive !== undefined) segment.isActive = isActive;
      
      await segment.save();
      
      console.log(`✅ Segmento actualizado: ${segment.name}`);
      
      res.json(segment);
      
    } catch (error) {
      console.error('Error actualizando segmento:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Eliminar segmento
  async delete(req, res) {
    try {
      const segment = await Segment.findByIdAndDelete(req.params.id);
      
      if (!segment) {
        return res.status(404).json({ error: 'Segmento no encontrado' });
      }
      
      console.log(`🗑️  Segmento eliminado: ${segment.name}`);
      
      res.json({ 
        success: true, 
        message: 'Segmento eliminado correctamente' 
      });
      
    } catch (error) {
      console.error('Error eliminando segmento:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Preview de segmento (ver clientes que coinciden)
  async preview(req, res) {
    try {
      const { conditions, limit = 10 } = req.body;
      
      if (!conditions || conditions.length === 0) {
        return res.status(400).json({ 
          error: 'Debes proporcionar condiciones' 
        });
      }
      
      const customers = await segmentationService.evaluateSegment(conditions, {
        limit: parseInt(limit),
        select: 'email firstName lastName totalSpent ordersCount lastOrderDate'
      });
      
      const totalCount = await segmentationService.countSegment(conditions);
      
      res.json({
        preview: customers,
        totalCount,
        showing: customers.length
      });
      
    } catch (error) {
      console.error('Error en preview de segmento:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Recalcular segmento
  async recalculate(req, res) {
    try {
      const segment = await Segment.findById(req.params.id);
      
      if (!segment) {
        return res.status(404).json({ error: 'Segmento no encontrado' });
      }
      
      console.log(`🔄 Recalculando segmento: ${segment.name}`);
      
      const customerCount = await segmentationService.countSegment(segment.conditions);
      
      segment.customerCount = customerCount;
      segment.lastCalculated = new Date();
      await segment.save();
      
      console.log(`✅ Recalculado: ${customerCount} clientes`);
      
      res.json({
        success: true,
        segment,
        message: `Segmento recalculado: ${customerCount} clientes`
      });
      
    } catch (error) {
      console.error('Error recalculando segmento:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Obtener clientes de un segmento
  async getCustomers(req, res) {
    try {
      const { page = 1, limit = 50 } = req.query;
      
      const segment = await Segment.findById(req.params.id);
      
      if (!segment) {
        return res.status(404).json({ error: 'Segmento no encontrado' });
      }
      
      const customers = await segmentationService.evaluateSegment(segment.conditions, {
        limit: parseInt(limit),
        skip: (page - 1) * limit
      });
      
      res.json({
        customers,
        total: segment.customerCount,
        page: parseInt(page),
        pages: Math.ceil(segment.customerCount / limit)
      });
      
    } catch (error) {
      console.error('Error obteniendo clientes del segmento:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // ==================== SEGMENTOS PREDEFINIDOS ====================
  
  async getPredefined(req, res) {
    try {
      const { type } = req.params;
      
      let customers;
      let name;
      
      switch (type) {
        case 'vip':
          customers = await segmentationService.getVIPCustomers();
          name = 'Clientes VIP';
          break;
          
        case 'new-subscribers':
          customers = await segmentationService.getNewSubscribers();
          name = 'Nuevos Suscriptores';
          break;
          
        case 'inactive':
          customers = await segmentationService.getInactiveCustomers();
          name = 'Clientes Inactivos';
          break;
          
        case 'one-time-buyers':
          customers = await segmentationService.getOneTimeBuyers();
          name = 'Compradores de Una Vez';
          break;
          
        case 'repeat-customers':
          customers = await segmentationService.getRepeatCustomers();
          name = 'Clientes Recurrentes';
          break;
          
        case 'high-aov':
          customers = await segmentationService.getHighAOVCustomers();
          name = 'Alto Valor Promedio';
          break;
          
        default:
          return res.status(400).json({ 
            error: 'Tipo de segmento no válido',
            validTypes: ['vip', 'new-subscribers', 'inactive', 'one-time-buyers', 'repeat-customers', 'high-aov']
          });
      }
      
      res.json({
        type,
        name,
        customers,
        count: customers.length
      });
      
    } catch (error) {
      console.error('Error obteniendo segmento predefinido:', error);
      res.status(500).json({ error: error.message });
    }
  }

  // Crear segmentos predefinidos en la BD
  async createPredefinedSegments(req, res) {
    try {
      console.log('📋 Creando segmentos predefinidos...\n');
      
      const predefinedSegments = [
        {
          name: '💎 Clientes VIP',
          description: 'Clientes de alto valor (más de $500 gastados y 3+ órdenes)',
          conditions: [
            { field: 'totalSpent', operator: 'greater_or_equal', value: '500', logicalOperator: 'AND' },
            { field: 'ordersCount', operator: 'greater_or_equal', value: '3', logicalOperator: 'AND' }
          ]
        },
        {
          name: '🆕 Nuevos Suscriptores',
          description: 'Suscriptores de los últimos 30 días sin compras',
          conditions: [
            { field: 'createdAt', operator: 'in_last_days', value: '30', logicalOperator: 'AND' },
            { field: 'ordersCount', operator: 'equals', value: '0', logicalOperator: 'AND' }
          ]
        },
        {
          name: '😴 Clientes Inactivos',
          description: 'No han comprado en los últimos 90 días',
          conditions: [
            { field: 'ordersCount', operator: 'greater_than', value: '0', logicalOperator: 'AND' },
            { field: 'lastOrderDate', operator: 'not_in_last_days', value: '90', logicalOperator: 'AND' }
          ]
        },
        {
          name: '🎯 One-Time Buyers',
          description: 'Clientes con exactamente 1 compra',
          conditions: [
            { field: 'ordersCount', operator: 'equals', value: '1', logicalOperator: 'AND' }
          ]
        },
        {
          name: '🔄 Clientes Recurrentes',
          description: 'Clientes con 2 o más compras',
          conditions: [
            { field: 'ordersCount', operator: 'greater_or_equal', value: '2', logicalOperator: 'AND' }
          ]
        },
        {
          name: '💰 Alto Valor Promedio',
          description: 'AOV mayor a $100',
          conditions: [
            { field: 'averageOrderValue', operator: 'greater_or_equal', value: '100', logicalOperator: 'AND' },
            { field: 'ordersCount', operator: 'greater_or_equal', value: '2', logicalOperator: 'AND' }
          ]
        }
      ];
      
      const results = [];
      
      for (const segmentData of predefinedSegments) {
        try {
          // Verificar si ya existe
          const existing = await Segment.findOne({ name: segmentData.name });
          
          if (existing) {
            console.log(`⏭️  ${segmentData.name} ya existe, recalculando...`);
            const count = await segmentationService.countSegment(segmentData.conditions);
            existing.customerCount = count;
            existing.lastCalculated = new Date();
            await existing.save();
            results.push({ ...existing.toObject(), status: 'updated' });
          } else {
            const count = await segmentationService.countSegment(segmentData.conditions);
            const segment = await Segment.create({
              ...segmentData,
              customerCount: count,
              lastCalculated: new Date()
            });
            console.log(`✅ ${segmentData.name} creado (${count} clientes)`);
            results.push({ ...segment.toObject(), status: 'created' });
          }
        } catch (error) {
          console.error(`❌ Error con ${segmentData.name}:`, error.message);
          results.push({ name: segmentData.name, status: 'error', error: error.message });
        }
      }
      
      console.log('\n🎉 Segmentos predefinidos listos!\n');
      
      res.json({
        success: true,
        segments: results
      });
      
    } catch (error) {
      console.error('Error creando segmentos predefinidos:', error);
      res.status(500).json({ error: error.message });
    }
  }
}

module.exports = new SegmentsController();