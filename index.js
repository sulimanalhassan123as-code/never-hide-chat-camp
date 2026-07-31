// Never Hide Chat Camp v2.0 — Telegram-integrated live chat
const express = require('express');
const http = require('http');
const app = express();
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, { maxHttpBufferSize: 1e6 });
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Admin chat ID (Ghana Cyber) — set when he sends /start to the bot
let ADMIN_CHAT_ID = null;

// Active sessions: socket.id -> { name, joinedAt, lastMessageAt }
const sessions = {};

// Map: telegram_message_id -> socket.id (for routing replies)
const replyMap = {};

// Last active visitor (for when admin replies without context)
let lastVisitorSocketId = null;

// Message history (keep last 50 per session)
const messageHistory = {};

// ============ TELEGRAM ============
async function sendTelegram(chatId, text, replyToMessageId) {
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML'
  };
  if (replyToMessageId) body.reply_to_message_id = replyToMessageId;
  
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    return data;
  } catch (err) {
    console.error('Telegram send error:', err.message);
    return null;
  }
}

async function sendTelegramWithKeyboard(chatId, text) {
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ I'm online", callback_data: "admin_online" }
          ]]
        }
      })
    });
    const data = await res.json();
    return data;
  } catch (err) {
    console.error('Telegram keyboard send error:', err.message);
    return null;
  }
}

// Telegram webhook endpoint
app.use(express.json());

app.post('/webhook', (req, res) => {
  const update = req.body;
  
  // Handle callback queries (button presses)
  if (update.callback_query) {
    const callback = update.callback_query;
    if (callback.data === 'admin_online' && ADMIN_CHAT_ID) {
      sendTelegram(ADMIN_CHAT_ID, "✅ You're now connected! When someone sends a message on the website, you'll get a notification here. Just reply to any message and it will go back to them.");
    }
    // Answer the callback
    fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callback.id })
    }).catch(() => {});
    return res.json({ ok: true });
  }
  
  if (!update.message) return res.json({ ok: true });
  
  const msg = update.message;
  const chatId = msg.chat.id;
  const text = msg.text || '';
  
  // Set admin chat ID on /start
  if (text.startsWith('/start')) {
    ADMIN_CHAT_ID = chatId;
    sendTelegramWithKeyboard(chatId, 
      "🟢 <b>Never Hide Chat Camp — Admin Connected</b>\n\n" +
      "Welcome, Ghana Cyber!\n\n" +
      "This bot is now linked to your chat website. When visitors send messages on the website, they'll appear here.\n\n" +
      "To reply to a visitor:\n" +
      "• Just reply to their forwarded message, OR\n" +
      "• Send any message and it goes to the last person who messaged\n\n" +
      "Tap the button below to confirm you're online 👇"
    );
    console.log(`Admin chat ID set: ${chatId}`);
    return res.json({ ok: true });
  }
  
  // If admin sends a message (reply to a visitor)
  if (ADMIN_CHAT_ID && chatId === ADMIN_CHAT_ID) {
    let targetSocketId = null;
    
    // Check if this is a reply to a forwarded message
    if (msg.reply_to_message) {
      const replyToId = msg.reply_to_message.message_id;
      targetSocketId = replyMap[replyToId];
    }
    
    // If no reply context, use last active visitor
    if (!targetSocketId && lastVisitorSocketId && io.sockets.sockets.get(lastVisitorSocketId)) {
      targetSocketId = lastVisitorSocketId;
    }
    
    if (targetSocketId && io.sockets.sockets.get(targetSocketId)) {
      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
      io.to(targetSocketId).emit('admin reply', {
        message: text,
        time: timestamp
      });
      
      // Store in history
      if (!messageHistory[targetSocketId]) messageHistory[targetSocketId] = [];
      messageHistory[targetSocketId].push({ from: 'admin', message: text, time: timestamp });
      
      sendTelegram(chatId, "✅ Sent to visitor");
    } else {
      sendTelegram(chatId, "⚠️ No active visitor to reply to. They may have left the chat.");
    }
    
    return res.json({ ok: true });
  }
  
  // If someone else messages the bot, tell them to use the website
  if (!ADMIN_CHAT_ID || chatId !== ADMIN_CHAT_ID) {
    sendTelegram(chatId, "👋 Hi! I'm Ghana Cyber's assistant bot. To chat with Ghana Cyber, please visit: https://never-hide-chat-camp.onrender.com");
    return res.json({ ok: true });
  }
  
  res.json({ ok: true });
});

