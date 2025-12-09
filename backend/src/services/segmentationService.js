// backend/src/services/segmentationService.js - ACTUALIZADO
const Customer = require('../models/Customer');

/**
 * Construye una query de MongoDB a partir de condiciones de segmento
 * Soporta campos nested como emailStats.opened y operadores avanzados
 */
const buildQuery = (conditions, options = {}) => {
  const { onlyMarketing = false } = options;
  
  if (!conditions || conditions.length === 0) {
    return onlyMarketing ? { acceptsMarketing: true } : {};
  }

  // Agrupar condiciones por operador lógico
  const andConditions = [];
  const orConditions = [];

  conditions.forEach((condition, index) => {
    const mongoCondition = buildCondition(condition);
    
    if (index === 0 || condition.logicalOperator === 'AND') {
      andConditions.push(mongoCondition);
    } else {
      orConditions.push(mongoCondition);
    }
  });

  let query = {};

  // Construir query con AND/OR
  if (andConditions.length > 0 && orConditions.length > 0) {
    query = {
      $and: [
        ...andConditions,
        { $or: orConditions }
      ]
    };
  } else if (andConditions.length > 0) {
    query = { $and: andConditions };
  } else if (orConditions.length > 0) {
    query = { $or: orConditions };
  }

  // Agregar filtro de marketing si es necesario
  if (onlyMarketing) {
    if (query.$and) {
      query.$and.push({ acceptsMarketing: true });
    } else {
      query = { $and: [query, { acceptsMarketing: true }] };
    }
  }

  return query;
};

/**
 * Construye una condición individual de MongoDB
 */
const buildCondition = (condition) => {
  const { field, operator, value } = condition;
  
  // Determinar el campo real (puede ser nested)
  const fieldPath = field; // MongoDB soporta dot notation directamente
  
  switch (operator) {
    // === Comparación numérica ===
    case 'equals':
      return { [fieldPath]: value };
      
    case 'not_equals':
      return { [fieldPath]: { $ne: value } };
      
    case 'greater_than':
      return { [fieldPath]: { $gt: parseNumericValue(value) } };
      
    case 'less_than':
      return { [fieldPath]: { $lt: parseNumericValue(value) } };
      
    case 'greater_than_or_equals':
      return { [fieldPath]: { $gte: parseNumericValue(value) } };
      
    case 'less_than_or_equals':
      return { [fieldPath]: { $lte: parseNumericValue(value) } };
    
    // === Strings ===
    case 'contains':
      return { [fieldPath]: { $regex: escapeRegex(value), $options: 'i' } };
      
    case 'not_contains':
      return { [fieldPath]: { $not: { $regex: escapeRegex(value), $options: 'i' } } };
      
    case 'starts_with':
      return { [fieldPath]: { $regex: `^${escapeRegex(value)}`, $options: 'i' } };
      
    case 'ends_with':
      return { [fieldPath]: { $regex: `${escapeRegex(value)}$`, $options: 'i' } };
    
    // === Fechas ===
    case 'in_last_days':
      const daysAgo = new Date();
      daysAgo.setDate(daysAgo.getDate() - parseInt(value));
      return { [fieldPath]: { $gte: daysAgo } };
      
    case 'not_in_last_days':
      const notDaysAgo = new Date();
      notDaysAgo.setDate(notDaysAgo.getDate() - parseInt(value));
      return { [fieldPath]: { $lt: notDaysAgo } };
      
    case 'before_date':
      return { [fieldPath]: { $lt: new Date(value) } };
      
    case 'after_date':
      return { [fieldPath]: { $gt: new Date(value) } };
    
    // === Existencia (para popupDiscountCode, etc.) ===
    case 'exists':
      return { [fieldPath]: { $exists: true, $ne: null, $ne: '' } };
      
    case 'not_exists':
      return { 
        $or: [
          { [fieldPath]: { $exists: false } },
          { [fieldPath]: null },
          { [fieldPath]: '' }
        ]
      };
      
    case 'is_empty':
      return { 
        $or: [
          { [fieldPath]: { $exists: false } },
          { [fieldPath]: null },
          { [fieldPath]: '' },
          { [fieldPath]: [] }
        ]
      };
      
    case 'is_not_empty':
      return { 
        [fieldPath]: { $exists: true, $ne: null, $ne: '', $ne: [] }
      };
    
    // === Arrays (para source, tags) ===
    case 'in':
      const inValues = Array.isArray(value) ? value : [value];
      return { [fieldPath]: { $in: inValues } };
      
    case 'not_in':
      const notInValues = Array.isArray(value) ? value : [value];
      return { [fieldPath]: { $nin: notInValues } };
    
    default:
      console.warn(`Unknown operator: ${operator}`);
      return {};
  }
};

