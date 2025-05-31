"use strict";
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
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


// Socket.IO connection handling
wss.on("connection", (ws, req) => {
  console.log("🟢 Client connected");
  ws._socket.setKeepAlive(true, 60000);
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
    console.log("🔴 Client disconnected");
  });

  ws.on("error", (err) => {
    console.error("⚠️ WebSocket error:", err);
  });
  ws.cors = {
    origin: '*',
  };
});

app.set('port', process.env.PORT || 3000);
// Start the server
server.listen(app.get('port'),"0.0.0.0", ()=> {
    console.log('Express server listening on port ' + server.address().port);
});

