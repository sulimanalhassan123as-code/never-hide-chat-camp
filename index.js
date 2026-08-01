// Never Hide Chat Camp v3.3 — Human-like AI friend "Camp"
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

let ADMIN_CHAT_ID = 8361316663;
let aiMode = false;
let aiPersonality = "You are a friend hanging out in the Never Hide Chat Camp, a chat platform by Ghana Cyber. You're NOT an AI or a bot to the users, you're just one of the guys. You talk like a real Ghanaian youth - casual, warm, use small slang sometimes (like chale, boss, I dey), keep it natural. Your replies are short (1-2 sentences mostly), you ask questions back, use lowercase a lot, throw in an emoji occasionally. You vibe with people, joke around, share opinions. If someone asks something you don't know, say you'll check and get back. NEVER say you're an AI, never say you're a bot, never use formal language. You're just a friend in the chat.";

const aiConversations = {};
const MAX_AI_HISTORY = 12;
const rooms = {};
const pendingRequests = {};
const sessions = {};
const pendingActions = {};
let requestCounter = 0;
const bannedNames = new Set();
let lastUpdateId = 0;
const roomLastActivity = {};
const INACTIVE_THRESHOLD = 45000;
const aiTypingRooms = new Set();

const defaultRooms = [
  { id: 'general', name: '🌍 General Chat', description: 'Open chat for everyone — say hi!', createdBy: 'Ghana Cyber' },
  { id: 'tech', name: '💻 Tech & Coding', description: 'Technology, programming, cyber talk', createdBy: 'Ghana Cyber' },
  { id: 'ghana', name: '🇬🇭 Ghana Talk', description: 'All things Ghana — news, culture, vibes', createdBy: 'Ghana Cyber' },
];
defaultRooms.forEach(r => { rooms[r.id] = { ...r, approved: true, memberCount: 0, createdAt: Date.now(), members: {} }; });

// ===== TG HELPERS =====
async function tgSend(chatId, text, extra = {}) {
  try {
    const res = await fetch(TELEGRAM_API + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra })
    });
    return await res.json();
  } catch (e) { console.error('TG send error:', e.message); return null; }
}

async function tgAnswer(callbackQueryId, text) {
  try { await fetch(TELEGRAM_API + '/answerCallbackQuery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: callbackQueryId, text: text || '' }) }); } catch (e) {}
}

async function tgEdit(chatId, messageId, text) {
  try { await fetch(TELEGRAM_API + '/editMessageText', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' }) }); } catch (e) {}
}

// ===== GROQ AI =====
async function getAIReply(roomName, senderName, message) {
  if (!GROQ_API_KEY) return null;
  if (!aiConversations[roomName]) aiConversations[roomName] = [];
  const history = aiConversations[roomName];
  history.push({ role: 'user', content: senderName + ': ' + message });
  while (history.length > MAX_AI_HISTORY * 2) history.shift();

  const messages = [
    { role: 'system', content: aiPersonality + ' You are in the room "' + roomName + '". Reply naturally as a friend.' },
    ...history.map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content }))
  ];

  try {
    const res = await fetch(GROQ_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_API_KEY },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, max_tokens: 120, temperature: 0.9 })
    });
    const data = await res.json();
    let reply = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content.trim() : null;
    if (!reply) return null;
    reply = reply.replace(/^(as an ai|i am an ai|i'm an ai|as a bot|i cannot|i can't help with)/i, '').trim();
    history.push({ role: 'assistant', content: reply });
    while (history.length > MAX_AI_HISTORY * 2) history.shift();
    return reply;
  } catch (e) {
    console.error('Groq error:', e.message);
    return null;
  }
}

function getTypingDelay(message) {
  const base = 1000 + Math.random() * 1000;
  const charDelay = Math.min(message.length * 50, 4000);
  return Math.min(base + charDelay, 6000);
}

function isMentioned(msg) {
  const l = msg.toLowerCase();
  return l.includes('@bot') || l.includes('@camp') || l.includes('@assistant') || l.includes('@ghana') || l.includes('@admin') || l.includes('hey camp') || l.includes('camp bot') || l.includes('camp assistant');
}

