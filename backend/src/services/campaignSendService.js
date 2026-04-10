// backend/src/services/campaignSendService.js
// Core campaign sending logic - used by both HTTP endpoint and schedulerJob

const Campaign = require('../models/Campaign');
const List = require('../models/List');
const Customer = require('../models/Customer');
const EmailSend = require('../models/EmailSend');
const emailService = require('./emailService');

/**
 * Send a campaign programmatically (no HTTP req/res needed)
 * This is the same logic as campaignsController.send() but callable from anywhere.
 *
 * @param {string} campaignId - Campaign ID to send
 * @returns {object} { success, campaignId, totalRecipients, error }
 */
async function sendCampaign(campaignId) {
  const campaign = await Campaign.findById(campaignId).populate('list');

  if (!campaign) {
    return { success: false, error: 'Campaign not found' };
  }

  if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
    return { success: false, error: `Cannot send campaign with status: ${campaign.status}` };
  }

  const { isAvailable, generateJobId } = require('../jobs/emailQueue');

  if (!isAvailable()) {
    return { success: false, error: 'Redis not available' };
  }

  console.log('\n╔════════════════════════════════════════════════╗');
  console.log(`║  📧 SENDING: ${campaign.name.substring(0, 37).padEnd(37)} ║`);
  console.log('╚════════════════════════════════════════════════╝\n');

  // Count recipients
  let totalRecipients = 0;
  if (campaign.targetType === 'list' && campaign.list) {
    const list = await List.findById(campaign.list._id || campaign.list).select('members');
    totalRecipients = list?.members?.length || 0;
  }

  if (totalRecipients === 0) {
    return { success: false, error: 'List has no members' };
  }

  console.log(`👥 Total recipients: ${totalRecipients.toLocaleString()}`);

  // Adaptive config
  const config = getOptimalConfig(totalRecipients);
  console.log(`⚙️  Mode: ${config.name}`);

  // Set to preparing
  campaign.status = 'preparing';
  campaign.stats.totalRecipients = totalRecipients;
  campaign.stats.sent = 0;
  campaign.stats.delivered = 0;
  campaign.stats.failed = 0;
  campaign.stats.skipped = 0;
  await campaign.save();

  // Process in background
  const campaignIdStr = campaign._id.toString();
  const htmlTemplate = campaign.htmlContent;
  const subject = campaign.subject;
  const fromName = campaign.fromName || 'Jersey Pickles';
  const fromEmail = campaign.fromEmail || 'info@jerseypickles.com';
  const replyTo = campaign.replyTo;
  const listId = campaign.list?._id || campaign.list;

  setImmediate(async () => {
    console.log(`📥 BACKGROUND - Processing campaign ${campaignIdStr}`);

    const CURSOR_BATCH_SIZE = config.cursorBatch;
    const BULK_WRITE_BATCH = config.bulkWriteBatch;
    const ENQUEUE_CHUNK_SIZE = config.enqueueChunk;

    let processedCount = 0;
    let createdEmailSends = 0;
    let skippedDuplicates = 0;

    let tempRecipients = [];
    let bulkOperations = [];
    const seenEmails = new Set();

    try {
      const list = await List.findById(listId).select('members');
      const memberIds = list?.members || [];

      // Load emails already sent or in-flight to skip duplicates on re-runs
      const alreadyProcessed = await EmailSend.find({
        campaignId: campaignIdStr,
        status: { $in: ['sent', 'delivered', 'skipped', 'bounced', 'processing', 'sending'] }
      }).select('recipientEmail').lean();
      const alreadyProcessedSet = new Set(alreadyProcessed.map(e => e.recipientEmail.toLowerCase().trim()));
      if (alreadyProcessedSet.size > 0) {
        console.log(`⏭️  Skipping ${alreadyProcessedSet.size} recipients already processed (re-run)`);
      }

      const cursor = Customer
        .find({ _id: { $in: memberIds } })
        .select('email firstName lastName _id')
        .lean()
        .cursor({ batchSize: CURSOR_BATCH_SIZE });

      for await (const customer of cursor) {
        processedCount++;

        const normalizedEmail = customer.email.toLowerCase().trim();
        const emailKey = `${campaignIdStr}:${normalizedEmail}`;
        if (seenEmails.has(emailKey)) {
          skippedDuplicates++;
          continue;
        }
        seenEmails.add(emailKey);

        // Skip if already processed in a previous run
        if (alreadyProcessedSet.has(normalizedEmail)) {
          skippedDuplicates++;
          continue;
        }

        const jobId = generateJobId(campaignIdStr, normalizedEmail);

        // EmailSend record
        bulkOperations.push({
          updateOne: {
            filter: { campaignId: campaignIdStr, recipientEmail: normalizedEmail },
            update: {
              $setOnInsert: {
                jobId,
                campaignId: campaignIdStr,
                recipientEmail: normalizedEmail,
                customerId: customer._id,
                status: 'pending',
                attempts: 0,
                createdAt: new Date(),
                lockedBy: null,
                lockedAt: null
              }
            },
            upsert: true
          }
        });

        // Personalize + tracking
        let html = htmlTemplate;
        html = emailService.personalize(html, customer);
        html = emailService.injectUnsubscribeLink(html, customer._id.toString(), normalizedEmail, campaignIdStr);
        html = emailService.injectTracking(html, campaignIdStr, customer._id.toString(), normalizedEmail);

        tempRecipients.push({
          email: normalizedEmail,
          subject,
          html,
          from: `${fromName} <${fromEmail}>`,
          replyTo,
          customerId: customer._id.toString(),
          jobId
        });

        // Bulk write to DB
        if (bulkOperations.length >= BULK_WRITE_BATCH) {
          try {
            const result = await EmailSend.bulkWrite(bulkOperations, { ordered: false });
            createdEmailSends += result.upsertedCount || 0;
          } catch (error) {
            if (error.code !== 11000) throw error;
          }
          bulkOperations = [];
        }

        // NOTE: We accumulate all recipients and enqueue at the end.
        // Calling addCampaignToQueue progressively causes duplicate jobIds
        // because chunkIndex restarts at 0 each call → BullMQ rejects silently.
      }

      // Residual bulk write
      if (bulkOperations.length > 0) {
        try {
          const result = await EmailSend.bulkWrite(bulkOperations, { ordered: false });
          createdEmailSends += result.upsertedCount || 0;
        } catch (error) {
          if (error.code !== 11000) throw error;
        }
      }

      // Enqueue ALL recipients in one call (prevents duplicate jobId issue)
      if (tempRecipients.length > 0) {
        const { addCampaignToQueue } = require('../jobs/emailQueue');
        console.log(`📤 Enqueueing ${tempRecipients.length} recipients in a single call`);
        await addCampaignToQueue(tempRecipients, campaignIdStr);
      }

      // Adjust and set to sending
      const actualRecipients = processedCount - skippedDuplicates;
      await Campaign.findByIdAndUpdate(campaignIdStr, {
        status: 'sending',
        sentAt: new Date(),
        'stats.totalRecipients': actualRecipients
      });

      console.log(`✅ Campaign ${campaignIdStr} prepared: ${actualRecipients} recipients, ${createdEmailSends} EmailSends`);

    } catch (error) {
      console.error(`❌ Campaign ${campaignIdStr} send error:`, error.message);
      await Campaign.findByIdAndUpdate(campaignIdStr, { status: 'failed' });
    }
  });

  return {
    success: true,
    campaignId: campaignIdStr,
    totalRecipients,
    status: 'preparing'
  };
}

// Adaptive config (same as in controller)
function getOptimalConfig(total) {
  if (total < 5000) {
    return {
      name: 'FAST',
      description: 'Small campaign - max speed',
      cursorBatch: 1000,
      bulkWriteBatch: 500,
      enqueueChunk: 2000,
      delayBetweenBatches: 50
    };
  } else if (total < 50000) {
    return {
      name: 'BALANCED',
      description: 'Medium campaign - balanced',
      cursorBatch: 500,
      bulkWriteBatch: 300,
      enqueueChunk: 1000,
      delayBetweenBatches: 75
    };
  } else if (total < 200000) {
    return {
      name: 'STABLE',
      description: 'Large campaign - stability first',
      cursorBatch: 300,
      bulkWriteBatch: 200,
      enqueueChunk: 500,
      delayBetweenBatches: 100
    };
  }
  return {
    name: 'ULTRA_STABLE',
    description: 'Massive campaign - max stability',
    cursorBatch: 200,
    bulkWriteBatch: 150,
    enqueueChunk: 300,
    delayBetweenBatches: 150
  };
}

module.exports = { sendCampaign };
