// Script temporal para analizar pending Second Chance SMS
const mongoose = require('mongoose');
require('dotenv').config();

async function analyze() {
  await mongoose.connect(process.env.MONGODB_URI);
  const SmsSubscriber = require('../src/models/SmsSubscriber');

  const now = new Date();
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);

  console.log('='.repeat(60));
  console.log('📊 ANÁLISIS DE SECOND CHANCE SMS PENDING');
  console.log('='.repeat(60));
  console.log('Hora actual:', now.toISOString());
  console.log('6 horas atrás:', sixHoursAgo.toISOString());
  console.log('');

  // Total pending (como lo cuenta el sistema)
  const totalPending = await SmsSubscriber.countDocuments({
    status: 'active',
    converted: false,
    secondSmsSent: { $ne: true },
    welcomeSmsStatus: 'delivered'
  });
  console.log('📌 TOTAL PENDING (como muestra el sistema):', totalPending);
  console.log('');

  // Desglose detallado
  console.log('─'.repeat(60));
  console.log('DESGLOSE POR ESTADO:');
  console.log('─'.repeat(60));

  // 1. Esperando ventana de 6h (< 6h desde primer SMS)
  const waitingFor6h = await SmsSubscriber.countDocuments({
    status: 'active',
    converted: false,
    secondSmsSent: { $ne: true },
    welcomeSmsStatus: 'delivered',
    $or: [
      { welcomeSmsAt: { $gt: sixHoursAgo } },
      { welcomeSmsSentAt: { $gt: sixHoursAgo } }
    ]
  });
  console.log('⏳ Esperando ventana 6h (< 6h desde 1er SMS):', waitingFor6h);

  // 2. Elegibles (6-8h) pero sin programar
  const eligibleNotScheduled = await SmsSubscriber.countDocuments({
    status: 'active',
    converted: false,
    secondSmsSent: { $ne: true },
    welcomeSmsStatus: 'delivered',
    secondSmsScheduledFor: null,
    $or: [
      { welcomeSmsAt: { $gte: eightHoursAgo, $lte: sixHoursAgo } },
      { welcomeSmsSentAt: { $gte: eightHoursAgo, $lte: sixHoursAgo } }
    ]
  });
  console.log('✅ Elegibles (6-8h) sin programar:', eligibleNotScheduled);

  // 3. Programados para después
  const scheduledLater = await SmsSubscriber.countDocuments({
    status: 'active',
    converted: false,
    secondSmsSent: { $ne: true },
    secondSmsScheduledFor: { $gt: now }
  });
  console.log('📅 Programados para después:', scheduledLater);

  // 4. Listos para enviar ahora
  const readyNow = await SmsSubscriber.countDocuments({
    status: 'active',
    converted: false,
    secondSmsSent: { $ne: true },
    secondSmsScheduledFor: { $lte: now }
  });
  console.log('🚀 Listos para enviar AHORA:', readyNow);

  // 5. Más de 8h sin segundo SMS (pasaron la ventana original)
  const pastWindow = await SmsSubscriber.countDocuments({
    status: 'active',
    converted: false,
    secondSmsSent: { $ne: true },
    welcomeSmsStatus: 'delivered',
    secondSmsScheduledFor: null,
    $or: [
      { welcomeSmsAt: { $lt: eightHoursAgo } },
      { welcomeSmsSentAt: { $lt: eightHoursAgo } }
    ]
  });
  console.log('⚠️  Más de 8h sin programar (pasaron ventana):', pastWindow);

  // 6. Sin welcomeSmsAt/welcomeSmsSentAt (datos incompletos)
  const noWelcomeTime = await SmsSubscriber.countDocuments({
    status: 'active',
    converted: false,
    secondSmsSent: { $ne: true },
    welcomeSmsStatus: 'delivered',
    welcomeSmsAt: null,
    welcomeSmsSentAt: null
  });
  console.log('❓ Sin fecha de primer SMS (datos incompletos):', noWelcomeTime);

  console.log('');
  console.log('─'.repeat(60));
  const suma = waitingFor6h + eligibleNotScheduled + scheduledLater + readyNow + pastWindow + noWelcomeTime;
  console.log('SUMA TOTAL:', suma);
  console.log('DIFERENCIA con pending:', totalPending - suma);
  console.log('─'.repeat(60));

  // Mostrar algunos ejemplos si hay pending > 8h
  if (pastWindow > 0) {
    console.log('');
    console.log('⚠️  EJEMPLOS de suscriptores > 8h sin segundo SMS:');
    const examples = await SmsSubscriber.find({
      status: 'active',
      converted: false,
      secondSmsSent: { $ne: true },
      welcomeSmsStatus: 'delivered',
      secondSmsScheduledFor: null,
      $or: [
        { welcomeSmsAt: { $lt: eightHoursAgo } },
        { welcomeSmsSentAt: { $lt: eightHoursAgo } }
      ]
    }).limit(5).select('phone welcomeSmsAt welcomeSmsSentAt createdAt').lean();

    examples.forEach((sub, i) => {
      const smsTime = sub.welcomeSmsAt || sub.welcomeSmsSentAt;
      const hoursAgo = smsTime ? ((now - new Date(smsTime)) / (1000 * 60 * 60)).toFixed(1) : 'N/A';
      console.log(`  ${i+1}. ***${sub.phone.slice(-4)} - 1er SMS hace ${hoursAgo}h`);
    });

    console.log('');
    console.log('💡 Estos suscriptores pasaron la ventana de 6-8h pero nunca');
    console.log('   fueron procesados por el cron job (quizás el job no estaba');
    console.log('   corriendo o estaban fuera de horario de envío).');
  }

  // Mostrar algunos con datos incompletos
  if (noWelcomeTime > 0) {
    console.log('');
    console.log('❓ EJEMPLOS de suscriptores sin fecha de primer SMS:');
    const examples = await SmsSubscriber.find({
      status: 'active',
      converted: false,
      secondSmsSent: { $ne: true },
      welcomeSmsStatus: 'delivered',
      welcomeSmsAt: null,
      welcomeSmsSentAt: null
    }).limit(5).select('phone createdAt welcomeSmsSent').lean();

    examples.forEach((sub, i) => {
      console.log(`  ${i+1}. ***${sub.phone.slice(-4)} - creado: ${sub.createdAt}`);
    });
  }

  await mongoose.disconnect();
}

analyze().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
