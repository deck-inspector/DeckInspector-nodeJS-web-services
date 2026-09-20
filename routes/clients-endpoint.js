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
