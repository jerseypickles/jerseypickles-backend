// backend/src/models/Segment.js
const mongoose = require('mongoose');

// Función helper para crear slug desde el nombre
function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')           // Reemplazar espacios con -
    .replace(/[^\w\-]+/g, '')       // Remover caracteres no alfanuméricos
    .replace(/\-\-+/g, '-')         // Reemplazar múltiples - con uno solo
    .replace(/^-+/, '')             // Remover - del inicio
    .replace(/-+$/, '');            // Remover - del final
}

const segmentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  slug: {
    type: String,
    unique: true,
    index: true
  },
  description: String,
  
  // Condiciones del segmento
  conditions: [{
    field: {
      type: String,
      required: true,
      enum: [
        'totalSpent', 'ordersCount', 'averageOrderValue',
        'lastOrderDate', 'createdAt', 'acceptsMarketing',
        'tags', 'city', 'province', 'country'
      ]
    },
    operator: {
      type: String,
      required: true,
      enum: [
        'equals', 'not_equals', 'greater_than', 'less_than',
        'greater_or_equal', 'less_or_equal', 'contains',
        'not_contains', 'in_last_days', 'not_in_last_days'
      ]
    },
    value: mongoose.Schema.Types.Mixed,
    logicalOperator: {
      type: String,
      enum: ['AND', 'OR'],
      default: 'AND'
    }
  }],
  
  // Estadísticas
  customerCount: {
    type: Number,
    default: 0
  },
  lastCalculated: Date,
  
  isActive: {
    type: Boolean,
    default: true
  },
  
  // Cache de IDs de clientes (opcional para segmentos grandes)
  cachedCustomerIds: [String]
  
}, {
  timestamps: true,
  collection: 'segments'
});

// Middleware: Generar slug automáticamente antes de guardar
segmentSchema.pre('save', async function(next) {
  // Solo generar slug si es nuevo o cambió el nombre
  if (this.isNew || this.isModified('name')) {
    const baseSlug = slugify(this.name);
    let slug = baseSlug;
    let counter = 1;
    
    // Verificar si el slug ya existe y agregar contador si es necesario
    while (await this.constructor.findOne({ slug, _id: { $ne: this._id } })) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }
    
    this.slug = slug;
  }
  next();
});

// Método para recalcular clientes del segmento
segmentSchema.methods.recalculate = async function() {
  const Customer = mongoose.model('Customer');
  const query = this.buildQuery();
  
  const customers = await Customer.find(query).select('_id');
  this.customerCount = customers.length;
  this.cachedCustomerIds = customers.map(c => c._id.toString());
  this.lastCalculated = new Date();
  
  await this.save();
  return this.customerCount;
};

// Método para construir query de MongoDB
segmentSchema.methods.buildQuery = function() {
  const query = {}; // ✅ CAMBIO: Ya no filtra por acceptsMarketing automáticamente
  
  this.conditions.forEach((condition, index) => {
    const { field, operator, value } = condition;
    
    let fieldQuery;
    
    switch (operator) {
      case 'equals':
        fieldQuery = value;
        break;
      case 'not_equals':
        fieldQuery = { $ne: value };
        break;
      case 'greater_than':
        fieldQuery = { $gt: parseFloat(value) };
        break;
      case 'less_than':
        fieldQuery = { $lt: parseFloat(value) };
        break;
      case 'greater_or_equal':
        fieldQuery = { $gte: parseFloat(value) };
        break;
      case 'less_or_equal':
        fieldQuery = { $lte: parseFloat(value) };
        break;
      case 'contains':
        fieldQuery = { $regex: value, $options: 'i' };
        break;
      case 'not_contains':
        fieldQuery = { $not: { $regex: value, $options: 'i' } };
        break;
      case 'in_last_days':
        const daysAgo = new Date();
        daysAgo.setDate(daysAgo.getDate() - parseInt(value));
        fieldQuery = { $gte: daysAgo };
        break;
      case 'not_in_last_days':
        const notDaysAgo = new Date();
        notDaysAgo.setDate(notDaysAgo.getDate() - parseInt(value));
        fieldQuery = { $lt: notDaysAgo };
        break;
    }
    
    query[field] = fieldQuery;
  });
  
  return query;
};

module.exports = mongoose.model('Segment', segmentSchema);