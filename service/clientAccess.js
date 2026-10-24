"use strict";
// CLIENT PORTAL - read-only access for owners / property managers (David, Oct 23 2026).
//
// A "client" login is a Users record with role:'client' and clientId pointing at a
// Client (model/clients.js). It may READ the inspection of the properties in that
// client's portfolio (project.ownerClientId / managerClientId) and NOTHING else:
// no edits, no reports, no proposals, no inspectors, no users, no other clients.
//
// This middleware is mounted in routes.js in front of EVERY /api router, so the
// lock lives on the server - hiding buttons in the web app is only cosmetic.
//
//   * Requests without a token, or with a staff token, pass straight through
//     (staff behaviour is unchanged).
//   * A client token may only use the short allow-list in RULES below. Each rule
//     names the ids it touches; every id must resolve (section -> unit -> building
//     -> project) to a project in the client's own portfolio, same tenant, not
//     deleted. Anything else -> 403. Any lookup error -> 503 (fail CLOSED).
//   * Responses to client tokens are scrubbed of staff-only fields (inspectors,
//     assignment, signer, QBO / invoice, proposal links, report / document lists).
//   * The user record is re-read (60 s cache) so deactivating a client login, or
//     moving it to another client, takes effect within a minute - not at token expiry.

const jwt = require("jsonwebtoken");
const couchbase = require("../database/couchbase");

const USER_TTL_MS = 60 * 1000;
const MAX_IDS = 500;
const userCache = new Map(); // lower(username) -> { rec, at }

// ---------------------------------------------------------------- user lookup
async function lookupUser(username) {
  const key = String(username || "").toLowerCase();
  if (!key) return null;
  const hit = userCache.get(key);
  if (hit && Date.now() - hit.at < USER_TTL_MS) return hit.rec;
  const users = require("../model/user");
  const rec = await users.getUserbyUsername(username);
  userCache.set(key, { rec: rec || null, at: Date.now() });
  if (userCache.size > 2000) userCache.delete(userCache.keys().next().value);
  return rec || null;
}
function forgetUser(username) {
  userCache.delete(String(username || "").toLowerCase());
}

function isClientRecord(rec) {
  return !!(rec && String(rec.role || "").toLowerCase() === "client");
}
// Repairs portal (Oct 23 2026): the client's contractor / maintenance crew.
function isContractorRecord(rec) {
  return !!(rec && String(rec.role || "").toLowerCase() === "contractor");
}
// Any outside (portal) login - never treated as staff.
function isPortalRecord(rec) {
  return isClientRecord(rec) || isContractorRecord(rec);
}
const PORTAL_ROLES = ["client", "contractor"];

// ---------------------------------------------------------------- id -> project
function ks(collection) {
  return `\`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.\`${collection}\``;
}
async function rowsByKeys(collection, ids, fields) {
  if (!ids.length) return [];
  const q = `SELECT META(d).id AS id, ${fields} FROM ${ks(collection)} d USE KEYS $1`;
  const result = await couchbase.cluster.query(q, { parameters: [ids] });
  return result.rows || [];
}

// Walk each id up the hierarchy (VisualSection -> Location -> SubProject -> Project,
// via parentid) until it lands on a Project. Returns Map(originalId -> projectRow|null).
async function resolveProjects(ids) {
  const out = new Map();
  let pending = new Map(ids.map((id) => [id, id])); // original -> current
  for (let depth = 0; depth < 5 && pending.size; depth++) {
    const cur = [...new Set(pending.values())];
    const projects = await rowsByKeys("Project", cur,
      "d.type, d.companyIdentifier, d.ownerClientId, d.managerClientId, d.isdeleted");
    const projById = new Map(projects.map((r) => [r.id, r]));
    for (const [orig, c] of [...pending]) {
      if (projById.has(c)) { out.set(orig, projById.get(c)); pending.delete(orig); }
    }
    if (!pending.size) break;
    const rest = [...new Set(pending.values())];
    const [secs, locs, subs] = await Promise.all([
      rowsByKeys("VisualSection", rest, "d.parentid"),
      rowsByKeys("Location", rest, "d.parentid"),
      rowsByKeys("SubProject", rest, "d.parentid"),
    ]);
    const parent = new Map();
    for (const r of [...secs, ...locs, ...subs]) if (r && r.parentid) parent.set(r.id, String(r.parentid));
    const next = new Map();
    for (const [orig, c] of pending) {
      const p = parent.get(c);
      if (p && p !== c) next.set(orig, p); else out.set(orig, null);
    }
    pending = next;
  }
  for (const orig of pending.keys()) out.set(orig, null);
  return out;
}

