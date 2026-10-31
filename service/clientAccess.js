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
// Oct 27 2026: photo links, rate limits, activity log, terms of use (portal logins only)
const shield = require("./portalShield");
// Nov 1 2026 (client portal PR 2): one client login can be linked to several
// inspectors; the token names the inspector currently being viewed.
const links = require("../model/portalLinks");
const billing = require("./portalBilling");

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

// null when any id is outside the client's portfolio, else the project ids touched
async function allIdsAllowed(ids, client) {
  const map = await resolveProjects(ids);
  const pids = new Set();
  for (const id of ids) {
    const row = map.get(id);
    if (!projectAllowed(row, client)) return null;
    pids.add(row.id);
  }
  return [...pids];
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

// Terms of use (Oct 27 2026): read + accept. Nothing else works until accepted.
const TERMS_FREE = [
  { method: "POST", re: /^\/login\/(login|logout)$/i },
  { method: "GET", re: /^\/tenants\/identifier\/([^/]+)$/i },
];
async function acceptTerms(req, res, client) {
  const v = req.body && req.body.version;
  if (v !== shield.TERMS_VERSION) return deny(res, 409, "These terms have been updated - please reload the page.");
  // Users live in the PROD scope (same as model/user.js / login), not DB_SCOPE_NAME
  const q = `UPDATE \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users AS u USE KEYS $1 SET u.termsVersion = $2, u.termsAcceptedAt = $3, u.termsAcceptedIp = $4`;
  await couchbase.cluster.query(q, { parameters: [client.userId, shield.TERMS_VERSION, new Date().toISOString(), shield.ipOf(req)] });
  forgetUser(client.username);
  return res.status(200).json({ success: true, version: shield.TERMS_VERSION });
}

// ---------------------------------------------------------------- billing (PR 3)
// What a locked client may still reach: its own billing, the inspector list / switch
// (answered before the gate), the inspector's logo for the lock screen, sign-in / out.
const BILLING_FREE = [
  { method: "POST", re: /^\/login\/(login|logout)$/i },
  { method: "GET", re: /^\/tenants\/identifier\/([^/]+)$/i },
];
async function billingCall(req, res, client, path, method) {
  const rec = await lookupUser(client.username);
  try {
    if (method === "GET" && /^\/portal\/billing$/i.test(path)) return res.status(200).json(await billing.clientStatus(rec));
    if (method === "POST" && /^\/portal\/billing\/checkout$/i.test(path)) return res.status(200).json(await billing.startCheckout(rec, req.body && req.body.interval === "year" ? "year" : "month"));
    if (method === "POST" && /^\/portal\/billing\/manage$/i.test(path)) return res.status(200).json(await billing.openPortal(rec));
  } catch (e) {
    console.error("portal billing:", e && e.message);
    return res.status((e && e.status) || 502).json({ success: false, message: (e && e.status && e.message) || "Billing is not available right now. Please try again in a moment." });
  }
  return null;
}

// ---------------------------------------------------------------- inspectors (PR 2)
// The inspectors this login is linked to, with names for the header switcher.
async function describeLinks(rec) {
  const Tenants = require("./tenantService");
  const clients = require("../model/clients");
  const out = [];
  for (const l of links.linksOf(rec)) {
    let inspector = "", clientName = "";
    try { const t = await Tenants.getTenantByCompanyIdentifier(l.companyIdentifier); inspector = (t && t.Tenant && t.Tenant.name) || ""; } catch (e) { /* name only */ }
    try { const c = await clients.getClientById(l.clientId); clientName = (c && c.name) || ""; } catch (e) { /* name only */ }
    out.push({ companyIdentifier: l.companyIdentifier, clientId: l.clientId, inspector: inspector || l.companyIdentifier, client: clientName, primary: !!l.primary, active: !!l.active });
  }
  return out;
}

async function listLinks(req, res, client) {
  const rec = await lookupUser(client.username);
  const list = await describeLinks(rec);
  return res.status(200).json({ success: true, current: client.company, links: list });
}

// POST /api/portal/switch { companyIdentifier } -> a fresh token for that inspector
async function switchLink(req, res, client) {
  const want = String((req.body && req.body.companyIdentifier) || "").trim();
  const wantClient = String((req.body && req.body.clientId) || "").trim();
  const rec = await lookupUser(client.username);
  const link = want ? links.linkFor(rec, want, wantClient || undefined) : null;
  if (!link) return deny(res, 404, "That inspector is not linked to your login.");
  const Tenants = require("./tenantService");
  const t = await Tenants.isTenantActive(link.companyIdentifier).catch(() => ({ success: false }));
  if (!t || !t.success || !t.allowLogin) return deny(res, 409, "That inspector's E3 account is not active right now.");
  const token = jwt.sign(
    { user_id: rec.id, username: rec.username, company: link.companyIdentifier, role: "client", clientId: link.clientId },
    process.env.TOKEN_KEY, { expiresIn: "1d" }
  );
  shield.note(client, "api", { req });
  return res.status(200).json({ success: true, token, companyIdentifier: link.companyIdentifier, clientId: link.clientId });
}

async function handleClient(req, res, next, client) {
  // match case-insensitively (as Express routes do) but keep the original
  // spelling so ids taken from the path are exact
  const path = String(req.path || "").replace(/\/+$/, "");
  const method = String(req.method || "").toUpperCase();

  // terms of use
  if (method === "GET" && /^\/portal\/terms$/i.test(path)) {
    return res.status(200).json(Object.assign({ accepted: client.termsVersion === shield.TERMS_VERSION }, shield.TERMS));
  }
  if (method === "POST" && /^\/portal\/terms\/accept$/i.test(path)) return acceptTerms(req, res, client);
  if (client.termsVersion !== shield.TERMS_VERSION && !TERMS_FREE.some((r) => r.method === method && r.re.test(path))) {
    return res.status(428).json({ success: false, needTerms: true, message: "Please accept the portal terms of use to continue." });
  }

  // several inspectors on one login (PR 2): list them / switch the token to one
  if (client.role === "client" && method === "GET" && /^\/portal\/links$/i.test(path)) return listLinks(req, res, client);
  if (client.role === "client" && method === "POST" && /^\/portal\/switch$/i.test(path)) return switchLink(req, res, client);

  // client billing (PR 3): status / Stripe Checkout / manage billing - always reachable, even when locked
  if (client.role === "client" && /^\/portal\/billing(\/|$)/i.test(path)) {
    const done = await billingCall(req, res, client, path, method);
    if (done) return done;
  }
  // LOCKOUT (PR 3): trial over and not paid (or payment failed for good). Property owners
  // only - contractor logins are never billed. Fails open if billing cannot be evaluated.
  if (client.role === "client" && !BILLING_FREE.some((r) => r.method === method && r.re.test(path))) {
    const st = await billing.standing(await lookupUser(client.username));
    if (!st.allowed) {
      return res.status(402).json({ success: false, billingRequired: true, state: st.state, reason: st.reason, message: st.message });
    }
  }

  // bulk pulling is stopped and recorded; normal browsing never gets near this
  if (!shield.allow(client.username, "api")) {
    shield.note(client, "throttled", { req });
    return deny(res, 429, "Too many requests - please slow down and try again in a few minutes.");
  }

  // photo links the page sends back (remove photo, thumbnail pre-build) -> storage address
  if (req.body && typeof req.body === "object") shield.unsignPhotos(req.body, client);

  let rule = null, match = null;
  for (const r of (client.role === "contractor" ? CONTRACTOR_RULES : RULES)) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (m) { rule = r; match = m; break; }
  }
  if (!rule) return deny(res, 403, client.role === "contractor" ? "Contractor accounts can add repair photos only." : "Client accounts can view inspections only.");

  const origin = shield.originOf(req);
  const protect = (body) => shield.signPhotos(body, client, origin);

  if (rule.kind === "pass") {
    const rp = /^\/repairs\/job\/([^/]+)$/i.exec(path);
    let pid = null;
    if (rp) { try { pid = decodeURIComponent(rp[1]); } catch (e) { pid = null; } }
    shield.note(client, "api", { req, projectIds: pid ? [pid] : [] });
    wrapJson(res, protect);
    return next();
  }

  if (rule.kind === "portfolio") {
    shield.note(client, "api", { req });
    const clients = require("../model/clients");
    const rows = await clients.getPortfolio(client.company, client.clientId);
    return res.status(201).json(protect({ success: true, projects: scrub(rows || []) }));
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
  const pids = await allIdsAllowed(ids, client);
  if (!pids) return deny(res, 403, "This inspection is not in your portfolio.");
  shield.note(client, "api", { req, projectIds: pids });
  wrapJson(res, (body) => protect(scrub(body)));
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
    // The token names the inspector being viewed: the login's own (primary)
    // inspector, or - client logins only (PR 2) - one of its active links.
    let company = rec.companyIdentifier, clientId = rec.clientId;
    if (isClientRecord(rec) && (payload.company !== rec.companyIdentifier || (payload.clientId && payload.clientId !== rec.clientId))) {
      const link = links.linkFor(rec, payload.company, payload.clientId || undefined);
      if (!link) return deny(res, 403, "This inspector is no longer linked to your login. Sign in again.");
      company = link.companyIdentifier; clientId = link.clientId;
    }
    if (!clientId || company !== payload.company) return deny(res, 403, "This login is not linked to a client.");
    req.clientViewer = {
      userId: rec.id, termsVersion: rec.termsVersion || "",
      username: rec.username, company, clientId,
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

// GET /api/pphoto/:tok - the watermarked, expiring portal photo (service/portalShield.js)
const portalPhoto = shield.makePhotoHandler(lookupUser);

module.exports = { clientGuard, portalPhoto, isClientRecord, isContractorRecord, isPortalRecord, forgetUser, scrub, resolveProjects, projectAllowed, RULES, CONTRACTOR_RULES };
