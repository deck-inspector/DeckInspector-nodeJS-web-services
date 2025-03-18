const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Attach Socket.IO to the HTTP server
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins (adjust for security)
        methods: ["GET", "POST"]
    }
});

// Express route
app.get("/", (req, res) => {
    res.send("Hello from Express Server!");
});

// Handle WebSocket connections
io.on("connection", (socket) => {
    console.log(`🔌 New client connected: ${socket.id}`);

    socket.on("message", (data) => {
        console.log(`📩 Message from ${socket.id}:`, data);
        socket.emit("message", `Echo: ${data}`);
    });

    socket.on("disconnect", (reason) => {
        console.log(`❌ Client disconnected: ${socket.id}, Reason: ${reason}`);
    });
});

// Start the server
const PORT = 4000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
