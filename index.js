// index.js (The Server Engine)
const express = require('express');
const http = require('http');
const app = express();
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// This line serves the single HTML file as our website
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

const rooms = {};

io.on('connection', (socket) => {
  // When a user joins a room
  socket.on('join room', ({ username, room }) => {
    socket.join(room); // The command to put a user in a room
    socket.username = username;
    socket.room = room;

    if (!rooms[room]) {
        rooms[room] = [];
    }
    rooms[room].push(username);

    // Send a welcome message to the user who just joined
    socket.emit('system message', `Welcome to the '${room}' event!`);
    
    // Tell everyone ELSE in the room that a new person has joined
    socket.to(room).emit('system message', `${username} has joined the event.`);

    // Send the updated user list to EVERYONE in that room
    io.to(room).emit('update users', rooms[room]);
  });

  // When a user sends a chat message
  socket.on('chat message', ({ username, room, message }) => {
    // Send the message only to users in that specific room
    io.to(room).emit('chat message', { username, message });
  });

  // When a user disconnects
  socket.on('disconnect', () => {
    if (socket.username && socket.room) {
        const room = socket.room;
        const username = socket.username;
        
        // Remove user from our list
        if (rooms[room]) {
            rooms[room] = rooms[room].filter(user => user !== username);
            
            // Tell everyone in the room that the person has left
            io.to(room).emit('system message', `${username} has left the event.`);
            
            // Send the updated user list to everyone in that room
            io.to(room).emit('update users', rooms[room]);
        }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server with event rooms is running on port ${PORT}`);
});
