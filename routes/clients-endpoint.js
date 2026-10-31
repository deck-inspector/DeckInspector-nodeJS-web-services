"use strict";
// Client portfolios (David, Sep 19 2026). Mounted at /api/clients behind
// authenticateToken; every call is scoped to req.user.company. See model/clients.js.
const express = require("express");
const router = express.Router();
const clients = require("../model/clients");
const projectService = require("../service/projectService");

function company(req) { return req.user && req.user.company; }

// GET /api/clients?type=owner|manager&archived=1
router.get("/", async (req, res) => {
  try {
    const rows = await clients.getClientsByCompany(company(req), {
      type: req.query.type, includeArchived: req.query.archived === "1",
    });
    res.status(200).json(rows);
  } catch (e) {
    console.error("clients list:", e && e.message);
    res.status(500).json({ message: "Could not list clients." });
  }
});

// POST /api/clients/save  { id?, clientType, name, contactName, phone, email, address{}, notes }
router.post("/save", async (req, res) => {
  try {
    const b = req.body || {};
    if (b.id) {
      const cur = await clients.getClientById(b.id);
      if (!cur || cur.companyIdentifier !== company(req)) return res.status(404).json({ message: "Client not found." });
    }
    const saved = await clients.upsertClient({
      ...b, companyIdentifier: company(req), createdBy: req.user && req.user.username,
    });
    let touched = 0;
    if (b.id) touched = await clients.fanOutSnapshot(saved, projectService.editProject);
    res.status(200).json({ client: saved, projectsUpdated: touched });
  } catch (e) {
    console.error("client save:", e && e.message);
    res.status(400).json({ message: (e && e.message) || "Could not save the client." });
  }
});

// POST /api/clients/archive { id, archived:true|false } - refused while the portfolio is non-empty
router.post("/archive", async (req, res) => {
  try {
    const cur = await clients.getClientById(req.body && req.body.id);
    if (!cur || cur.companyIdentifier !== company(req)) return res.status(404).json({ message: "Client not found." });
    const archive = req.body.archived !== false;
    if (archive) {
      const n = await clients.portfolioCount(company(req), cur.id);
      if (n > 0) return res.status(409).json({ message: `This client still has ${n} propert${n === 1 ? "y" : "ies"}. Move or remove them first.` });
    }
    const saved = await clients.upsertClient({ ...cur, isActive: !archive });
    res.status(200).json({ client: saved });
  } catch (e) {
    console.error("client archive:", e && e.message);
    res.status(500).json({ message: "Could not update the client." });
  }
});

// GET /api/clients/:id/projects - the portfolio
router.get("/:id/projects", async (req, res) => {
  try {
    const cur = await clients.getClientById(req.params.id);
    if (!cur || cur.companyIdentifier !== company(req)) return res.status(404).json({ message: "Client not found." });
    res.status(200).json(await clients.getPortfolio(company(req), cur.id));
  } catch (e) {
    console.error("client portfolio:", e && e.message);
    res.status(500).json({ message: "Could not load the portfolio." });
  }
});

// ---------------------------------------------------------------------------
// CLIENT PORTAL LOGINS (Oct 23 2026) - read-only website logins for the people
// at an owner / property manager. ADMINS ONLY. A login sees the inspections of
// this client's portfolio and nothing else (service/clientAccess.js). Logins
// never count against the tenant's inspector seats.
// ---------------------------------------------------------------------------
const bcrypt = require("bcrypt");
const users = require("../model/user");
const { forgetUser } = require("../service/clientAccess");

async function requireAdmin(req, res) {
  try {
    const me = await users.getUserbyUsername(req.user && req.user.username);
    if (me && String(me.role || "").toLowerCase() === "admin" && me.companyIdentifier === company(req)) return true;
  } catch (e) { /* fall through */ }
  res.status(403).json({ message: "Only an admin can manage client logins." });
  return false;
}

async function clientOf(req, res) {
  const cur = await clients.getClientById(req.params.id);
  if (!cur || cur.companyIdentifier !== company(req)) {
    res.status(404).json({ message: "Client not found." });
    return null;
  }
  return cur;
}

// The target login must be a client login of THIS client in THIS tenant - either
// its own (primary) login or one linked to it from another inspector (PR 2).
// Returns the record with `linked: true` when it reaches this client through a link.
const portalLinks = require("../model/portalLinks");
async function loginOf(req, res, client, username) {
  const rec = username ? await users.getUserbyUsername(String(username)) : null;
  if (rec && String(rec.role || "").toLowerCase() === "client") {
    if (rec.companyIdentifier === company(req) && rec.clientId === client.id) return rec;
    if (portalLinks.hasLink(rec, company(req), client.id)) return Object.assign({}, rec, { linked: true });
  }
  res.status(404).json({ message: "Login not found for this client." });
  return null;
}

// GET /api/clients/:id/logins - this client's own logins + logins shared from
// another inspector (one person, several inspectors - PR 2)
router.get("/:id/logins", async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const cur = await clientOf(req, res); if (!cur) return;
    const own = await users.getClientUsers(company(req), cur.id);
    let linked = [];
    try { linked = await portalLinks.linkedUsers(company(req), cur.id); } catch (e) { console.error("linked logins:", e && e.message); }
    res.status(200).json(own.concat(linked));
  } catch (e) {
    console.error("client logins list:", e && e.message);
    res.status(500).json({ message: "Could not list the logins." });
  }
});

