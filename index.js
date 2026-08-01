// Never Hide Chat Camp v3.0 — Premium Event Platform by Ghana Cyber
const express = require('express');
const http = require('http');
const app = express();
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, { maxHttpBufferSize: 2e6, pingTimeout: 60000 });
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.CHAT_BOT_TOKEN || '';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ===== STATE =====
let ADMIN_CHAT_ID = null;

// Events/Rooms: { roomId: { name, description, createdBy, approved, memberCount, createdAt, members: {socketId: name} } }
const rooms = {};

// Pending room requests: { requestId: { name, description, requestedBy, socketId, timestamp } }
const pendingRequests = {};

// Socket sessions: { socketId: { name, roomId } }
const sessions = {};

// Map telegram msg id -> action data (for approval buttons)
const pendingActions = {};

let requestCounter = 0;

// ===== PRE-APPROVED DEFAULT ROOMS =====
const defaultRooms = [
  { id: 'general', name: '🌍 General Chat', description: 'Open chat for everyone — say hi!', createdBy: 'Ghana Cyber' },
  { id: 'tech', name: '💻 Tech & Coding', description: 'Technology, programming, cyber talk', createdBy: 'Ghana Cyber' },
  { id: 'ghana', name: '🇬🇭 Ghana Talk', description: 'All things Ghana — news, culture, vibes', createdBy: 'Ghana Cyber' },
];

defaultRooms.forEach(r => {
  rooms[r.id] = { ...r, approved: true, memberCount: 0, createdAt: Date.now(), members: {} };
});

