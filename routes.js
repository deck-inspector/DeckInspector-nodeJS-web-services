const express = require("express");
var userRouter = require("./routes/user-endpoint");
var projectDocumentsRouter = require("./routes/projectdocuments-endpoint");
var projectReportsRouter = require("./routes/projectreports-endpoint");
var imageRouter = require("./routes/images-endpoint");
var projectRouter = require("./routes/project-endpoint");
var subprojectRouter = require("./routes/subproject-endpoint");
var locationRouter = require("./routes/location-endpoint");
var sectionRouter = require("./routes/section-endpoint");
var dynamicSectionRouter = require("./routes/dynamic-section-endpoint");
var invasivesectionRouter = require("./routes/invasivesection-endpoint");
var conclusiveSectionRouter = require("./routes/conclusivesection-endpoint");
var tenantRouter = require("./routes/tenants-endpoint");
var loginRouter = require("./routes/login-endpoint");
var locationFormRouter = require("./routes/locationform-endpoint");
var migrateRouter = require("./routes/migrate-endpoint");
var qboRouter = require("./routes/qbo-endpoint");
const { authenticate } = require("passport");
const jwt = require("jsonwebtoken");

module.exports = function (app) {
  app.use(express.json());
  app.use("/api/user", authenticateToken, userRouter);
  app.use("/api/projectdocuments", projectDocumentsRouter);
  app.use("/api/projectreports", projectReportsRouter);
  app.use("/api/image", authenticateToken, imageRouter);
  app.use("/api/project", authenticateToken, projectRouter);
  app.use("/api/subproject", subprojectRouter);
  app.use("/api/location", locationRouter);
  app.use("/api/section", sectionRouter);
  app.use("/api/dynamicsection", dynamicSectionRouter);
  app.use("/api/invasivesection", invasivesectionRouter);
  app.use("/api/conclusivesection", conclusiveSectionRouter);
  app.use("/api/tenants", authenticateToken, tenantRouter);
  app.use("/api/login", loginRouter);
  app.use("/api/locationforms", locationFormRouter);
  app.use("/api/migrate", migrateRouter);
  // PUBLIC QuickBooks OAuth callback (state-signed; see routes/qbo-endpoint.js)
  app.use("/api/qbo", qboRouter);
};

function authenticateToken(req, res, next) {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).json({ error: "Unauthorized: Token not provided" });
  }

  jwt.verify(token, process.env.TOKEN_KEY, (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Unauthorized: Invalid token" });
    }

    req.user = user; // Attach user information to the request object
    next();
  });
}
