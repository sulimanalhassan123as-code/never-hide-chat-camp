// Never Hide Chat Camp v3.2.1 — Long Polling Mode
const express = require('express');
const http = require('http');
const app = express();
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, { maxHttpBufferSize: 2e6, pingTimeout: 60000 });
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.CHAT_BOT_TOKEN || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions';

let ADMIN_CHAT_ID = null;
let aiMode = false;
let aiPersonality = `You are the assistant for "Never Hide Chat Camp", a premium live chat platform run by Ghana Cyber. You are friendly, warm, and casual. You greet people, answer questions about the platform, keep conversations going, and represent Ghana Cyber when he's away. Keep replies short (1-3 sentences), use occasional emojis, and be engaging. If someone asks something you don't know, say Ghana Cyber will get back to them soon.`;

const aiConversations = {};
const MAX_AI_HISTORY = 10;
const rooms = {};
const pendingRequests = {};
const sessions = {};
const pendingActions = {};
let requestCounter = 0;
const bannedNames = new Set();
let lastUpdateId = 0;

const defaultRooms = [
  { id: 'general', name: '🌍 General Chat', description: 'Open chat for everyone — say hi!', createdBy: 'Ghana Cyber' },
  { id: 'tech', name: '💻 Tech & Coding', description: 'Technology, programming, cyber talk', createdBy: 'Ghana Cyber' },
  { id: 'ghana', name: '🇬🇭 Ghana Talk', description: 'All things Ghana — news, culture, vibes', createdBy: 'Ghana Cyber' },
];
defaultRooms.forEach(r => { rooms[r.id] = { ...r, approved: true, memberCount: 0, createdAt: Date.now(), members: {} }; });

// ===== TG HELPERS =====
async function tgSend(chatId, text, extra = {}) {
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra })
    });
    const data = await res.json();
    if (!data.ok) console.error('TG send failed:', data.description, '| chatId:', chatId);
    return data;
  } catch (e) { console.error('TG send error:', e.message); return null; }
}

async function tgAnswer(callbackQueryId, text = '') {
  try {
    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text })
    });
  } catch (e) {}
}

async function tgEdit(chatId, messageId, text) {
  try {
    await fetch(`${TELEGRAM_API}/editMessageText`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' })
    });
  } catch (e) {}
}

// ===== GROQ AI =====
async function getAIReply(roomName, senderName, message) {
  if (!GROQ_API_KEY) return "I'd love to chat but my AI brain isn't configured. Ghana Cyber will be back! 🔧";
  if (!aiConversations[roomName]) aiConversations[roomName] = [];
  const history = aiConversations[roomName];
  history.push({ role: 'user', content: `${senderName}: ${message}` });
  while (history.length > MAX_AI_HISTORY * 2) history.shift();

  const messages = [
    { role: 'system', content: aiPersonality + ` You are in room "${roomName}". Reply naturally.` },
    ...history.map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content }))
  ];

  try {
    const res = await fetch(GROQ_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, max_tokens: 150, temperature: 0.8 })
    });
    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || "Hmm, tell me more! 😊";
    history.push({ role: 'assistant', content: reply });
    while (history.length > MAX_AI_HISTORY * 2) history.shift();
    return reply;
  } catch (e) {
    console.error('Groq error:', e.message);
    return "I'm having trouble right now. Ghana Cyber will be back! 🧠";
  }
}

