const express = require('express');
const axios = require('axios');
const app = express();

// ================================
// ENVIRONMENT VARIABLES
// ================================
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'vf_webhook_2024_secure';
const VOICEFLOW_API_KEY = process.env.VOICEFLOW_API_KEY;
const VOICEFLOW_PROJECT_ID = process.env.VOICEFLOW_PROJECT_ID;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// ================================
// MIDDLEWARE SETUP
// ================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// CORS headers for Vercel
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

// ================================
// WEBHOOK VERIFICATION (GET)
// ================================
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('🔍 Webhook verification attempt:', { 
    mode, 
    token: token ? 'PROVIDED' : 'MISSING', 
    challenge: challenge ? 'PROVIDED' : 'MISSING' 
  });

  if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
    console.log('✅ Webhook verified successfully!');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Webhook verification failed');
    res.sendStatus(403);
  }
});

// ================================
// WEBHOOK MESSAGE HANDLER (POST)
// ================================
app.post('/webhook', async (req, res) => {
  try {
    // Immediately acknowledge receipt
    res.sendStatus(200);
    
    console.log('📨 Incoming webhook data:', JSON.stringify(req.body, null, 2));

    const entry = req.body.entry?.[0];
    if (!entry) {
      console.log('⏭️ No entry found in webhook data');
      return;
    }

    const changes = entry.changes;
    if (!changes || changes.length === 0) {
      console.log('⏭️ No changes found in webhook data');
      return;
    }

    // Process each change
    for (const change of changes) {
      if (change.field === 'messages' && change.value.messages) {
        for (const message of change.value.messages) {
          // Process message asynchronously to avoid blocking
          processMessage(message, change.value).catch(error => {
            console.error('❌ Error processing message:', error);
          });
        }
      }
    }

  } catch (error) {
    console.error('❌ Webhook processing error:', error);
  }
});

// ================================
// MESSAGE PROCESSING
// ================================
async function processMessage(message, messageData) {
  const from = message.from;
  const messageId = message.id;
  const timestamp = message.timestamp;

  console.log(`\n📱 Processing message from ${from} (ID: ${messageId})`);
  console.log(`🕒 Message timestamp: ${new Date(timestamp * 1000).toISOString()}`);

  // Extract user input based on message type
  let userInput = '';
  let messageType = message.type;

  switch (messageType) {
    case 'text':
      userInput = message.text?.body || '';
      break;
      
    case 'interactive':
      if (message.interactive?.type === 'button_reply') {
        userInput = message.interactive.button_reply.title;
        console.log(`🔘 Button clicked: ${userInput}`);
      } else if (message.interactive?.type === 'list_reply') {
        userInput = message.interactive.list_reply.title;
        console.log(`📋 List option selected: ${userInput}`);
      }
      break;
      
    case 'image':
      userInput = message.image?.caption || 'User sent an image';
      console.log(`🖼️ Image received with caption: ${userInput}`);
      break;
      
    case 'audio':
      userInput = 'User sent a voice message';
      console.log('🎵 Audio message received');
      break;
      
    case 'document':
      userInput = message.document?.caption || 'User sent a document';
      console.log(`📄 Document received: ${message.document?.filename}`);
      break;
      
    default:
      console.log(`⏭️ Unsupported message type: ${messageType}`);
      return;
  }

  if (!userInput.trim()) {
    console.log('⏭️ Empty message, skipping');
    return;
  }

  try {
    // Send typing indicator
    await sendTypingIndicator(from);
    
    // Send to Voiceflow
    console.log(`🤖 Sending to Voiceflow: "${userInput}"`);
    const voiceflowResponse = await sendToVoiceflow(from, userInput);
    
    // Process and send response
    await processVoiceflowResponse(from, voiceflowResponse);
    
    console.log(`✅ Message processing completed for ${from}`);
    
  } catch (error) {
    console.error(`❌ Error processing message from ${from}:`, error);
    
    // Send error message to user
    await sendWhatsAppText(from, "I'm sorry, I'm experiencing technical difficulties right now. Please try again in a few moments. 🤖💭");
  }
}

