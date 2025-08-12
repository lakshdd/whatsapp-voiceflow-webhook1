const express = require('express');
const axios = require('axios');
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Environment variables with fallbacks
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'my_voiceflow_webhook_2024';
const VOICEFLOW_API_KEY = process.env.VOICEFLOW_API_KEY;
const VOICEFLOW_PROJECT_ID = process.env.VOICEFLOW_PROJECT_ID;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Validate environment variables
const requiredEnvVars = {
  WHATSAPP_TOKEN,
  VOICEFLOW_API_KEY,
  PHONE_NUMBER_ID
};

for (const [key, value] of Object.entries(requiredEnvVars)) {
  if (!value) {
    console.error(`❌ Missing required environment variable: ${key}`);
  }
}

// Health check endpoint
app.get('/', (req, res) => {
  const envCheck = {};
  Object.keys(requiredEnvVars).forEach(key => {
    envCheck[key] = !!process.env[key];
  });

  res.json({
    status: 'WhatsApp Voiceflow Webhook is running! 🚀',
    timestamp: new Date().toISOString(),
    environment: 'Vercel',
    environmentVariables: envCheck,
    version: '2.0'
  });
});

// Webhook verification endpoint
app.get('/webhook', (req, res) => {
  console.log('🔍 Webhook verification request:', req.query);
  
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
      console.log('✅ Webhook verified successfully!');
      res.status(200).send(challenge);
    } else {
      console.log('❌ Webhook verification failed - token mismatch');
      console.log(`Expected: ${WHATSAPP_VERIFY_TOKEN}, Received: ${token}`);
      res.sendStatus(403);
    }
  } else {
    console.log('❌ Missing verification parameters');
    res.sendStatus(400);
  }
});

