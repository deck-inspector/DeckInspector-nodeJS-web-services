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
var apkRouter = require("./routes/apk-endpoint");
var clientsRouter = require("./routes/clients-endpoint");
// Review of Prior Inspection Report - prior-report upload, Claude draft, Word generation (routes/review-endpoint.js)
var reviewRouter = require("./routes/review-endpoint");
// Visual Report - Claude drafts every section + the Final Report summary (routes/visualai-endpoint.js)
var visualAiRouter = require("./routes/visualai-endpoint");
// Repairs portal - contractor photos, supervisor sign-off, inspector review (routes/repairs-endpoint.js)
var repairsRouter = require("./routes/repairs-endpoint");
// Client portal invitations (Oct 31 2026): member side + public accept page (routes/invite-endpoint.js)
const inviteRoutes = require("./routes/invite-endpoint");
// Client portal billing (Nov 1 2026): Stripe webhook + E3 Admin fee controls (routes/billing-endpoint.js)
const billingRoutes = require("./routes/billing-endpoint");
// Client portal (Oct 23 2026): read-only owner / property-manager logins.
const { clientGuard, portalPhoto, portalReport } = require("./service/clientAccess");
// Client portal reports (Nov 1 2026): inspector signs + releases report files (routes/portalreports-endpoint.js)
const portalReportsRouter = require("./routes/portalreports-endpoint");
const portalShield = require("./service/portalShield");
const { authenticate } = require("passport");
const jwt = require("jsonwebtoken");

module.exports = function (app) {
  // the Stripe webhook is signature-checked against the EXACT bytes Stripe sent, so keep them
  app.use(express.json({ verify: (req, res, buf) => { if (String(req.originalUrl || req.url || "").startsWith("/api/portalbilling/webhook")) req.rawBody = buf; } }));
  // CLIENT PORTAL LOCK (Oct 23 2026): runs before every router. Staff and
  // token-less requests pass through untouched; a client (owner / property
  // manager) token may only READ its own portfolio's inspection - see
  // service/clientAccess.js.
  app.use("/api", clientGuard);
  // PORTAL PHOTOS (Oct 27 2026): what client / contractor logins see instead of
  // storage addresses - expiring, watermarked, reduced size. The signed link is
  // the permission (an <img> can't send a token). See service/portalShield.js.
  app.get("/api/pphoto/:tok", portalPhoto);
  // PORTAL REPORTS (Nov 1 2026): signed reports released to the client stream as PDF
  // through an expiring per-login link (service/portalReports.js).
  app.get("/api/preport/:tok", portalReport);
  app.use("/api/portalreports", authenticateToken, portalReportsRouter);
  // Portal terms of use - staff can read them too (portal logins are answered
  // by clientGuard, which also records their acceptance).
  app.get("/api/portal/terms", authenticateToken, (req, res) => res.status(200).json(portalShield.TERMS));
  app.use("/api/user", authenticateToken, userRouter);
  app.use("/api/projectdocuments", authenticateToken, projectDocumentsRouter);
  // Report downloads stay link-friendly (plain <a href> in the web app, no
  // header possible; they only proxy files from the E3 storage accounts).
  // Listing / adding / deleting report entries needs a signed-in user.
  app.use("/api/projectreports", tokenUnlessDownload, projectReportsRouter);
  app.use("/api/image", authenticateToken, imageRouter);
  app.use("/api/project", authenticateToken, projectRouter);
  // These inspection routers used to accept requests with NO token at all
  // (anyone could add / edit sections). The web app and admin site always send
  // the token; the phone app writes through Sync Gateway, not these routes.
  app.use("/api/subproject", authenticateToken, subprojectRouter);
  app.use("/api/location", authenticateToken, locationRouter);
  app.use("/api/section", authenticateToken, sectionRouter);
  app.use("/api/dynamicsection", authenticateToken, dynamicSectionRouter);
  app.use("/api/invasivesection", authenticateToken, invasivesectionRouter);
  app.use("/api/conclusivesection", authenticateToken, conclusiveSectionRouter);
  app.use("/api/tenants", authenticateToken, tenantRouter);
  // Client portfolios - owners / property managers and their properties (routes/clients-endpoint.js)
  app.use("/api/clients", authenticateToken, clientsRouter);
  app.use("/api/review", authenticateToken, reviewRouter);
  app.use("/api/visualai", authenticateToken, visualAiRouter);
  app.use("/api/repairs", authenticateToken, repairsRouter);
// CLIENT PORTAL INVITATIONS (Oct 31 2026): admins invite a client by email + one-time code
app.use("/api/portalinvite", authenticateToken, inviteRoutes.memberRouter);
// PUBLIC: the client opens the invitation link and creates its own login - no token yet
app.use("/api/invite", inviteRoutes.publicRouter);
// CLIENT PORTAL BILLING (Nov 1 2026): PUBLIC Stripe webhook (signature-checked) + E3 Admin-only routes (own check)
app.use("/api/portalbilling", billingRoutes);
  app.use("/api/login", loginRouter);
  app.use("/api/locationforms", authenticateToken, locationFormRouter);
  app.use("/api/migrate", migrateRouter);
  // PUBLIC QuickBooks OAuth callback (state-signed; see routes/qbo-endpoint.js)
  app.use("/api/qbo", qboRouter);
  // PUBLIC Android APK install page + download (routes/apk-endpoint.js)
  app.use("/apk", apkRouter);
};

function tokenUnlessDownload(req, res, next) {
  const p = String(req.path || "").toLowerCase();
  if (req.method === "GET" && (p === "/downloadfile" || p === "/downloadpdf")) return next();
  return authenticateToken(req, res, next);
}

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
