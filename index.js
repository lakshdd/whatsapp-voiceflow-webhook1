const express = require('express');
const axios = require('axios');
const app = express();

// Environment variables (you'll set these in Vercel)
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'my_voiceflow_webhook_2024';
const VOICEFLOW_API_KEY = process.env.VOICEFLOW_API_KEY;
const VOICEFLOW_PROJECT_ID = process.env.VOICEFLOW_PROJECT_ID;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

app.use(express.json());

// Add CORS headers for Vercel
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  next();
});

// Webhook verification endpoint
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('🔍 Verification request:', { mode, token, challenge });

  if (mode && token) {
    if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
      console.log('✅ Webhook verified successfully!');
      res.status(200).send(challenge);
    } else {
      console.log('❌ Webhook verification failed - token mismatch');
      res.sendStatus(403);
    }
  } else {
    console.log('❌ Missing verification parameters');
    res.sendStatus(400);
  }
});

// Handle incoming WhatsApp messages
app.post('/webhook', async (req, res) => {
  try {
    console.log('📨 Incoming webhook:', JSON.stringify(req.body, null, 2));

    // Quick acknowledgment to WhatsApp
    res.sendStatus(200);

    const changes = req.body.entry?.[0]?.changes;
    if (!changes) {
      console.log('⏭️ No changes found in webhook');
      return;
    }

    for (const change of changes) {
      if (change.field === 'messages') {
        const messages = change.value.messages;
        if (messages) {
          for (const message of messages) {
            // Process message asynchronously to avoid timeout
            setImmediate(() => handleMessage(message, change.value));
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.sendStatus(500);
  }
});

// Handle individual messages
async function handleMessage(message, messageData) {
  const from = message.from;
  const messageText = message.text?.body || '';
  const messageType = message.type;

  console.log(`📱 Processing message from ${from}: ${messageText} (type: ${messageType})`);

  // Handle different message types
  let userInput = messageText;
  
  if (messageType === 'interactive') {
    // Handle button clicks and list selections
    if (message.interactive?.type === 'button_reply') {
      userInput = message.interactive.button_reply.title;
    } else if (message.interactive?.type === 'list_reply') {
      userInput = message.interactive.list_reply.title;
    }
  }

  // Skip if not a supported message type
  if (!['text', 'interactive'].includes(messageType)) {
    console.log(`⏭️ Skipping unsupported message type: ${messageType}`);
    return;
  }

  try {
    // Send message to Voiceflow
    console.log(`🤖 Sending to Voiceflow: "${userInput}"`);
    const voiceflowResponse = await sendToVoiceflow(from, userInput);
    
    // Process and send response back to WhatsApp
    await processVoiceflowResponse(from, voiceflowResponse);
    
  } catch (error) {
    console.error('❌ Error processing message:', error);
    // Send fallback message
    await sendWhatsAppText(from, "Sorry, I'm experiencing technical difficulties. Please try again in a moment. 🤖");
  }
}

// Send message to Voiceflow and get response
async function sendToVoiceflow(userId, message) {
  try {
    const response = await axios.post(
      `https://general-runtime.voiceflow.com/state/user/${userId}/interact`,
      {
        action: {
          type: 'text',
          payload: message
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
        timeout: 10000 // 10 second timeout
      }
    );

    console.log('🤖 Voiceflow response received:', response.data?.length || 0, 'traces');
    return response.data;
  } catch (error) {
    console.error('❌ Voiceflow API error:', error.response?.data || error.message);
    throw error;
  }
}

// Process Voiceflow response and send to WhatsApp
async function processVoiceflowResponse(to, voiceflowResponse) {
  if (!Array.isArray(voiceflowResponse)) {
    console.log('⚠️ Unexpected Voiceflow response format');
    return;
  }
  
  for (const trace of voiceflowResponse) {
    try {
      console.log(`📤 Processing trace type: ${trace.type}`);
      
      if (trace.type === 'text' && trace.payload?.message) {
        await sendWhatsAppText(to, trace.payload.message);
      } 
      else if (trace.type === 'visual' && trace.payload?.image) {
        await sendWhatsAppImage(to, trace.payload.image, trace.payload.text);
      }
      else if (trace.type === 'carousel' && trace.payload?.cards) {
        await handleCarousel(to, trace.payload);
      }
      else if (trace.type === 'choice' && trace.payload?.buttons) {
        await handleChoiceButtons(to, trace.payload);
      }
      else if (trace.type === 'speak' && trace.payload?.message) {
        // Convert speak to text for WhatsApp
        await sendWhatsAppText(to, trace.payload.message);
      }
      
      // Small delay between messages to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
      
    } catch (error) {
      console.error(`❌ Error processing trace type ${trace.type}:`, error);
    }
  }
}

// Send WhatsApp image message
async function sendWhatsAppImage(to, imageUrl, caption = '') {
  try {
    const payload = {
      messaging_product: "whatsapp",
      to: to,
      type: "image",
      image: {
        link: imageUrl
      }
    };
    
    if (caption) {
      payload.image.caption = caption;
    }

    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    console.log('✅ Image message sent successfully');
  } catch (error) {
    console.error('❌ Failed to send image:', error.response?.data || error.message);
  }
}

// Handle carousel - convert to WhatsApp list or buttons
async function handleCarousel(to, payload) {
  const cards = payload.cards || [];
  if (cards.length === 0) return;

  console.log(`🎠 Processing carousel with ${cards.length} cards`);

  // Send header message if available
  if (payload.title) {
    await sendWhatsAppText(to, payload.title);
  }

  // If only one card, send as image + buttons
  if (cards.length === 1) {
    const card = cards[0];
    
    // Send image if available
    if (card.imageUrl) {
      await sendWhatsAppImage(to, card.imageUrl, card.title);
    } else {
      let message = `*${card.title}*`;
      if (card.description) {
        message += `\n\n${card.description}`;
      }
      await sendWhatsAppText(to, message);
    }
    return;
  }

  // Multiple cards - create interactive list
  const sections = [{
    title: "Available Options",
    rows: cards.slice(0, 10).map((card, index) => ({
      id: `card_${index}`,
      title: (card.title || `Option ${index + 1}`).substring(0, 24),
      description: (card.description || '').substring(0, 72)
    }))
  }];

  await sendWhatsAppList(to, "Please select an option from the list below:", "Select Option", sections);
}

// Handle choice buttons
async function handleChoiceButtons(to, payload) {
  const buttons = payload.buttons || [];
  if (buttons.length === 0) return;

  console.log(`🔘 Processing ${buttons.length} choice buttons`);

  const messageText = payload.message || "Please choose an option:";

  if (buttons.length <= 3) {
    // Use interactive buttons (WhatsApp limit: 3 buttons)
    const interactiveButtons = buttons.slice(0, 3).map((button, index) => ({
      type: "reply",
      reply: {
        id: `btn_${index}_${Date.now()}`,
        title: (button.name || `Option ${index + 1}`).substring(0, 20)
      }
    }));

    await sendWhatsAppButtons(to, messageText, interactiveButtons);
  } else {
    // Use list for more than 3 options (WhatsApp limit: 10 items)
    const sections = [{
      title: "Choose an Option",
      rows: buttons.slice(0, 10).map((button, index) => ({
        id: `choice_${index}_${Date.now()}`,
        title: (button.name || `Option ${index + 1}`).substring(0, 24),
        description: (button.request?.payload?.label || '').substring(0, 72)
      }))
    }];

    await sendWhatsAppList(to, messageText, "Choose", sections);
  }
}

// Send WhatsApp text message
async function sendWhatsAppText(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        type: "text",
        text: { body: text }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    console.log('✅ Text message sent successfully');
  } catch (error) {
    console.error('❌ Failed to send text:', error.response?.data || error.message);
  }
}

// Send WhatsApp interactive buttons
async function sendWhatsAppButtons(to, text, buttons) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: text },
          action: { buttons: buttons }
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    console.log('✅ Button message sent successfully');
  } catch (error) {
    console.error('❌ Failed to send buttons:', error.response?.data || error.message);
  }
}

// Send WhatsApp list message
async function sendWhatsAppList(to, text, buttonText, sections) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        type: "interactive",
        interactive: {
          type: "list",
          header: { type: "text", text: "Available Options" },
          body: { text: text },
          action: {
            button: buttonText,
            sections: sections
          }
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    console.log('✅ List message sent successfully');
  } catch (error) {
    console.error('❌ Failed to send list:', error.response?.data || error.message);
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'WhatsApp Voiceflow Webhook is running! 🚀',
    timestamp: new Date().toISOString(),
    environment: 'Vercel',
    nodeVersion: process.version
  });
});

// Export for Vercel
module.exports = app;

// Start server (only for local development)
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log('📱 WhatsApp Voiceflow Webhook ready!');
  });
}
