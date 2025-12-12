// backend/scripts/recalculateCampaignStats.js
// 🔧 Script para recalcular stats de campañas con opens/clicks ÚNICOS
// Ejecutar: node scripts/recalculateCampaignStats.js

require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;

async function recalculateAllCampaignStats() {
  try {
    console.log('🔌 Conectando a MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Conectado\n');

    const Campaign = require('../src/models/Campaign');
    const EmailEvent = require('../src/models/EmailEvent');

    // Obtener todas las campañas enviadas
    const campaigns = await Campaign.find({ status: 'sent' });
    console.log(`📊 Encontradas ${campaigns.length} campañas para recalcular\n`);

    for (const campaign of campaigns) {
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`📧 Campaña: ${campaign.name}`);
      console.log(`   ID: ${campaign._id}`);
      console.log(`   Sent At: ${campaign.sentAt}`);
      
      // Stats actuales (incorrectos)
      console.log(`\n   📉 Stats ACTUALES (posiblemente inflados):`);
      console.log(`      Sent: ${campaign.stats.sent}`);
      console.log(`      Delivered: ${campaign.stats.delivered}`);
      console.log(`      Opened: ${campaign.stats.opened} (${campaign.stats.openRate}%)`);
      console.log(`      Clicked: ${campaign.stats.clicked} (${campaign.stats.clickRate}%)`);

      // Contar eventos ÚNICOS por email
      const uniqueOpens = await EmailEvent.aggregate([
        { 
          $match: { 
            campaign: campaign._id, 
            eventType: 'opened' 
          } 
        },
        { 
          $group: { 
            _id: '$email' 
          } 
        },
        { 
          $count: 'total' 
        }
      ]);

      const uniqueClicks = await EmailEvent.aggregate([
        { 
          $match: { 
            campaign: campaign._id, 
            eventType: 'clicked' 
          } 
        },
        { 
          $group: { 
            _id: '$email' 
          } 
        },
        { 
          $count: 'total' 
        }
      ]);

      const uniqueDelivered = await EmailEvent.aggregate([
        { 
          $match: { 
            campaign: campaign._id, 
            eventType: 'delivered' 
          } 
        },
        { 
          $group: { 
            _id: '$email' 
          } 
        },
        { 
          $count: 'total' 
        }
      ]);

      const uniqueBounced = await EmailEvent.aggregate([
        { 
          $match: { 
            campaign: campaign._id, 
            eventType: 'bounced' 
          } 
        },
        { 
          $group: { 
            _id: '$email' 
          } 
        },
        { 
          $count: 'total' 
        }
      ]);

      const uniqueComplained = await EmailEvent.aggregate([
        { 
          $match: { 
            campaign: campaign._id, 
            eventType: 'complained' 
          } 
        },
        { 
          $group: { 
            _id: '$email' 
          } 
        },
        { 
          $count: 'total' 
        }
      ]);

      // Extraer valores
      const newDelivered = uniqueDelivered[0]?.total || campaign.stats.delivered;
      const newOpened = uniqueOpens[0]?.total || 0;
      const newClicked = uniqueClicks[0]?.total || 0;
      const newBounced = uniqueBounced[0]?.total || campaign.stats.bounced;
      const newComplained = uniqueComplained[0]?.total || campaign.stats.complained;

      // Calcular nuevos rates
      const newOpenRate = newDelivered > 0 
        ? parseFloat(((newOpened / newDelivered) * 100).toFixed(2)) 
        : 0;
      const newClickRate = newDelivered > 0 
        ? parseFloat(((newClicked / newDelivered) * 100).toFixed(2)) 
        : 0;
      const newBounceRate = campaign.stats.sent > 0 
        ? parseFloat(((newBounced / campaign.stats.sent) * 100).toFixed(2)) 
        : 0;

      console.log(`\n   📈 Stats CORREGIDOS (únicos):`);
      console.log(`      Delivered: ${newDelivered}`);
      console.log(`      Opened: ${newOpened} (era ${campaign.stats.opened})`);
      console.log(`      Clicked: ${newClicked} (era ${campaign.stats.clicked})`);
      console.log(`      Open Rate: ${newOpenRate}% (era ${campaign.stats.openRate}%)`);
      console.log(`      Click Rate: ${newClickRate}% (era ${campaign.stats.clickRate}%)`);

      // Actualizar en DB
      await Campaign.findByIdAndUpdate(campaign._id, {
        $set: {
          'stats.delivered': newDelivered,
          'stats.opened': newOpened,
          'stats.clicked': newClicked,
          'stats.bounced': newBounced,
          'stats.complained': newComplained,
          'stats.openRate': newOpenRate,
          'stats.clickRate': newClickRate,
          'stats.bounceRate': newBounceRate
        }
      });

      console.log(`   ✅ Campaña actualizada`);
    }

    console.log(`\n\n${'═'.repeat(50)}`);
    console.log(`✅ COMPLETADO: ${campaigns.length} campañas recalculadas`);
    console.log(`${'═'.repeat(50)}\n`);

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Desconectado de MongoDB');
    process.exit(0);
  }
}

// Ejecutar
recalculateAllCampaignStats();