// Handle incoming WhatsApp messages
app.post('/webhook', async (req, res) => {
  console.log('📨 Incoming webhook data:', JSON.stringify(req.body, null, 2));
  
  // Immediately respond to WhatsApp (prevents timeout)
  res.sendStatus(200);

  try {
    // Validate webhook data structure
    if (!req.body.entry || !Array.isArray(req.body.entry)) {
      console.log('⚠️ Invalid webhook structure');
      return;
    }

    // Process each entry
    for (const entry of req.body.entry) {
      if (!entry.changes || !Array.isArray(entry.changes)) continue;

      for (const change of entry.changes) {
        if (change.field === 'messages' && change.value.messages) {
          // Process messages asynchronously
          for (const message of change.value.messages) {
            // Use setImmediate to prevent blocking
            setImmediate(() => handleMessage(message, change.value));
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
  }
});

// Handle individual messages
async function handleMessage(message, messageData) {
  if (!message || !message.from) {
    console.log('⚠️ Invalid message structure');
    return;
  }

  const from = message.from;
  const messageId = message.id;
  const messageType = message.type;

  console.log(`📱 Processing message ${messageId} from ${from} (type: ${messageType})`);

  // Extract message text based on type
  let userInput = '';
  
  try {
    switch (messageType) {
      case 'text':
        userInput = message.text?.body || '';
        break;
      case 'interactive':
        if (message.interactive?.type === 'button_reply') {
          userInput = message.interactive.button_reply.title;
        } else if (message.interactive?.type === 'list_reply') {
          userInput = message.interactive.list_reply.title;
        }
        break;
      default:
        console.log(`⏭️ Skipping unsupported message type: ${messageType}`);
        return;
    }

    if (!userInput.trim()) {
      console.log('⏭️ Empty message, skipping');
      return;
    }

    console.log(`🤖 Processing input: "${userInput}"`);

    // Send to Voiceflow with retry logic
    const voiceflowResponse = await sendToVoiceflowWithRetry(from, userInput, 3);
    
    // Process response
    await processVoiceflowResponse(from, voiceflowResponse);

  } catch (error) {
    console.error(`❌ Error handling message ${messageId}:`, error);
    
    // Send user-friendly error message
    await sendWhatsAppTextSafe(from, "I'm having some technical difficulties right now. Please try again in a moment! 🤖");
  }
}

// Send to Voiceflow with retry logic
async function sendToVoiceflowWithRetry(userId, message, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🤖 Attempt ${attempt}: Sending to Voiceflow`);
      
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

      console.log(`✅ Voiceflow response received (${response.data?.length || 0} traces)`);
      return response.data || [];

    } catch (error) {
      console.error(`❌ Voiceflow attempt ${attempt} failed:`, error.response?.data || error.message);
      
      if (attempt === maxRetries) {
        throw new Error(`Voiceflow failed after ${maxRetries} attempts`);
      }
      
      // Wait before retry (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
}

// Process Voiceflow response
async function processVoiceflowResponse(to, traces) {
  if (!Array.isArray(traces) || traces.length === 0) {
    console.log('⚠️ No traces to process');
    await sendWhatsAppTextSafe(to, "I didn't understand that. Can you try rephrasing?");
    return;
  }

  console.log(`📤 Processing ${traces.length} traces`);

  for (let i = 0; i < traces.length; i++) {
    const trace = traces[i];
    
    try {
      console.log(`Processing trace ${i + 1}/${traces.length}: ${trace.type}`);

      switch (trace.type) {
        case 'text':
          if (trace.payload?.message) {
            await sendWhatsAppTextSafe(to, trace.payload.message);
          }
          break;

        case 'speak':
          if (trace.payload?.message) {
            await sendWhatsAppTextSafe(to, trace.payload.message);
          }
          break;

        case 'visual':
          if (trace.payload?.image) {
            await sendWhatsAppImageSafe(to, trace.payload.image, trace.payload.text);
          }
          break;

        case 'choice':
          if (trace.payload?.buttons && trace.payload.buttons.length > 0) {
            await handleChoiceButtons(to, trace.payload);
          }
          break;

        default:
          console.log(`⏭️ Skipping unsupported trace type: ${trace.type}`);
      }

      // Small delay between messages to prevent rate limiting
      if (i < traces.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }

    } catch (error) {
      console.error(`❌ Error processing trace ${i + 1}:`, error);
      // Continue with other traces
    }
  }
}

// Handle choice buttons
async function handleChoiceButtons(to, payload) {
  const buttons = payload.buttons || [];
  const messageText = payload.message || "Please choose an option:";

  console.log(`🔘 Handling ${buttons.length} choice buttons`);

  if (buttons.length === 0) return;

  if (buttons.length <= 3) {
    // Use WhatsApp interactive buttons (max 3)
    const interactiveButtons = buttons.slice(0, 3).map((button, index) => ({
      type: "reply",
      reply: {
        id: `btn_${index}_${Date.now()}`,
        title: (button.name || `Option ${index + 1}`).substring(0, 20)
      }
    }));

    await sendWhatsAppButtonsSafe(to, messageText, interactiveButtons);
  } else {
    // Convert to text with numbers for more than 3 options
    let textMessage = messageText + "\n\n";
    buttons.slice(0, 10).forEach((button, index) => {
      textMessage += `${index + 1}. ${button.name}\n`;
    });
    textMessage += "\nPlease reply with the number of your choice.";

    await sendWhatsAppTextSafe(to, textMessage);
  }
}

// Safe WhatsApp text sender with error handling
async function sendWhatsAppTextSafe(to, text, maxRetries = 2) {
  if (!text || !text.trim()) {
    console.log('⚠️ Empty text message, skipping');
    return;
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await axios.post(
        `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to: to,
          type: "text",
          text: { body: text.trim() }
        },
        {
          headers: {
            'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          },
          timeout: 15000
        }
      );

      console.log(`✅ Text message sent successfully (attempt ${attempt})`);
      return;

    } catch (error) {
      console.error(`❌ Text send attempt ${attempt} failed:`, error.response?.data || error.message);
      
      if (attempt === maxRetries) {
        console.error(`❌ Failed to send text after ${maxRetries} attempts`);
      } else {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
}

// Safe WhatsApp image sender
async function sendWhatsAppImageSafe(to, imageUrl, caption = '') {
  try {
    const payload = {
      messaging_product: "whatsapp",
      to: to,
      type: "image",
      image: { link: imageUrl }
    };

    if (caption && caption.trim()) {
      payload.image.caption = caption.trim();
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
    console.error('❌ Image send failed:', error.response?.data || error.message);
    // Fallback to text message
    await sendWhatsAppTextSafe(to, caption || 'Image not available');
  }
}

// Safe WhatsApp buttons sender
async function sendWhatsAppButtonsSafe(to, text, buttons) {
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
        timeout: 15000
      }
    );

    console.log('✅ Button message sent successfully');

  } catch (error) {
    console.error('❌ Button send failed:', error.response?.data || error.message);
    
    // Fallback to numbered text options
    let fallbackText = text + "\n\n";
    buttons.forEach((button, index) => {
      fallbackText += `${index + 1}. ${button.reply.title}\n`;
    });
    fallbackText += "\nPlease reply with the number of your choice.";
    
    await sendWhatsAppTextSafe(to, fallbackText);
  }
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Export for Vercel
module.exports = app;

// Local development server (won't run on Vercel)
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log('📱 WhatsApp Voiceflow Webhook ready!');
    console.log(`🔗 Webhook URL: http://localhost:${PORT}/webhook`);
  });
}
