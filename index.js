// Never Hide Chat Camp v3.1 — Premium Event Platform with AI Auto-Reply
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

// ===== STATE =====
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

const defaultRooms = [
  { id: 'general', name: '🌍 General Chat', description: 'Open chat for everyone — say hi!', createdBy: 'Ghana Cyber' },
  { id: 'tech', name: '💻 Tech & Coding', description: 'Technology, programming, cyber talk', createdBy: 'Ghana Cyber' },
  { id: 'ghana', name: '🇬🇭 Ghana Talk', description: 'All things Ghana — news, culture, vibes', createdBy: 'Ghana Cyber' },
];
defaultRooms.forEach(r => { rooms[r.id] = { ...r, approved: true, memberCount: 0, createdAt: Date.now(), members: {} }; });

// ===== TG HELPERS =====
async function tgSend(chatId, text, extra = {}) {
  try {
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }) });
    return await res.json();
  } catch (e) { console.error('TG send error:', e.message); return null; }
}
async function tgAnswer(callbackQueryId, text = '') {
  try { await fetch(`${TELEGRAM_API}/answerCallbackQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: callbackQueryId, text }) }); } catch (e) {}
}
async function tgEdit(chatId, messageId, text) {
  try { await fetch(`${TELEGRAM_API}/editMessageText`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' }) }); } catch (e) {}
}

// ===== GROQ AI =====
async function getAIReply(roomName, senderName, message) {
  if (!GROQ_API_KEY) return "I'd love to chat but my AI brain isn't configured yet. Ghana Cyber will be back soon! 🔧";
  if (!aiConversations[roomName]) aiConversations[roomName] = [];
  const history = aiConversations[roomName];
  history.push({ role: 'user', content: `${senderName}: ${message}` });
  while (history.length > MAX_AI_HISTORY * 2) history.shift();

  const messages = [
    { role: 'system', content: aiPersonality + ` You are in the room "${roomName}". Reply naturally without prefixing names. Just respond as yourself.` },
    ...history.map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content }))
  ];

  try {
    const res = await fetch(GROQ_API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` }, body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages, max_tokens: 150, temperature: 0.8 }) });
    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || "Hmm, I didn't catch that. Tell me more! 😊";
    history.push({ role: 'assistant', content: reply });
    while (history.length > MAX_AI_HISTORY * 2) history.shift();
    return reply;
  } catch (e) {
    console.error('Groq error:', e.message);
    return "I'm having trouble thinking right now. Ghana Cyber will be back soon! 🧠";
  }
}

// ===== EXPRESS =====
app.use(express.json());
app.use(express.static('public'));