// POST /api/clients/:id/logins { username, password, first_name, last_name, email, mobile }
router.post("/:id/logins", async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const cur = await clientOf(req, res); if (!cur) return;
    const b = req.body || {};
    const username = String(b.username || "").trim();
    const email = String(b.email || "").trim().toLowerCase();
    const password = String(b.password || "");
    if (!/^[A-Za-z0-9._@-]{3,60}$/.test(username)) return res.status(400).json({ message: "Username: 3-60 letters, numbers, . _ - or @." });
    if (password.length < 8) return res.status(400).json({ message: "Password must be at least 8 characters." });
    const free = await users.claimIdentity(username, email);
    if (!free.ok) return res.status(409).json({ message: free.message, field: free.field });
    const r = await users.addClientUser({
      username, email,
      first_name: String(b.first_name || "").trim().slice(0, 80),
      last_name: String(b.last_name || "").trim().slice(0, 80),
      mobile: String(b.mobile || "").trim().slice(0, 40),
      password: await bcrypt.hash(password, 10),
      clientId: cur.id,
      companyIdentifier: company(req),
      createdBy: req.user && req.user.username,
    });
    res.status(201).json({ ok: 1, id: r.insertedId, username });
  } catch (e) {
    console.error("client login create:", e && e.message);
    res.status(500).json({ message: "Could not create the login." });
  }
});

// POST /api/clients/:id/logins/status { username, active:true|false }
router.post("/:id/logins/status", async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const cur = await clientOf(req, res); if (!cur) return;
    const rec = await loginOf(req, res, cur, req.body && req.body.username); if (!rec) return;
    const active = req.body.active !== false;
    if (rec.linked) {
      // a shared login: only THIS inspector's access is switched, the login itself stays
      await portalLinks.setLinkActive(rec.id, company(req), cur.id, active);
      forgetUser(rec.username);
      return res.status(200).json({ ok: 1, message: active ? "Access to your properties turned on." : "Access to your properties turned off. The login itself still works for their other inspectors.", username: rec.username });
    }
    const r = await users.setActive(rec, active, req.body.newUsername);
    forgetUser(rec.username); // takes effect on the client's next request
    if (r.status !== 201) return res.status(r.status).json(r);
    res.status(200).json({ ok: 1, message: r.message, username: r.username || "" });
  } catch (e) {
    console.error("client login status:", e && e.message);
    res.status(500).json({ message: "Could not update the login." });
  }
});

// POST /api/clients/:id/logins/password { username, password }
router.post("/:id/logins/password", async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const cur = await clientOf(req, res); if (!cur) return;
    const rec = await loginOf(req, res, cur, req.body && req.body.username); if (!rec) return;
    if (rec.linked) return res.status(409).json({ message: "This login was created by another inspector and is shared with you; only that inspector can reset its password." });
    const password = String((req.body && req.body.password) || "");
    if (password.length < 8) return res.status(400).json({ message: "Password must be at least 8 characters." });
    await users.resetUserPassword(rec.username, company(req), password);
    res.status(200).json({ ok: 1 });
  } catch (e) {
    console.error("client login password:", e && e.message);
    res.status(500).json({ message: "Could not reset the password." });
  }
});

// GET /api/clients/:id/activity?days=30 - what this client's portal logins (its
// people and its contractors) looked at: last seen, properties, photos, slow-downs,
// where from. ADMINS ONLY. (service/portalShield.js keeps the log, Oct 27 2026)
router.get("/:id/activity", async (req, res) => {
  try {
    if (!(await requireAdmin(req, res))) return;
    const cur = await clientOf(req, res); if (!cur) return;
    const days = Math.min(180, Math.max(1, parseInt(req.query.days, 10) || 30));
    const shield = require("../service/portalShield");
    const rows = await shield.activityFor(company(req), cur.id, days);
    let names = {};
    try {
      const props = await clients.getPortfolio(company(req), cur.id);
      for (const p of props || []) names[p.id || p._id] = p.name || p.address || "";
    } catch (e) { names = {}; }
    res.status(200).json({
      days,
      logins: rows.map((a) => Object.assign({}, a, {
        properties: Object.entries(a.projects || {})
          .map(([id, n]) => ({ id, name: names[id] || "(property not in this portfolio)", views: n }))
          .sort((x, y) => y.views - x.views),
      })),
    });
  } catch (e) {
    console.error("client activity:", e && e.message);
    res.status(500).json({ message: "Could not load the activity." });
  }
});

// GET /api/clients/:id
router.get("/:id", async (req, res) => {
  try {
    const cur = await clients.getClientById(req.params.id);
    if (!cur || cur.companyIdentifier !== company(req)) return res.status(404).json({ message: "Client not found." });
    res.status(200).json(cur);
  } catch (e) {
    res.status(500).json({ message: "Could not load the client." });
  }
});

module.exports = router;
