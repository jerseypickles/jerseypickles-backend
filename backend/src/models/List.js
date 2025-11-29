// backend/src/models/List.js
const mongoose = require('mongoose');

const listSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  
  description: {
    type: String,
    trim: true
  },
  
  // Miembros de la lista (solo IDs de customers)
  members: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer'
  }],
  
  // Estadísticas
  memberCount: {
    type: Number,
    default: 0
  },
  
  // Tags para organización
  tags: [String],
  
  // Estado
  isActive: {
    type: Boolean,
    default: true
  }
  
}, {
  timestamps: true
});

// Índices
listSchema.index({ name: 1 });
listSchema.index({ members: 1 });
listSchema.index({ createdAt: -1 });

// Método para actualizar conteo
listSchema.methods.updateMemberCount = function() {
  this.memberCount = this.members.length;
  return this.save();
};

// Método para agregar miembro
listSchema.methods.addMember = function(customerId) {
  if (!this.members.includes(customerId)) {
    this.members.push(customerId);
    this.memberCount = this.members.length;
  }
  return this.save();
};

// Método para remover miembro
listSchema.methods.removeMember = function(customerId) {
  this.members = this.members.filter(id => id.toString() !== customerId.toString());
  this.memberCount = this.members.length;
  return this.save();
};

// Método para agregar múltiples miembros
listSchema.methods.addMembers = function(customerIds) {
  const existingIds = new Set(this.members.map(id => id.toString()));
  
  customerIds.forEach(customerId => {
    const idString = customerId.toString();
    if (!existingIds.has(idString)) {
      this.members.push(customerId);
      existingIds.add(idString);
    }
  });
  
  this.memberCount = this.members.length;
  return this.save();
};

module.exports = mongoose.model('List', listSchema);