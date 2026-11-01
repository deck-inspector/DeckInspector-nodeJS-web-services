"use strict";
// INSPECTOR SIDE of the client portal reports (David, Nov 1 2026) - mounted at
// /api/portalreports behind authenticateToken. Portal logins never get here
// (service/clientAccess.js refuses every route it does not list).
//
//   GET  /api/portalreports/project/:projectId   report files + documents of a project with
//                                                their "signed / released to client" state
//   POST /api/portalreports/release { id, kind, title, released }
//                                                Signed - release to client (or withdraw)
const express = require("express");
const router = express.Router();
const reports = require("../service/portalReports");

async function staffOf(req) {
  const company = req.user && req.user.company;
  if (!company) return null; // E3 Admin / legacy tokens have no company
  const users = require("../model/user");
  let me = null;
  try { me = await users.getUserbyUsername(req.user.username); } catch (e) { me = null; }
  if (!me) return null;
  const role = String(me.role || "").toLowerCase();
  if (role === "client" || role === "contractor") return null;
  if (me.companyIdentifier && me.companyIdentifier !== company) return null;
  return { company, username: me.username, name: [me.first_name, me.last_name].filter(Boolean).join(" ") || me.username, isAdmin: role === "admin" };
}
function fail(res, code, message) { return res.status(code).json({ success: false, message }); }

router.get("/project/:projectId", async (req, res) => {
  try {
    const staff = await staffOf(req);
    if (!staff) return fail(res, 403, "Not allowed.");
    const p = await reports.getProject(req.params.projectId);
    if (!p || p.companyIdentifier !== staff.company) return fail(res, 404, "Project not found.");
    return res.status(200).json({ success: true, kinds: reports.KINDS, files: await reports.filesOf(p.id) });
  } catch (e) {
    console.error("portalreports list:", e && e.message);
    return fail(res, 500, "Could not load the report files.");
  }
});

router.post("/release", async (req, res) => {
  try {
    const staff = await staffOf(req);
    if (!staff) return fail(res, 403, "Not allowed.");
    const b = req.body || {};
    const out = await reports.release(staff, { id: String(b.id || ""), kind: b.kind, title: b.title, released: b.released !== false });
    return res.status(200).json(Object.assign({ success: true }, out));
  } catch (e) {
    if (e && e.status) return fail(res, e.status, e.message);
    console.error("portalreports release:", e && e.message);
    return fail(res, 500, "Could not release the report.");
  }
});

module.exports = router;
