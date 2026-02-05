// Check message statuses for a campaign
require('dotenv').config();
const mongoose = require('mongoose');

async function check() {
  await mongoose.connect(process.env.MONGODB_URI);

  const SmsMessage = require('../src/models/SmsMessage');

  const campaignId = process.argv[2] || '6983e3fe23d5f6587f1767dc';

  // Count by status
  const stats = await SmsMessage.aggregate([
    { $match: { campaign: new mongoose.Types.ObjectId(campaignId) } },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);

  console.log('Message status breakdown:');
  stats.forEach(s => console.log('  ' + s._id + ': ' + s.count));

  // Check a few sample messages
  const samples = await SmsMessage.find({
    campaign: new mongoose.Types.ObjectId(campaignId)
  }).limit(5).select('phone status messageId sentAt deliveredAt').lean();

  console.log('\nSample messages:');
  samples.forEach(m => {
    console.log('  ' + m.phone + ' - status: ' + m.status + ', hasMessageId: ' + (m.messageId ? 'yes' : 'no'));
  });

  await mongoose.disconnect();
}

check();
