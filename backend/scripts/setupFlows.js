// backend/scripts/setupFlows.js
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../src/config/database');
const Flow = require('../src/models/Flow');

async function setupFlows() {
  try {
    // Connect to MongoDB
    await connectDB();
    console.log('✅ Connected to MongoDB');
    
    // Flow 1: Welcome Series
    const welcomeFlow = await Flow.findOneAndUpdate(
      { name: '🎉 Welcome Series' },
      {
        name: '🎉 Welcome Series',
        description: 'Welcome email series for new customers',
        trigger: { type: 'customer_created' },
        status: 'active',
        steps: [
          {
            type: 'send_email',
            order: 1,
            config: {
              subject: 'Welcome to Jersey Pickles! 🥒',
              templateId: 'welcome'
            }
          },
          {
            type: 'wait',
            order: 2,
            config: { delayMinutes: 1440 } // 24 hours
          },
          {
            type: 'send_email',
            order: 3,
            config: {
              subject: 'Discover Our Best Sellers ⭐',
              templateId: 'products_showcase'
            }
          },
          {
            type: 'wait',
            order: 4,
            config: { delayMinutes: 4320 } // 3 days
          },
          {
            type: 'condition',
            order: 5,
            config: {
              conditionType: 'has_purchased',
              ifFalse: [
                {
                  type: 'create_discount',
                  config: {
                    discountCode: 'WELCOME15',
                    discountType: 'percentage',
                    discountValue: 15,
                    expiresInDays: 7
                  }
                },
                {
                  type: 'send_email',
                  config: {
                    subject: '15% OFF - Your Special Welcome Gift 🎁',
                    templateId: 'welcome_discount'
                  }
                }
              ],
              ifTrue: [
                {
                  type: 'add_tag',
                  config: { tagName: 'customer' }
                }
              ]
            }
          }
        ]
      },
      { upsert: true, new: true }
    );
    console.log('✅ Flow created: Welcome Series');
    
    // Flow 2: Post-Purchase Thank You
    const postPurchaseFlow = await Flow.findOneAndUpdate(
      { name: '📦 Post-Purchase Experience' },
      {
        name: '📦 Post-Purchase Experience',
        description: 'Post-purchase follow-up sequence',
        trigger: { type: 'order_placed' },
        status: 'active',
        steps: [
          {
            type: 'send_email',
            order: 1,
            config: {
              subject: 'Thank You For Your Order! 🎉',
              templateId: 'order_confirmation'
            }
          },
          {
            type: 'add_tag',
            order: 2,
            config: { tagName: 'customer' }
          },
          {
            type: 'wait',
            order: 3,
            config: { delayMinutes: 10080 } // 7 days
          },
          {
            type: 'send_email',
            order: 4,
            config: {
              subject: 'How Are Your Pickles? We\'d Love Your Feedback!',
              templateId: 'review_request'
            }
          }
        ]
      },
      { upsert: true, new: true }
    );
    console.log('✅ Flow created: Post-Purchase Experience');
    
    // Flow 3: Abandoned Cart Recovery
    const abandonedCartFlow = await Flow.findOneAndUpdate(
      { name: '🛒 Abandoned Cart Recovery' },
      {
        name: '🛒 Abandoned Cart Recovery',
        description: 'Recover abandoned checkouts',
        trigger: { 
          type: 'cart_abandoned',
          config: { abandonedAfterMinutes: 60 }
        },
        status: 'active',
        steps: [
          {
            type: 'wait',
            order: 1,
            config: { delayMinutes: 60 } // 1 hour
          },
          {
            type: 'send_email',
            order: 2,
            config: {
              subject: 'Did You Forget Something? 🥒',
              templateId: 'cart_reminder_1'
            }
          },
          {
            type: 'wait',
            order: 3,
            config: { delayMinutes: 1440 } // 24 hours
          },
          {
            type: 'create_discount',
            order: 4,
            config: {
              discountCode: 'COMEBACK10',
              discountType: 'percentage',
              discountValue: 10,
              expiresInDays: 3
            }
          },
          {
            type: 'send_email',
            order: 5,
            config: {
              subject: '10% OFF - Complete Your Order Today!',
              templateId: 'cart_discount'
            }
          }
        ]
      },
      { upsert: true, new: true }
    );
    console.log('✅ Flow created: Abandoned Cart Recovery');
    
    // Flow 4: Order Fulfilled
    const orderFulfilledFlow = await Flow.findOneAndUpdate(
      { name: '📬 Order Shipped Notification' },
      {
        name: '📬 Order Shipped Notification',
        description: 'Notify customers when order ships',
        trigger: { type: 'order_fulfilled' },
        status: 'active',
        steps: [
          {
            type: 'send_email',
            order: 1,
            config: {
              subject: 'Your Pickles Are On The Way! 🚚',
              templateId: 'order_shipped'
            }
          }
        ]
      },
      { upsert: true, new: true }
    );
    console.log('✅ Flow created: Order Shipped Notification');
    
    // Flow 5: VIP Customer
    const vipFlow = await Flow.findOneAndUpdate(
      { name: '💎 VIP Customer Program' },
      {
        name: '💎 VIP Customer Program',
        description: 'Welcome high-value customers to VIP program',
        trigger: { 
          type: 'customer_tag_added',
          config: { tagName: 'VIP' }
        },
        status: 'active',
        steps: [
          {
            type: 'send_email',
            order: 1,
            config: {
              subject: 'Welcome to VIP Status! 💎',
              templateId: 'vip_welcome'
            }
          },
          {
            type: 'create_discount',
            order: 2,
            config: {
              discountCode: 'VIP20',
              discountType: 'percentage',
              discountValue: 20,
              expiresInDays: 30
            }
          }
        ]
      },
      { upsert: true, new: true }
    );
    console.log('✅ Flow created: VIP Customer Program');
    
    console.log('\n╔════════════════════════════════════════╗');
    console.log('║  🎉 ALL FLOWS CONFIGURED SUCCESSFULLY  ║');
    console.log('╚════════════════════════════════════════╝\n');
    
    // Show summary
    const activeFlows = await Flow.find({ status: 'active' });
    console.log(`Total active flows: ${activeFlows.length}`);
    activeFlows.forEach(flow => {
      console.log(`  ✅ ${flow.name} - ${flow.steps.length} steps`);
    });
    
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

setupFlows();