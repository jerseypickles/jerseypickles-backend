// backend/src/jobs/aiAnalyticsJob.js
// 🧠 AI Analytics Cron Job - Calcula insights y genera análisis con Claude
// 🔧 UPDATED: Better error handling and logging for Claude integration
const cron = require('node-cron');
const AIInsight = require('../models/AIInsight');
const aiCalculator = require('../services/aiCalculator');
const claudeService = require('../services/claudeService');

class AIAnalyticsJob {
  constructor() {
    this.isRunning = false;
    this.lastRun = null;
    this.schedule = null;
    this.claudeEnabled = false;
  }

  init(cronExpression = '0 */6 * * *') {
    console.log('🧠 AI Analytics Job inicializado');
    console.log(`   Schedule: ${cronExpression}`);
    
    claudeService.init();
    this.claudeEnabled = claudeService.isAvailable();
    
    if (this.claudeEnabled) {
      console.log('   🤖 Claude API: ✅ Habilitado');
      console.log(`   🤖 Model: ${claudeService.model}`);
    } else {
      console.log('   🤖 Claude API: ⚠️  No configurado (usando análisis básico)');
    }
    
    this.schedule = cron.schedule(cronExpression, () => {
      this.runAllAnalyses();
    });
    
    setTimeout(() => {
      this.checkAndRunIfNeeded();
    }, 30000);
    
    console.log('✅ AI Analytics Job listo');
  }

  async checkAndRunIfNeeded() {
    // Prevent concurrent runs
    if (this.isRunning) {
      console.log('✅ Análisis ya en progreso, saltando verificación');
      return;
    }
    
    try {
      // Check if we have recent Claude insights (less than 6 hours old)
      const claudeInsight = await AIInsight.findOne({
        type: 'ai_generated_insights',
        periodDays: 30,
        segmentId: null,
        createdAt: { $gte: new Date(Date.now() - 6 * 60 * 60 * 1000) }
      }).lean();
      
      if (claudeInsight) {
        console.log('✅ Análisis de IA reciente encontrado, no es necesario recalcular');
        return;
      }
      
      // Check if we have any analysis at all
      const summary = await AIInsight.getDashboardSummary();
      const hasData = Object.values(summary.analyses).some(a => a !== null);
      
      if (!hasData) {
        console.log('\n🧠 No hay análisis guardados, ejecutando cálculo inicial...');
        await this.runAllAnalyses();
      } else {
        console.log('\n🔄 Análisis de Claude no encontrado o expirado, ejecutando...');
        await this.runAllAnalyses();
      }
    } catch (error) {
      console.error('❌ Error verificando análisis:', error.message);
    }
  }