app.post('/webhook', async (req, res) => {
  const update = req.body;

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
        await tgEdit(ADMIN_CHAT_ID, msgId, `✅ <b>Room Approved!</b>\n\n<b>${pending.name}</b>\nCreated by: ${pending.requestedBy}\n\nRoom is now live.`);
      } else { await tgSend(ADMIN_CHAT_ID, '⚠️ This request has expired.'); }
    } else if (data.startsWith('reject_')) {
      const reqId = data.replace('reject_', '');
      const pending = pendingRequests[reqId];
      if (pending) {
        const sock = io.sockets.sockets.get(pending.socketId);
        if (sock) sock.emit('room rejected', { name: pending.name });
        delete pendingRequests[reqId];
        await tgEdit(ADMIN_CHAT_ID, msgId, `❌ <b>Room Rejected</b>\n\n<b>${pending.name}</b>\nRequested by: ${pending.requestedBy}`);
      }
    } else if (data.startsWith('kick_')) {
      const targetName = data.replace('kick_', '');
      for (const [sid, sess] of Object.entries(sessions)) {
        if (sess.name === targetName) { const sock = io.sockets.sockets.get(sid); if (sock) { sock.emit('kicked', { reason: 'Removed by admin' }); sock.disconnect(true); } }
      }
      bannedNames.add(targetName);
      await tgEdit(ADMIN_CHAT_ID, msgId, `👢 <b>${targetName}</b> has been kicked and banned.`);
    } else if (data.startsWith('close_')) {
      const roomId = data.replace('close_', '');
      if (rooms[roomId]) {
        io.to(roomId).emit('system msg', { text: '⚠️ This room has been closed by Ghana Cyber.' });
        io.in(roomId).socketsLeave(roomId);
        delete rooms[roomId];
        io.emit('room list update', getRoomList());
        await tgEdit(ADMIN_CHAT_ID, msgId, `🔒 <b>Room closed.</b>`);
      }
    }
    return res.json({ ok: true });
  }

  if (!update.message) return res.json({ ok: true });
  const msg = update.message;
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const isAdmin = ADMIN_CHAT_ID && chatId === ADMIN_CHAT_ID;

  if (text.startsWith('/start')) { ADMIN_CHAT_ID = chatId; await sendAdminMenu(chatId); return res.json({ ok: true }); }

  if (text === '/help' && isAdmin) {
    await tgSend(chatId,
      `<b>📖 Full Command List</b>\n\n` +
      `<b>📋 Room Management</b>\n/rooms — List all rooms\n/visitors — Who's online\n/close — Close a room (buttons)\n\n` +
      `<b>🤖 AI Auto-Reply</b>\n/aichat on — Activate AI bot\n/aichat off — Turn off AI\n/aichat status — Check status\n/aichat personality [text] — Set personality\n/aichat reset — Clear AI memory\n\n` +
      `<b>💬 Messaging</b>\n/broadcast [msg] — Send to all rooms\nReply to forwarded msg — Reply to that room\n(Plain text) — Goes to all rooms\n\n` +
      `<b>👥 User Control</b>\n/kick — Kick & ban visitor (buttons)\n/unban [name] — Unban visitor\n\n` +
      `<b>📊 Stats</b>\n/stats — Full statistics\n/status — Quick health check\n\n` +
      `<b>🔧 System</b>\n/menu — Quick action menu\n/help — This message`);
    return res.json({ ok: true });
  }

  if (text === '/menu' && isAdmin) { await sendAdminMenu(chatId); return res.json({ ok: true }); }

  if (text.startsWith('/rooms') && isAdmin) {
    const list = Object.values(rooms).map(r => `• <b>${r.name}</b> — ${r.memberCount} online\n  ${r.description}`).join('\n\n');
    await tgSend(chatId, `<b>📋 Active Rooms (${Object.keys(rooms).length})</b>\n\n${list || 'No rooms yet.'}`);
    return res.json({ ok: true });
  }

  if (text.startsWith('/visitors') && isAdmin) {
    const vis = Object.entries(sessions).map(([sid, s]) => { const room = s.roomId ? (rooms[s.roomId]?.name || 'Unknown') : 'Lobby'; return `• <b>${s.name}</b> — in ${room}`; });
    await tgSend(chatId, `<b>👥 Online Visitors (${vis.length})</b>\n\n${vis.join('\n') || 'No one online.'}`);
    return res.json({ ok: true });
  }

  if (text.startsWith('/broadcast ') && isAdmin) {
    const broadcastMsg = text.replace('/broadcast ', '').trim();
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    io.emit('admin broadcast', { message: broadcastMsg, time: timestamp });
    await tgSend(chatId, `✅ Broadcast sent to ${Object.keys(sessions).length} visitor(s).`);
    return res.json({ ok: true });
  }

  if (text.startsWith('/aichat') && isAdmin) {
    const parts = text.split(' '); const sub = parts[1] || '';
    if (sub === 'on') {
      aiMode = true;
      await tgSend(chatId, `🤖 <b>AI Auto-Reply ACTIVATED!</b>\n\nThe bot will auto-reply to all visitor messages.\n\nPersonality: <i>${aiPersonality.substring(0, 80)}...</i>\n\n/aichat off to turn off.`);
      io.emit('system msg', { text: '🤖 AI Assistant is now active! Ghana Cyber has enabled auto-reply mode.' });
    } else if (sub === 'off') {
      aiMode = false;
      await tgSend(chatId, `🔴 <b>AI Auto-Reply deactivated.</b> Manual mode is back.`);
      io.emit('system msg', { text: '💤 AI Assistant turned off. Ghana Cyber is back in control.' });
    } else if (sub === 'status') {
      await tgSend(chatId, `🤖 <b>AI Status</b>\n\nMode: ${aiMode ? '🟢 ON' : '🔴 OFF'}\nModel: Llama 3.3 70B (Groq)\nPersonality: <i>${aiPersonality.substring(0, 100)}...</i>\nMemories: ${Object.keys(aiConversations).length} room(s)`);
    } else if (sub === 'personality') {
      const newP = text.replace('/aichat personality', '').trim();
      if (newP) { aiPersonality = newP; Object.keys(aiConversations).forEach(k => delete aiConversations[k]); await tgSend(chatId, `✅ <b>Personality updated!</b>\n\n<i>${aiPersonality}</i>`); }
      else { await tgSend(chatId, `Current personality:\n\n<i>${aiPersonality}</i>`); }
    } else if (sub === 'reset') {
      Object.keys(aiConversations).forEach(k => delete aiConversations[k]);
      await tgSend(chatId, `🧹 <b>AI memory cleared.</b>`);
    } else {
      await tgSend(chatId, `🤖 <b>AI Auto-Reply</b>\n\nStatus: ${aiMode ? '🟢 ON' : '🔴 OFF'}\n\n/aichat on\n/aichat off\n/aichat status\n/aichat personality [text]\n/aichat reset`);
    }
    return res.json({ ok: true });
  }

  if (text === '/kick' && isAdmin) {
    const onlineNames = [...new Set(Object.values(sessions).map(s => s.name))];
    if (onlineNames.length === 0) { await tgSend(chatId, `No visitors online.`); return res.json({ ok: true }); }
    await tgSend(chatId, `<b>Select visitor to kick & ban:</b>`, { reply_markup: { inline_keyboard: onlineNames.map(n => [{ text: `👢 ${n}`, callback_data: `kick_${n}` }]) } });
    return res.json({ ok: true });
  }

  if (text.startsWith('/unban ') && isAdmin) {
    const name = text.replace('/unban ', '').trim();
    if (bannedNames.has(name)) { bannedNames.delete(name); await tgSend(chatId, `✅ <b>${name}</b> unbanned.`); } else { await tgSend(chatId, `${name} is not banned.`); }
    return res.json({ ok: true });
  }

  if (text === '/close' && isAdmin) {
    const roomList = Object.values(rooms).filter(r => r.approved);
    if (roomList.length === 0) { await tgSend(chatId, `No rooms to close.`); return res.json({ ok: true }); }
    await tgSend(chatId, `<b>Select room to close:</b>`, { reply_markup: { inline_keyboard: roomList.map(r => [{ text: `🔒 ${r.name}`, callback_data: `close_${r.id}` }]) } });
    return res.json({ ok: true });
  }

  if (text === '/stats' && isAdmin) {
    await tgSend(chatId,
      `<b>📊 Platform Stats</b>\n\n<b>Rooms:</b> ${Object.keys(rooms).length}\n<b>Visitors:</b> ${Object.keys(sessions).length}\n<b>Pending:</b> ${Object.keys(pendingRequests).length}\n<b>Banned:</b> ${bannedNames.size}\n<b>AI:</b> ${aiMode ? '🟢 ON' : '🔴 OFF'}\n<b>AI Memories:</b> ${Object.keys(aiConversations).length}`);
    return res.json({ ok: true });
  }

  if (text === '/status' && isAdmin) {
    await tgSend(chatId, `🟢 <b>System OK</b>\n\nServer: v3.1\nBot: @Neverhidechatcampbot\nAI: ${aiMode ? 'Active' : 'Standing by'}\nVisitors: ${Object.keys(sessions).length}\nRooms: ${Object.keys(rooms).length}`);
    return res.json({ ok: true });
  }

  if (isAdmin && text && !text.startsWith('/')) {
    let targetRoomId = null;
    if (msg.reply_to_message) { const replyToId = msg.reply_to_message.message_id; if (pendingActions[replyToId]) targetRoomId = pendingActions[replyToId].roomId; }
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    if (!targetRoomId) { Object.keys(rooms).forEach(rid => io.to(rid).emit('admin message', { message: text, time: timestamp })); await tgSend(chatId, `✅ Sent to all rooms.`); }
    else { io.to(targetRoomId).emit('admin message', { message: text, time: timestamp }); await tgSend(chatId, `✅ Sent to ${rooms[targetRoomId]?.name}.`); }
  }

  res.json({ ok: true });
});