/**
 * Parsea valor numérico
 */
const parseNumericValue = (value) => {
  const num = parseFloat(value);
  return isNaN(num) ? 0 : num;
};

/**
 * Escapa caracteres especiales para regex
 */
const escapeRegex = (string) => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * Obtiene el conteo de clientes para un segmento
 */
const getSegmentCustomerCount = async (segment, options = {}) => {
  const query = buildQuery(segment.conditions, options);
  return await Customer.countDocuments(query);
};

/**
 * Obtiene los clientes de un segmento
 */
const getSegmentCustomers = async (segment, options = {}) => {
  const { 
    page = 1, 
    limit = 50, 
    sort = { createdAt: -1 },
    onlyMarketing = false,
    fields = null
  } = options;
  
  const query = buildQuery(segment.conditions, { onlyMarketing });
  
  let queryBuilder = Customer.find(query)
    .sort(sort)
    .skip((page - 1) * limit)
    .limit(limit);
    
  if (fields) {
    queryBuilder = queryBuilder.select(fields);
  }
  
  const [customers, total] = await Promise.all([
    queryBuilder.exec(),
    Customer.countDocuments(query)
  ]);
  
  return {
    customers,
    total,
    page,
    pages: Math.ceil(total / limit)
  };
};

/**
 * Preview de un segmento (sin guardar)
 */
const previewSegment = async (conditions, options = {}) => {
  const { limit = 10, onlyMarketing = false } = options;
  
  const query = buildQuery(conditions, { onlyMarketing });
  
  const [customers, count] = await Promise.all([
    Customer.find(query)
      .select('email firstName lastName ordersCount totalSpent emailStats.opened emailStats.clicked source')
      .limit(limit)
      .sort({ createdAt: -1 }),
    Customer.countDocuments(query)
  ]);
  
  return { customers, count };
};

/**
 * SEGMENTOS PREDEFINIDOS ACTUALIZADOS
 * Basados en datos reales de MongoDB después de 1 mes de operación
 */