async function sendAIReply(roomId, senderName, message) {
  const roomName = rooms[roomId] ? rooms[roomId].name : null;
  if (!roomName || aiTypingRooms.has(roomId)) return;
  aiTypingRooms.add(roomId);
  io.to(roomId).emit('bot typing', { name: 'Camp' });

  const aiReply = await getAIReply(roomName, senderName, message);
  if (!aiReply) { aiTypingRooms.delete(roomId); io.to(roomId).emit('bot stop typing'); return; }

  const delay = getTypingDelay(aiReply);
  await new Promise(r => setTimeout(r, delay));

  io.to(roomId).emit('bot stop typing');
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
  io.to(roomId).emit('bot message', { message: aiReply, time: ts });

  if (ADMIN_CHAT_ID) tgSend(ADMIN_CHAT_ID, '🤖 [<b>' + roomName + '</b>] <b>Camp:</b> ' + aiReply);
  roomLastActivity[roomId] = Date.now();
  aiTypingRooms.delete(roomId);
}

// ===== LONG POLLING =====
async function pollTelegram() {
  console.log('📡 Telegram polling started...');
  try { await fetch(TELEGRAM_API + '/deleteWebhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) {}
  while (true) {
    try {
      const res = await fetch(TELEGRAM_API + '/getUpdates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset: lastUpdateId + 1, timeout: 30, allowed_updates: ['message', 'callback_query'] })
      });
      const data = await res.json();
      if (!data.ok) { console.error('Poll error:', data.description); await new Promise(r => setTimeout(r, 3000)); continue; }
      for (const update of data.result || []) {
        if (update.update_id >= lastUpdateId) lastUpdateId = update.update_id;
        try { await handleUpdate(update); } catch (e) { console.error('Handle error:', e.message); }
      }
    } catch (e) { console.error('Poll fetch error:', e.message); await new Promise(r => setTimeout(r, 5000)); }
  }
}

async function handleUpdate(update) {
  if (update.callback_query) {
    const cb = update.callback_query;
    const data = cb.data || '';
    const msgId = cb.message ? cb.message.message_id : null;
    await tgAnswer(cb.id);

    if (data.startsWith('approve_')) {
      const reqId = data.replace('approve_', '');
      const p = pendingRequests[reqId];
      if (p) {
        rooms[reqId] = { id: reqId, name: p.name, description: p.description, createdBy: p.requestedBy, approved: true, memberCount: 0, createdAt: Date.now(), members: {} };
        delete pendingRequests[reqId];
        const s = io.sockets.sockets.get(p.socketId);
        if (s) s.emit('room approved', { roomId: reqId, name: p.name });
        io.emit('room list update', getRoomList());
        await tgEdit(ADMIN_CHAT_ID, msgId, '✅ <b>Approved!</b>\n\n<b>' + p.name + '</b>\nBy: ' + p.requestedBy);
      }
    } else if (data.startsWith('reject_')) {
      const reqId = data.replace('reject_', '');
      const p = pendingRequests[reqId];
      if (p) {
        const s = io.sockets.sockets.get(p.socketId);
        if (s) s.emit('room rejected', { name: p.name });
        delete pendingRequests[reqId];
        await tgEdit(ADMIN_CHAT_ID, msgId, '❌ <b>Rejected</b>\n\n<b>' + p.name + '</b>');
      }
    } else if (data.startsWith('kick_')) {
      const n = data.replace('kick_', '');
      for (const [sid, sess] of Object.entries(sessions)) {
        if (sess.name === n) {
          const s = io.sockets.sockets.get(sid);
          if (s) { s.emit('kicked', { reason: 'Removed by admin' }); s.disconnect(true); }
        }
      }
      bannedNames.add(n);
      await tgEdit(ADMIN_CHAT_ID, msgId, '👢 <b>' + n + '</b> kicked & banned.');
    } else if (data.startsWith('close_')) {
      const rid = data.replace('close_', '');
      if (rooms[rid]) {
        io.to(rid).emit('system msg', { text: '⚠️ Room closed.' });
        io.in(rid).socketsLeave(rid);
        delete rooms[rid];
        io.emit('room list update', getRoomList());
        await tgEdit(ADMIN_CHAT_ID, msgId, '🔒 <b>Room closed.</b>');
      }
    }
    return;
  }

  if (!update.message) return;
  const msg = update.message;
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const OWNER_ID = 8361316663;

  if (chatId !== OWNER_ID) {
    await tgSend(chatId, '🔒 This bot is private. Only the owner can use it.');
    return;
  }

  const isAdmin = String(chatId) === String(ADMIN_CHAT_ID);

  if (text.startsWith('/start')) { ADMIN_CHAT_ID = chatId; await sendAdminMenu(chatId); return; }
  if (text === '/help' && isAdmin) { await tgSend(chatId, '<b>📖 Commands</b>\n\n/rooms /visitors /stats /status\n/aichat on | off | status | personality [text] | reset\n/broadcast [msg] /kick /close\n/menu\n\n💡 AI replies when: @camp mentioned OR nobody responds in 45s'); return; }
  if (text === '/menu' && isAdmin) { await sendAdminMenu(chatId); return; }
  if (text.startsWith('/rooms') && isAdmin) { const l = Object.values(rooms).map(r => '• <b>' + r.name + '</b> — ' + r.memberCount + ' online').join('\n'); await tgSend(chatId, '<b>📋 Rooms (' + Object.keys(rooms).length + ')</b>\n\n' + (l || 'None.')); return; }
  if (text.startsWith('/visitors') && isAdmin) { const v = Object.entries(sessions).map(([sid, s]) => '• <b>' + s.name + '</b> — ' + (s.roomId ? (rooms[s.roomId] ? rooms[s.roomId].name : '?') : 'Lobby')); await tgSend(chatId, '<b>👥 Online (' + v.length + ')</b>\n\n' + (v.join('\n') || 'None.')); return; }
  if (text.startsWith('/broadcast ') && isAdmin) { const m = text.replace('/broadcast ', '').trim(); const ts = new Date().toLocaleTimeString('en-US', { hour12: false }); io.emit('admin broadcast', { message: m, time: ts }); await tgSend(chatId, '✅ Sent to ' + Object.keys(sessions).length + ' visitor(s).'); return; }

  if (text.startsWith('/aichat') && isAdmin) {
    const parts = text.split(' '); const sub = parts[1] || '';
    if (sub === 'on') { aiMode = true; await tgSend(chatId, '🤖 <b>AI Friend Mode ON!</b>\n\nBot replies as "Camp" — a friend. Only when:\n1. Someone mentions @camp\n2. Nobody responds in 45s\n\nTypes with human delays. 🤫'); io.emit('system msg', { text: '💬 A new friend just joined!' }); }
    else if (sub === 'off') { aiMode = false; await tgSend(chatId, '🔴 <b>AI off.</b>'); io.emit('system msg', { text: '👋 Camp has left.' }); }
    else if (sub === 'status') { await tgSend(chatId, '🤖 AI: ' + (aiMode ? '🟢 ON (friend mode)' : '🔴 OFF') + '\nModel: Llama 3.3 70B\nMemories: ' + Object.keys(aiConversations).length + ' room(s)'); }
    else if (sub === 'personality') { const np = text.replace('/aichat personality', '').trim(); if (np) { aiPersonality = np; Object.keys(aiConversations).forEach(k => delete aiConversations[k]); await tgSend(chatId, '✅ Updated!\n\n<i>' + aiPersonality + '</i>'); } else { await tgSend(chatId, 'Current:\n\n<i>' + aiPersonality + '</i>'); } }
    else if (sub === 'reset') { Object.keys(aiConversations).forEach(k => delete aiConversations[k]); await tgSend(chatId, '🧹 Memory cleared.'); }
    else { await tgSend(chatId, '🤖 AI: ' + (aiMode ? '🟢 ON' : '🔴 OFF') + '\n\n/aichat on | off | status | personality [text] | reset'); }
    return;
  }

  if (text === '/kick' && isAdmin) { const ns = [...new Set(Object.values(sessions).map(s => s.name))]; if (!ns.length) { await tgSend(chatId, 'No visitors.'); return; } await tgSend(chatId, '<b>Kick who?</b>', { reply_markup: { inline_keyboard: ns.map(n => [{ text: '👢 ' + n, callback_data: 'kick_' + n }]) } }); return; }
  if (text.startsWith('/unban ') && isAdmin) { const n = text.replace('/unban ', '').trim(); if (bannedNames.has(n)) { bannedNames.delete(n); await tgSend(chatId, '✅ ' + n + ' unbanned.'); } else { await tgSend(chatId, n + ' not banned.'); } return; }
  if (text === '/close' && isAdmin) { const rl = Object.values(rooms).filter(r => r.approved); if (!rl.length) { await tgSend(chatId, 'No rooms.'); return; } await tgSend(chatId, '<b>Close which?</b>', { reply_markup: { inline_keyboard: rl.map(r => [{ text: '🔒 ' + r.name, callback_data: 'close_' + r.id }]) } }); return; }
  if (text === '/stats' && isAdmin) { await tgSend(chatId, '<b>📊 Stats</b>\n\nRooms: ' + Object.keys(rooms).length + '\nVisitors: ' + Object.keys(sessions).length + '\nBanned: ' + bannedNames.size + '\nAI: ' + (aiMode ? '🟢 ON' : '🔴 OFF')); return; }
  if (text === '/status' && isAdmin) { await tgSend(chatId, '🟢 <b>System OK</b>\n\nv3.3 | AI: ' + (aiMode ? 'Active' : 'Standby') + '\nVisitors: ' + Object.keys(sessions).length + '\nRooms: ' + Object.keys(rooms).length); return; }

  if (isAdmin && text && !text.startsWith('/')) {
    let targetRoomId = null;
    if (msg.reply_to_message) { const rid = msg.reply_to_message.message_id; if (pendingActions[rid]) targetRoomId = pendingActions[rid].roomId; }
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    if (!targetRoomId) { Object.keys(rooms).forEach(rid => io.to(rid).emit('admin message', { message: text, time: ts })); await tgSend(chatId, '✅ Sent to all rooms.'); }
    else { io.to(targetRoomId).emit('admin message', { message: text, time: ts }); await tgSend(chatId, '✅ Sent to ' + (rooms[targetRoomId] ? rooms[targetRoomId].name : targetRoomId) + '.'); roomLastActivity[targetRoomId] = Date.now(); }
  }
}

async function sendAdminMenu(chatId) {
  await tgSend(chatId, '🟢 <b>Never Hide Chat Camp — Admin</b>\n\nRooms: ' + Object.keys(rooms).length + ' | Visitors: ' + Object.keys(sessions).length + ' | AI: ' + (aiMode ? '🟢 ON' : '🔴 OFF') + '\n\n<b>Quick:</b> /aichat on | /aichat off | /rooms | /visitors | /stats | /help', { reply_markup: { keyboard: [[{ text: '/rooms' }, { text: '/visitors' }, { text: '/stats' }], [{ text: '/aichat on' }, { text: '/aichat off' }, { text: '/aichat status' }], [{ text: '/help' }, { text: '/menu' }]], resize_keyboard: true } });
}

// ===== EXPRESS =====
app.use(express.json());
app.use(express.static('public'));
app.post('/webhook', async (req, res) => { try { await handleUpdate(req.body); } catch(e) {} res.json({ ok: true }); });
app.get('/health', (req, res) => res.json({ status: 'ok', version: '3.3.0', rooms: Object.keys(rooms).length, visitors: Object.keys(sessions).length, aiMode, adminConnected: !!ADMIN_CHAT_ID }));
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
    if (ADMIN_CHAT_ID) tgSend(ADMIN_CHAT_ID, '👤 <b>' + n + '</b> joined the lobby.');
  });

  socket.on('join room', ({ roomId }) => {
    if (!sessions[socket.id]) return;
    if (!rooms[roomId] || !rooms[roomId].approved) { socket.emit('error msg', 'Room not found.'); return; }
    const name = sessions[socket.id].name;
    const oldRoom = sessions[socket.id].roomId;
    if (oldRoom) {
      socket.leave(oldRoom);
      if (rooms[oldRoom]) {
        delete rooms[oldRoom].members[socket.id];
        rooms[oldRoom].memberCount = Object.keys(rooms[oldRoom].members).length;
        io.to(oldRoom).emit('system msg', { text: name + ' left.' });
        io.to(oldRoom).emit('member count', { count: rooms[oldRoom].memberCount });
      }
    }
    socket.join(roomId);
    sessions[socket.id].roomId = roomId;
    rooms[roomId].members[socket.id] = name;
    rooms[roomId].memberCount = Object.keys(rooms[roomId].members).length;
    socket.emit('joined room', { roomId, name: rooms[roomId].name, description: rooms[roomId].description });
    io.to(roomId).emit('system msg', { text: name + ' joined. 👋' });
    io.to(roomId).emit('member count', { count: rooms[roomId].memberCount });
    io.emit('room list update', getRoomList());
    if (ADMIN_CHAT_ID) tgSend(ADMIN_CHAT_ID, '🚪 <b>' + name + '</b> joined <b>' + rooms[roomId].name + '</b>');
    roomLastActivity[roomId] = Date.now();

    if (aiMode && GROQ_API_KEY) {
      setTimeout(async () => {
        if (!aiTypingRooms.has(roomId)) {
          await sendAIReply(roomId, 'System', name + ' just joined the room. Welcome them warmly like a friend would, keep it super short and casual.');
        }
      }, 2000 + Math.random() * 2000);
    }
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
    if (ADMIN_CHAT_ID) {
      tgSend(ADMIN_CHAT_ID, '📋 <b>New Room Request</b>\n\n<b>Name:</b> ' + roomName + '\n<b>Desc:</b> ' + (roomDesc || 'None') + '\n<b>By:</b> ' + requester, { reply_markup: { inline_keyboard: [[{ text: '✅ Approve', callback_data: 'approve_' + reqId }, { text: '❌ Reject', callback_data: 'reject_' + reqId }]] } }).then(result => { if (result && result.ok && result.result) pendingActions[result.result.message_id] = { type: 'room_request', reqId }; });
    } else {
      socket.emit('error msg', 'Admin not connected.');
      delete pendingRequests[reqId];
    }
  });

  socket.on('chat message', async ({ message }) => {
    if (!sessions[socket.id]) return;
    const { name, roomId } = sessions[socket.id];
    if (!roomId || !rooms[roomId]) return;
    const msg = (message || '').trim().substring(0, 1000);
    if (!msg) return;
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

    io.to(roomId).emit('chat message', { name, message: msg, time: ts, socketId: socket.id });
    roomLastActivity[roomId] = Date.now();

    if (ADMIN_CHAT_ID) {
      tgSend(ADMIN_CHAT_ID, '💬 [<b>' + rooms[roomId].name + '</b>] <b>' + name + ':</b> ' + msg).then(result => { if (result && result.ok && result.result) pendingActions[result.result.message_id] = { roomId }; });
    }

    if (aiMode && GROQ_API_KEY) {
      const mentioned = isMentioned(msg);
      const history = aiConversations[rooms[roomId].name];
      const botLastSpoke = history && history.length > 0 && history[history.length - 1].role === 'assistant';

      if (mentioned && !botLastSpoke) {
        const delay = 3000 + Math.random() * 2000;
        setTimeout(async () => { await sendAIReply(roomId, name, msg); }, delay);
      } else if (!botLastSpoke) {
        // Set inactivity timer — bot steps in after 45s of no response
        setTimeout(async () => {
          const timeSince = Date.now() - (roomLastActivity[roomId] || 0);
          if (timeSince >= INACTIVE_THRESHOLD && !aiTypingRooms.has(roomId)) {
            await sendAIReply(roomId, name, msg);
          }
        }, INACTIVE_THRESHOLD + 1000);
      }
    }
  });

  socket.on('typing', () => {
    if (sessions[socket.id]) {
      const { name, roomId } = sessions[socket.id];
      if (roomId) { socket.to(roomId).emit('typing', { name }); roomLastActivity[roomId] = Date.now(); }
    }
  });
  socket.on('stop typing', () => {
    if (sessions[socket.id]) {
      const { roomId } = sessions[socket.id];
      if (roomId) socket.to(roomId).emit('stop typing');
    }
  });

  socket.on('disconnect', () => {
    if (sessions[socket.id]) {
      const { name, roomId } = sessions[socket.id];
      if (roomId && rooms[roomId]) {
        delete rooms[roomId].members[socket.id];
        rooms[roomId].memberCount = Object.keys(rooms[roomId].members).length;
        io.to(roomId).emit('system msg', { text: name + ' left.' });
        io.to(roomId).emit('member count', { count: rooms[roomId].memberCount });
        io.emit('room list update', getRoomList());
      }
      delete sessions[socket.id];
    }
  });
});

server.listen(PORT, () => {
  console.log('🚀 Never Hide Chat Camp v3.3 on port ' + PORT);
  console.log('Bot: ' + (BOT_TOKEN ? 'SET' : 'NOT SET') + ' | Groq: ' + (GROQ_API_KEY ? 'SET' : 'NOT SET'));
  if (BOT_TOKEN) pollTelegram().catch(e => console.error('Polling crashed:', e.message));
});