async function sendAdminMenu(chatId) {
  await tgSend(chatId,
    `🟢 <b>Never Hide Chat Camp — Admin Panel</b>\n\n` +
    `Rooms: ${Object.keys(rooms).length} | Visitors: ${Object.keys(sessions).length} | AI: ${aiMode ? '🟢 ON' : '🔴 OFF'}\n\n` +
    `<b>Quick Commands:</b>\n/menu /help /rooms /visitors /aichat on /aichat off /stats /kick /close`,
    { reply_markup: { keyboard: [[{ text: '/rooms' }, { text: '/visitors' }, { text: '/stats' }], [{ text: '/aichat on' }, { text: '/aichat off' }, { text: '/aichat status' }], [{ text: '/help' }, { text: '/menu' }]], resize_keyboard: true } });
}

app.get('/health', (req, res) => res.json({ status: 'ok', version: '3.1.0', rooms: Object.keys(rooms).length, visitors: Object.keys(sessions).length, aiMode, adminConnected: !!ADMIN_CHAT_ID }));
app.get('/api/rooms', (req, res) => res.json(getRoomList()));
app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

function getRoomList() { return Object.values(rooms).filter(r => r.approved).map(r => ({ id: r.id, name: r.name, description: r.description, createdBy: r.createdBy, memberCount: r.memberCount })); }

