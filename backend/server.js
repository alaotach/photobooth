const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    console.log(`User ${socket.id} joined room ${roomId}`);
    
    // Tell other users in the room that someone new joined
    socket.to(roomId).emit('user-connected', socket.id);
  });

  socket.on('offer', (payload) => {
    io.to(payload.target).emit('offer', {
      caller: socket.id,
      sdp: payload.sdp
    });
  });

  socket.on('answer', (payload) => {
    io.to(payload.target).emit('answer', {
      callee: socket.id,
      sdp: payload.sdp
    });
  });

  socket.on('ice-candidate', (payload) => {
    io.to(payload.target).emit('ice-candidate', {
      sender: socket.id,
      candidate: payload.candidate
    });
  });

  socket.on('change-background', (payload) => {
    // payload: { roomId, bgUrl }
    socket.to(payload.roomId).emit('change-background', payload.bgUrl);
  });

  socket.on('depth-update', (payload) => {
    io.to(payload.target).emit('depth-update', payload.depth);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    socket.broadcast.emit('user-disconnected', socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});