function projectAllowed(row, client) {
  if (!row) return false;
  if (row.type && row.type !== "Project") return false;
  if (row.isdeleted === true || String(row.isdeleted).toLowerCase() === "true") return false;
  if (row.companyIdentifier !== client.company) return false;
  return row.ownerClientId === client.clientId || row.managerClientId === client.clientId;
}

async function allIdsAllowed(ids, client) {
  const map = await resolveProjects(ids);
  for (const id of ids) if (!projectAllowed(map.get(id), client)) return false;
  return true;
}

// ---------------------------------------------------------------- scrubbing
const DROP_KEYS = new Set([
  "assignedto", "assignmentstatus", "createdby", "lasteditedby", "editedby", "updatedby",
  "modifiedby", "uploader", "uploadedby", "username", "inspector", "inspectorname",
  "inspectors", "signer", "signers", "reportsent", "reportsentat", "channels", "files",
  "documents", "reports", "deviceid", "password", "token", "notes",
]);
const DROP_PREFIX = /^(qbo|invoice|proposal|linkedproposal|visualai|aidraft|reviewdraft|prior)/i;

function scrub(v, depth = 0) {
  if (depth > 14 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  const o = {};
  for (const k of Object.keys(v)) {
    const lk = k.toLowerCase();
    if (DROP_KEYS.has(lk) || DROP_PREFIX.test(k)) continue;
    o[k] = scrub(v[k], depth + 1);
  }
  return o;
}

// Only the logo / name for the page header - nothing else of the tenant record.
function brandingOnly(body) {
  const t = (body && (body.Tenant || body.tenant)) || body || {};
  const icons = t.icons || {};
  const sizes = t.brandSizes || {};
  return {
    success: true,
    Tenant: {
      name: t.name || "",
      logo: t.logo || "",
      icons: { logoUrl: icons.logoUrl || "", header: icons.header || "" },
      brandSizes: { website: sizes.website || {} },
    },
  };
}

function wrapJson(res, fn) {
  const orig = res.json.bind(res);
  res.json = (body) => orig(fn(body));
}

// ---------------------------------------------------------------- allow-list
function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function oneId(v) {
  const s = str(v);
  return s ? [s] : null;
}
function manyIds(v) {
  if (!Array.isArray(v) || !v.length || v.length > MAX_IDS) return null;
  const ids = v.map(str);
  return ids.every(Boolean) ? ids : null;
}
function param(m) {
  try { return oneId(decodeURIComponent(m[1])); } catch (e) { return null; }
}

// Paths are relative to /api and matched case-insensitively (Express routing
// is case-insensitive). Anything not listed here is refused for client tokens.
const RULES = [
  // signing in / out never needs a token, but tolerate one
  { method: "POST", re: /^\/login\/(login|logout)$/i, kind: "pass" },
  // "My Properties" - served right here from the client's portfolio
  { method: "GET", re: /^\/project\/allprojects$/i, kind: "portfolio" },
  // the inspection itself (read-only)
  { method: "GET", re: /^\/project\/getprojectmetadata\/([^/]+)$/i, ids: (req, m) => param(m) },
  { method: "POST", re: /^\/section\/getsectionsbyparentids$/i, ids: (req) => manyIds(req.body && req.body.parentids) },
  { method: "POST", re: /^\/section\/getsectionsbyparentid$/i, ids: (req) => oneId(req.body && req.body.parentid) },
  { method: "POST", re: /^\/section\/getsectionbyid$/i, ids: (req) => oneId(req.body && req.body.sectionid) },
  { method: "POST", re: /^\/invasivesection\/getinvasivesectionbyparentid$/i, ids: (req) => oneId(req.body && req.body.parentSectionId) },
  { method: "POST", re: /^\/dynamicsection\/getsectionsbyparentid$/i, ids: (req) => oneId(req.body && req.body.parentid) },
  // thumbnails for photos the page is about to show (derived images only)
  { method: "POST", re: /^\/image\/prebuild$/i, kind: "pass" },
  // the tenant logo for the page header - own tenant only, logo fields only
  { method: "GET", re: /^\/tenants\/identifier\/([^/]+)$/i, kind: "branding" },
  // repairs portal - routes/repairs-endpoint.js checks every request against the
  // login's role, client and assigned properties itself
  { method: "GET", re: /^\/repairs(\/.*)?$/i, kind: "pass" },
  { method: "POST", re: /^\/repairs(\/.*)?$/i, kind: "pass" },
];

// A contractor login may ONLY use the repairs routes (plus sign-in, thumbnails and
// the logo). It never reads the inspection itself through the general routes.
const CONTRACTOR_RULES = [
  { method: "POST", re: /^\/login\/(login|logout)$/i, kind: "pass" },
  { method: "GET", re: /^\/repairs(\/.*)?$/i, kind: "pass" },
  { method: "POST", re: /^\/repairs(\/.*)?$/i, kind: "pass" },
  { method: "POST", re: /^\/image\/prebuild$/i, kind: "pass" },
  { method: "GET", re: /^\/tenants\/identifier\/([^/]+)$/i, kind: "branding" },
];

function deny(res, code, message) {
  return res.status(code).json({ success: false, message });
}

async function handleClient(req, res, next, client) {
  // match case-insensitively (as Express routes do) but keep the original
  // spelling so ids taken from the path are exact
  const path = String(req.path || "").replace(/\/+$/, "");
  const method = String(req.method || "").toUpperCase();
  let rule = null, match = null;
  for (const r of (client.role === "contractor" ? CONTRACTOR_RULES : RULES)) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (m) { rule = r; match = m; break; }
  }
  if (!rule) return deny(res, 403, client.role === "contractor" ? "Contractor accounts can add repair photos only." : "Client accounts can view inspections only.");

  if (rule.kind === "pass") return next();

  if (rule.kind === "portfolio") {
    const clients = require("../model/clients");
    const rows = await clients.getPortfolio(client.company, client.clientId);
    return res.status(201).json({ success: true, projects: scrub(rows || []) });
  }

  if (rule.kind === "branding") {
    let cid = "";
    try { cid = decodeURIComponent(match[1]); } catch (e) { cid = ""; }
    if (cid !== client.company) return deny(res, 403, "Client accounts can view inspections only.");
    wrapJson(res, brandingOnly);
    return next();
  }

  const ids = rule.ids(req, match);
  if (!ids) return deny(res, 400, "Missing or invalid id.");
  if (!(await allIdsAllowed(ids, client))) return deny(res, 403, "This inspection is not in your portfolio.");
  wrapJson(res, (body) => scrub(body));
  return next();
}

