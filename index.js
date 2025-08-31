"use strict";
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const redisManager = require('./sync-services/redisService');
const app = express();
const { startAllCollectionStreams } = require('./sync-services/collectionStreamer');


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
const fs = require('fs').promises;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

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
(async () => {await cleanUploadsDir(); await mongo.Connect();
  startAllCollectionStreams();
})();

(async () => {
  await redisManager.connectRedis();
  // Set a test key
  await redisManager.redisClient.set('test-key', 'hello');
  const value = await redisManager.redisClient.get('test-key');
  console.log('Value from Redis:', value);
})();

async function cleanUploadsDir() {
  try {
    // Ensure uploads dir exists
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    const entries = await fs.readdir(UPLOADS_DIR, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(UPLOADS_DIR, entry.name);
      // remove files or directories
      await fs.rm(fullPath, { recursive: true, force: true });
    }));
    console.log('✅ Uploads folder cleaned');
  } catch (err) {
    console.error('Failed to clean uploads folder:', err);
  }
}


// Socket.IO connection handling
wss.on("connection", (ws, req) => {
  console.log("🟢 Client connected");
  ws._socket.setKeepAlive(true, 60000);
  ws.once("message", async (initMessage) => {
    let clientId;
    let companyIdentifier;
    try {
      const initData = JSON.parse(initMessage);
      clientId = initData.clientId;
      companyIdentifier = initData.companyIdentifier;
      if (!clientId || !companyIdentifier) {
        ws.send(JSON.stringify({ status: 'error', message: 'clientId and companyIdentifier required on connect' }));
        ws.close();
        return;
      }
      ws.clientId = clientId;
      redisManager.addClient(clientId,companyIdentifier, ws);

      // Deliver any queued messages from Redis Stream
      await redisManager.deliverQueuedMessages(clientId,companyIdentifier, ws);
      
    } catch (e) {
      ws.send(JSON.stringify({ status: 'error', message: 'Invalid init message' }));
      ws.close();
      return;
    }

    // replace original on-message handler with queued sequential processor
    ws._messageQueue = [];
    ws._deferredQueue = [];
    ws._processingQueue = false;

    ws.on("message", (message) => {
      // classify and enqueue message
      let parsed;
      try {
        parsed = JSON.parse(message);
      } catch (e) {
        // on parse failure, push to main queue so processor can report error
        ws._messageQueue.push({ raw: message, parsed: null });
        startProcessorIfNeeded();
        return;
      }

      // events to defer to the end
      const DEFER_EVENTS = new Set(['addImageCount', 'addImages']);
      if (parsed && DEFER_EVENTS.has(parsed.action)) {
        ws._deferredQueue.push({ raw: message, parsed });
      } else {
        ws._messageQueue.push({ raw: message, parsed });
      }

      // protect against unbounded queue growth across both queues
      const MAX_QUEUE = 5000;
      if (ws._messageQueue.length + ws._deferredQueue.length > MAX_QUEUE) {
        console.warn(`Message queue exceeded ${MAX_QUEUE} for client ${ws.clientId}, dropping oldest message`);
        // drop from main queue first, otherwise from deferred
        if (ws._messageQueue.length > 0) ws._messageQueue.shift();
        else ws._deferredQueue.shift();
      }

      startProcessorIfNeeded();
    });

    function startProcessorIfNeeded() {
      if (!ws._processingQueue) {
        processQueue().catch(err => console.error('Queue processor error:', err));
      }
    }

    async function processQueue() {
      ws._processingQueue = true;
      // process main queue first
      while (ws._messageQueue.length > 0) {
        const item = ws._messageQueue.shift();
        await processQueueItem(item);
      }

      // after main queue drained, process deferred items in order
      while (ws._deferredQueue.length > 0) {
        const item = ws._deferredQueue.shift();
        await processQueueItem(item);
      }

      ws._processingQueue = false;
    }

    async function processQueueItem(item) {
      const { raw, parsed } = item;
      try {
        const parsedMessage = parsed || JSON.parse(raw);
        const compId = ws.clientId + '.' + companyIdentifier;

        // ack handling
        if (parsedMessage.type === 'ack' && parsedMessage.redisEntryId && ws.clientId) {
          await redisManager.deleteQueuedMessage(compId, parsedMessage.redisEntryId);
          return;
        }

        console.log('Collection Name: ', parsedMessage.collectionName);
        console.log('Event Name: ', parsedMessage.action);

        let updateResult = false;
        switch (parsedMessage.collectionName) {
          case 'project':
            updateResult = await projectSocketHandler(raw, ws, app);
            break;
          case 'subProject':
            updateResult = await subProjectSocketHandler(raw, ws, app);
            break;
          case 'location':
            updateResult = await locationSocketHandler(raw, ws, app);
            break;
          case 'visualSection':
            updateResult = await visualSectionSocketHandler(raw, ws, app);
            break;
          case 'invasiveSection':
            updateResult = await invasiveSectionSocketHandler(raw, ws, app);
            break;
          case 'dynamicSection':
            updateResult = await dynamicSectionSocketHandler(raw, ws, app);
            break;
          case 'conclusiveSection':
            updateResult = await conclusiveSectionSocketHandler(raw, ws, app);
            break;
          default:
            try { ws.send(JSON.stringify({ status: 'error', message: 'Unknown collection' })); } catch(e){}
        }

      } catch (err) {
        console.error('Error processing queued message for', ws.clientId, err);
        try { ws.send(JSON.stringify({ status: 'error', message: 'Invalid message format' })); } catch (_) {}
      }
    }
    
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


