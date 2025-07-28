"use strict";
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const redisManager = require('./sync-services/redisService');
const app = express();


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
const conclusiveSectionSocketHandler = require('./sync-services/conclusiveSectionSocketHandler');
const { measureMemory } = require('vm');

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

(async () => {
  await redisManager.connectRedis();
  // Set a test key
  await redisManager.redisClient.set('test-key', 'hello');
  const value = await redisManager.redisClient.get('test-key');
  console.log('Value from Redis:', value);
})();


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
      redisManager.addClient(clientId, ws);

      // Deliver any queued messages from Redis Stream
      await redisManager.deliverQueuedMessages(clientId, ws);
      
    } catch (e) {
      ws.send(JSON.stringify({ status: 'error', message: 'Invalid init message' }));
      ws.close();
      return;
    }

    ws.on("message", async (message) => {
      //console.log("📩 Received:", message);
      try {
        const parsedMessage = JSON.parse(message);
        console.log("Collection Name: ", parsedMessage.collectionName);
        console.log("Event Name: ", parsedMessage.action);
        let updateResult =false;
        // Route the message to the appropriate handler based on the collection
        switch (parsedMessage.collectionName) {
        
        case 'project':
          updateResult= await projectSocketHandler(message, ws,app);
          break;
        case 'subProject':
          updateResult= await subProjectSocketHandler(message, ws,app);
          break;
        case 'location':
          updateResult= await locationSocketHandler(message, ws,app);
          break;
        case 'visualSection':
          updateResult= await visualSectionSocketHandler(message, ws,app);
          break;
        case 'invasiveSection':
          updateResult= await invasiveSectionSocketHandler(message, ws,app);
          break;
        case 'dynamicSection':
          updateResult= await dynamicSectionSocketHandler(message, ws,app);
          break;
        case 'conclusiveSection':
          updateResult= await conclusiveSectionSocketHandler(message, ws,app);
          break;
        default:
          ws.send(JSON.stringify({ status: 'error', message: 'Unknown collection' }));
      }
      if (updateResult) {
        //broadcast to all clients
        redisManager.broadcastToOthers(parsedMessage.clientId,message)
      }
    } catch (error) {
      console.error('Error processing message:', error);
      ws.send(JSON.stringify({ status: 'error', message: 'Invalid message format' }));
    }
    });
    
    ws.on("close", () => {
      redisManager.removeClient(clientId);
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

app.set('port', process.env.PORT || 3000);
// Start the server
server.listen(app.get('port'),"0.0.0.0", ()=> {
    console.log('Express server listening on port ' + server.address().port);
});

