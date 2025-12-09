// backend/src/jobs/aiAnalyticsJob.js
// 🧠 AI Analytics Cron Job - Calcula insights periódicamente
const cron = require('node-cron');
const AIInsight = require('../models/AIInsight');
const aiCalculator = require('../services/aiCalculator');

/**
 * AI Analytics Job
 * 
 * Ejecuta análisis de IA en segundo plano y guarda resultados en MongoDB.
 * Los endpoints solo leen de la DB, nunca calculan en tiempo real.
 */

class AIAnalyticsJob {
  constructor() {
    this.isRunning = false;
    this.lastRun = null;
    this.schedule = null;
  }

  /**
   * Inicializar el job con schedule
   * Por defecto: cada 6 horas
   */
  init(cronExpression = '0 */6 * * *') {
    console.log('🧠 AI Analytics Job inicializado');
    console.log(`   Schedule: ${cronExpression}`);
    
    // Schedule regular
    this.schedule = cron.schedule(cronExpression, () => {
      this.runAllAnalyses();
    });
    
    // También correr análisis al iniciar (después de 30 segundos)
    setTimeout(() => {
      this.checkAndRunIfNeeded();
    }, 30000);
    
    console.log('✅ AI Analytics Job listo');
  }

  /**
   * Verificar si hay análisis pendientes y correr si es necesario
   */
  async checkAndRunIfNeeded() {
    try {
      const dueAnalyses = await AIInsight.getDueForRecalculation();
      
      if (dueAnalyses.length > 0) {
        console.log(`\n🔄 ${dueAnalyses.length} análisis pendientes, ejecutando...`);
        await this.runAllAnalyses();
      } else {
        // Verificar si hay análisis guardados
        const summary = await AIInsight.getDashboardSummary();
        const hasData = Object.values(summary.analyses).some(a => a !== null);
        
        if (!hasData) {
          console.log('\n🧠 No hay análisis guardados, ejecutando cálculo inicial...');
          await this.runAllAnalyses();
        } else {
          console.log('✅ Análisis de IA al día');
        }
      }
    } catch (error) {
      console.error('❌ Error verificando análisis:', error.message);
    }
  }

  /**
   * Ejecutar todos los análisis
   */
  async runAllAnalyses() {
    if (this.isRunning) {
      console.log('⚠️  AI Analytics ya está ejecutándose, saltando...');
      return;
    }

    this.isRunning = true;
    this.lastRun = new Date();
    
    console.log('\n╔════════════════════════════════════════════════╗');
    console.log('║  🧠 AI ANALYTICS - CALCULANDO INSIGHTS          ║');
    console.log('╚════════════════════════════════════════════════╝');
    console.log(`   Inicio: ${this.lastRun.toISOString()}\n`);

    const startTime = Date.now();
    const results = {
      success: [],
      failed: []
    };

    try {
      // 1. Health Check (siempre primero)
      await this.runAnalysis('health_check', 7, async () => {
        return await aiCalculator.calculateHealthCheck();
      }, results);

      // 2. Subject Analysis (30 días)
      await this.runAnalysis('subject_analysis', 30, async () => {
        return await aiCalculator.calculateSubjectAnalysis({ days: 30 });
      }, results);

      // 3. Subject Analysis (90 días)
      await this.runAnalysis('subject_analysis', 90, async () => {
        return await aiCalculator.calculateSubjectAnalysis({ days: 90 });
      }, results);

      // 4. Send Timing (90 días - más data mejor)
      await this.runAnalysis('send_timing', 90, async () => {
        return await aiCalculator.calculateSendTiming({ days: 90 });
      }, results);

      // 5. Segment Performance (30 días)
      await this.runAnalysis('segment_performance', 30, async () => {
        return await aiCalculator.calculateSegmentPerformance({ days: 30 });
      }, results);

      // 6. Segment Performance (90 días)
      await this.runAnalysis('segment_performance', 90, async () => {
        return await aiCalculator.calculateSegmentPerformance({ days: 90 });
      }, results);

      // 7. Comprehensive Report (30 días)
      await this.runAnalysis('comprehensive_report', 30, async () => {
        return await aiCalculator.calculateComprehensiveReport({ days: 30 });
      }, results);

      // Cleanup old insights
      await AIInsight.cleanup(90);

    } catch (error) {
      console.error('❌ Error crítico en AI Analytics Job:', error);
    } finally {
      this.isRunning = false;
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      
      console.log('\n╔════════════════════════════════════════════════╗');
      console.log('║  ✅ AI ANALYTICS - COMPLETADO                   ║');
      console.log('╚════════════════════════════════════════════════╝');
      console.log(`   Duración: ${duration}s`);
      console.log(`   Exitosos: ${results.success.length}`);
      console.log(`   Fallidos: ${results.failed.length}`);
      
      if (results.failed.length > 0) {
        console.log(`   ⚠️  Fallos: ${results.failed.join(', ')}`);
      }
      
      console.log('════════════════════════════════════════════════\n');
    }
  }

