"use strict";
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const express = require('express');
const http = require('http');
const socketIO = require('socket.io'); // Import Socket.IO

const app = express();
app.set('port', process.env.PORT || 3000);
 // Import HTTP module
const server = http.createServer(app); // Create HTTP server

var path = require('path');
var bodyParser = require('body-parser');
const cors = require('cors');
var mongo = require('./database/mongo');
const projectSocketHandler = require('./sync-services/projectSocketHandler');

const io =  socketIO(server,{
  cors: {
      origin: "*", // Allow all origins (adjust for security)
      methods: ["GET", "POST"]
  }
}); // Initialize Socket.IO with the HTTP server

app.use(cors());
app.timeout = 600000;

require('./routes')(app);
app.get("/", (req, res) => {
  res.send("Hello from Express!");
});
app.use(bodyParser.json());

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
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    // Attach projectSocketHandler to handle project-related socket events
    projectSocketHandler(socket, io);

    socket.on('test', (data) => {
      console.log('Test event received:', data);
      socket.emit('testResponse', { message: 'Test successful!' })
    });
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
  });


// Start the server
server.listen(app.get('port'), async function () {
    console.log('Express server listening on port ' + server.address().port);
});

