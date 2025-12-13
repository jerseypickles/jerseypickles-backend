// backend/src/jobs/aiAnalyticsJob.js
// 🧠 AI Analytics Cron Job - Calcula insights y genera análisis con Claude
// ✅ FIXED: Guarda correctamente la estructura de respuesta de Claude
const cron = require('node-cron');
const AIInsight = require('../models/AIInsight');
const aiCalculator = require('../services/aiCalculator');
const claudeService = require('../services/claudeService');

/**
 * AI Analytics Job
 * 
 * Ejecuta análisis de IA en segundo plano y guarda resultados en MongoDB.
 * NUEVO: Integra Claude API para generar insights inteligentes.
 * Los endpoints solo leen de la DB, nunca calculan en tiempo real.
 */

class AIAnalyticsJob {
  constructor() {
    this.isRunning = false;
    this.lastRun = null;
    this.schedule = null;
    this.claudeEnabled = false;
  }

  /**
   * Inicializar el job con schedule
   * Por defecto: cada 6 horas
   */
  init(cronExpression = '0 */6 * * *') {
    console.log('🧠 AI Analytics Job inicializado');
    console.log(`   Schedule: ${cronExpression}`);
    
    // Inicializar Claude Service
    claudeService.init();
    this.claudeEnabled = claudeService.isAvailable();
    
    if (this.claudeEnabled) {
      console.log('   🤖 Claude API: ✅ Habilitado');
    } else {
      console.log('   🤖 Claude API: ⚠️  No configurado (usando análisis básico)');
    }
    
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
    console.log(`   Inicio: ${this.lastRun.toISOString()}`);
    console.log(`   Claude API: ${this.claudeEnabled ? '✅' : '❌'}\n`);

    const startTime = Date.now();
    const results = {
      success: [],
      failed: []
    };
    
    // Guardar resultados de análisis para Claude
    const analysisResults = {
      healthCheck: null,
      subjectAnalysis: null,
      sendTiming: null,
      listPerformance: null
    };

    try {
      // ==================== FASE 1: CALCULAR MÉTRICAS ====================
      
      // 1. Health Check (siempre primero)
      analysisResults.healthCheck = await this.runAnalysis('health_check', 7, async () => {
        return await aiCalculator.calculateHealthCheck();
      }, results);

      // 2. Subject Analysis (30 días)
      analysisResults.subjectAnalysis = await this.runAnalysis('subject_analysis', 30, async () => {
        return await aiCalculator.calculateSubjectAnalysis({ days: 30 });
      }, results);

      // 3. Subject Analysis (90 días) - solo guardar, no usar para Claude
      await this.runAnalysis('subject_analysis', 90, async () => {
        return await aiCalculator.calculateSubjectAnalysis({ days: 90 });
      }, results);

      // 4. Send Timing (90 días - más data mejor)
      analysisResults.sendTiming = await this.runAnalysis('send_timing', 90, async () => {
        return await aiCalculator.calculateSendTiming({ days: 90 });
      }, results);

      // 5. List Performance (30 días)
      analysisResults.listPerformance = await this.runAnalysis('list_performance', 30, async () => {
        return await aiCalculator.calculateListPerformance({ days: 30 });
      }, results);

      // 6. List Performance (90 días) - solo guardar
      await this.runAnalysis('list_performance', 90, async () => {
        return await aiCalculator.calculateListPerformance({ days: 90 });
      }, results);

      // ==================== FASE 2: GENERAR INSIGHTS CON CLAUDE ====================
      
      await this.generateClaudeInsights(analysisResults, results);

      // ==================== FASE 3: COMPREHENSIVE REPORT ====================
      
      // 7. Comprehensive Report (incluye insights de Claude si están disponibles)
      await this.runAnalysis('comprehensive_report', 30, async () => {
        const report = await aiCalculator.calculateComprehensiveReport({ days: 30 });
        
        // Agregar insights de Claude al reporte si existen
        const claudeInsight = await AIInsight.getLatest('ai_generated_insights', 30);
        if (claudeInsight?.data) {
          report.aiInsights = claudeInsight.data;
        }
        
        return report;
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
   * ✅ FIXED: Generar insights usando Claude API
   * Ahora guarda la estructura correcta que devuelve claudeService
   */
  async generateClaudeInsights(analysisResults, results) {
    console.log('\n   🤖 Generando insights con Claude...');
    
    try {
      // Preparar datos compactos para Claude
      const dataForClaude = aiCalculator.prepareDataForClaude(analysisResults);
      
      console.log(`      📦 Datos preparados: ${JSON.stringify(dataForClaude).length} bytes`);
      
      // Llamar a Claude
      const claudeResponse = await claudeService.generateEmailInsights(dataForClaude);
      
      if (claudeResponse.success) {
        // ✅ FIXED: Guardar TODA la respuesta de Claude directamente
        // claudeResponse ya tiene la estructura correcta:
        // - executiveSummary
        // - deepAnalysis
        // - actionPlan
        // - quickWins
        // - warnings
        // - opportunities
        // - productRecommendations
        // - revenueGoalStrategy
        // - nextCampaignSuggestion
        // - etc.
        
        await AIInsight.saveAnalysis('ai_generated_insights', 30, claudeResponse, {
          recalculateHours: 6
        });
        
        results.success.push('ai_generated_insights (Claude)');
        console.log(`      ✅ Claude generó análisis completo`);
        console.log(`      📊 Tokens: ${claudeResponse.tokensUsed?.input || 0} in / ${claudeResponse.tokensUsed?.output || 0} out`);
        console.log(`      📝 Action plan items: ${claudeResponse.actionPlan?.length || 0}`);
        console.log(`      ⚡ Quick wins: ${claudeResponse.quickWins?.length || 0}`);
        console.log(`      ⚠️ Warnings: ${claudeResponse.warnings?.length || 0}`);
        
        if (claudeResponse.executiveSummary) {
          console.log(`      📋 Executive Summary: ${claudeResponse.executiveSummary.substring(0, 80)}...`);
        }
      } else {
        console.log('      ⚠️  Claude no disponible, usando insights básicos');
        
        // ✅ FIXED: El fallback también tiene la estructura correcta
        // getFallbackInsights ya devuelve: executiveSummary, deepAnalysis, actionPlan, etc.
        await AIInsight.saveAnalysis('ai_generated_insights', 30, claudeResponse, {
          recalculateHours: 6
        });
        
        results.success.push('ai_generated_insights (fallback)');
      }
      
    } catch (error) {
      console.error(`      ❌ Error generando insights con Claude: ${error.message}`);
      results.failed.push('ai_generated_insights');
    }
  }

  /**
   * Ejecutar un análisis específico
   * @returns {Object} El resultado del análisis para usar en Claude
   */
  async runAnalysis(type, periodDays, calculator, results) {
    const label = `${type} (${periodDays}d)`;
    console.log(`   📊 Calculando: ${label}...`);
    
    const startTime = new Date();
    let analysisResult = null;
    
    try {
      analysisResult = await calculator();
      
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
    
    // Retornar resultado para usar en Claude
    return analysisResult;
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
        
      case 'list_performance':
        await this.runAnalysis('list_performance', 30, async () => {
          return await aiCalculator.calculateListPerformance({ days: 30 });
        }, results);
        await this.runAnalysis('list_performance', 90, async () => {
          return await aiCalculator.calculateListPerformance({ days: 90 });
        }, results);
        break;
        
      case 'comprehensive_report':
        await this.runAnalysis('comprehensive_report', 30, async () => {
          return await aiCalculator.calculateComprehensiveReport({ days: 30 });
        }, results);
        break;
        
      case 'ai_generated_insights':
        // Para regenerar insights de Claude, necesitamos recalcular todo
        await this.runAllAnalyses();
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
      schedule: '0 */6 * * *', // Cada 6 horas
      claudeEnabled: this.claudeEnabled,
      claudeModel: claudeService.model
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