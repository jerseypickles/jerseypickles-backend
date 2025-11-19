// backend/src/jobs/emailQueue.js
const emailService = require('../services/emailService');
const Campaign = require('../models/Campaign');
const EmailEvent = require('../models/EmailEvent');

// ✅ DESACTIVAR Bull temporalmente
let emailQueue = null;
let isQueueReady = false;

console.log('⚠️  Bull Queue desactivado temporalmente - Usando envío directo');
console.log('💡 Para habilitar Bull, configura correctamente REDIS_URL');

// Función helper para agregar emails (no hace nada sin queue)
async function addEmailsToQueue(emails, campaignId) {
  throw new Error('Redis queue no disponible. Usa el método de envío directo.');
}

// getQueueStatus siempre retorna offline
async function getQueueStatus() {
  return { 
    available: false,
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
    paused: false,
    total: 0,
    error: 'Bull Queue desactivado - Usando envío directo' 
  };
}

async function pauseQueue() {
  return { success: false, error: 'Queue not available' };
}

async function resumeQueue() {
  return { success: false, error: 'Queue not available' };
}

async function cleanQueue() {
  return { success: false, error: 'Queue not available' };
}

async function closeQueue() {
  console.log('✅ No queue to close');
}

module.exports = {
  emailQueue,
  addEmailsToQueue,
  getQueueStatus,
  pauseQueue,
  resumeQueue,
  cleanQueue,
  closeQueue,
  isAvailable: () => false // ✅ Siempre retorna false
};