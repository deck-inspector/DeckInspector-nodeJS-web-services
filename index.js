"use strict";
require("dotenv").config();
const swaggerUi = require("swagger-ui-express");
const swaggerJsdoc = require("swagger-jsdoc");
const express = require("express");
const http = require("http");

const app = express();
app.set("port", process.env.PORT || 3000);
// Import HTTP module
const server = http.createServer(app); // Create HTTP server

var path = require("path");
var bodyParser = require("body-parser");
const cors = require("cors");
const { connectToDatabase } = require("./database/couchbase");

app.use(cors());
app.timeout = 600000;

require("./routes")(app);
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
  apis: ["./api-docs/*.yaml"],
};

const specs = swaggerJsdoc(options);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs));

// Start the server with Couchbase connection
server.listen(app.get("port"), async function () {
  console.log("Express server listening on port " + server.address().port);

  // Initialize Couchbase connection on app startup
  try {
    await connectToDatabase();
    console.log("Couchbase database connection established successfully");
  } catch (error) {
    console.error("Failed to connect to Couchbase:", error);
    process.exit(1);
  }
});
