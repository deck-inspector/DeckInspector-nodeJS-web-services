"use strict";
// CLIENT PORTAL BILLING - routes (PR 3). Mounted at /api/portalbilling (routes.js).
//
//   POST /webhook                 PUBLIC - Stripe -> us, signature-checked (STRIPE_WEBHOOK_SECRET)
//   GET  /admin/config            E3 ADMIN ONLY - settings + Stripe status
//   POST /admin/config            E3 ADMIN ONLY - change price / trial days / intro price / on-off
//   GET  /admin/accounts          E3 ADMIN ONLY - every client's billing standing
//   GET  /admin/account?email=    E3 ADMIN ONLY - one client, with its log
//   POST /admin/waive             E3 ADMIN ONLY - complimentary on/off ({ email, waived, note, until })
//   POST /admin/recount           E3 ADMIN ONLY - re-count properties -> subscription quantity
//   POST /admin/invoice           E3 ADMIN ONLY - invoice billing for a large client
//   GET  /admin/clients           E3 ADMIN ONLY - every portal client login + inspectors + billing
//   GET  /admin/client?id=        E3 ADMIN ONLY - one portal client, with billing history
//   POST /admin/client/login      E3 ADMIN ONLY - the whole login on/off ({ id, active })
//
// "E3 Admin" = a SuperUsers record (the E3 Multi-Tenant admin site login). A tenant
// administrator - the inspecting member - is NOT E3 Admin and has no route here, so a
// member can never waive or change a client's fee (David's rule).

const express = require("express");
const jwt = require("jsonwebtoken");
const couchbase = require("../database/couchbase");
const stripe = require("../service/stripeApi");
const billing = require("../service/portalBilling");
const portalClients = require("../service/portalClients");

const router = express.Router();
const superCache = new Map(); // lower(username) -> { ok, at }

async function isSuperUser(username) {
  const key = String(username || "").toLowerCase();
  if (!key) return false;
  const hit = superCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.ok;
  const q = `SELECT META(u).id AS id FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.SuperUsers u WHERE LOWER(u.username) = LOWER($1) OR LOWER(u.email) = LOWER($1) LIMIT 1`;
  const r = await couchbase.cluster.query(q, { parameters: [key] });
  const ok = !!(r.rows && r.rows.length);
  superCache.set(key, { ok, at: Date.now() });
  return ok;
}

async function e3Admin(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ message: "Unauthorized: Token not provided" });
  let p;
  try { p = jwt.verify(token, process.env.TOKEN_KEY); } catch (e) { return res.status(403).json({ message: "Unauthorized: Invalid token" }); }
  // tenant staff and portal tokens carry a `company`; E3 Admin (super-user) tokens do not
  if (!p || p.company || !p.username) return res.status(403).json({ message: "E3 Admin only." });
  try {
    if (!(await isSuperUser(p.username))) return res.status(403).json({ message: "E3 Admin only." });
  } catch (e) {
    console.error("billing admin check:", e && e.message);
    return res.status(503).json({ message: "Please try again in a moment." });
  }
  req.e3admin = p.username;
  return next();
}

function fail(res, e, what) {
  console.error("portalbilling " + what + ":", e && e.message);
  const status = e && e.status && e.status >= 400 && e.status < 600 ? e.status : 400;
  return res.status(status).json({ success: false, message: (e && e.message) || "Could not complete that." });
}

// ---------------------------------------------------------------------- webhook
router.post("/webhook", async (req, res) => {
  const v = stripe.verifyWebhook(req.rawBody, req.headers["stripe-signature"]);
  if (!v.ok) {
    console.error("stripe webhook rejected:", v.reason);
    return res.status(400).json({ message: "Bad signature." });
  }
  try {
    const out = await billing.handleEvent(req.body);
    return res.status(200).json({ received: true, handled: !!out.handled });
  } catch (e) {
    // 500 makes Stripe retry later (it retries for days)
    console.error("stripe webhook handling:", req.body && req.body.type, "-", e && e.message);
    return res.status(500).json({ message: "Could not process the event." });
  }
});

// ------------------------------------------------------------------- E3 Admin
router.get("/admin/config", e3Admin, async (req, res) => {
  try {
    const cfg = await billing.getConfig(true);
    res.status(200).json({
      success: true, config: cfg, pricing: billing.pricing(cfg), priceLine: billing.priceLine(cfg),
      stripe: { configured: stripe.configured(), testMode: stripe.testMode(), webhookSecretSet: !!process.env.STRIPE_WEBHOOK_SECRET },
    });
  } catch (e) { fail(res, e, "config"); }
});

router.post("/admin/config", e3Admin, async (req, res) => {
  try {
    const b = req.body || {};
    if (b.enabled === true && !stripe.configured()) throw new Error("Add STRIPE_SECRET_KEY in the App Service settings before switching billing on.");
    if (b.enabled === true && !process.env.STRIPE_WEBHOOK_SECRET) throw new Error("Add STRIPE_WEBHOOK_SECRET in the App Service settings before switching billing on.");
    const cfg = await billing.saveConfig(b, req.e3admin);
    res.status(200).json({ success: true, config: cfg, pricing: billing.pricing(cfg), priceLine: billing.priceLine(cfg) });
  } catch (e) { fail(res, e, "save config"); }
});

router.get("/admin/accounts", e3Admin, async (req, res) => {
  try { res.status(200).json({ success: true, accounts: await billing.adminList() }); } catch (e) { fail(res, e, "list"); }
});

router.get("/admin/account", e3Admin, async (req, res) => {
  try { res.status(200).json({ success: true, account: await billing.adminView(req.query.email) }); } catch (e) { fail(res, e, "view"); }
});

router.post("/admin/waive", e3Admin, async (req, res) => {
  try {
    const b = req.body || {};
    const account = await billing.waive(b.email, b.waived !== false, b.note, b.until, req.e3admin);
    res.status(200).json({ success: true, account });
  } catch (e) { fail(res, e, "waive"); }
});

router.post("/admin/recount", e3Admin, async (req, res) => {
  try { res.status(200).json({ success: true, account: await billing.adminRecount((req.body || {}).email, req.e3admin) }); } catch (e) { fail(res, e, "recount"); }
});

// PORTAL CLIENTS (Nov 1 2026) - every property-owner login, its inspectors and billing.
router.get("/admin/clients", e3Admin, async (req, res) => {
  try { res.status(200).json({ success: true, clients: await portalClients.list() }); } catch (e) { fail(res, e, "clients"); }
});
router.get("/admin/client", e3Admin, async (req, res) => {
  try { res.status(200).json({ success: true, client: await portalClients.view(req.query.id) }); } catch (e) { fail(res, e, "client"); }
});
// The whole login on/off - E3 Admin only (an inspector only ends its own access).
router.post("/admin/client/login", e3Admin, async (req, res) => {
  try {
    const b = req.body || {};
    res.status(200).json({ success: true, client: await portalClients.setLogin(b.id, b.active !== false, req.e3admin) });
  } catch (e) { fail(res, e, "client login"); }
});

router.post("/admin/invoice", e3Admin, async (req, res) => {
  try {
    const b = req.body || {};
    res.status(200).json({ success: true, account: await billing.adminInvoiceBilling(b.email, b.interval, b.daysUntilDue, req.e3admin) });
  } catch (e) { fail(res, e, "invoice"); }
});

module.exports = router;