// ============ SERVE STATIC FILES ============
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// ============ SOCKET.IO ============
io.on('connection', (socket) => {
  console.log(`New connection: ${socket.id}`);
  
  socket.on('visitor join', (data) => {
    const name = (data && data.name) ? data.name.trim().substring(0, 30) : 'Guest';
    sessions[socket.id] = { name, joinedAt: Date.now(), lastMessageAt: null };
    messageHistory[socket.id] = [];
    
    // Send welcome message to visitor
    socket.emit('chat message', {
      from: 'system',
      message: `Welcome, ${name}! 👋 You're now connected to Ghana Cyber. Send a message and he'll get it on Telegram instantly.`,
      time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' })
    });
    
    // Notify admin on Telegram
    if (ADMIN_CHAT_ID) {
      sendTelegram(ADMIN_CHAT_ID, 
        `🟢 <b>New Visitor Online</b>\n\n` +
        `👤 <b>Name:</b> ${name}\n` +
        `🕐 <b>Time:</b> ${new Date().toLocaleString('en-US', { timeZone: 'Africa/Accra' })}\n` +
        `🔗 <b>Session:</b> ${socket.id.substring(0, 8)}`
      );
    }
    
    console.log(`Visitor joined: ${name} (${socket.id})`);
  });
  
  socket.on('chat message', (data) => {
    if (!sessions[socket.id]) return;
    
    const name = sessions[socket.id].name;
    const message = (data.message || '').trim().substring(0, 1000);
    if (!message) return;
    
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    sessions[socket.id].lastMessageAt = Date.now();
    lastVisitorSocketId = socket.id;
    
    // Store in history
    if (!messageHistory[socket.id]) messageHistory[socket.id] = [];
    messageHistory[socket.id].push({ from: 'visitor', name, message, time: timestamp });
    
    // Echo back to visitor
    socket.emit('chat message', {
      from: 'me',
      message: message,
      time: timestamp
    });
    
    // Forward to admin on Telegram
    if (ADMIN_CHAT_ID) {
      const telegramText = `💬 <b>New message from ${name}</b>\n\n${message}\n\n<i>Reply to this message to respond to ${name}</i>`;
      sendTelegram(ADMIN_CHAT_ID, telegramText).then(result => {
        if (result && result.ok && result.result && result.result.message_id) {
          replyMap[result.result.message_id] = socket.id;
        }
      });
    }
    
    console.log(`Message from ${name}: ${message.substring(0, 50)}...`);
  });
  
  socket.on('typing', () => {
    if (sessions[socket.id]) {
      socket.emit('admin typing'); // Not used yet but ready
    }
  });
  
  socket.on('disconnect', () => {
    if (sessions[socket.id]) {
      const name = sessions[socket.id].name;
      const duration = Math.round((Date.now() - sessions[socket.id].joinedAt) / 1000);
      
      if (ADMIN_CHAT_ID) {
        sendTelegram(ADMIN_CHAT_ID, 
          `🔴 <b>Visitor Left</b>\n\n👤 ${name} has left the chat.\n⏱️ Session duration: ${duration}s`
        );
      }
      
      delete sessions[socket.id];
      delete messageHistory[socket.id];
      if (lastVisitorSocketId === socket.id) lastVisitorSocketId = null;
      
      console.log(`Visitor left: ${name}`);
    }
  });
});

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '2.0.0',
    adminConnected: ADMIN_CHAT_ID !== null,
    activeVisitors: Object.keys(sessions).length
  });
});

// ============ STARTUP ============
server.listen(PORT, () => {
  console.log(`🚀 Never Hide Chat Camp v2.0 running on port ${PORT}`);
  
  // Set webhook on startup
  if (BOT_TOKEN) {
    const webhookUrl = `https://never-hide-chat-camp.onrender.com/webhook`;
    fetch(`${TELEGRAM_API}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ['message', 'callback_query']
      })
    })
    .then(r => r.json())
    .then(data => console.log('Telegram webhook set:', JSON.stringify(data)))
    .catch(err => console.error('Webhook setup error:', err.message));
  }
});
