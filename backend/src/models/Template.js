// backend/src/models/Template.js
const mongoose = require('mongoose');

const templateSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    unique: true
  },
  description: String,
  
  // Contenido
  subject: String,
  htmlContent: {
    type: String,
    required: true
  },
  previewText: String,
  
  // Tipo de template
  type: {
    type: String,
    enum: ['welcome', 'abandoned_cart', 'order_confirmation', 'promotional', 'newsletter', 'custom'],
    default: 'custom',
    index: true
  },
  
  // Variables disponibles en el template
  variables: [{
    name: String,
    description: String,
    defaultValue: String
  }],
  
  // Thumbnail para preview
  thumbnail: String,
  
  // Estadísticas de uso
  usageCount: {
    type: Number,
    default: 0
  },
  
  isActive: {
    type: Boolean,
    default: true
  },
  
  // Tags para organización
  tags: [String]
  
}, {
  timestamps: true,
  collection: 'templates'
});

// Método para renderizar template con datos
templateSchema.methods.render = function(data) {
  let html = this.htmlContent;
  let subject = this.subject;
  
  // Reemplazar variables {{variable}}
  Object.keys(data).forEach(key => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    html = html.replace(regex, data[key] || '');
    if (subject) {
      subject = subject.replace(regex, data[key] || '');
    }
  });
  
  return { html, subject };
};

module.exports = mongoose.model('Template', templateSchema);