// ================================
// VOICEFLOW INTEGRATION
// ================================
async function sendToVoiceflow(userId, message) {
  try {
    const payload = {
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
    };

    console.log('🔄 Voiceflow request payload:', JSON.stringify(payload, null, 2));

    const response = await axios.post(
      `https://general-runtime.voiceflow.com/state/user/${userId}/interact`,
      payload,
      {
        headers: {
          'Authorization': VOICEFLOW_API_KEY,
          'Content-Type': 'application/json',
          'versionID': 'production'
        },
        timeout: 15000
      }
    );

    console.log(`🤖 Voiceflow response: ${response.data?.length || 0} traces received`);
    return response.data || [];

  } catch (error) {
    console.error('❌ Voiceflow API error:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    throw new Error('Voiceflow API communication failed');
  }
}

// ================================
// VOICEFLOW RESPONSE PROCESSING
// ================================
async function processVoiceflowResponse(to, traces) {
  if (!Array.isArray(traces) || traces.length === 0) {
    console.log('⚠️ No traces to process');
    await sendWhatsAppText(to, "I understand your message, but I don't have a response ready right now. Could you please try rephrasing?");
    return;
  }

  for (let i = 0; i < traces.length; i++) {
    const trace = traces[i];
    console.log(`📤 Processing trace ${i + 1}/${traces.length}: ${trace.type}`);

    try {
      switch (trace.type) {
        case 'text':
          if (trace.payload?.message) {
            await sendWhatsAppText(to, trace.payload.message);
          }
          break;

        case 'speak':
          if (trace.payload?.message) {
            await sendWhatsAppText(to, trace.payload.message);
          }
          break;

        case 'visual':
          if (trace.payload?.image) {
            await sendWhatsAppImage(to, trace.payload.image, trace.payload.text);
          }
          break;

        case 'carousel':
          if (trace.payload?.cards && trace.payload.cards.length > 0) {
            await handleCarousel(to, trace.payload);
          }
          break;

        case 'choice':
          if (trace.payload?.buttons && trace.payload.buttons.length > 0) {
            await handleChoiceButtons(to, trace.payload);
          }
          break;

        case 'cardV2':
          await handleCardV2(to, trace.payload);
          break;

        default:
          console.log(`⏭️ Unhandled trace type: ${trace.type}`);
          break;
      }

      // Small delay between messages to avoid rate limits
      if (i < traces.length - 1) {
        await delay(300);
      }

    } catch (error) {
      console.error(`❌ Error processing trace ${trace.type}:`, error);
    }
  }
}

// ================================
// WHATSAPP MESSAGE SENDERS
// ================================

// Send typing indicator
async function sendTypingIndicator(to) {
  try {
    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "reaction",
        reaction: {
          message_id: to,
          emoji: "⏳"
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      }
    );
  } catch (error) {
    // Typing indicator is not critical, so just log the error
    console.log('ℹ️ Could not send typing indicator');
  }
}

// Send text message
async function sendWhatsAppText(to, text) {
  try {
    if (!text || text.trim().length === 0) {
      console.log('⚠️ Attempted to send empty text message');
      return;
    }

    // WhatsApp has a 4096 character limit for text messages
    const maxLength = 4000;
    if (text.length > maxLength) {
      // Split long messages
      const chunks = text.match(new RegExp(`.{1,${maxLength}}`, 'g'));
      for (const chunk of chunks) {
        await sendWhatsAppText(to, chunk);
        await delay(500);
      }
      return;
    }

    const response = await axios.post(
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
    return response.data;

  } catch (error) {
    console.error('❌ Failed to send text message:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    throw error;
  }
}

// Send image message
async function sendWhatsAppImage(to, imageUrl, caption = '') {
  try {
    if (!imageUrl) {
      console.log('⚠️ No image URL provided');
      return;
    }

    const payload = {
      messaging_product: "whatsapp",
      to: to,
      type: "image",
      image: {
        link: imageUrl
      }
    };

    if (caption && caption.trim()) {
      payload.image.caption = caption.substring(0, 1024); // WhatsApp caption limit
    }

    await axios.post(
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

    console.log('✅ Image message sent successfully');

  } catch (error) {
    console.error('❌ Failed to send image:', error.response?.data || error.message);
    
    // Fallback: send caption as text if image fails
    if (caption) {
      await sendWhatsAppText(to, `🖼️ ${caption}`);
    }
  }
}

// Send interactive buttons
async function sendWhatsAppButtons(to, text, buttons) {
  try {
    if (!buttons || buttons.length === 0) {
      await sendWhatsAppText(to, text);
      return;
    }

    // WhatsApp allows max 3 buttons
    const limitedButtons = buttons.slice(0, 3);

    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: text },
          action: { buttons: limitedButtons }
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

    console.log(`✅ Interactive buttons sent (${limitedButtons.length} buttons)`);

  } catch (error) {
    console.error('❌ Failed to send buttons:', error.response?.data || error.message);
    
    // Fallback: send as numbered list
    let fallbackText = text + '\n\n';
    buttons.forEach((button, index) => {
      fallbackText += `${index + 1}. ${button.reply.title}\n`;
    });
    await sendWhatsAppText(to, fallbackText);
  }
}

// Send interactive list
async function sendWhatsAppList(to, bodyText, buttonText, sections) {
  try {
    if (!sections || sections.length === 0) {
      await sendWhatsAppText(to, bodyText);
      return;
    }

    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: to,
        type: "interactive",
        interactive: {
          type: "list",
          header: { type: "text", text: "Select an Option" },
          body: { text: bodyText },
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

    console.log('✅ Interactive list sent successfully');

  } catch (error) {
    console.error('❌ Failed to send list:', error.response?.data || error.message);
    
    // Fallback: send as numbered text
    let fallbackText = bodyText + '\n\n';
    sections.forEach(section => {
      section.rows.forEach((row, index) => {
        fallbackText += `${index + 1}. ${row.title}\n`;
      });
    });
    await sendWhatsAppText(to, fallbackText);
  }
}

// ================================
// CONTENT HANDLERS
// ================================

// Handle carousel
async function handleCarousel(to, payload) {
  const cards = payload.cards || [];
  if (cards.length === 0) return;

  console.log(`🎠 Processing carousel with ${cards.length} cards`);

  // Send carousel title if available
  if (payload.title) {
    await sendWhatsAppText(to, `*${payload.title}*`);
    await delay(500);
  }

  if (cards.length === 1) {
    // Single card - send as image with text
    const card = cards[0];
    
    if (card.imageUrl) {
      const caption = card.title + (card.description ?
