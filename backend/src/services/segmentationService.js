// backend/src/services/segmentationService.js
const Customer = require('../models/Customer');

class SegmentationService {
  
  // Evaluar un segmento y retornar clientes que coinciden
  async evaluateSegment(conditions, options = {}) {
    try {
      const query = this.buildQuery(conditions, options);
      
      let cursor = Customer.find(query)
        .select(options.select || 'email firstName lastName totalSpent ordersCount acceptsMarketing')
        .sort(options.sort || { _id: 1 }); // ✅ Usar _id para paginación consistente
      
      // ✅ AGREGADO: Soporte para skip (paginación)
      if (options.skip) {
        cursor = cursor.skip(options.skip);
      }
      
      if (options.limit) {
        cursor = cursor.limit(options.limit);
      }
      
      // ✅ AGREGADO: .lean() para mejor rendimiento de memoria
      const customers = await cursor.lean();
      
      return customers;
      
    } catch (error) {
      console.error('Error evaluando segmento:', error);
      throw error;
    }
  }

  // Construir query de MongoDB desde condiciones
  buildQuery(conditions, options = {}) {
    const query = {};
    
    if (options.onlyMarketing) {
      query.acceptsMarketing = true;
    }
    
    if (!conditions || conditions.length === 0) {
      return query;
    }
    
    conditions.forEach((condition, index) => {
      const { field, operator, value, logicalOperator } = condition;
      
      let fieldQuery = this.buildFieldQuery(field, operator, value);
      
      if (index === 0 || logicalOperator === 'AND') {
        if (query[field]) {
          if (!query.$and) {
            query.$and = [];
          }
          query.$and.push({ [field]: fieldQuery });
        } else {
          query[field] = fieldQuery;
        }
      } else if (logicalOperator === 'OR') {
        if (!query.$or) {
          query.$or = [];
        }
        query.$or.push({ [field]: fieldQuery });
      }
    });
    
    return query;
  }

  // Construir query para un campo específico
  buildFieldQuery(field, operator, value) {
    switch (operator) {
      case 'equals':
        return value;
        
      case 'not_equals':
        return { $ne: value };
        
      case 'greater_than':
        return { $gt: parseFloat(value) };
        
      case 'less_than':
        return { $lt: parseFloat(value) };
        
      case 'greater_or_equal':
        return { $gte: parseFloat(value) };
        
      case 'less_or_equal':
        return { $lte: parseFloat(value) };
        
      case 'contains':
        return { $regex: value, $options: 'i' };
        
      case 'not_contains':
        return { $not: { $regex: value, $options: 'i' } };
        
      case 'in_last_days':
        const daysAgo = new Date();
        daysAgo.setDate(daysAgo.getDate() - parseInt(value));
        return { $gte: daysAgo };
        
      case 'not_in_last_days':
        const notDaysAgo = new Date();
        notDaysAgo.setDate(notDaysAgo.getDate() - parseInt(value));
        return { $lt: notDaysAgo };
        
      case 'is_null':
        return null;
        
      case 'is_not_null':
        return { $ne: null };
        
      default:
        return value;
    }
  }

  // Contar clientes en un segmento
  async countSegment(conditions, options = {}) {
    try {
      const query = this.buildQuery(conditions, options);
      const count = await Customer.countDocuments(query);
      return count;
    } catch (error) {
      console.error('Error contando segmento:', error);
      throw error;
    }
  }

  // ==================== SEGMENTOS PREDEFINIDOS ====================
  
  async getVIPCustomers(onlyMarketing = false) {
    const query = {
      totalSpent: { $gte: 500 },
      ordersCount: { $gte: 3 }
    };
    
    if (onlyMarketing) {
      query.acceptsMarketing = true;
    }
    
    return await Customer.find(query).sort({ totalSpent: -1 }).lean();
  }

  async getNewSubscribers(onlyMarketing = false) {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const query = {
      createdAt: { $gte: thirtyDaysAgo },
      ordersCount: 0
    };
    
    if (onlyMarketing) {
      query.acceptsMarketing = true;
    }
    
    return await Customer.find(query).sort({ createdAt: -1 }).lean();
  }

  async getInactiveCustomers(onlyMarketing = false) {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    
    const query = {
      ordersCount: { $gt: 0 },
      lastOrderDate: { $lt: ninetyDaysAgo }
    };
    
    if (onlyMarketing) {
      query.acceptsMarketing = true;
    }
    
    return await Customer.find(query).sort({ lastOrderDate: 1 }).lean();
  }

  async getOneTimeBuyers(onlyMarketing = false) {
    const query = {
      ordersCount: 1
    };
    
    if (onlyMarketing) {
      query.acceptsMarketing = true;
    }
    
    return await Customer.find(query).sort({ lastOrderDate: -1 }).lean();
  }

  async getRepeatCustomers(onlyMarketing = false) {
    const query = {
      ordersCount: { $gte: 2 }
    };
    
    if (onlyMarketing) {
      query.acceptsMarketing = true;
    }
    
    return await Customer.find(query).sort({ ordersCount: -1 }).lean();
  }

  async getCustomersByLocation(state = null, country = 'US', onlyMarketing = false) {
    const query = {
      'address.country': country
    };
    
    if (state) {
      query['address.province'] = state;
    }
    
    if (onlyMarketing) {
      query.acceptsMarketing = true;
    }
    
    return await Customer.find(query).lean();
  }

  async getHighAOVCustomers(minAOV = 100, onlyMarketing = false) {
    const query = {
      averageOrderValue: { $gte: minAOV },
      ordersCount: { $gte: 2 }
    };
    
    if (onlyMarketing) {
      query.acceptsMarketing = true;
    }
    
    return await Customer.find(query).sort({ averageOrderValue: -1 }).lean();
  }
}

module.exports = new SegmentationService();