// ===== TELEGRAM HELPERS =====
async function tgSend(chatId, text, extra = {}) {
  try {
    const body = { chat_id: chatId, text, parse_mode: 'HTML', ...extra };
    const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return await res.json();
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

// ===== EXPRESS =====
app.use(express.json());
app.use(express.static('public'));

// Webhook
app.post('/webhook', async (req, res) => {
  const update = req.body;

  // Callback query (button press)
  if (update.callback_query) {
    const cb = update.callback_query;
    const data = cb.data || '';
    const msgId = cb.message ? cb.message.message_id : null;
    await tgAnswer(cb.id);

    if (data.startsWith('approve_')) {
      const reqId = data.replace('approve_', '');
      const pending = pendingRequests[reqId];
      if (pending) {
        // Create the room
        rooms[reqId] = {
          id: reqId,
          name: pending.name,
          description: pending.description,
          createdBy: pending.requestedBy,
          approved: true,
          memberCount: 0,
          createdAt: Date.now(),
          members: {}
        };
        delete pendingRequests[reqId];

        // Notify the requesting socket
        const sock = io.sockets.sockets.get(pending.socketId);
        if (sock) {
          sock.emit('room approved', { roomId: reqId, name: pending.name });
        }

        // Broadcast new room to everyone
        io.emit('room list update', getRoomList());

        await tgEdit(ADMIN_CHAT_ID, msgId,
          `✅ <b>Room Approved!</b>\n\n<b>${pending.name}</b>\nCreated by: ${pending.requestedBy}\n\nRoom is now live on the platform.`
        );
      } else {
        await tgSend(ADMIN_CHAT_ID, '⚠️ This request has expired or already been handled.');
      }

    } else if (data.startsWith('reject_')) {
      const reqId = data.replace('reject_', '');
      const pending = pendingRequests[reqId];
      if (pending) {
        const sock = io.sockets.sockets.get(pending.socketId);
        if (sock) sock.emit('room rejected', { name: pending.name });
        delete pendingRequests[reqId];
        await tgEdit(ADMIN_CHAT_ID, msgId,
          `❌ <b>Room Rejected</b>\n\n<b>${pending.name}</b>\nRequested by: ${pending.requestedBy}\n\nRequest has been declined.`
        );
      }
    }
    return res.json({ ok: true });
  }

  if (!update.message) return res.json({ ok: true });

  const msg = update.message;
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (text.startsWith('/start')) {
    ADMIN_CHAT_ID = chatId;
    const roomCount = Object.keys(rooms).length;
    await tgSend(chatId,
      `🟢 <b>Never Hide Chat Camp — Admin Panel</b>\n\n` +
      `Welcome, Ghana Cyber! You are the controller of this platform.\n\n` +
      `<b>Active Rooms:</b> ${roomCount}\n` +
      `<b>Active Visitors:</b> ${Object.keys(sessions).length}\n\n` +
      `<b>Commands:</b>\n` +
      `/rooms — List all active rooms\n` +
      `/visitors — See who's online\n` +
      `/broadcast [msg] — Send to everyone\n\n` +
      `When someone requests a new event room, you'll get a notification here with Approve/Reject buttons. ✅`
    );
    return res.json({ ok: true });
  }

  if (text.startsWith('/rooms') && ADMIN_CHAT_ID && chatId === ADMIN_CHAT_ID) {
    const list = Object.values(rooms).map(r =>
      `• <b>${r.name}</b> — ${r.memberCount} online\n  ${r.description}`
    ).join('\n\n');
    await tgSend(chatId, `<b>📋 Active Rooms (${Object.keys(rooms).length})</b>\n\n${list || 'No rooms yet.'}`);
    return res.json({ ok: true });
  }

  if (text.startsWith('/visitors') && ADMIN_CHAT_ID && chatId === ADMIN_CHAT_ID) {
    const vis = Object.entries(sessions).map(([sid, s]) => {
      const room = s.roomId ? (rooms[s.roomId] ? rooms[s.roomId].name : 'Unknown') : 'Lobby';
      return `• <b>${s.name}</b> — in ${room}`;
    });
    await tgSend(chatId, `<b>👥 Online Visitors (${vis.length})</b>\n\n${vis.join('\n') || 'No one online.'}`);
    return res.json({ ok: true });
  }

  if (text.startsWith('/broadcast ') && ADMIN_CHAT_ID && chatId === ADMIN_CHAT_ID) {
    const broadcastMsg = text.replace('/broadcast ', '').trim();
    io.emit('admin broadcast', { message: broadcastMsg, time: new Date().toLocaleTimeString('en-US', { hour12: false }) });
    await tgSend(chatId, `✅ Broadcast sent to ${Object.keys(sessions).length} visitor(s).`);
    return res.json({ ok: true });
  }

  // Admin reply in a room — reply to any message
  if (ADMIN_CHAT_ID && chatId === ADMIN_CHAT_ID && text && !text.startsWith('/')) {
    // Find the room to reply to via reply_to_message context
    let targetRoomId = null;
    if (msg.reply_to_message) {
      // Try to find the room from context stored in pendingActions
      const replyToId = msg.reply_to_message.message_id;
      if (pendingActions[replyToId]) {
        targetRoomId = pendingActions[replyToId].roomId;
      }
    }
    if (!targetRoomId) {
      // Broadcast to all rooms
      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
      Object.keys(rooms).forEach(rid => {
        io.to(rid).emit('admin message', { message: text, time: timestamp });
      });
      await tgSend(chatId, `✅ Message sent to all active rooms.`);
    } else {
      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
      io.to(targetRoomId).emit('admin message', { message: text, time: timestamp });
      await tgSend(chatId, `✅ Message sent to ${rooms[targetRoomId] ? rooms[targetRoomId].name : targetRoomId}.`);
    }
  }

  res.json({ ok: true });
});

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '3.0.0', rooms: Object.keys(rooms).length, visitors: Object.keys(sessions).length });
});

// API: get room list
app.get('/api/rooms', (req, res) => {
  res.json(getRoomList());
});

app.get('/', (req, res) => res.sendFile(__dirname + '/public/index.html'));

