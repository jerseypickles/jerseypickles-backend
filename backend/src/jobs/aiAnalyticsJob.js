// backend/src/jobs/aiAnalyticsJob.js
// 🧠 AI Analytics Cron Job - Ahora enfocado en SMS Marketing
// Calcula insights de SMS y genera análisis con Claude

const cron = require('node-cron');
const AIInsight = require('../models/AIInsight');
const smsCalculator = require('../services/smsCalculator');
const claudeService = require('../services/claudeService');
const smsAnalyticsService = require('../services/smsAnalyticsService');

/**
 * AI Analytics Job (SMS-Focused)
 *
 * Ejecuta análisis de SMS marketing en segundo plano y guarda resultados en MongoDB.
 * Integra Claude API para generar insights inteligentes sobre SMS.
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
  init(cronExpression = '0 6 * * *') {
    console.log('🧠 AI Analytics Job (SMS) inicializado');
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

    console.log('✅ AI Analytics Job (SMS) listo');
  }

  /**
   * Verificar si hay análisis pendientes y correr si es necesario
   */
  async checkAndRunIfNeeded() {
    try {
      // Verificar si hay análisis SMS guardados
      const smsHealth = await AIInsight.getLatest('sms_health_check', 7);

      if (!smsHealth) {
        console.log('\n🧠 No hay análisis SMS guardados, ejecutando cálculo inicial...');
        await this.runAllAnalyses();
      } else {
        // Verificar si está desactualizado (más de 6 horas)
        const ageHours = (Date.now() - new Date(smsHealth.createdAt).getTime()) / (1000 * 60 * 60);
        if (ageHours > 24) {
          console.log(`\n🔄 Análisis SMS desactualizado (${ageHours.toFixed(1)}h), recalculando...`);
          await this.runAllAnalyses();
        } else {
          console.log('✅ Análisis SMS al día');
        }
      }
    } catch (error) {
      console.error('❌ Error verificando análisis:', error.message);
    }
  }

  /**
   * Ejecutar todos los análisis SMS
   */
  async runAllAnalyses() {
    if (this.isRunning) {
      console.log('⚠️  AI Analytics ya está ejecutándose, saltando...');
      return;
    }

    this.isRunning = true;
    this.lastRun = new Date();

    console.log('\n╔════════════════════════════════════════════════╗');
    console.log('║  📱 SMS ANALYTICS - CALCULANDO INSIGHTS         ║');
    console.log('╚════════════════════════════════════════════════╝');
    console.log(`   Inicio: ${this.lastRun.toISOString()}`);
    console.log(`   Claude API: ${this.claudeEnabled ? '✅' : '❌'}\n`);

    const startTime = Date.now();
    const results = {
      success: [],
      failed: []
    };

    // Guardar resultados para Claude
    const analysisResults = {
      healthCheck: null,
      conversionFunnel: null,
      secondChancePerformance: null,
      timeToConvert: null,
      campaignPerformance: null
    };

    try {
      // ==================== FASE 1: CALCULAR MÉTRICAS SMS ====================

      // 1. SMS Health Check (7 días)
      analysisResults.healthCheck = await this.runAnalysis(
        'sms_health_check', 7,
        async () => await smsCalculator.calculateSmsHealthCheck({ days: 7 }),
        results
      );

      // 2. Conversion Funnel (30 días)
      analysisResults.conversionFunnel = await this.runAnalysis(
        'sms_conversion_funnel', 30,
        async () => await smsCalculator.calculateConversionFunnel({ days: 30 }),
        results
      );

      // 3. Second Chance Performance (30 días) - MUY IMPORTANTE
      analysisResults.secondChancePerformance = await this.runAnalysis(
        'sms_second_chance', 30,
        async () => await smsCalculator.calculateSecondChancePerformance({ days: 30 }),
        results
      );

      // 4. Time to Convert Analysis (30 días)
      analysisResults.timeToConvert = await this.runAnalysis(
        'sms_time_to_convert', 30,
        async () => await smsCalculator.calculateTimeToConvert({ days: 30 }),
        results
      );

      // 5. Campaign Performance (30 días)
      analysisResults.campaignPerformance = await this.runAnalysis(
        'sms_campaign_performance', 30,
        async () => await smsCalculator.calculateCampaignPerformance({ days: 30 }),
        results
      );

      // ==================== FASE 2: INSIGHTS CON FALLBACK (sin Claude) ====================

      await this.generateFallbackSmsInsights(analysisResults, results);

      // ==================== FASE 3: COMPREHENSIVE REPORT ====================

      await this.runAnalysis('sms_comprehensive_report', 30, async () => {
        const report = await smsCalculator.calculateComprehensiveReport({ days: 30 });

        // Agregar insights de Claude al reporte si existen
        const claudeInsight = await AIInsight.getLatest('sms_ai_insights', 30);
        if (claudeInsight?.data) {
          report.aiInsights = claudeInsight.data;
        }

        return report;
      }, results);

      // Cleanup old insights
      await AIInsight.cleanup(90);

    } catch (error) {
      console.error('Error critico en AI Analytics Job:', error);
    } finally {
      this.isRunning = false;

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      console.log('\n╔════════════════════════════════════════════════╗');
      console.log('  ANALYTICS + IA BUSINESS - COMPLETADO            ');
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
   * Generar insights de SMS usando fallback (sin Claude API)
   */
  async generateFallbackSmsInsights(analysisResults, results) {
    console.log('\n   📊 Generando insights SMS con fallback...');

    try {
      const dataForClaude = await smsCalculator.prepareDataForClaude(analysisResults);
      const fallbackResponse = claudeService.getSmsFallbackInsights(dataForClaude);

      await AIInsight.saveAnalysis('sms_ai_insights', 30, fallbackResponse, {
        recalculateHours: 24
      });

      smsAnalyticsService.saveAiInsights(fallbackResponse);

      results.success.push('sms_ai_insights (fallback)');
      console.log(`      ✅ Insights SMS generados con fallback`);
      console.log(`      📝 Action plan items: ${fallbackResponse.actionPlan?.length || 0}`);
      console.log(`      ⚠️ Warnings: ${fallbackResponse.warnings?.length || 0}`);

    } catch (error) {
      console.error(`      ❌ Error generando insights fallback: ${error.message}`);
      results.failed.push('sms_ai_insights');
    }
  }


  /**
   * Ejecutar un análisis específico
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
          recalculateHours: 24
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

  /**
   * Forzar recálculo de todos los análisis
   */
  async forceRecalculate() {
    console.log('🔄 Forzando recálculo de todos los análisis SMS...');
    await AIInsight.invalidate();
    await this.runAllAnalyses();
  }

  /**
   * Forzar recálculo de un tipo específico
   */
  async forceRecalculateType(type) {
    console.log(`🔄 Forzando recálculo de: ${type}...`);
    await AIInsight.invalidate(type);

    const results = { success: [], failed: [] };

    switch (type) {
      case 'sms_health_check':
        await this.runAnalysis('sms_health_check', 7, async () => {
          return await smsCalculator.calculateSmsHealthCheck({ days: 7 });
        }, results);
        break;

      case 'sms_conversion_funnel':
        await this.runAnalysis('sms_conversion_funnel', 30, async () => {
          return await smsCalculator.calculateConversionFunnel({ days: 30 });
        }, results);
        break;

      case 'sms_second_chance':
        await this.runAnalysis('sms_second_chance', 30, async () => {
          return await smsCalculator.calculateSecondChancePerformance({ days: 30 });
        }, results);
        break;

      case 'sms_time_to_convert':
        await this.runAnalysis('sms_time_to_convert', 30, async () => {
          return await smsCalculator.calculateTimeToConvert({ days: 30 });
        }, results);
        break;

      case 'sms_campaign_performance':
        await this.runAnalysis('sms_campaign_performance', 30, async () => {
          return await smsCalculator.calculateCampaignPerformance({ days: 30 });
        }, results);
        break;

      case 'sms_ai_insights':
        // Para regenerar insights de Claude, necesitamos recalcular todo
        await this.runAllAnalyses();
        break;

      case 'sms_comprehensive_report':
        await this.runAnalysis('sms_comprehensive_report', 30, async () => {
          return await smsCalculator.calculateComprehensiveReport({ days: 30 });
        }, results);
        break;

      default:
        console.log(`⚠️  Tipo desconocido: ${type}`);
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
      schedule: '0 6 * * *',
      claudeEnabled: this.claudeEnabled,
      claudeModel: claudeService.model,
      focusMode: 'sms'
    };
  }

  /**
   * Obtener próxima ejecución
   */
  getNextRun() {
    const now = new Date();
    const next = new Date(now);

    if (now.getHours() >= 6) {
      next.setDate(next.getDate() + 1);
    }
    next.setHours(6, 0, 0, 0);

    return next;
  }

  /**
   * Detener el job
   */
  stop() {
    if (this.schedule) {
      this.schedule.stop();
      console.log('🛑 AI Analytics Job (SMS) detenido');
    }
  }
}

// Singleton
const aiAnalyticsJob = new AIAnalyticsJob();

module.exports = aiAnalyticsJob;