const PREDEFINED_SEGMENTS = {
  // === CATEGORÍA: PURCHASE ===
  'compradores': {
    name: 'Compradores',
    slug: 'compradores',
    description: 'Clientes que han realizado al menos una compra',
    category: 'purchase',
    conditions: [
      { field: 'ordersCount', operator: 'greater_than', value: 0 }
    ]
  },
  'no-compradores': {
    name: 'No han comprado',
    slug: 'no-compradores',
    description: 'Clientes registrados que nunca han comprado',
    category: 'purchase',
    conditions: [
      { field: 'ordersCount', operator: 'equals', value: 0 }
    ]
  },
  'compradores-recurrentes': {
    name: 'Compradores recurrentes',
    slug: 'compradores-recurrentes',
    description: 'Clientes que han comprado 2 o más veces',
    category: 'purchase',
    conditions: [
      { field: 'ordersCount', operator: 'greater_than_or_equals', value: 2 }
    ]
  },
  'vip': {
    name: 'VIP ($200+)',
    slug: 'vip',
    description: 'Clientes que han gastado $200 o más en total',
    category: 'purchase',
    conditions: [
      { field: 'totalSpent', operator: 'greater_than_or_equals', value: 200 }
    ]
  },
  'super-vip': {
    name: 'Super VIP ($500+)',
    slug: 'super-vip',
    description: 'Clientes que han gastado $500 o más en total',
    category: 'purchase',
    conditions: [
      { field: 'totalSpent', operator: 'greater_than_or_equals', value: 500 }
    ]
  },

  // === CATEGORÍA: ENGAGEMENT ===
  'engaged-sin-compra': {
    name: 'Engaged sin compra',
    slug: 'engaged-sin-compra',
    description: 'Abrieron emails pero nunca han comprado - alto potencial de conversión',
    category: 'engagement',
    conditions: [
      { field: 'emailStats.opened', operator: 'greater_than', value: 0 },
      { field: 'ordersCount', operator: 'equals', value: 0, logicalOperator: 'AND' }
    ]
  },
  'clickers-sin-compra': {
    name: 'Clickers sin compra',
    slug: 'clickers-sin-compra',
    description: 'Hicieron click en emails pero no han comprado - muy cerca de convertir',
    category: 'engagement',
    conditions: [
      { field: 'emailStats.clicked', operator: 'greater_than', value: 0 },
      { field: 'ordersCount', operator: 'equals', value: 0, logicalOperator: 'AND' }
    ]
  },
  'super-engaged': {
    name: 'Super engaged',
    slug: 'super-engaged',
    description: 'Abrieron 5+ emails - muy interesados en tu contenido',
    category: 'engagement',
    conditions: [
      { field: 'emailStats.opened', operator: 'greater_than_or_equals', value: 5 }
    ]
  },
  'nunca-abrieron': {
    name: 'Nunca abrieron',
    slug: 'nunca-abrieron',
    description: 'Recibieron emails pero nunca abrieron ninguno',
    category: 'engagement',
    conditions: [
      { field: 'emailStats.sent', operator: 'greater_than', value: 0 },
      { field: 'emailStats.opened', operator: 'equals', value: 0, logicalOperator: 'AND' }
    ]
  },

  // === CATEGORÍA: POPUP ===
  'popup-sin-convertir': {
    name: 'Popup sin convertir',
    slug: 'popup-sin-convertir',
    description: 'Suscriptores de popup que aún no han usado su descuento',
    category: 'popup',
    conditions: [
      { field: 'popupDiscountCode', operator: 'exists' },
      { field: 'ordersCount', operator: 'equals', value: 0, logicalOperator: 'AND' }
    ]
  },
  'popup-convertidos': {
    name: 'Popup convertidos',
    slug: 'popup-convertidos',
    description: 'Suscriptores de popup que sí compraron',
    category: 'popup',
    conditions: [
      { field: 'popupDiscountCode', operator: 'exists' },
      { field: 'ordersCount', operator: 'greater_than', value: 0, logicalOperator: 'AND' }
    ]
  },
  'todos-popup': {
    name: 'Todos de popup',
    slug: 'todos-popup',
    description: 'Todos los suscriptores que vinieron de popups',
    category: 'popup',
    conditions: [
      { field: 'popupDiscountCode', operator: 'exists' }
    ]
  },

  // === CATEGORÍA: LIFECYCLE ===
  'nuevos-30-dias': {
    name: 'Nuevos (30 días)',
    slug: 'nuevos-30-dias',
    description: 'Clientes registrados en los últimos 30 días',
    category: 'lifecycle',
    conditions: [
      { field: 'createdAt', operator: 'in_last_days', value: 30 }
    ]
  },
  'inactivos-90-dias': {
    name: 'Inactivos (90 días)',
    slug: 'inactivos-90-dias',
    description: 'No han comprado en los últimos 90 días',
    category: 'lifecycle',
    conditions: [
      { field: 'lastOrderDate', operator: 'not_in_last_days', value: 90 },
      { field: 'ordersCount', operator: 'greater_than', value: 0, logicalOperator: 'AND' }
    ]
  },
  'compradores-recientes': {
    name: 'Compradores recientes',
    slug: 'compradores-recientes',
    description: 'Compraron en los últimos 30 días',
    category: 'lifecycle',
    conditions: [
      { field: 'lastOrderDate', operator: 'in_last_days', value: 30 }
    ]
  },

  // === CATEGORÍA: CLEANUP ===
  'bounced': {
    name: 'Bounced (limpiar)',
    slug: 'bounced',
    description: 'Emails que rebotan - considerar eliminar de listas',
    category: 'cleanup',
    conditions: [
      { field: 'bounceInfo.isBounced', operator: 'equals', value: true }
    ]
  },
  'hard-bounced': {
    name: 'Hard bounces',
    slug: 'hard-bounced',
    description: 'Hard bounces - eliminar inmediatamente',
    category: 'cleanup',
    conditions: [
      { field: 'bounceInfo.bounceType', operator: 'equals', value: 'hard' }
    ]
  },
  'unsubscribed': {
    name: 'Desuscritos',
    slug: 'unsubscribed',
    description: 'Clientes que se desuscribieron',
    category: 'cleanup',
    conditions: [
      { field: 'emailStatus', operator: 'equals', value: 'unsubscribed' }
    ]
  },
  'complained': {
    name: 'Reportaron spam',
    slug: 'complained',
    description: 'Marcaron emails como spam - NO enviar más',
    category: 'cleanup',
    conditions: [
      { field: 'emailStatus', operator: 'equals', value: 'complained' }
    ]
  }
};