// ===== HELPERS =====
function getRoomList() {
  return Object.values(rooms)
    .filter(r => r.approved)
    .map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      createdBy: r.createdBy,
      memberCount: r.memberCount
    }));
}

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  // Send room list on connect
  socket.emit('room list', getRoomList());

  socket.on('set name', ({ name }) => {
    const n = (name || 'Guest').trim().substring(0, 30);
    sessions[socket.id] = { name: n, roomId: null };
    socket.emit('name set', { name: n });

    if (ADMIN_CHAT_ID) {
      tgSend(ADMIN_CHAT_ID, `👤 <b>${n}</b> joined the lobby.`);
    }
  });

  socket.on('join room', ({ roomId }) => {
    if (!sessions[socket.id]) return;
    if (!rooms[roomId] || !rooms[roomId].approved) {
      socket.emit('error msg', 'Room not found or not yet approved.');
      return;
    }
    const name = sessions[socket.id].name;
    const oldRoom = sessions[socket.id].roomId;

    // Leave old room
    if (oldRoom) {
      socket.leave(oldRoom);
      if (rooms[oldRoom]) {
        delete rooms[oldRoom].members[socket.id];
        rooms[oldRoom].memberCount = Object.keys(rooms[oldRoom].members).length;
        io.to(oldRoom).emit('system msg', { text: `${name} left the room.` });
        io.to(oldRoom).emit('member count', { count: rooms[oldRoom].memberCount });
      }
    }

    // Join new room
    socket.join(roomId);
    sessions[socket.id].roomId = roomId;
    rooms[roomId].members[socket.id] = name;
    rooms[roomId].memberCount = Object.keys(rooms[roomId].members).length;

    socket.emit('joined room', { roomId, name: rooms[roomId].name, description: rooms[roomId].description });
    io.to(roomId).emit('system msg', { text: `${name} joined the room. 👋` });
    io.to(roomId).emit('member count', { count: rooms[roomId].memberCount });
    io.emit('room list update', getRoomList());

    if (ADMIN_CHAT_ID) {
      tgSend(ADMIN_CHAT_ID, `🚪 <b>${name}</b> joined <b>${rooms[roomId].name}</b>`);
    }
  });

  socket.on('request room', ({ name, description }) => {
    if (!sessions[socket.id]) return;
    const requester = sessions[socket.id].name;
    const roomName = (name || '').trim().substring(0, 50);
    const roomDesc = (description || '').trim().substring(0, 120);

    if (!roomName) return;

    const reqId = 'req_' + Date.now() + '_' + (++requestCounter);
    pendingRequests[reqId] = {
      name: roomName,
      description: roomDesc || 'No description',
      requestedBy: requester,
      socketId: socket.id,
      timestamp: Date.now()
    };

    socket.emit('request sent', { name: roomName });

    if (ADMIN_CHAT_ID) {
      tgSend(ADMIN_CHAT_ID,
        `📋 <b>New Room Request</b>\n\n` +
        `<b>Room Name:</b> ${roomName}\n` +
        `<b>Description:</b> ${roomDesc || 'None'}\n` +
        `<b>Requested by:</b> ${requester}\n` +
        `<b>Time:</b> ${new Date().toLocaleString('en-US', { timeZone: 'Africa/Accra' })}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Approve', callback_data: `approve_${reqId}` },
              { text: '❌ Reject', callback_data: `reject_${reqId}` }
            ]]
          }
        }
      ).then(result => {
        if (result && result.ok && result.result) {
          pendingActions[result.result.message_id] = { type: 'room_request', reqId };
        }
      });
    } else {
      socket.emit('error msg', 'Admin is not connected. Try again later.');
      delete pendingRequests[reqId];
    }
  });

  socket.on('chat message', ({ message }) => {
    if (!sessions[socket.id]) return;
    const { name, roomId } = sessions[socket.id];
    if (!roomId || !rooms[roomId]) return;
    const msg = (message || '').trim().substring(0, 1000);
    if (!msg) return;

    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    io.to(roomId).emit('chat message', { name, message: msg, time: timestamp, socketId: socket.id });

    if (ADMIN_CHAT_ID) {
      tgSend(ADMIN_CHAT_ID,
        `💬 [<b>${rooms[roomId].name}</b>] <b>${name}:</b> ${msg}`
      ).then(result => {
        if (result && result.ok && result.result) {
          pendingActions[result.result.message_id] = { roomId };
        }
      });
    }
  });

  socket.on('typing', () => {
    if (!sessions[socket.id]) return;
    const { name, roomId } = sessions[socket.id];
    if (!roomId) return;
    socket.to(roomId).emit('typing', { name });
  });

  socket.on('stop typing', () => {
    if (!sessions[socket.id]) return;
    const { roomId } = sessions[socket.id];
    if (!roomId) return;
    socket.to(roomId).emit('stop typing');
  });

  socket.on('disconnect', () => {
    if (sessions[socket.id]) {
      const { name, roomId } = sessions[socket.id];
      if (roomId && rooms[roomId]) {
        delete rooms[roomId].members[socket.id];
        rooms[roomId].memberCount = Object.keys(rooms[roomId].members).length;
        io.to(roomId).emit('system msg', { text: `${name} left.` });
        io.to(roomId).emit('member count', { count: rooms[roomId].memberCount });
        io.emit('room list update', getRoomList());
      }
      delete sessions[socket.id];
    }
    console.log(`Disconnected: ${socket.id}`);
  });
});

// ===== START =====
server.listen(PORT, () => {
  console.log(`🚀 Never Hide Chat Camp v3.0 on port ${PORT}`);
  console.log(`Using bot token: ${BOT_TOKEN ? 'SET' : 'NOT SET'}`);
  // NOTE: Webhook is managed externally — do NOT auto-set it here
});
