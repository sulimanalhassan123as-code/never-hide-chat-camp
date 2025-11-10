// index.js (Version with Pro Features: Timestamps, Online & Typing Status)
const express = require('express');
const http = require('http');
const app = express();
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// This is YOUR list of approved events.
const approvedEvents = [
    "WebDev Class 101",
    "Monday Review",
    "Project Alpha Kick-off",
    "General Student Chat"
];

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// --- FEATURE UPGRADE: We now store more user data ---
// Instead of just a list of names, we store objects with name and status.
// rooms = { "WebDev Class 101": [ {id: "socketid1", name: "Sulley", status: "online"} ] }
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
        // Add the new user with their details
        rooms[room].push({ id: socket.id, name: username, status: 'online' });

        socket.emit('system message', { text: `Welcome to the '${room}' event!`, time: new Date().toLocaleTimeString() });
        socket.to(room).emit('system message', { text: `${username} has joined the event.`, time: new Date().toLocaleTimeString() });
        io.to(room).emit('update users', rooms[room]);

    } else {
        socket.emit('join error', 'This event does not exist. Please check the event name.');
    }
  });

  // --- FEATURE UPGRADE: Handle typing events ---
  socket.on('typing', ({ room, username }) => {
    // Find the user in the room and update their status
    if(rooms[room]) {
        const user = rooms[room].find(u => u.name === username);
        if (user) user.status = 'typing...';
        // Send the updated list to everyone in the room
        io.to(room).emit('update users', rooms[room]);
    }
  });

  socket.on('stop typing', ({ room, username }) => {
    // Find the user and change their status back to 'online'
    if(rooms[room]) {
        const user = rooms[room].find(u => u.name === username);
        if (user) user.status = 'online';
        io.to(room).emit('update users', rooms[room]);
    }
  });

  socket.on('chat message', ({ username, room, message }) => {
    // --- FEATURE UPGRADE: Add a timestamp to every message ---
    const timestamp = new Date().toLocaleTimeString();
    io.to(room).emit('chat message', { username, message, time: timestamp });
  });

  socket.on('disconnect', () => {
    if (socket.username && socket.room) {
        const room = socket.room;
        const username = socket.username;
        if (rooms[room]) {
            // Remove user from our list
            rooms[room] = rooms[room].filter(user => user.id !== socket.id);
            
            io.to(room).emit('system message', { text: `${username} has left the event.`, time: new Date().toLocaleTimeString() });
            io.to(room).emit('update users', rooms[room]);
        }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Pro server is running on port ${PORT}`);
});