  /**
   * Ejecutar un análisis específico
   */
  async runAnalysis(type, periodDays, calculator, results) {
    const label = `${type} (${periodDays}d)`;
    console.log(`   📊 Calculando: ${label}...`);
    
    const startTime = new Date();
    
    try {
      const analysisResult = await calculator();
      
      if (analysisResult && analysisResult.success !== false) {
        await AIInsight.saveAnalysis(type, periodDays, analysisResult, {
          calculationStartTime: startTime,
          recalculateHours: type === 'health_check' ? 1 : 6 // Health check más frecuente
        });
        
        results.success.push(label);
        console.log(`      ✅ ${label} completado`);
      } else {
        console.log(`      ⚠️  ${label}: datos insuficientes`);
        
        // Guardar igual para que el frontend sepa que no hay data
        await AIInsight.saveAnalysis(type, periodDays, {
          success: false,
          message: analysisResult?.message || 'Insufficient data',
          summary: { status: 'insufficient_data', score: 0 }
        }, {
          calculationStartTime: startTime,
          recalculateHours: 1 // Reintentar pronto
        });
        
        results.success.push(label);
      }
      
    } catch (error) {
      console.error(`      ❌ ${label}: ${error.message}`);
      results.failed.push(label);
    }
  }

  /**
   * Forzar recálculo de todos los análisis
   */
  async forceRecalculate() {
    console.log('🔄 Forzando recálculo de todos los análisis...');
    await AIInsight.invalidate();
    await this.runAllAnalyses();
  }

  /**
   * Forzar recálculo de un tipo específico
   */
  async forceRecalculateType(type) {
    console.log(`🔄 Forzando recálculo de: ${type}...`);
    await AIInsight.invalidate(type);
    
    // Correr solo ese tipo
    const results = { success: [], failed: [] };
    
    switch (type) {
      case 'health_check':
        await this.runAnalysis('health_check', 7, async () => {
          return await aiCalculator.calculateHealthCheck();
        }, results);
        break;
        
      case 'subject_analysis':
        await this.runAnalysis('subject_analysis', 30, async () => {
          return await aiCalculator.calculateSubjectAnalysis({ days: 30 });
        }, results);
        await this.runAnalysis('subject_analysis', 90, async () => {
          return await aiCalculator.calculateSubjectAnalysis({ days: 90 });
        }, results);
        break;
        
      case 'send_timing':
        await this.runAnalysis('send_timing', 90, async () => {
          return await aiCalculator.calculateSendTiming({ days: 90 });
        }, results);
        break;
        
      case 'segment_performance':
        await this.runAnalysis('segment_performance', 30, async () => {
          return await aiCalculator.calculateSegmentPerformance({ days: 30 });
        }, results);
        await this.runAnalysis('segment_performance', 90, async () => {
          return await aiCalculator.calculateSegmentPerformance({ days: 90 });
        }, results);
        break;
        
      case 'comprehensive_report':
        await this.runAnalysis('comprehensive_report', 30, async () => {
          return await aiCalculator.calculateComprehensiveReport({ days: 30 });
        }, results);
        break;
    }
    
    return results;
  }

  /**
   * Obtener estado del job
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastRun: this.lastRun,
      nextScheduledRun: this.getNextRun(),
      schedule: '0 */6 * * *' // Cada 6 horas
    };
  }

  /**
   * Obtener próxima ejecución
   */
  getNextRun() {
    // Calcular próxima hora múltiplo de 6
    const now = new Date();
    const nextHour = Math.ceil(now.getHours() / 6) * 6;
    const next = new Date(now);
    
    if (nextHour >= 24) {
      next.setDate(next.getDate() + 1);
      next.setHours(0, 0, 0, 0);
    } else {
      next.setHours(nextHour, 0, 0, 0);
    }
    
    return next;
  }

  /**
   * Detener el job
   */
  stop() {
    if (this.schedule) {
      this.schedule.stop();
      console.log('🛑 AI Analytics Job detenido');
    }
  }
}

// Singleton
const aiAnalyticsJob = new AIAnalyticsJob();

module.exports = aiAnalyticsJob;