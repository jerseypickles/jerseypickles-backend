// backend/src/utils/unsubscribeToken.js
const crypto = require('crypto');

// Clave secreta para firmar tokens (usa variable de entorno en producción)
const SECRET_KEY = process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || 'jersey-pickles-unsubscribe-secret-2024';

/**
 * Genera un token seguro de unsubscribe
 * El token contiene: customerId + email + campaignId (opcional) + timestamp, todo encriptado
 */
function generateUnsubscribeToken(customerId, email, campaignId = null) {
  const payload = {
    cid: customerId.toString(),
    e: email.toLowerCase(),
    ts: Date.now()
  };
  
  // Incluir campaignId si existe
  if (campaignId) {
    payload.cpid = campaignId.toString();
  }
  
  // Convertir a JSON y encriptar con AES-256
  const payloadString = JSON.stringify(payload);
  
  // Crear IV aleatorio
  const iv = crypto.randomBytes(16);
  
  // Derivar clave de 32 bytes del secret
  const key = crypto.scryptSync(SECRET_KEY, 'salt', 32);
  
  // Encriptar
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(payloadString, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  // Combinar IV + encrypted y convertir a base64url
  const combined = iv.toString('hex') + ':' + encrypted;
  const token = Buffer.from(combined).toString('base64url');
  
  return token;
}

/**
 * Verifica y decodifica un token de unsubscribe
 * Retorna { customerId, email, timestamp } o null si es inválido
 */
function verifyUnsubscribeToken(token) {
  try {
    // Decodificar de base64url
    const combined = Buffer.from(token, 'base64url').toString('utf8');
    const [ivHex, encrypted] = combined.split(':');
    
    if (!ivHex || !encrypted) {
      console.log('❌ Token malformado: falta IV o encrypted');
      return null;
    }
    
    // Reconstruir IV y key
    const iv = Buffer.from(ivHex, 'hex');
    const key = crypto.scryptSync(SECRET_KEY, 'salt', 32);
    
    // Desencriptar
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    // Parsear JSON
    const payload = JSON.parse(decrypted);
    
    // Verificar que tenga los campos necesarios
    if (!payload.cid || !payload.e) {
      console.log('❌ Token inválido: faltan campos');
      return null;
    }
    
    // Opcional: Verificar que el token no sea muy viejo (30 días)
    const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 días
    if (Date.now() - payload.ts > maxAge) {
      console.log('⚠️ Token expirado (más de 30 días)');
      // Aún así lo aceptamos para unsubscribe, pero loggeamos
    }
    
    return {
      customerId: payload.cid,
      email: payload.e,
      timestamp: payload.ts,
      campaignId: payload.cpid || null  // 🆕 Incluir campaignId si existe
    };
    
  } catch (error) {
    console.error('❌ Error verificando token:', error.message);
    return null;
  }
}

/**
 * Genera un token simple (alternativa más corta usando HMAC)
 * Formato: base64(customerId:email):signature
 */
function generateSimpleToken(customerId, email) {
  const data = `${customerId}:${email.toLowerCase()}`;
  const dataBase64 = Buffer.from(data).toString('base64url');
  
  const signature = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(data)
    .digest('base64url')
    .substring(0, 16); // Solo primeros 16 chars para mantenerlo corto
  
  return `${dataBase64}.${signature}`;
}

/**
 * Verifica token simple
 */
function verifySimpleToken(token) {
  try {
    const [dataBase64, signature] = token.split('.');
    
    if (!dataBase64 || !signature) {
      return null;
    }
    
    const data = Buffer.from(dataBase64, 'base64url').toString('utf8');
    const [customerId, email] = data.split(':');
    
    // Verificar firma
    const expectedSignature = crypto
      .createHmac('sha256', SECRET_KEY)
      .update(data)
      .digest('base64url')
      .substring(0, 16);
    
    if (signature !== expectedSignature) {
      console.log('❌ Firma inválida');
      return null;
    }
    
    return { customerId, email };
    
  } catch (error) {
    console.error('❌ Error verificando token simple:', error.message);
    return null;
  }
}

module.exports = {
  generateUnsubscribeToken,
  verifyUnsubscribeToken,
  generateSimpleToken,
  verifySimpleToken
};