// ===== LONG POLLING =====
async function pollTelegram() {
  console.log('📡 Starting Telegram long polling...');
  
  // Delete webhook first
  try {
    const dwRes = await fetch(`${TELEGRAM_API}/deleteWebhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const dwData = await dwRes.json();
    console.log('Webhook deleted:', dwData.description || 'OK');
  } catch (e) { console.error('Delete webhook error:', e.message); }

  while (true) {
    try {
      const res = await fetch(`${TELEGRAM_API}/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offset: lastUpdateId + 1,
          timeout: 30,
          allowed_updates: ['message', 'callback_query']
        })
      });
      const data = await res.json();

      if (!data.ok) {
        console.error('Polling error:', data.description);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      const updates = data.result || [];
      if (updates.length > 0) console.log(`Received ${updates.length} update(s)`);
      
      for (const update of updates) {
        if (update.update_id >= lastUpdateId) lastUpdateId = update.update_id;
        try {
          await handleUpdate(update);
        } catch (e) {
          console.error('Handle update error:', e.message, e.stack);
        }
      }
    } catch (e) {
      console.error('Poll fetch error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function handleUpdate(update) {
  // Callback query
  if (update.callback_query) {
    const cb = update.callback_query;
    const data = cb.data || '';
    const msgId = cb.message ? cb.message.message_id : null;
    await tgAnswer(cb.id);

    if (data.startsWith('approve_')) {
      const reqId = data.replace('approve_', '');
      const pending = pendingRequests[reqId];
      if (pending) {
        rooms[reqId] = { id: reqId, name: pending.name, description: pending.description, createdBy: pending.requestedBy, approved: true, memberCount: 0, createdAt: Date.now(), members: {} };
        delete pendingRequests[reqId];
        const sock = io.sockets.sockets.get(pending.socketId);
        if (sock) sock.emit('room approved', { roomId: reqId, name: pending.name });
        io.emit('room list update', getRoomList());
        await tgEdit(ADMIN_CHAT_ID, msgId, `✅ <b>Room Approved!</b>\n\n<b>${pending.name}</b>\nBy: ${pending.requestedBy}`);
      }
    } else if (data.startsWith('reject_')) {
      const reqId = data.replace('reject_', '');
      const pending = pendingRequests[reqId];
      if (pending) {
        const sock = io.sockets.sockets.get(pending.socketId);
        if (sock) sock.emit('room rejected', { name: pending.name });
        delete pendingRequests[reqId];
        await tgEdit(ADMIN_CHAT_ID, msgId, `❌ <b>Room Rejected</b>\n\n<b>${pending.name}</b>`);
      }
    } else if (data.startsWith('kick_')) {
      const name = data.replace('kick_', '');
      for (const [sid, sess] of Object.entries(sessions)) {
        if (sess.name === name) { const s = io.sockets.sockets.get(sid); if (s) { s.emit('kicked', { reason: 'Removed by admin' }); s.disconnect(true); } }
      }
      bannedNames.add(name);
      await tgEdit(ADMIN_CHAT_ID, msgId, `👢 <b>${name}</b> kicked & banned.`);
    } else if (data.startsWith('close_')) {
      const roomId = data.replace('close_', '');
      if (rooms[roomId]) {
        io.to(roomId).emit('system msg', { text: '⚠️ Room closed.' });
        io.in(roomId).socketsLeave(roomId);
        delete rooms[roomId];
        io.emit('room list update', getRoomList());
        await tgEdit(ADMIN_CHAT_ID, msgId, `🔒 <b>Room closed.</b>`);
      }
    }
    return;
  }

  if (!update.message) return;
  const msg = update.message;
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const isAdmin = ADMIN_CHAT_ID && String(chatId) === String(ADMIN_CHAT_ID);

  console.log(`Message from ${msg.from?.first_name} (id:${chatId}): ${text}`);

  if (text.startsWith('/start')) {
    ADMIN_CHAT_ID = chatId;
    console.log(`✅ Admin registered: ${chatId}`);
    await sendAdminMenu(chatId);
    return;
  }

  if (!ADMIN_CHAT_ID) { ADMIN_CHAT_ID = chatId; console.log(`Auto admin: ${chatId}`); await sendAdminMenu(chatId); return; }

  if (text === '/help' && isAdmin) {
    await tgSend(chatId,
      `<b>📖 Full Command List</b>\n\n` +
      `<b>📋 Rooms</b>\n/rooms — List all rooms\n/visitors — Who's online\n/close — Close a room\n\n` +
      `<b>🤖 AI Auto-Reply</b>\n/aichat on — Activate AI\n/aichat off — Turn off AI\n/aichat status — Check status\n/aichat personality [text] — Set personality\n/aichat reset — Clear memory\n\n` +
      `<b>💬 Messaging</b>\n/broadcast [msg] — Send to all\nReply to msg — Reply to room\n(Plain text) — All rooms\n\n` +
      `<b>👥 Users</b>\n/kick — Kick & ban\n/unban [name] — Unban\n\n` +
      `<b>📊 Stats</b>\n/stats — Statistics\n/status — Health\n/menu — Quick menu`);
    return;
  }

  if (text === '/menu' && isAdmin) { await sendAdminMenu(chatId); return; }

  if (text.startsWith('/rooms') && isAdmin) {
    const list = Object.values(rooms).map(r => `• <b>${r.name}</b> — ${r.memberCount} online\n  ${r.description}`).join('\n\n');
    await tgSend(chatId, `<b>📋 Rooms (${Object.keys(rooms).length})</b>\n\n${list || 'None.'}`);
    return;
  }

  if (text.startsWith('/visitors') && isAdmin) {
    const vis = Object.entries(sessions).map(([sid, s]) => { const rm = s.roomId ? (rooms[s.roomId]?.name || '?') : 'Lobby'; return `• <b>${s.name}</b> — ${rm}`; });
    await tgSend(chatId, `<b>👥 Online (${vis.length})</b>\n\n${vis.join('\n') || 'No one online.'}`);
    return;
  }

  if (text.startsWith('/broadcast ') && isAdmin) {
    const m = text.replace('/broadcast ', '').trim();
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    io.emit('admin broadcast', { message: m, time: ts });
    await tgSend(chatId, `✅ Sent to ${Object.keys(sessions).length} visitor(s).`);
    return;
  }

  if (text.startsWith('/aichat') && isAdmin) {
    const parts = text.split(' '); const sub = parts[1] || '';
    if (sub === 'on') {
      aiMode = true;
      await tgSend(chatId, `🤖 <b>AI Auto-Reply ON!</b>\n\nBot will auto-reply to visitors.\n\nPersonality: <i>${aiPersonality.substring(0, 80)}...</i>`);
      io.emit('system msg', { text: '🤖 AI Assistant activated!' });
    } else if (sub === 'off') {
      aiMode = false;
      await tgSend(chatId, `🔴 <b>AI OFF.</b>`);
      io.emit('system msg', { text: '💤 AI off. Ghana Cyber is back.' });
    } else if (sub === 'status') {
      await tgSend(chatId, `🤖 AI: ${aiMode ? '🟢 ON' : '🔴 OFF'}\nModel: Llama 3.3 70B\nMemories: ${Object.keys(aiConversations).length} room(s)`);
    } else if (sub === 'personality') {
      const np = text.replace('/aichat personality', '').trim();
      if (np) { aiPersonality = np; Object.keys(aiConversations).forEach(k => delete aiConversations[k]); await tgSend(chatId, `✅ Updated!\n\n<i>${aiPersonality}</i>`); }
      else { await tgSend(chatId, `Current:\n\n<i>${aiPersonality}</i>`); }
    } else if (sub === 'reset') {
      Object.keys(aiConversations).forEach(k => delete aiConversations[k]);
      await tgSend(chatId, `🧹 Memory cleared.`);
    } else {
      await tgSend(chatId, `🤖 AI: ${aiMode ? '🟢 ON' : '🔴 OFF'}\n\n/aichat on | off | status | personality [text] | reset`);
    }
    return;
  }

  if (text === '/kick' && isAdmin) {
    const names = [...new Set(Object.values(sessions).map(s => s.name))];
    if (!names.length) { await tgSend(chatId, `No visitors online.`); return; }
    await tgSend(chatId, `<b>Kick who?</b>`, { reply_markup: { inline_keyboard: names.map(n => [{ text: `👢 ${n}`, callback_data: `kick_${n}` }]) } });
    return;
  }

  if (text.startsWith('/unban ') && isAdmin) {
    const name = text.replace('/unban ', '').trim();
    if (bannedNames.has(name)) { bannedNames.delete(name); await tgSend(chatId, `✅ ${name} unbanned.`); } else { await tgSend(chatId, `${name} not banned.`); }
    return;
  }

  if (text === '/close' && isAdmin) {
    const rl = Object.values(rooms).filter(r => r.approved);
    if (!rl.length) { await tgSend(chatId, `No rooms.`); return; }
    await tgSend(chatId, `<b>Close which?</b>`, { reply_markup: { inline_keyboard: rl.map(r => [{ text: `🔒 ${r.name}`, callback_data: `close_${r.id}` }]) } });
    return;
  }

  if (text === '/stats' && isAdmin) {
    await tgSend(chatId, `<b>📊 Stats</b>\n\nRooms: ${Object.keys(rooms).length}\nVisitors: ${Object.keys(sessions).length}\nPending: ${Object.keys(pendingRequests).length}\nBanned: ${bannedNames.size}\nAI: ${aiMode ? '🟢 ON' : '🔴 OFF'}`);
    return;
  }

  if (text === '/status' && isAdmin) {
    await tgSend(chatId, `🟢 <b>System OK</b>\n\nv3.2.1 | Bot: @Neverhidechatcampbot\nAI: ${aiMode ? 'Active' : 'Standby'}\nVisitors: ${Object.keys(sessions).length}\nRooms: ${Object.keys(rooms).length}`);
    return;
  }

  if (isAdmin && text && !text.startsWith('/')) {
    let targetRoomId = null;
    if (msg.reply_to_message) { const rid = msg.reply_to_message.message_id; if (pendingActions[rid]) targetRoomId = pendingActions[rid].roomId; }
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    if (!targetRoomId) { Object.keys(rooms).forEach(rid => io.to(rid).emit('admin message', { message: text, time: ts })); await tgSend(chatId, `✅ Sent to all rooms.`); }
    else { io.to(targetRoomId).emit('admin message', { message: text, time: ts }); await tgSend(chatId, `✅ Sent to ${rooms[targetRoomId]?.name}.`); }
  }
}

async function sendAdminMenu(chatId) {
  await tgSend(chatId,
    `🟢 <b>Never Hide Chat Camp — Admin Panel</b>\n\n` +
    `Rooms: ${Object.keys(rooms).length} | Visitors: ${Object.keys(sessions).length} | AI: ${aiMode ? '🟢 ON' : '🔴 OFF'}\n\n` +
    `<b>Commands:</b>\n/menu /help /rooms /visitors\n/aichat on /aichat off /aichat status\n/broadcast [msg] /kick /close\n/stats /status`,
    { reply_markup: { keyboard: [[{ text: '/rooms' }, { text: '/visitors' }, { text: '/stats' }], [{ text: '/aichat on' }, { text: '/aichat off' }, { text: '/aichat status' }], [{ text: '/help' }, { text: '/menu' }]], resize_keyboard: true } });
}

// ===== EXPRESS =====
app.use(express.json());
app.use(express.static('public'));
app.post('/webhook', async (req, res) => { try { await handleUpdate(req.body); } catch(e) {} res.json({ ok: true }); });
app.get('/health', (req, res) => res.json({ status: 'ok', version: '3.2.1', rooms: Object.keys(rooms).length, visitors: Object.keys(sessions).length, aiMode, adminConnected: !!ADMIN_CHAT_ID, polling: 'active' }));
app.get('/api/rooms', (req, res) => res.json(getRoomList()));
app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

function getRoomList() { return Object.values(rooms).filter(r => r.approved).map(r => ({ id: r.id, name: r.name, description: r.description, createdBy: r.createdBy, memberCount: r.memberCount })); }

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
  socket.emit('room list', getRoomList());

  socket.on('set name', ({ name }) => {
    const n = (name || 'Guest').trim().substring(0, 30);
    if (bannedNames.has(n)) { socket.emit('kicked', { reason: 'Banned.' }); socket.disconnect(true); return; }
    sessions[socket.id] = { name: n, roomId: null };
    socket.emit('name set', { name: n });
    if (ADMIN_CHAT_ID) tgSend(ADMIN_CHAT_ID, `👤 <b>${n}</b> joined the lobby.`);
  });

  socket.on('join room', ({ roomId }) => {
    if (!sessions[socket.id]) return;
    if (!rooms[roomId] || !rooms[roomId].approved) { socket.emit('error msg', 'Room not found.'); return; }
    const name = sessions[socket.id].name;
    const oldRoom = sessions[socket.id].roomId;
    if (oldRoom) { socket.leave(oldRoom); if (rooms[oldRoom]) { delete rooms[oldRoom].members[socket.id]; rooms[oldRoom].memberCount = Object.keys(rooms[oldRoom].members).length; io.to(oldRoom).emit('system msg', { text: `${name} left.` }); io.to(oldRoom).emit('member count', { count: rooms[oldRoom].memberCount }); } }
    socket.join(roomId); sessions[socket.id].roomId = roomId; rooms[roomId].members[socket.id] = name; rooms[roomId].memberCount = Object.keys(rooms[roomId].members).length;
    socket.emit('joined room', { roomId, name: rooms[roomId].name, description: rooms[roomId].description });
    io.to(roomId).emit('system msg', { text: `${name} joined. 👋` });
    io.to(roomId).emit('member count', { count: rooms[roomId].memberCount });
    io.emit('room list update', getRoomList());
    if (ADMIN_CHAT_ID) tgSend(ADMIN_CHAT_ID, `🚪 <b>${name}</b> joined <b>${rooms[roomId].name}</b>`);
    if (aiMode && GROQ_API_KEY) { setTimeout(async () => { const r = await getAIReply(rooms[roomId].name, 'System', `${name} just joined. Greet them warmly.`); io.to(roomId).emit('admin message', { message: r, time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }) }); }, 1500); }
  });

  socket.on('request room', ({ name, description }) => {
    if (!sessions[socket.id]) return;
    const requester = sessions[socket.id].name;
    const roomName = (name || '').trim().substring(0, 50);
    const roomDesc = (description || '').trim().substring(0, 120);
    if (!roomName) return;
    const reqId = 'req_' + Date.now() + '_' + (++requestCounter);
    pendingRequests[reqId] = { name: roomName, description: roomDesc || 'No description', requestedBy: requester, socketId: socket.id, timestamp: Date.now() };
    socket.emit('request sent', { name: roomName });
    if (ADMIN_CHAT_ID) { tgSend(ADMIN_CHAT_ID, `📋 <b>New Room Request</b>\n\n<b>Name:</b> ${roomName}\n<b>Desc:</b> ${roomDesc || 'None'}\n<b>By:</b> ${requester}`, { reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${reqId}` }, { text: '❌ Reject', callback_data: `reject_${reqId}` }]] } }).then(result => { if (result?.ok && result.result) pendingActions[result.result.message_id] = { type: 'room_request', reqId }; }); }
    else { socket.emit('error msg', 'Admin not connected.'); delete pendingRequests[reqId]; }
  });

  socket.on('chat message', async ({ message }) => {
    if (!sessions[socket.id]) return;
    const { name, roomId } = sessions[socket.id];
    if (!roomId || !rooms[roomId]) return;
    const msg = (message || '').trim().substring(0, 1000);
    if (!msg) return;
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    io.to(roomId).emit('chat message', { name, message: msg, time: ts, socketId: socket.id });
    if (ADMIN_CHAT_ID) { tgSend(ADMIN_CHAT_ID, `💬 [<b>${rooms[roomId].name}</b>] <b>${name}:</b> ${msg}`).then(result => { if (result?.ok && result.result) pendingActions[result.result.message_id] = { roomId }; }); }
    if (aiMode && GROQ_API_KEY) { setTimeout(async () => { try { const r = await getAIReply(rooms[roomId].name, name, msg); io.to(roomId).emit('admin message', { message: r, time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }) }); if (ADMIN_CHAT_ID) tgSend(ADMIN_CHAT_ID, `🤖 [<b>${rooms[roomId].name}</b>] <b>AI:</b> ${r}`); } catch (e) {} }, 800); }
  });

  socket.on('typing', () => { if (sessions[socket.id]) { const { name, roomId } = sessions[socket.id]; if (roomId) socket.to(roomId).emit('typing', { name }); } });
  socket.on('stop typing', () => { if (sessions[socket.id]) { const { roomId } = sessions[socket.id]; if (roomId) socket.to(roomId).emit('stop typing'); } });

  socket.on('disconnect', () => {
    if (sessions[socket.id]) { const { name, roomId } = sessions[socket.id]; if (roomId && rooms[roomId]) { delete rooms[roomId].members[socket.id]; rooms[roomId].memberCount = Object.keys(rooms[roomId].members).length; io.to(roomId).emit('system msg', { text: `${name} left.` }); io.to(roomId).emit('member count', { count: rooms[roomId].memberCount }); io.emit('room list update', getRoomList()); } delete sessions[socket.id]; }
  });
});


// ===== DEBUG =====
app.get('/debug', async (req, res) => {
  const results = {
    node_version: process.version,
    fetch_available: typeof fetch !== 'undefined',
    bot_token: BOT_TOKEN ? 'SET (len: ' + BOT_TOKEN.length + ')' : 'NOT SET',
    groq_key: GROQ_API_KEY ? 'SET' : 'NOT SET',
    admin_chat_id: ADMIN_CHAT_ID,
    last_update_id: lastUpdateId,
    telegram_test: null
  };
  try {
    const tgRes = await fetch(TELEGRAM_API + '/getMe');
    const tgData = await tgRes.json();
    results.telegram_test = tgData.ok ? 'OK - @' + tgData.result.username : 'FAIL - ' + tgData.description;
  } catch (e) {
    results.telegram_test = 'ERROR: ' + e.message;
  }
  res.json(results);
});

// ===== START =====
server.listen(PORT, () => {
  console.log(`🚀 Never Hide Chat Camp v3.2.1 on port ${PORT}`);
  console.log(`Bot: ${BOT_TOKEN ? 'SET' : 'NOT SET'} | Groq: ${GROQ_API_KEY ? 'SET' : 'NOT SET'}`);
  if (BOT_TOKEN) {
    pollTelegram().catch(e => console.error('Polling crashed:', e.message));
  } else {
    console.error('❌ No BOT_TOKEN set!');
  }
});
