const express = require('express');
const axios = require('axios');
const app = express();

// Environment variables
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'my_voiceflow_webhook_2024';
const VOICEFLOW_API_KEY = process.env.VOICEFLOW_API_KEY;
const VOICEFLOW_PROJECT_ID = process.env.VOICEFLOW_PROJECT_ID;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Add CORS headers for Vercel
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Webhook verification endpoint
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('🔍 Webhook Verification:', { mode, token, challenge });

  if (mode && token) {
    if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
      console.log('✅ WEBHOOK VERIFIED SUCCESSFULLY!');
      res.status(200).send(challenge);
    } else {
      console.log('❌ Token mismatch. Expected:', WHATSAPP_VERIFY_TOKEN, 'Got:', token);
      res.sendStatus(403);
    }
  } else {
    console.log('❌ Missing verification parameters');
    res.sendStatus(400);
  }
});

// Handle incoming WhatsApp messages
app.post('/webhook', async (req, res) => {
  console.log('📨 INCOMING WEBHOOK DATA:', JSON.stringify(req.body, null, 2));
  
  // Send immediate 200 response to WhatsApp
  res.sendStatus(200);

  try {
    const entry = req.body.entry;
    if (!entry || entry.length === 0) {
      console.log('⏭️ No entry data found');
      return;
    }

    const changes = entry[0]?.changes;
    if (!changes || changes.length === 0) {
      console.log('⏭️ No changes found');
      return;
    }

    for (const change of changes) {
      if (change.field === 'messages') {
        const value = change.value;
        const messages = value.messages;
        
        if (messages && messages.length > 0) {
          for (const message of messages) {
            // Process each message asynchronously
            processMessage(message, value).catch(error => {
              console.error('❌ Error in processMessage:', error);
            });
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
  }
});

// Process individual WhatsApp message
async function processMessage(message, messageData) {
  try {
    const from = message.from;
    const messageId = message.id;
    const timestamp = message.timestamp;
    const messageType = message.type;

    console.log(`\n🔄 PROCESSING MESSAGE:`);
    console.log(`📱 From: ${from}`);
    console.log(`🆔 Message ID: ${messageId}`);
    console.log(`⏰ Timestamp: ${timestamp}`);
    console.log(`📝 Type: ${messageType}`);

    let userInput = '';
    let messageContext = '';

    // Extract message content based on type
    switch (messageType) {
      case 'text':
        userInput = message.text.body;
        messageContext = 'text_message';
        break;
        
      case 'interactive':
        if (message.interactive.type === 'button_reply') {
          userInput = message.interactive.button_reply.title;
          messageContext = 'button_click';
          console.log(`🔘 Button clicked: ${userInput}`);
        } else if (message.interactive.type === 'list_reply') {
          userInput = message.interactive.list_reply.title;
          messageContext = 'list_selection';
          console.log(`📋 List item selected: ${userInput}`);
        }
        break;
        
      case 'image':
        userInput = message.image.caption || 'User sent an image';
        messageContext = 'image_message';
        break;
        
      case 'document':
        userInput = message.document.caption || 'User sent a document';
        messageContext = 'document_message';
        break;
        
      case 'audio':
        userInput = 'User sent an audio message';
        messageContext = 'audio_message';
        break;
        
      default:
        console.log(`⏭️ Unsupported message type: ${messageType}`);
        return;
    }

    console.log(`💬 User Input: "${userInput}"`);
    console.log(`🏷️ Context: ${messageContext}`);

    // Send to Voiceflow and process response
    await handleVoiceflowConversation(from, userInput, messageContext);

  } catch (error) {
    console.error('❌ Error in processMessage:', error);
    await sendWhatsAppMessage(message.from, {
      type: 'text',
      text: "I'm experiencing technical difficulties. Please try again in a moment. 🤖"
    });
  }
}

// Handle Voiceflow conversation with retry mechanism
async function handleVoiceflowConversation(userId, userInput, context = '') {
  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      attempt++;
      console.log(`\n🤖 VOICEFLOW API CALL (Attempt ${attempt}/${maxRetries})`);
      console.log(`👤 User ID: ${userId}`);
      console.log(`💭 Message: "${userInput}"`);

      const voiceflowResponse = await axios.post(
        `https://general-runtime.voiceflow.com/state/user/${userId}/interact`,
        {
          action: {
            type: 'text',
            payload: userInput
          },
          config: {
            tts: false,
            stripSSML: true,
            stopAll: true,
            excludeTypes: ["block", "debug", "flow"]
          }
        },
        {
          headers: {
            'Authorization': VOICEFLOW_API_KEY,
            'Content-Type': 'application/json',
            'versionID': 'production'
          },
          timeout: 20000, // 20 second timeout
          validateStatus: function (status) {
            return status >= 200 && status < 300;
          }
        }
      );

      console.log(`✅ Voiceflow Response Status: ${voiceflowResponse.status}`);
      console.log(`📊 Response Data Length: ${voiceflowResponse.data?.length || 0} traces`);

      if (voiceflowResponse.data && Array.isArray(voiceflowResponse.data)) {
        await processVoiceflowTraces(userId, voiceflowResponse.data);
        return; // Success, exit retry loop
      } else {
        throw new Error('Invalid response format from Voiceflow');
      }

    } catch (error) {
      console.error(`❌ Voiceflow API Error (Attempt ${attempt}):`, error.response?.data || error.message);
      
      if (attempt >= maxRetries) {
        console.log('💔 All Voiceflow attempts failed, sending fallback response');
        await sendWhatsAppMessage(userId, {
          type: 'text',
          text: "Hi! Welcome to Laksh Estate Real Estate Assistant! 🏠\n\nI'm here to help you with all your property needs. What would you like to do today?\n\n🔹 Property Services\n🔹 Buy/Sell Properties\n🔹 Investment Advisory\n🔹 Property Management\n\nJust let me know how I can assist you!"
        });
        return;
      }

      // Wait before retry (exponential backoff)
      const waitTime = 2000 * attempt;
      console.log(`⏳ Waiting ${waitTime}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

// Process all traces from Voiceflow response
async function processVoiceflowTraces(userId, traces) {
  console.log(`\n📋 PROCESSING ${traces.length} VOICEFLOW TRACES:`);

  let messagesSent = 0;
  const delayBetweenMessages = 1000; // 1 second delay between messages

  for (let i = 0; i < traces.length; i++) {
    const trace = traces[i];
    console.log(`\n📤 Processing Trace ${i + 1}/${traces.length}:`);
    console.log(`🔧 Type: ${trace.type}`);
    console.log(`📦 Payload:`, JSON.stringify(trace.payload, null, 2));

    try {
      let messageSent = false;

      switch (trace.type) {
        case 'text':
          if (trace.payload && trace.payload.message) {
            await sendWhatsAppMessage(userId, {
              type: 'text',
              text: trace.payload.message
            });
            messageSent = true;
          }
          break;

        case 'speak':
          if (trace.payload && trace.payload.message) {
            await sendWhatsAppMessage(userId, {
              type: 'text', 
              text: trace.payload.message
            });
            messageSent = true;
          }
          break;

        case 'visual':
          if (trace.payload && trace.payload.image) {
            await sendWhatsAppMessage(userId, {
              type: 'image',
              image: {
                link: trace.payload.image,
                caption: trace.payload.text || ''
              }
            });
            messageSent = true;
          }
          break;

        case 'carousel':
          if (trace.payload && trace.payload.cards && trace.payload.cards.length > 0) {
            await handleCarouselMessage(userId, trace.payload);
            messageSent = true;
          }
          break;

        case 'choice':
          if (trace.payload && trace.payload.buttons && trace.payload.buttons.length > 0) {
            await handleChoiceMessage(userId, trace.payload);
            messageSent = true;
          }
          break;

        case 'cardV2':
          if (trace.payload) {
            await handleCardV2Message(userId, trace.payload);
            messageSent = true;
          }
          break;

        case 'image':
          if (trace.payload && trace.payload.imageURL) {
            await sendWhatsAppMessage(userId, {
              type: 'image',
              image: {
                link: trace.payload.imageURL,
                caption: trace.payload.text || ''
              }
            });
            messageSent = true;
          }
          break;

        default:
          console.log(`⏭️ Skipping unsupported trace type: ${trace.type}`);
          break;
      }

      if (messageSent) {
        messagesSent++;
        console.log(`✅ Message ${messagesSent} sent successfully`);
        
        // Add delay between messages to avoid rate limiting
        if (i < traces.length - 1) { // Don't delay after the last message
          await new Promise(resolve => setTimeout(resolve, delayBetweenMessages));
        }
      }

    } catch (error) {
      console.error(`❌ Error processing trace ${i + 1}:`, error);
      // Continue with next trace instead of stopping
    }
  }

  console.log(`\n🎯 PROCESSING COMPLETE: ${messagesSent} messages sent to WhatsApp`);
}

// Handle carousel messages
async function handleCarouselMessage(userId, payload) {
  const cards = payload.cards || [];
  console.log(`🎠 Processing carousel with ${cards.length} cards`);

  if (cards.length === 0) return;

  // Send carousel title if available
  if (payload.title) {
    await sendWhatsAppMessage(userId, {
      type: 'text',
      text: payload.title
    });
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // If single card, send as image + text
  if (cards.length === 1) {
    const card = cards[0];
    
    if (card.imageUrl) {
      await sendWhatsAppMessage(userId, {
        type: 'image',
        image: {
          link: card.imageUrl,
          caption: `*${card.title || 'Card'}*${card.description ? '\n\n' + card.description : ''}`
        }
      });
    } else {
      await sendWhatsAppMessage(userId, {
        type: 'text',
        text: `*${card.title || 'Card'}*${card.description ? '\n\n' + card.description : ''}`
      });
    }
    return;
  }

  // Multiple cards - create interactive list
  const sections = [{
    title: "Available Options",
    rows: cards.slice(0, 10).map((card, index) => ({
      id: `carousel_${index}_${Date.now()}`,
      title: (card.title || `Option ${index + 1}`).substring(0, 24),
      description: (card.description || '').substring(0, 72)
    }))
  }];

  await sendWhatsAppMessage(userId, {
    type: 'interactive',
    interactive: {
      type: 'list',
      header: {
        type: 'text',
        text: 'Available Options'
      },
      body: {
        text: 'Please select an option from the list below:'
      },
      action: {
        button: 'Select Option',
        sections: sections
      }
    }
  });
}

// Handle choice/button messages
async function handleChoiceMessage(userId, payload) {
  const buttons = payload.buttons || [];
  console.log(`🔘 Processing ${buttons.length} choice buttons`);

  if (buttons.length === 0) return;

  const messageText = payload.message || "Please choose an option:";

  // WhatsApp supports max 3 interactive buttons
  if (buttons.length <= 3) {
    const interactiveButtons = buttons.slice(0, 3).map((button, index) => ({
      type: "reply",
      reply: {
        id: `btn_${index}_${Date.now()}`,
        title: (button.name || `Option ${index + 1}`).substring(0, 20)
      }
    }));

    await sendWhatsAppMessage(userId, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: messageText },
        action: { buttons: interactiveButtons }
      }
    });
  } else {
    // More than 3 options - use list
    const sections = [{
      title: "Choose an Option",
      rows: buttons.slice(0, 10).map((button, index) => ({
        id: `choice_${index}_${Date.now()}`,
        title: (button.name || `Option ${index + 1}`).substring(0, 24),
        description: (button.request?.payload?.label || '').substring(0, 72)
      }))
    }];

    await sendWhatsAppMessage(userId, {
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'Options' },
        body: { text: messageText },
        action: {
          button: 'Choose',
          sections: sections
        }
      }
    });
  }
}

// Handle CardV2 messages
async function handleCardV2Message(userId, payload) {
  console.log(`🎴 Processing CardV2 message`);
  
  let message = '';
  if (payload.title) message += `*${payload.title}*\n\n`;
  if (payload.description) message += `${payload.description}\n\n`;
  if (payload.text) message += `${payload.text}`;

  if (message.trim()) {
    await sendWhatsAppMessage(userId, {
      type: 'text',
      text: message.trim()
    });
  }
}

// Universal WhatsApp message sender
async function sendWhatsAppMessage(to, messageData) {
  try {
    const payload = {
      messaging_product: "whatsapp",
      to: to,
      ...messageData
    };

    console.log(`📤 Sending WhatsApp message:`, JSON.stringify(payload, null, 2));

    const response = await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    console.log(`✅ WhatsApp API Response: Status ${response.status}`);
    return response.data;

  } catch (error) {
    console.error(`❌ WhatsApp API Error:`, error.response?.data || error.message);
    throw error;
  }
}

// Health check endpoint with comprehensive diagnostics
app.get('/', (req, res) => {
  const healthCheck = {
    status: '🚀 WhatsApp Voiceflow Webhook is RUNNING!',
    timestamp: new Date().toISOString(),
    environment: 'Vercel Production',
    nodeVersion: process.version,
    systemCheck: {
      whatsappToken: WHATSAPP_TOKEN ? '✅ Configured' : '❌ Missing',
      voiceflowApiKey: VOICEFLOW_API_KEY ? '✅ Configured' : '❌ Missing',
      phoneNumberId: PHONE_NUMBER_ID ? '✅ Configured' : '❌ Missing',
      verifyToken: WHATSAPP_VERIFY_TOKEN ? '✅ Configured' : '❌ Missing'
    },
    webhookUrl: 'https://whatsapp-voiceflow-webhook1-4p7x.vercel.app/webhook',
    features: [
      '✅ Text Messages',
      '✅ Image Messages with Captions', 
      '✅ Interactive Buttons (1-3 options)',
      '✅ Interactive Lists (4-10 options)',
      '✅ Carousel Cards',
      '✅ Long Text Processing',
      '✅ Conversation Flow Management',
      '✅ Error Recovery & Fallbacks',
      '✅ Retry Mechanisms'
    ]
  };

  console.log('🔍 Health check requested:', healthCheck);
  res.json(healthCheck);
});

// Catch all other routes
app.all('*', (req, res) => {
  console.log(`📍 Route not found: ${req.method} ${req.path}`);
  res.status(404).json({ 
    error: 'Route not found',
    availableEndpoints: [
      'GET / - Health check',
      'GET /webhook - Webhook verification', 
      'POST /webhook - Message processing'
    ]
  });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error('🚨 Global Error Handler:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Export for Vercel serverless
module.exports = app;

// Local development server
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  
  app.listen(PORT, () => {
    console.log(`\n🚀 SERVER STARTED SUCCESSFULLY!`);
    console.log(`📍 Port: ${PORT}`);
    console.log(`🌐 Local URL: http://localhost:${PORT}`);
    console.log(`🔗 Webhook URL: http://localhost:${PORT}/webhook`);
    console.log(`\n📋 ENVIRONMENT CHECK:`);
    console.log(`   WHATSAPP_TOKEN: ${WHATSAPP_TOKEN ? '✅' : '❌'}`);
    console.log(`   VOICEFLOW_API_KEY: ${VOICEFLOW_API_KEY ? '✅' : '❌'}`);
    console.log(`   PHONE_NUMBER_ID: ${PHONE_NUMBER_ID ? '✅' : '❌'}`);
    console.log(`   VERIFY_TOKEN: ${WHATSAPP_VERIFY_TOKEN ? '✅' : '❌'}`);
    console.log(`\n🤖 WhatsApp Voiceflow Bot Ready!`);
  });
}