  async runAllAnalyses() {
    if (this.isRunning) {
      console.log('⚠️  AI Analytics ya está ejecutándose, saltando...');
      return;
    }

    // Doble verificación con timestamp para evitar race conditions
    const now = Date.now();
    if (this.lastRun && (now - this.lastRun.getTime()) < 30000) {
      console.log('⚠️  AI Analytics ejecutado hace menos de 30s, saltando...');
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
    
    const analysisResults = {
      healthCheck: null,
      subjectAnalysis: null,
      sendTiming: null,
      listPerformance: null
    };

    try {
      // FASE 1: CALCULAR MÉTRICAS
      analysisResults.healthCheck = await this.runAnalysis('health_check', 7, async () => {
        return await aiCalculator.calculateHealthCheck();
      }, results);

      analysisResults.subjectAnalysis = await this.runAnalysis('subject_analysis', 30, async () => {
        return await aiCalculator.calculateSubjectAnalysis({ days: 30 });
      }, results);

      await this.runAnalysis('subject_analysis', 90, async () => {
        return await aiCalculator.calculateSubjectAnalysis({ days: 90 });
      }, results);

      analysisResults.sendTiming = await this.runAnalysis('send_timing', 90, async () => {
        return await aiCalculator.calculateSendTiming({ days: 90 });
      }, results);

      analysisResults.listPerformance = await this.runAnalysis('list_performance', 30, async () => {
        return await aiCalculator.calculateListPerformance({ days: 30 });
      }, results);

      await this.runAnalysis('list_performance', 90, async () => {
        return await aiCalculator.calculateListPerformance({ days: 90 });
      }, results);

      // FASE 2: GENERAR INSIGHTS CON CLAUDE
      await this.generateClaudeInsights(analysisResults, results);

      // FASE 3: COMPREHENSIVE REPORT
      await this.runAnalysis('comprehensive_report', 30, async () => {
        const report = await aiCalculator.calculateComprehensiveReport({ days: 30 });
        
        const claudeInsight = await AIInsight.getLatest('ai_generated_insights', 30);
        if (claudeInsight?.data?.insights) {
          report.aiInsights = claudeInsight.data.insights;
          report.aiSummary = claudeInsight.data.summary;
          report.aiRecommendations = claudeInsight.data.recommendations;
        }
        
        return report;
      }, results);

      await AIInsight.cleanup(90);

    } catch (error) {
      console.error('❌ Error crítico en AI Analytics Job:', error);
      console.error('   Stack:', error.stack);
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
   * Generar insights usando Claude API - Con mejor manejo de errores
   */
  async generateClaudeInsights(analysisResults, results) {
    console.log('\n   🤖 Generando insights con Claude...');
    
    try {
      // Verificar que tenemos datos para enviar
      if (!analysisResults.healthCheck && !analysisResults.subjectAnalysis && !analysisResults.listPerformance) {
        console.log('      ⚠️  No hay datos suficientes para enviar a Claude');
        results.failed.push('ai_generated_insights (no data)');
        return;
      }

      // Preparar datos compactos para Claude
      const dataForClaude = aiCalculator.prepareDataForClaude(analysisResults);
      const dataSize = JSON.stringify(dataForClaude).length;
      
      console.log(`      📦 Datos preparados: ${dataSize} bytes`);
      console.log(`      📊 Health data: ${dataForClaude.health ? 'Sí' : 'No'}`);
      console.log(`      📊 Subjects data: ${dataForClaude.subjects?.top ? 'Sí' : 'No'}`);
      console.log(`      📊 Lists data: ${dataForClaude.lists?.length || 0} listas`);
      console.log(`      📊 Timing data: ${dataForClaude.timing?.best ? 'Sí' : 'No'}`);
      
      // Llamar a Claude
      console.log('      🔄 Llamando a Claude API...');
      const claudeStartTime = Date.now();
      
      const claudeResponse = await claudeService.generateEmailInsights(dataForClaude);
      
      const claudeDuration = ((Date.now() - claudeStartTime) / 1000).toFixed(2);
      console.log(`      ⏱️  Claude respondió en ${claudeDuration}s`);
      
      if (claudeResponse.success) {
        // Verificar que tenemos contenido útil
        const hasContent = claudeResponse.executiveSummary || 
                          claudeResponse.deepAnalysis || 
                          claudeResponse.actionPlan?.length > 0;
        
        if (!hasContent) {
          console.log('      ⚠️  Claude respondió pero sin contenido útil');
          console.log('      Response keys:', Object.keys(claudeResponse));
        }
        
        // Guardar insights generados por Claude
        await AIInsight.saveAnalysis('ai_generated_insights', 30, {
          success: true,
          executiveSummary: claudeResponse.executiveSummary || '',
          deepAnalysis: claudeResponse.deepAnalysis || {},
          actionPlan: claudeResponse.actionPlan || [],
          quickWins: claudeResponse.quickWins || [],
          warnings: claudeResponse.warnings || [],
          opportunities: claudeResponse.opportunities || [],
          nextCampaignSuggestion: claudeResponse.nextCampaignSuggestion || null,
          // Metadata
          model: claudeResponse.model,
          tokensUsed: claudeResponse.tokensUsed,
          generatedAt: claudeResponse.generatedAt,
          duration: claudeResponse.duration,
          isFallback: claudeResponse.isFallback || false,
          // Debug info
          inputDataSize: dataSize,
          parseError: claudeResponse.parseError || false
        }, {
          recalculateHours: 6
        });
        
        results.success.push(`ai_generated_insights (${claudeResponse.isFallback ? 'fallback' : 'Claude'})`);
        
        console.log(`      ✅ Insights guardados correctamente`);
        console.log(`      📝 Executive Summary: ${claudeResponse.executiveSummary ? 'Sí' : 'No'}`);
        console.log(`      📝 Action Plan: ${claudeResponse.actionPlan?.length || 0} items`);
        console.log(`      📝 Quick Wins: ${claudeResponse.quickWins?.length || 0} items`);
        console.log(`      📝 Warnings: ${claudeResponse.warnings?.length || 0} items`);
        
        if (claudeResponse.tokensUsed) {
          console.log(`      📊 Tokens: ${claudeResponse.tokensUsed.input || 0} in / ${claudeResponse.tokensUsed.output || 0} out`);
        }
        
        if (claudeResponse.executiveSummary) {
          const preview = claudeResponse.executiveSummary.substring(0, 100);
          console.log(`      📝 Resumen: ${preview}...`);
        }
      } else {
        console.log('      ⚠️  Claude no disponible o falló, guardando fallback');
        console.log(`      Message: ${claudeResponse.message || 'No message'}`);
        
        // Guardar el fallback de todas formas
        await AIInsight.saveAnalysis('ai_generated_insights', 30, claudeResponse, {
          recalculateHours: 1 // Reintentar más pronto si falló
        });
        
        results.success.push('ai_generated_insights (fallback)');
      }
      
    } catch (error) {
      console.error(`      ❌ Error generando insights con Claude: ${error.message}`);
      console.error(`      Stack: ${error.stack?.substring(0, 300)}`);
      results.failed.push('ai_generated_insights');
      
      // Intentar guardar un fallback básico para que el frontend tenga algo
      try {
        const fallbackData = {
          success: false,
          executiveSummary: `Error generando análisis: ${error.message}`,
          deepAnalysis: {},
          actionPlan: [],
          quickWins: [],
          warnings: [{
            severity: 'warning',
            issue: 'Error en Claude API',
            consequence: 'Análisis AI no disponible temporalmente',
            solution: 'El sistema reintentará automáticamente'
          }],
          error: error.message,
          generatedAt: new Date().toISOString()
        };
        
        await AIInsight.saveAnalysis('ai_generated_insights', 30, fallbackData, {
          recalculateHours: 1
        });
        
        console.log('      💾 Fallback de error guardado');
      } catch (saveError) {
        console.error(`      ❌ Error guardando fallback: ${saveError.message}`);
      }
    }
  }

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
          recalculateHours: type === 'health_check' ? 1 : 6
        });
        
        results.success.push(label);
        console.log(`      ✅ ${label} completado`);
      } else {
        console.log(`      ⚠️  ${label}: datos insuficientes`);
        
        await AIInsight.saveAnalysis(type, periodDays, {
          success: false,
          message: analysisResult?.message || 'Insufficient data',
          summary: { status: 'insufficient_data', score: 0 }
        }, {
          calculationStartTime: startTime,
          recalculateHours: 1
        });
        
        results.success.push(label);
      }
      
    } catch (error) {
      console.error(`      ❌ ${label}: ${error.message}`);
      results.failed.push(label);
    }
    
    return analysisResult;
  }

  async forceRecalculate() {
    console.log('🔄 Forzando recálculo de todos los análisis...');
    // NO invalidar primero - esto causa race conditions cuando hay múltiples instancias
    // Los nuevos análisis automáticamente marcarán los viejos como stale en saveAnalysis
    await this.runAllAnalyses();
  }

  async forceRecalculateType(type) {
    console.log(`🔄 Forzando recálculo de: ${type}...`);
    await AIInsight.invalidate(type);
    
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
        await this.runAllAnalyses();
        break;
    }
    
    return results;
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      lastRun: this.lastRun,
      nextScheduledRun: this.getNextRun(),
      schedule: '0 */6 * * *',
      claudeEnabled: this.claudeEnabled,
      claudeModel: claudeService.model
    };
  }

  getNextRun() {
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

  stop() {
    if (this.schedule) {
      this.schedule.stop();
      console.log('🛑 AI Analytics Job detenido');
    }
  }
}

const aiAnalyticsJob = new AIAnalyticsJob();
module.exports = aiAnalyticsJob;