/**
 * Obtiene definición de un segmento predefinido
 */
const getPredefinedSegment = (key) => {
  return PREDEFINED_SEGMENTS[key] || null;
};

/**
 * Obtiene todos los segmentos predefinidos
 */
const getAllPredefinedSegments = () => {
  return PREDEFINED_SEGMENTS;
};

/**
 * Obtiene segmentos predefinidos por categoría
 */
const getPredefinedByCategory = (category) => {
  return Object.entries(PREDEFINED_SEGMENTS)
    .filter(([_, segment]) => segment.category === category)
    .reduce((acc, [key, segment]) => {
      acc[key] = segment;
      return acc;
    }, {});
};

/**
 * Crea todos los segmentos predefinidos en la BD
 */
const createAllPredefinedSegments = async () => {
  const Segment = require('../models/Segment');
  const results = [];
  
  for (const [key, definition] of Object.entries(PREDEFINED_SEGMENTS)) {
    try {
      // Verificar si ya existe
      let segment = await Segment.findOne({ slug: definition.slug });
      
      if (segment) {
        // Actualizar si existe
        segment.name = definition.name;
        segment.description = definition.description;
        segment.conditions = definition.conditions;
        segment.category = definition.category;
        segment.isPredefined = true;
        segment.type = 'predefined';
        await segment.save();
        
        // Recalcular count
        await segment.recalculate();
        
        results.push({ key, action: 'updated', count: segment.customerCount });
      } else {
        // Crear nuevo
        segment = new Segment({
          ...definition,
          isPredefined: true,
          type: 'predefined',
          isActive: true
        });
        await segment.save();
        
        // Calcular count
        await segment.recalculate();
        
        results.push({ key, action: 'created', count: segment.customerCount });
      }
    } catch (error) {
      console.error(`Error creating segment ${key}:`, error);
      results.push({ key, action: 'error', error: error.message });
    }
  }
  
  return results;
};

module.exports = {
  buildQuery,
  getSegmentCustomerCount,
  getSegmentCustomers,
  previewSegment,
  getPredefinedSegment,
  getAllPredefinedSegments,
  getPredefinedByCategory,
  createAllPredefinedSegments,
  PREDEFINED_SEGMENTS
};