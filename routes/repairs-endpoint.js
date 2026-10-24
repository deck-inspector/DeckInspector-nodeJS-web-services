"use strict";
// REPAIRS PORTAL (David, Oct 23 2026) - mounted at /api/repairs behind authenticateToken.
//
//   Contractor (role 'contractor')  uploads after-photos for each repair item of the
//                                    properties its client assigned to it, marks items done.
//   Client supervisor (role 'client') sees the same items, accepts each one or sends it back,
//                                    then presses "Repairs complete" (= sign-off), and manages
//                                    its contractor logins.
//   Staff (Deck Inspectors)          reviews submitted jobs: approve items from the photos, ask
//                                    for new photos, or call for an on-site Final.
//
// A repair item = an inspection point the inspector rated Bad, flagged for further invasive
// review, or failed (same rule as FinalRepairsGenerator.isBadSection). The server lock
// (service/clientAccess.js) lets portal logins reach ONLY this router; every request here is
// checked against the login's role, tenant, client and assigned properties.
const express = require("express");
const router = express.Router();
const fs = require("fs");
const bcrypt = require("bcrypt");
const multer = require("multer");
const couchbase = require("../database/couchbase");
const repairs = require("../model/repairs");

const upload = multer({ dest: "uploads/", limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
const MAX_PHOTOS_PER_ITEM = 20;

// ---------------------------------------------------------------- who is asking
async function actorOf(req) {
  const v = req.clientViewer;
  if (v && (v.role === "client" || v.role === "contractor")) {
    return { kind: v.role, company: v.company, clientId: v.clientId, username: v.username, name: v.name || v.username, contractorProjects: v.contractorProjects || [] };
  }
  // staff (the guard already sent portal logins here with req.clientViewer set)
  const users = require("../model/user");
  let me = null;
  try { me = await users.getUserbyUsername(req.user && req.user.username); } catch (e) { me = null; }
  const role = String((me && me.role) || "").toLowerCase();
  if (role === "client" || role === "contractor") return { kind: "none" }; // never staff
  return {
    kind: "staff", company: req.user && req.user.company, username: req.user && req.user.username,
    name: me ? ([me.first_name, me.last_name].filter(Boolean).join(" ") || me.username) : (req.user && req.user.username),
    isAdmin: role === "admin",
  };
}

function fail(res, code, message) { return res.status(code).json({ success: false, message }); }

function ks(c) { return `\`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.\`${c}\``; }
async function projectsByKeys(ids) {
  if (!ids.length) return [];
  const r = await couchbase.cluster.query(
    `SELECT META(p).id AS id, p.name, p.address, p.url, p.companyIdentifier, p.ownerClientId, p.managerClientId, p.isdeleted, p.iscomplete, p.finalinspection
     FROM ${ks("Project")} p USE KEYS $1`, { parameters: [ids] });
  return r.rows || [];
}
const deleted = (p) => p.isdeleted === true || String(p.isdeleted).toLowerCase() === "true";

// The project, if this actor may work on it; otherwise null.
async function accessibleProject(actor, projectId) {
  if (!projectId || typeof projectId !== "string") return null;
  const [p] = await projectsByKeys([projectId]);
  if (!p || deleted(p) || p.companyIdentifier !== actor.company) return null;
  if (actor.kind === "staff") return p;
  const mine = p.ownerClientId === actor.clientId || p.managerClientId === actor.clientId;
  if (!mine) return null;
  if (actor.kind === "client") return p;
  if (actor.kind === "contractor" && actor.contractorProjects.includes(p.id)) return p;
  return null;
}

// ---------------------------------------------------------------- repair items
function yes(v) { return v === true || /^(yes|true)$/i.test(String(v || "")); }
function isRepairItem(s) {
  if (!s || yes(s.unitUnavailable)) return false;
  const v = String(s.visualreview || "").toLowerCase();
  return v.startsWith("bad") || yes(s.furtherinvasivereviewrequired) || String(s.conditionalassessment || "").toLowerCase().startsWith("fail");
}
function plain(s, max) {
  const t = String(s || "").replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(p|div|li|tr)>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\n{3,}/g, "\n\n").trim();
  return max && t.length > max ? t.slice(0, max - 1) + "…" : t;
}
const natural = (a, b) => String(a || "").localeCompare(String(b || ""), "en", { numeric: true, sensitivity: "base" });

// Every repair item of a project, merged with its RepairItem record.
async function buildItems(projectId) {
  const { getSingleProjectMetadata } = require("../service/projectmetadata/getProjectMetaData.js");
  const sectionDAO = require("../model/sectionDAO");
  const meta = await getSingleProjectMetadata(projectId);
  const item = (meta && meta.data && meta.data.item && meta.data.item[0]) || {};
  const locs = [];
  for (const l of (item.locations || [])) locs.push({ ...l, building: "" });
  for (const sp of (item.subProjects || [])) for (const l of (sp.subProjectLocations || [])) locs.push({ ...l, building: sp.name || "" });
  const locById = new Map(locs.map((l, i) => [String(l.locationId), { ...l, order: i }]));
  const ids = [...locById.keys()];
  let secs = [];
  for (let i = 0; i < ids.length; i += 200) secs = secs.concat(await sectionDAO.getSectionsByParentIds(ids.slice(i, i + 200)));
  const records = new Map((await repairs.getItems(projectId)).map((r) => [String(r.sectionId), r]));
  const out = [];
  for (const s of secs) {
    if (!isRepairItem(s)) continue;
    const sid = String(s.id || s._id);
    const loc = locById.get(String(s.parentid)) || {};
    const r = records.get(sid) || {};
    out.push({
      sectionId: sid, locationId: String(s.parentid), building: loc.building || "", locationName: loc.locationName || "",
      name: s.name || "", order: loc.order || 0, seq: Number(s.sequenceNo) || 0,
      finding: {
        visualreview: s.visualreview || "", condition: plain(s.conditionalassessment, 80),
        invasive: yes(s.furtherinvasivereviewrequired), unsafe: yes(s.unsafecondition),
        comment: plain(s.additionalconsiderations || s.additionalconsiderationshtml, 500),
      },
      inspectionPhotos: (s.images || []).slice(0, 4),
      status: r.status || "open", photos: r.photos || [],
      contractorNote: r.contractorNote || "", supervisorNote: r.supervisorNote || "", reviewNote: r.reviewNote || "",
      doneBy: r.doneBy || "", doneAt: r.doneAt || "", acceptedBy: r.acceptedBy || "", acceptedAt: r.acceptedAt || "",
    });
  }
  out.sort((a, b) => (a.order - b.order) || (a.seq - b.seq) || natural(a.name, b.name));
  return out;
}

function summarize(items) {
  const c = { total: items.length, withPhotos: 0, open: 0, done: 0, returned: 0, accepted: 0, approved: 0, rephoto: 0, onsite: 0 };
  for (const i of items) { if (i.photos.length) c.withPhotos++; c[i.status] = (c[i.status] || 0) + 1; }
  return c;
}

async function jobOf(project) {
  return (await repairs.getJob(project.id)) || { projectId: project.id, companyIdentifier: project.companyIdentifier, status: "open", round: 1, history: [] };
}
function logTo(job, actor, what, note) {
  job.history = (job.history || []).slice(-60);
  job.history.push({ at: new Date().toISOString(), by: actor.name || actor.username, role: actor.kind, what, note: note ? String(note).slice(0, 500) : "" });
}

// The item a request names, if it is a repair item of that project.
async function itemFor(project, sectionId) {
  if (!sectionId || typeof sectionId !== "string") return null;
  const items = await buildItems(project.id);
  return { items, item: items.find((i) => i.sectionId === sectionId) || null };
}
function recordOf(project, it) {
  return {
    projectId: project.id, sectionId: it.sectionId, locationId: it.locationId, companyIdentifier: project.companyIdentifier,
    status: it.status, photos: it.photos, contractorNote: it.contractorNote, supervisorNote: it.supervisorNote, reviewNote: it.reviewNote,
    doneBy: it.doneBy, doneAt: it.doneAt, acceptedBy: it.acceptedBy, acceptedAt: it.acceptedAt,
  };
}

// ---------------------------------------------------------------- read
// GET /api/repairs/jobs
//   client: its portfolio · contractor: its assigned properties · staff: the review queue
router.get("/jobs", async (req, res) => {
  try {
    const actor = await actorOf(req);
    if (actor.kind === "none") return fail(res, 403, "Not allowed.");
    let projects;
    if (actor.kind === "staff") {
      const jobs = await repairs.submittedJobs(actor.company);
      const ps = await projectsByKeys(jobs.map((j) => j.projectId));
      const byId = new Map(ps.map((p) => [p.id, p]));
      const clients = require("../model/clients");
      const out = [];
      for (const j of jobs) {
        const p = byId.get(j.projectId);
        if (!p || deleted(p) || p.companyIdentifier !== actor.company) continue;
        let clientName = "", clientEmail = "", clientContact = "";
        try {
          const c = await clients.getClientById(p.managerClientId || p.ownerClientId);
          clientName = (c && c.name) || ""; clientEmail = (c && c.email) || ""; clientContact = (c && c.contactName) || "";
        } catch (e) { /* */ }
        out.push({ projectId: p.id, name: p.name, address: p.address || "", url: p.url || "", clientName, clientEmail, clientContact, job: j });
      }
      return res.status(200).json(out);
    }
    const clients = require("../model/clients");
    projects = await clients.getPortfolio(actor.company, actor.clientId);
    if (actor.kind === "contractor") projects = projects.filter((p) => actor.contractorProjects.includes(p.id));
    const ids = projects.map((p) => p.id);
    const jobs = new Map((await repairs.getJobs(ids)).map((j) => [j.projectId, j]));
    const counts = await repairs.itemCounts(ids);
    return res.status(200).json(projects.map((p) => ({
      projectId: p.id, name: p.name, address: p.address || "", url: p.url || "",
      job: jobs.get(p.id) ? { status: jobs.get(p.id).status, itemsTotal: jobs.get(p.id).itemsTotal, submittedAt: jobs.get(p.id).submittedAt || "", reviewedAt: jobs.get(p.id).reviewedAt || "" } : { status: "open" },
      counts: counts[p.id] || { withPhotos: 0, byStatus: {} },
    })));
  } catch (e) {
    console.error("repairs jobs:", e && e.message);
    return fail(res, 500, "Could not load the repair jobs.");
  }
});

// GET /api/repairs/job/:projectId - every repair item with its photos and status
router.get("/job/:projectId", async (req, res) => {
  try {
    const actor = await actorOf(req);
    const p = await accessibleProject(actor, req.params.projectId);
    if (!p) return fail(res, 404, "Property not found.");
    const items = await buildItems(p.id);
    const job = await jobOf(p);
    if (job.itemsTotal !== items.length && (await repairs.getJob(p.id))) { job.itemsTotal = items.length; await repairs.saveJob(job); }
    return res.status(200).json({
      project: { id: p.id, name: p.name, address: p.address || "", url: p.url || "" },
      job: { status: job.status, round: job.round || 1, submittedBy: job.submittedBy || "", submittedAt: job.submittedAt || "",
        reviewedBy: job.reviewedBy || "", reviewedAt: job.reviewedAt || "", reviewNote: job.reviewNote || "", history: job.history || [] },
      items, summary: summarize(items), you: { kind: actor.kind, username: actor.username },
    });
  } catch (e) {
    console.error("repairs job:", e && e.message);
    return fail(res, 500, "Could not load the repairs.");
  }
});

// ---------------------------------------------------------------- contractor + supervisor work
const WORKABLE = ["open", "done", "returned", "rephoto"];

// POST /api/repairs/photo  multipart: photo, projectId, sectionId
router.post("/photo", upload.single("photo"), async (req, res) => {
  const tmp = req.file && req.file.path;
  try {
    const actor = await actorOf(req);
    if (actor.kind !== "contractor" && actor.kind !== "client") return fail(res, 403, "Only the client's team adds repair photos.");
    const b = req.body || {};
    const p = await accessibleProject(actor, b.projectId);
    if (!p) return fail(res, 404, "Property not found.");
    const job = await jobOf(p);
    if (job.status !== "open") return fail(res, 409, "These repairs were already submitted to the inspector.");
    const found = await itemFor(p, b.sectionId);
    if (!found || !found.item) return fail(res, 404, "Repair item not found.");
    const it = found.item;
    if (!WORKABLE.includes(it.status)) return fail(res, 409, "This item was already accepted.");
    if (it.photos.length >= MAX_PHOTOS_PER_ITEM) return fail(res, 409, `Up to ${MAX_PHOTOS_PER_ITEM} photos per item.`);
    const f = req.file;
    if (!f) return fail(res, 400, "No photo was received.");
    const ext = f.mimetype === "image/png" ? "png" : (f.mimetype === "image/jpeg" ? "jpg" : "");
    if (!ext) return fail(res, 400, "Please send a JPG or PNG photo.");
    const uploadBlob = require("../database/uploadimage");
    const container = ("repairs-" + String(p.companyIdentifier || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase()).slice(0, 60);
    const blobName = `${p.id}/${it.sectionId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const r = JSON.parse(await uploadBlob.uploadFile(container, blobName, f.path, {
      blobHTTPHeaders: { blobContentType: f.mimetype },
      metadata: { uploader: String(actor.username || "").replace(/[^\x20-\x7E]/g, "") },
    }));
    if (!r.url) { console.error("repair photo upload:", r.error); return fail(res, 500, "The photo could not be stored."); }
    it.photos = it.photos.concat([{ url: r.url, by: actor.username, byName: actor.name, role: actor.kind, at: new Date().toISOString() }]);
    await repairs.saveItem(recordOf(p, it));
    return res.status(201).json({ ok: 1, photos: it.photos });
  } catch (e) {
    console.error("repairs photo:", e && e.message);
    return fail(res, 500, "Could not add the photo.");
  } finally {
    if (tmp) fs.unlink(tmp, () => {});
  }
});

// POST /api/repairs/photo/remove { projectId, sectionId, url }
router.post("/photo/remove", async (req, res) => {
  try {
    const actor = await actorOf(req);
    if (actor.kind !== "contractor" && actor.kind !== "client") return fail(res, 403, "Not allowed.");
    const b = req.body || {};
    const p = await accessibleProject(actor, b.projectId);
    if (!p) return fail(res, 404, "Property not found.");
    if ((await jobOf(p)).status !== "open") return fail(res, 409, "These repairs were already submitted.");
    const found = await itemFor(p, b.sectionId);
    if (!found || !found.item) return fail(res, 404, "Repair item not found.");
    const it = found.item;
    if (!WORKABLE.includes(it.status)) return fail(res, 409, "This item was already accepted.");
    const ph = it.photos.find((x) => x.url === b.url);
    if (!ph) return fail(res, 404, "Photo not found.");
    if (actor.kind === "contractor" && ph.by !== actor.username) return fail(res, 403, "You can remove only your own photos.");
    it.photos = it.photos.filter((x) => x.url !== b.url);
    if (!it.photos.length && it.status === "done") it.status = "open";
    await repairs.saveItem(recordOf(p, it));
    return res.status(200).json({ ok: 1, photos: it.photos, status: it.status });
  } catch (e) {
    console.error("repairs photo remove:", e && e.message);
    return fail(res, 500, "Could not remove the photo.");
  }
});

// POST /api/repairs/item/done { projectId, sectionId, note }  - contractor (or supervisor)
router.post("/item/done", async (req, res) => {
  try {
    const actor = await actorOf(req);
    if (actor.kind !== "contractor" && actor.kind !== "client") return fail(res, 403, "Not allowed.");
    const b = req.body || {};
    const p = await accessibleProject(actor, b.projectId);
    if (!p) return fail(res, 404, "Property not found.");
    if ((await jobOf(p)).status !== "open") return fail(res, 409, "These repairs were already submitted.");
    const found = await itemFor(p, b.sectionId);
    if (!found || !found.item) return fail(res, 404, "Repair item not found.");
    const it = found.item;
    if (!WORKABLE.includes(it.status)) return fail(res, 409, "This item was already accepted.");
    if (!it.photos.length) return fail(res, 400, "Add at least one photo of the completed repair first.");
    it.status = "done"; it.doneBy = actor.name; it.doneAt = new Date().toISOString();
    if (b.note !== undefined) it.contractorNote = String(b.note || "").slice(0, 1000);
    await repairs.saveItem(recordOf(p, it));
    const left = found.items.filter((x) => x.sectionId !== it.sectionId && !["done", "accepted", "approved"].includes(x.status)).length;
    return res.status(200).json({ ok: 1, status: it.status, itemsLeft: left });
  } catch (e) {
    console.error("repairs done:", e && e.message);
    return fail(res, 500, "Could not update the item.");
  }
});

// POST /api/repairs/item/review { projectId, sectionId, decision: 'accept'|'return', note }  - supervisor
router.post("/item/review", async (req, res) => {
  try {
    const actor = await actorOf(req);
    if (actor.kind !== "client") return fail(res, 403, "Only the client's supervisor reviews repairs.");
    const b = req.body || {};
    if (b.decision !== "accept" && b.decision !== "return") return fail(res, 400, "Decision must be accept or return.");
    const p = await accessibleProject(actor, b.projectId);
    if (!p) return fail(res, 404, "Property not found.");
    if ((await jobOf(p)).status !== "open") return fail(res, 409, "These repairs were already submitted.");
    const found = await itemFor(p, b.sectionId);
    if (!found || !found.item) return fail(res, 404, "Repair item not found.");
    const it = found.item;
    if (it.status === "approved") return fail(res, 409, "The inspector already approved this item.");
    if (b.decision === "accept") {
      if (!it.photos.length) return fail(res, 400, "This item has no photos yet.");
      it.status = "accepted"; it.acceptedBy = actor.name; it.acceptedAt = new Date().toISOString();
    } else {
      it.status = "returned"; it.acceptedBy = ""; it.acceptedAt = "";
    }
    it.supervisorNote = String(b.note || "").slice(0, 1000);
    await repairs.saveItem(recordOf(p, it));
    return res.status(200).json({ ok: 1, status: it.status });
  } catch (e) {
    console.error("repairs review:", e && e.message);
    return fail(res, 500, "Could not update the item.");
  }
});

// POST /api/repairs/job/submit { projectId, note }  - supervisor: "Repairs complete - request Final"
router.post("/job/submit", async (req, res) => {
  try {
    const actor = await actorOf(req);
    if (actor.kind !== "client") return fail(res, 403, "Only the client's supervisor can submit the repairs.");
    const b = req.body || {};
    const p = await accessibleProject(actor, b.projectId);
    if (!p) return fail(res, 404, "Property not found.");
    const job = await jobOf(p);
    if (job.status !== "open") return fail(res, 409, "These repairs were already submitted.");
    const items = await buildItems(p.id);
    if (!items.length) return fail(res, 400, "This property has no repair items.");
    const notReady = items.filter((i) => i.status !== "accepted" && i.status !== "approved");
    if (notReady.length) return fail(res, 409, `${notReady.length} item${notReady.length === 1 ? " is" : "s are"} not accepted yet.`);
    job.status = "submitted"; job.itemsTotal = items.length;
    job.submittedBy = actor.name; job.submittedByUser = actor.username; job.submittedAt = new Date().toISOString();
    job.reviewedBy = ""; job.reviewedAt = ""; job.reviewNote = "";
    logTo(job, actor, "submitted", b.note);
    await repairs.saveJob(job);
    return res.status(200).json({ ok: 1, job: { status: job.status, submittedAt: job.submittedAt, submittedBy: job.submittedBy } });
  } catch (e) {
    console.error("repairs submit:", e && e.message);
    return fail(res, 500, "Could not submit the repairs.");
  }
});

// POST /api/repairs/job/decide  - staff
//   { projectId, all: 'onsite', note }  or  { projectId, decisions: { <sectionId>: { decision: 'approve'|'rephoto'|'onsite', note } }, note }
router.post("/job/decide", async (req, res) => {
  try {
    const actor = await actorOf(req);
    if (actor.kind !== "staff") return fail(res, 403, "Only the inspection company decides.");
    const b = req.body || {};
    const p = await accessibleProject(actor, b.projectId);
    if (!p) return fail(res, 404, "Property not found.");
    const job = await jobOf(p);
    if (job.status !== "submitted") return fail(res, 409, "These repairs are not waiting for a decision.");
    const items = await buildItems(p.id);
    const decisions = b.decisions && typeof b.decisions === "object" ? b.decisions : {};
    const allOnsite = b.all === "onsite";
    let nApprove = 0, nRephoto = 0, nOnsite = 0;
    for (const it of items) {
      let d = allOnsite ? "onsite" : ((decisions[it.sectionId] && decisions[it.sectionId].decision) || (it.status === "approved" ? "approve" : ""));
      if (!["approve", "rephoto", "onsite"].includes(d)) return fail(res, 400, `Choose approve, new photos or on site for "${it.locationName} - ${it.name}".`);
      it.status = d === "approve" ? "approved" : d;
      it.reviewNote = String((decisions[it.sectionId] && decisions[it.sectionId].note) || "").slice(0, 1000);
      if (d === "approve") nApprove++; else if (d === "rephoto") nRephoto++; else nOnsite++;
      await repairs.saveItem(recordOf(p, it));
    }
    job.status = nOnsite ? "onsite" : (nRephoto ? "open" : "approved");
    if (job.status === "open") job.round = (job.round || 1) + 1;
    job.reviewedBy = actor.name; job.reviewedAt = new Date().toISOString(); job.reviewNote = String(b.note || "").slice(0, 2000);
    logTo(job, actor, allOnsite ? "on-site Final required (all)" : `decided: ${nApprove} approved, ${nRephoto} new photos, ${nOnsite} on site`, b.note);
    await repairs.saveJob(job);
    return res.status(200).json({ ok: 1, job: { status: job.status }, counts: { approved: nApprove, rephoto: nRephoto, onsite: nOnsite } });
  } catch (e) {
    console.error("repairs decide:", e && e.message);
    return fail(res, 500, "Could not save the decision.");
  }
});

// ---------------------------------------------------------------- contractor logins
// The client supervisor manages its own contractors; a tenant admin may too (clientId given).
async function contractorScope(req, res, clientIdParam) {
  const actor = await actorOf(req);
  if (actor.kind === "client") return { actor, clientId: actor.clientId };
  if (actor.kind === "staff" && actor.isAdmin) {
    const clients = require("../model/clients");
    const c = clientIdParam ? await clients.getClientById(String(clientIdParam)) : null;
    if (!c || c.companyIdentifier !== actor.company) { fail(res, 404, "Client not found."); return null; }
    return { actor, clientId: c.id };
  }
  fail(res, 403, "Only the client's supervisor or an admin manages contractor logins.");
  return null;
}
async function portfolioIds(company, clientId) {
  const clients = require("../model/clients");
  return new Set((await clients.getPortfolio(company, clientId)).map((p) => p.id));
}
async function contractorOf(scope, username) {
  const users = require("../model/user");
  const rec = username ? await users.getUserbyUsername(String(username)) : null;
  if (!rec || String(rec.role || "").toLowerCase() !== "contractor" || rec.companyIdentifier !== scope.actor.company || rec.clientId !== scope.clientId) return null;
  return rec;
}

// GET /api/repairs/contractors?clientId=
router.get("/contractors", async (req, res) => {
  try {
    const scope = await contractorScope(req, res, req.query.clientId); if (!scope) return;
    const users = require("../model/user");
    return res.status(200).json(await users.getContractors(scope.actor.company, scope.clientId));
  } catch (e) {
    console.error("contractors list:", e && e.message);
    return fail(res, 500, "Could not list the contractors.");
  }
});

// POST /api/repairs/contractors { clientId?, username, password, first_name, last_name, company, email, mobile, projectIds[] }
router.post("/contractors", async (req, res) => {
  try {
    const b = req.body || {};
    const scope = await contractorScope(req, res, b.clientId); if (!scope) return;
    const users = require("../model/user");
    const Role = require("../model/role");
    const username = String(b.username || "").trim();
    const email = String(b.email || "").trim().toLowerCase();
    const password = String(b.password || "");
    if (!/^[A-Za-z0-9._@-]{3,60}$/.test(username)) return fail(res, 400, "Username: 3-60 letters, numbers, . _ - or @.");
    if (password.length < 8) return fail(res, 400, "Password must be at least 8 characters.");
    if (await users.getUserbyUsername(username)) return fail(res, 409, "That username is already taken.");
    if (email && (await users.getUser(email))) return fail(res, 409, "A login with that email already exists.");
    const mine = await portfolioIds(scope.actor.company, scope.clientId);
    const projectIds = (Array.isArray(b.projectIds) ? b.projectIds : []).map(String).filter((id) => mine.has(id));
    const r = await users.addClientUser({
      role: Role.Contractor, username, email, password: await bcrypt.hash(password, 10),
      first_name: String(b.first_name || "").trim().slice(0, 80), last_name: String(b.last_name || "").trim().slice(0, 80),
      mobile: String(b.mobile || "").trim().slice(0, 40), company: b.company,
      clientId: scope.clientId, companyIdentifier: scope.actor.company, createdBy: scope.actor.username,
      contractorProjects: projectIds,
    });
    return res.status(201).json({ ok: 1, id: r.insertedId, username, projectIds });
  } catch (e) {
    console.error("contractor create:", e && e.message);
    return fail(res, 500, "Could not create the contractor login.");
  }
});

// POST /api/repairs/contractors/assign { clientId?, username, projectIds[] }
router.post("/contractors/assign", async (req, res) => {
  try {
    const b = req.body || {};
    const scope = await contractorScope(req, res, b.clientId); if (!scope) return;
    const rec = await contractorOf(scope, b.username);
    if (!rec) return fail(res, 404, "Contractor not found.");
    const mine = await portfolioIds(scope.actor.company, scope.clientId);
    const projectIds = (Array.isArray(b.projectIds) ? b.projectIds : []).map(String).filter((id) => mine.has(id));
    const users = require("../model/user");
    await users.setContractorProjects(rec.id, projectIds);
    require("../service/clientAccess").forgetUser(rec.username);
    return res.status(200).json({ ok: 1, projectIds });
  } catch (e) {
    console.error("contractor assign:", e && e.message);
    return fail(res, 500, "Could not update the properties.");
  }
});

// POST /api/repairs/contractors/status { clientId?, username, active }
router.post("/contractors/status", async (req, res) => {
  try {
    const b = req.body || {};
    const scope = await contractorScope(req, res, b.clientId); if (!scope) return;
    const rec = await contractorOf(scope, b.username);
    if (!rec) return fail(res, 404, "Contractor not found.");
    const users = require("../model/user");
    const r = await users.updateUserStatus(rec.username, b.active !== false);
    require("../service/clientAccess").forgetUser(rec.username);
    return res.status(r.status === 201 ? 200 : 500).json({ ok: r.status === 201 ? 1 : 0 });
  } catch (e) {
    console.error("contractor status:", e && e.message);
    return fail(res, 500, "Could not update the login.");
  }
});

// POST /api/repairs/contractors/password { clientId?, username, password }
router.post("/contractors/password", async (req, res) => {
  try {
    const b = req.body || {};
    const scope = await contractorScope(req, res, b.clientId); if (!scope) return;
    const rec = await contractorOf(scope, b.username);
    if (!rec) return fail(res, 404, "Contractor not found.");
    const password = String(b.password || "");
    if (password.length < 8) return fail(res, 400, "Password must be at least 8 characters.");
    const users = require("../model/user");
    await users.resetUserPassword(rec.username, scope.actor.company, password);
    return res.status(200).json({ ok: 1 });
  } catch (e) {
    console.error("contractor password:", e && e.message);
    return fail(res, 500, "Could not reset the password.");
  }
});

// multer errors (too big, etc.)
router.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") return fail(res, 413, "That photo is too large (15 MB maximum).");
  if (err) { console.error("repairs router:", err && err.message); return fail(res, 400, "Could not read the upload."); }
  return next();
});

module.exports = router;
module.exports._test = { isRepairItem, summarize, plain };