io.on('connection', (socket) => {
  socket.emit('room list', getRoomList());

  socket.on('set name', ({ name }) => {
    const n = (name || 'Guest').trim().substring(0, 30);
    if (bannedNames.has(n)) { socket.emit('kicked', { reason: 'You have been banned.' }); socket.disconnect(true); return; }
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
    if (aiMode && GROQ_API_KEY) { setTimeout(async () => { const r = await getAIReply(rooms[roomId].name, 'System', `${name} just joined. Greet them warmly and briefly.`); io.to(roomId).emit('admin message', { message: r, time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }) }); }, 1500); }
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
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    io.to(roomId).emit('chat message', { name, message: msg, time: timestamp, socketId: socket.id });
    if (ADMIN_CHAT_ID) { tgSend(ADMIN_CHAT_ID, `💬 [<b>${rooms[roomId].name}</b>] <b>${name}:</b> ${msg}`).then(result => { if (result?.ok && result.result) pendingActions[result.result.message_id] = { roomId }; }); }
    if (aiMode && GROQ_API_KEY) { setTimeout(async () => { try { const r = await getAIReply(rooms[roomId].name, name, msg); io.to(roomId).emit('admin message', { message: r, time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' }) }); if (ADMIN_CHAT_ID) tgSend(ADMIN_CHAT_ID, `🤖 [<b>${rooms[roomId].name}</b>] <b>AI:</b> ${r}`); } catch (e) { console.error('AI reply error:', e.message); } }, 800); }
  });

  socket.on('typing', () => { if (sessions[socket.id]) { const { name, roomId } = sessions[socket.id]; if (roomId) socket.to(roomId).emit('typing', { name }); } });
  socket.on('stop typing', () => { if (sessions[socket.id]) { const { roomId } = sessions[socket.id]; if (roomId) socket.to(roomId).emit('stop typing'); } });

  socket.on('disconnect', () => {
    if (sessions[socket.id]) { const { name, roomId } = sessions[socket.id]; if (roomId && rooms[roomId]) { delete rooms[roomId].members[socket.id]; rooms[roomId].memberCount = Object.keys(rooms[roomId].members).length; io.to(roomId).emit('system msg', { text: `${name} left.` }); io.to(roomId).emit('member count', { count: rooms[roomId].memberCount }); io.emit('room list update', getRoomList()); } delete sessions[socket.id]; }
  });
});

server.listen(PORT, () => { console.log(`🚀 Never Hide Chat Camp v3.1 on port ${PORT}`); console.log(`Bot: ${BOT_TOKEN ? 'SET' : 'NOT SET'} | Groq: ${GROQ_API_KEY ? 'SET' : 'NOT SET'}`); });
