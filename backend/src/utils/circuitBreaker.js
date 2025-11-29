// backend/src/utils/circuitBreaker.js
/**
 * Circuit Breaker Pattern para Resend API
 * 
 * Previene saturación en caso de errores consecutivos
 * Estados: CLOSED (normal) → OPEN (bloqueado) → HALF_OPEN (probando)
 */

class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5; // Fallos consecutivos para abrir
    this.successThreshold = options.successThreshold || 2;  // Éxitos para cerrar
    this.timeout = options.timeout || 60000; // 60s en estado OPEN
    
    this.state = 'CLOSED'; // CLOSED | OPEN | HALF_OPEN
    this.failures = 0;
    this.successes = 0;
    this.nextAttempt = Date.now();
    
    this.stats = {
      totalRequests: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      circuitOpened: 0,
      lastStateChange: new Date()
    };
  }
  
  /**
   * Ejecuta una función con circuit breaker
   */
  async execute(fn, context = 'request') {
    this.stats.totalRequests++;
    
    // Verificar si el circuito está OPEN
    if (this.state === 'OPEN') {
      // Ver si ya pasó el timeout
      if (Date.now() < this.nextAttempt) {
        const waitTime = Math.ceil((this.nextAttempt - Date.now()) / 1000);
        throw new Error(`Circuit breaker OPEN - espera ${waitTime}s (${context})`);
      }
      
      // Pasar a HALF_OPEN para probar
      this.state = 'HALF_OPEN';
      this.successes = 0;
      console.log(`🟡 Circuit breaker: HALF_OPEN (probando recuperación)`);
    }
    
    try {
      const result = await fn();
      this.onSuccess(context);
      return result;
    } catch (error) {
      this.onFailure(error, context);
      throw error;
    }
  }
  
  /**
   * Maneja éxito
   */
  onSuccess(context) {
    this.stats.totalSuccesses++;
    this.failures = 0;
    
    if (this.state === 'HALF_OPEN') {
      this.successes++;
      
      if (this.successes >= this.successThreshold) {
        this.state = 'CLOSED';
        this.stats.lastStateChange = new Date();
        console.log(`✅ Circuit breaker: CLOSED (recuperado después de ${this.successes} éxitos)`);
      }
    }
  }
  
  /**
   * Maneja fallo
   */
  onFailure(error, context) {
    this.stats.totalFailures++;
    this.failures++;
    
    const errorType = this.classifyError(error);
    
    // Solo contar errores de servicio (no errores de cliente)
    if (errorType === 'service') {
      if (this.failures >= this.failureThreshold) {
        this.trip(context);
      } else {
        console.warn(`⚠️  Circuit breaker: ${this.failures}/${this.failureThreshold} fallos (${context})`);
      }
    } else {
      // Errores de cliente no cuentan para abrir el circuito
      this.failures = Math.max(0, this.failures - 1);
    }
  }
  
  /**
   * Abre el circuito (TRIP)
   */
  trip(context) {
    this.state = 'OPEN';
    this.nextAttempt = Date.now() + this.timeout;
    this.stats.circuitOpened++;
    this.stats.lastStateChange = new Date();
    
    const waitTime = Math.ceil(this.timeout / 1000);
    
    console.error(`\n╔════════════════════════════════════════════╗`);
    console.error(`║  🔴 CIRCUIT BREAKER TRIPPED               ║`);
    console.error(`╚════════════════════════════════════════════╝`);
    console.error(`   Context: ${context}`);
    console.error(`   Fallos consecutivos: ${this.failures}`);
    console.error(`   Esperando: ${waitTime}s antes de reintentar`);
    console.error(`   Total aperturas: ${this.stats.circuitOpened}`);
    console.error(`════════════════════════════════════════════\n`);
  }
  
  /**
   * Clasifica el tipo de error
   */
  classifyError(error) {
    const message = error.message || '';
    const statusCode = error.statusCode || error.status;
    
    // Errores de servicio (cuentan para abrir circuito)
    if (statusCode >= 500) return 'service';
    if (statusCode === 429) return 'service'; // Rate limit
    if (message.includes('timeout')) return 'service';
    if (message.includes('ECONNREFUSED')) return 'service';
    if (message.includes('ENOTFOUND')) return 'service';
    
    // Errores de cliente (NO cuentan para abrir circuito)
    if (statusCode >= 400 && statusCode < 500) return 'client';
    
    // Por defecto, considerarlo de servicio
    return 'service';
  }
  
  /**
   * Obtiene el estado actual
   */
  getState() {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      nextAttempt: this.state === 'OPEN' ? new Date(this.nextAttempt) : null,
      stats: this.stats
    };
  }
  
  /**
   * Reset manual del circuit breaker
   */
  reset() {
    this.state = 'CLOSED';
    this.failures = 0;
    this.successes = 0;
    this.nextAttempt = Date.now();
    this.stats.lastStateChange = new Date();
    
    console.log('🔄 Circuit breaker reseteado manualmente');
  }
}

module.exports = CircuitBreaker;