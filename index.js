"use strict";
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const app = express();
const redis = require('redis');
const { promisify } = require('util');

const server = http.createServer(app); // Create HTTP server
const wss = new WebSocket.Server({server}); // Attach WebSocket server to HTTP server
var path = require('path');
var bodyParser = require('body-parser');
const cors = require('cors');
var mongo = require('./database/mongo');
const projectSocketHandler = require('./sync-services/projectSocketHandler');
const subProjectSocketHandler = require('./sync-services/subProjectSocketHandler');
const locationSocketHandler = require('./sync-services/locationSocketHandler');
const visualSectionSocketHandler = require('./sync-services/visualSectionSocketHandler');
const invasiveSectionSocketHandler = require('./sync-services/invasiveSectionSocketHandler');
const dynamicSectionSocketHandler = require('./sync-services/dynamicSectionSocketHandler');

app.use(cors());
app.use(bodyParser.json());
app.timeout = 600000;
//change to trigger build
require('./routes')(app);

// Swagger details
const options = {
    definition: {
      openapi: "3.0.0",
      info: {
        title: "Library API",
        version: "1.0.0",
        description: "DeckInspectors Library API",
        termsOfService: "http://example.com/terms/",
        contact: {
          name: "API Support",
          url: "http://www.exmaple.com/support",
          email: "support@example.com",
        },
      },
      servers: [
        {
          url: "deckmultitenantwebservices.azurewebsites.net",
          description: "Prod Deck Inspectors Documentation",
        },
        {
          url: "http://localhost:3000",
          description: "Local Deck Inspectors Documentation",
        },
      ],
    },
    apis: ['./api-docs/*.yaml'],
};
  
const specs = swaggerJsdoc(options);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs));

// Initialize SERVER & DB connection once
mongo.Connect();

const redisHost = process.env.REDIS_HOST; 
const redisPassword = process.env.REDIS_KEY;

const redisClient = redis.createClient({
  url: `rediss://${redisHost}:6380`,
  password: redisPassword,
  socket: {
    tls: true,
    rejectUnauthorized: false 
  }
});
redisClient.connect().catch(console.error);

const REDIS_STREAM_PREFIX = 'ws_offline_';

// Helper: Add message to Redis Stream for a client
async function queueMessage(clientId, message) {
  await redisClient.xAdd(
    REDIS_STREAM_PREFIX + clientId,
    '*',
    { message: typeof message === 'string' ? message : JSON.stringify(message) }
  );
}

// Helper: Deliver queued messages from Redis Stream to client
async function deliverQueuedMessages(clientId, ws) {
  const streamKey = REDIS_STREAM_PREFIX + clientId;
  // Read all messages from the stream
  let lastId = '0-0';
  while (true) {
    const entries = await redisClient.xRead(
      [{ key: streamKey, id: lastId }],
      { COUNT: 10, BLOCK: 200 }
    );
    if (!entries || entries.length === 0) break;
    for (const entry of entries[0].messages) {
      const msg = entry.message.message;
      ws.send(msg);
      lastId = entry.id;
    }
  }
  // Delete the stream after delivery
  await redisClient.del(streamKey);
}

// Map to track connected clients: clientId -> ws
const clients = new Map();


// Socket.IO connection handling
wss.on("connection", (ws, req) => {
  console.log("🟢 Client connected");
  ws._socket.setKeepAlive(true, 60000);
  ws.once("message", async (initMessage) => {
    let clientId;
    try {
      const initData = JSON.parse(initMessage);
      clientId = initData.clientId;
      if (!clientId) {
        ws.send(JSON.stringify({ status: 'error', message: 'clientId required on connect' }));
        ws.close();
        return;
      }
      ws.clientId = clientId;
      clients.set(clientId, ws);

      // Deliver any queued messages from Redis Stream
      await deliverQueuedMessages(clientId, ws);
    } catch (e) {
      ws.send(JSON.stringify({ status: 'error', message: 'Invalid init message' }));
      ws.close();
      return;
    }

    ws.on("message", async (message) => {
      //console.log("📩 Received:", message);
      try{
      const parsedMessage = JSON.parse(message);
      console.log("Collection Name: ", parsedMessage.collectionName);
      console.log("Event Name: ", parsedMessage.action);
      // Route the message to the appropriate handler based on the collection
      switch (parsedMessage.collectionName) {
        
        case 'project':
          await projectSocketHandler(message, ws,app);
          break;
        case 'subProject':
          await subProjectSocketHandler(message, ws,app);
          break;
        case 'location':
          await locationSocketHandler(message, ws,app);
          break;
        case 'visualSection':
          await visualSectionSocketHandler(message, ws,app);
          break;
        case 'invasiveSection':
          await invasiveSectionSocketHandler(message, ws,app);
          break;
        case 'dynamicSection':
          await dynamicSectionSocketHandler(message, ws,app);
          break;
        case 'conclusiveSection':
          await dynamicSectionSocketHandler(message, ws,app);
          break;
        default:
          ws.send(JSON.stringify({ status: 'error', message: 'Unknown collection' }));
      }
    } catch (error) {
      console.error('Error processing message:', error);
      ws.send(JSON.stringify({ status: 'error', message: 'Invalid message format' }));
    }
    });

    ws.on("close", () => {
      clients.delete(clientId);
      console.log("🔴 Client disconnected");
    });

    ws.on("error", (err) => {
      console.error("⚠️ WebSocket error:", err);
    });
    ws.cors = {
      origin: '*',
    };
  });
});

// Helper to send message to a client, or queue in Redis Stream if offline
async function sendOrQueue(clientId, message) {
  const client = clients.get(clientId);
  if (client && client.readyState === WebSocket.OPEN) {
    client.send(message);
  } else {
    await queueMessage(clientId, message);
  }
}

// Example broadcast function (call this in your handlers as needed)
async function broadcastToOthers(senderId, message) {
  for (const [clientId, ws] of clients.entries()) {
    if (clientId !== senderId && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    } else if (clientId !== senderId) {
      await queueMessage(clientId, message);
    }
  }
}

app.set('port', process.env.PORT || 3000);
// Start the server
server.listen(app.get('port'),"0.0.0.0", ()=> {
    console.log('Express server listening on port ' + server.address().port);
});