// ---------------------------------------------------------------- middleware
function clientGuard(req, res, next) {
  const token = req.headers && req.headers.authorization;
  if (!token) return next();
  let payload;
  try { payload = jwt.verify(token, process.env.TOKEN_KEY); } catch (e) { return next(); } // routes answer bad tokens
  if (!payload || !payload.company || !payload.username) return next(); // super-user / legacy tokens

  (async () => {
    let rec;
    try {
      rec = await lookupUser(payload.username);
    } catch (e) {
      // Can't tell who this is. A token that SAYS client is refused; staff carry on
      // as before so a database hiccup never locks inspectors out.
      if (PORTAL_ROLES.includes(String(payload.role || "").toLowerCase())) return deny(res, 503, "Please try again in a moment.");
      return next();
    }
    if (!isPortalRecord(rec)) {
      if (PORTAL_ROLES.includes(String(payload.role || "").toLowerCase())) return deny(res, 401, "Session expired - please sign in again.");
      return next(); // staff
    }
    if (rec.isActive === false) return deny(res, 401, "This login has been turned off.");
    if (!rec.clientId || rec.companyIdentifier !== payload.company) return deny(res, 403, "This login is not linked to a client.");
    req.clientViewer = {
      username: rec.username, company: rec.companyIdentifier, clientId: rec.clientId,
      role: isContractorRecord(rec) ? "contractor" : "client",
      contractorProjects: Array.isArray(rec.contractorProjects) ? rec.contractorProjects.map(String) : [],
      name: [rec.first_name, rec.last_name].filter(Boolean).join(" ") || rec.username,
    };
    return handleClient(req, res, next, req.clientViewer);
  })().catch((e) => {
    console.error("clientGuard:", e && e.message);
    if (!res.headersSent) deny(res, 503, "Please try again in a moment.");
  });
}

module.exports = { clientGuard, isClientRecord, isContractorRecord, isPortalRecord, forgetUser, scrub, resolveProjects, projectAllowed, RULES, CONTRACTOR_RULES };
