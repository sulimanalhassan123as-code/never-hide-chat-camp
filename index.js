// index.js (Version with Security - Approved Events List)
const express = require('express');
const http = require('http');
const app = express();
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// --- SECURITY UPGRADE START ---
// This is YOUR list of approved events. 
// ONLY events with these exact names will be allowed.
const approvedEvents = [
    "website developers",
    "coding army class",
    "have a conversation with never",
    "General Student Chat"
];
// You can add or remove any names from this list!
// --- SECURITY UPGRADE END ---

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

const rooms = {};

io.on('connection', (socket) => {
  socket.on('join room', ({ username, room }) => {
    
    // --- SECURITY CHECK ---
    // The server now CHECKS if the requested room is on your approved list.
    if (approvedEvents.includes(room)) {
        // If it's approved, let them in.
        socket.join(room);
        socket.username = username;
        socket.room = room;

        if (!rooms[room]) {
            rooms[room] = [];
        }
        rooms[room].push(username);

        socket.emit('system message', `Welcome to the '${room}' event!`);
        socket.to(room).emit('system message', `${username} has joined the event.`);
        io.to(room).emit('update users', rooms[room]);

    } else {
        // If the event name is NOT on your list, REJECT them.
        socket.emit('join error', 'This event does not exist. Please check the event name.');
    }
    // --- END OF SECURITY CHECK ---
  });

  socket.on('chat message', ({ username, room, message }) => {
    io.to(room).emit('chat message', { username, message });
  });

  socket.on('disconnect', () => {
    if (socket.username && socket.room) {
        const room = socket.room;
        const username = socket.username;
        if (rooms[room]) {
            rooms[room] = rooms[room].filter(user => user !== username);
            io.to(room).emit('system message', `${username} has left the event.`);
            io.to(room).emit('update users', rooms[room]);
        }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Secure server with event list is running on port ${PORT}`);
});
