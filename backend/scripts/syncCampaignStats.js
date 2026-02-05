// backend/scripts/syncCampaignStats.js
// 📊 Sync campaign stats from SmsMessage records
// Usage: node scripts/syncCampaignStats.js [campaignId]

require('dotenv').config();
const mongoose = require('mongoose');

async function syncCampaignStats(campaignId = null) {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    const SmsCampaign = require('../src/models/SmsCampaign');
    const SmsMessage = require('../src/models/SmsMessage');

    // Get campaigns to sync
    const query = campaignId
      ? { _id: campaignId }
      : { status: { $in: ['sending', 'sent'] } };

    const campaigns = await SmsCampaign.find(query);
    console.log(`📊 Found ${campaigns.length} campaigns to sync\n`);

    for (const campaign of campaigns) {
      console.log(`\n📱 Campaign: ${campaign.name}`);
      console.log(`   ID: ${campaign._id}`);
      console.log(`   Status: ${campaign.status}`);
      console.log(`   Current stats:`);
      console.log(`      - sent: ${campaign.stats.sent}`);
      console.log(`      - delivered: ${campaign.stats.delivered}`);
      console.log(`      - failed: ${campaign.stats.failed}`);
      console.log(`      - converted: ${campaign.stats.converted}`);

      // Count actual message statuses
      const messageStats = await SmsMessage.aggregate([
        { $match: { campaign: campaign._id } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        }
      ]);

      const statusCounts = {};
      messageStats.forEach(s => { statusCounts[s._id] = s.count; });

      // Calculate correct values
      const totalMessages = await SmsMessage.countDocuments({ campaign: campaign._id });
      const queued = statusCounts['queued'] || 0;
      const sent = statusCounts['sent'] || 0;
      const deliveredFromDb = statusCounts['delivered'] || 0;
      const failed = (statusCounts['failed'] || 0) + (statusCounts['undelivered'] || 0);
      const pending = statusCounts['pending'] || 0;

      // If webhooks didn't update status, assume queued messages were delivered
      // This is common when webhook processing wasn't set up correctly
      const delivered = deliveredFromDb > 0 ? deliveredFromDb : (queued + sent);

      // Get conversions
      const conversions = await SmsMessage.countDocuments({
        campaign: campaign._id,
        converted: true
      });

      // Get total revenue
      const revenueResult = await SmsMessage.aggregate([
        { $match: { campaign: campaign._id, converted: true } },
        { $group: { _id: null, total: { $sum: '$conversionData.orderTotal' } } }
      ]);
      const totalRevenue = revenueResult[0]?.total || 0;

      console.log(`\n   Actual counts from messages:`);
      console.log(`      - total messages: ${totalMessages}`);
      console.log(`      - pending: ${pending}`);
      console.log(`      - queued: ${queued}`);
      console.log(`      - sent: ${sent}`);
      console.log(`      - delivered (from DB): ${deliveredFromDb}`);
      console.log(`      - delivered (estimated): ${delivered}`);
      console.log(`      - failed: ${failed}`);
      console.log(`      - converted: ${conversions}`);
      console.log(`      - revenue: $${totalRevenue.toFixed(2)}`);

      // Calculate rates
      const totalSent = queued + sent + deliveredFromDb;
      const deliveryRate = totalSent > 0 ? ((delivered / totalSent) * 100).toFixed(1) : 0;
      const conversionRate = delivered > 0 ? ((conversions / delivered) * 100).toFixed(1) : 0;

      console.log(`\n   Calculated rates:`);
      console.log(`      - delivery rate: ${deliveryRate}%`);
      console.log(`      - conversion rate: ${conversionRate}%`);

      // Update campaign
      const updates = {
        'stats.delivered': delivered,
        'stats.failed': failed,
        'stats.converted': conversions,
        'stats.totalRevenue': totalRevenue,
        'stats.deliveryRate': parseFloat(deliveryRate),
        'stats.conversionRate': parseFloat(conversionRate),
        'stats.queued': pending
      };

      // Update sent to reflect total non-pending, non-failed messages
      updates['stats.sent'] = queued + sent + deliveredFromDb;

      // Check if campaign is complete
      if (pending === 0 && campaign.status === 'sending') {
        updates.status = 'sent';
        updates.completedAt = new Date();
        console.log(`\n   ✅ Marking campaign as 'sent' (complete)`);
      }

      await SmsCampaign.findByIdAndUpdate(campaign._id, { $set: updates });
      console.log(`\n   ✅ Stats updated!`);
    }

    console.log('\n\n🎉 Sync complete!');

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
  }
}

// Run with optional campaign ID argument
const campaignId = process.argv[2];
syncCampaignStats(campaignId);
