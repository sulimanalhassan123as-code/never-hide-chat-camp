// index.js (Version with Welcome Message)
const express = require('express');
const http = require('http');
const app = express();
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// This is YOUR list of approved events.
const approvedEvents = [
    "coding Army's class",    "classpp creators class",
   "never hide chat room privately",
   "General Student Chat"
];

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

const rooms = {};

io.on('connection', (socket) => {
  socket.on('join room', ({ username, room }) => {
    if (approvedEvents.includes(room)) {
        socket.join(room);
        socket.username = username;
        socket.room = room;

        if (!rooms[room]) {
            rooms[room] = [];
        }
        rooms[room].push({ id: socket.id, name: username, status: 'online' });

        // --- NEW FEATURE: Private Welcome Message ---
        // Send a private welcome message ONLY to the user who just connected.
        socket.emit('system message', { text: `Welcome, ${username}! You have joined the '${room}' event.`, time: new Date().toLocaleTimeString() });
        
        // Send a public message to EVERYONE ELSE in the room.
        socket.to(room).emit('system message', { text: `${username} has joined the event.`, time: new Date().toLocaleTimeString() });
        
        io.to(room).emit('update users', rooms[room]);

    } else {
        socket.emit('join error', 'This event does not exist. Please check the event name.');
    }
  });

  socket.on('typing', ({ room, username }) => {
    if(rooms[room]) {
        const user = rooms[room].find(u => u.name === username);
        if (user) user.status = 'typing...';
        io.to(room).emit('update users', rooms[room]);
    }
  });

  socket.on('stop typing', ({ room, username }) => {
    if(rooms[room]) {
        const user = rooms[room].find(u => u.name === username);
        if (user) user.status = 'online';
        io.to(room).emit('update users', rooms[room]);
    }
  });

  socket.on('chat message', ({ username, room, message }) => {
    const timestamp = new Date().toLocaleTimeString();
    io.to(room).emit('chat message', { username, message, time: timestamp });
  });

  socket.on('disconnect', () => {
    if (socket.username && socket.room) {
        const room = socket.room;
        const username = socket.username;
        if (rooms[room]) {
            rooms[room] = rooms[room].filter(user => user.id !== socket.id);
            io.to(room).emit('system message', { text: `${username} has left the event.`, time: new Date().toLocaleTimeString() });
            io.to(room).emit('update users', rooms[room]);
        }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Pro server with Welcome Message is running on port ${PORT}`);
});
