"use strict";
// CLIENT PORTAL INVITATIONS + ACCOUNTS (David, Oct 31 2026).
//
// A client reaches the portal only through an invitation issued by an admin of
// an inspection company that is an ACTIVE E3 Inspection Association member
// (service/associationMembership.js). The invitation carries a one-time code;
// accepting it creates the client's own login (role 'client', see
// routes/invite-endpoint.js) and a PortalAccount - the one record that will
// later carry the trial / billing state (Stripe, PR 3). Until billing ships
// every account sits in state 'trial' with no end date.
//
// Both document kinds live in the existing ProjectReports collection under
// docType 'PortalInvitation' / 'PortalAccount' - the same trick as Clients and
// proposals, so nothing has to be provisioned in Couchbase and nothing reaches
// the phones (they sync the Project collection only).
//
// EVERY read and write here is a plain key-value operation on the collection
// (database/couchbase.js exports it as ProjectReports) - never a N1QL query.
// The first live test (dev slot, Oct 31 2026) answered "index failure" for
// both a WHERE on a new field and a USE KEYS select (the query wrapper forces
// request_plus consistency on a collection without an index). KV needs no
// index and no query service at all. So the keys carry the meaning:
//   pinv_<sha256(code)>                    one invitation; the code IS the key
//   pinvlist_<company>_<clientId>          the ids of a client's invitations
//   pacct_<company>_<clientId>             the client's portal account
// A resend therefore creates a NEW invitation document (new code = new key) and
// marks the old one 'replaced'.

const crypto = require("crypto");
const couchbase = require("../database/couchbase");

const INVITE_DAYS = 14;
const CODE_LEN = 12;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I - typed by people
const STATES = ["invited", "trial", "active", "past_due", "locked", "complimentary"];

// The collection is created by connectToDatabase(), so it is looked up per call.
function coll() {
  const c = couchbase.ProjectReports;
  if (!c) throw new Error("Database connection not initialized (ProjectReports).");
  return c;
}
function isNotFound(e) {
  const name = (e && e.constructor && e.constructor.name) || "";
  return name === "DocumentNotFoundError" || (e && e.code === 101) || /document not found/i.test((e && e.message) || "");
}
function now() { return new Date().toISOString(); }
function clean(s, max = 200) { return String(s == null ? "" : s).trim().slice(0, max); }
function safeKeyPart(s) { return String(s == null ? "" : s).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80); }

async function getByKey(id) {
  try {
    const r = await coll().get(String(id));
    return r && r.content != null ? r.content : null;
  } catch (e) {
    if (isNotFound(e)) return null;
    console.error("portalAccess get failed:", id, "-", e && e.message, e && e.context ? JSON.stringify(e.context) : "");
    throw e;
  }
}
async function getByKeys(ids) {
  if (!ids.length) return [];
  const rows = await Promise.all(ids.map((id) => getByKey(id)));
  return rows.filter(Boolean);
}
async function put(id, doc) {
  try {
    await coll().upsert(String(id), doc);
  } catch (e) {
    console.error("portalAccess upsert failed:", id, "-", e && e.message, e && e.context ? JSON.stringify(e.context) : "");
    throw e;
  }
  return doc;
}

// ------------------------------------------------------------------- codes
function newCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}
function normCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 40);
}
// Only the hash is stored (as the document key); the code itself goes to the client once.
function hashCode(code) {
  return crypto.createHash("sha256").update(normCode(code)).digest("hex");
}
function inviteKey(code) { return "pinv_" + hashCode(code); }
function listKey(companyIdentifier, clientId) { return `pinvlist_${safeKeyPart(companyIdentifier)}_${safeKeyPart(clientId)}`; }
function accountKey(companyIdentifier, clientId) { return `pacct_${safeKeyPart(companyIdentifier)}_${safeKeyPart(clientId)}`; }

// ------------------------------------------------------------- invitations
// status: sent -> accepted | revoked | replaced | expired (expired is computed)
async function addToList(companyIdentifier, clientId, inviteId) {
  const key = listKey(companyIdentifier, clientId);
  const cur = (await getByKey(key)) || { docType: "PortalInvitationList", id: key, companyIdentifier, clientId, ids: [] };
  if (!cur.ids.includes(inviteId)) cur.ids = cur.ids.concat([inviteId]).slice(-200);
  cur.updatedAt = now();
  await put(key, cur);
}

async function createInvitation(inv) {
  const code = newCode();
  const id = inviteKey(code);
  const created = now();
  const doc = {
    docType: "PortalInvitation",
    id,
    companyIdentifier: inv.companyIdentifier,
    clientId: inv.clientId,
    clientName: clean(inv.clientName),
    email: clean(inv.email, 254).toLowerCase(),
    first_name: clean(inv.first_name, 80),
    last_name: clean(inv.last_name, 80),
    note: clean(inv.note, 600),
    propertyIds: Array.isArray(inv.propertyIds) ? inv.propertyIds.map(String).slice(0, 500) : [],
    propertyCount: Number(inv.propertyCount) || 0,
    member: { username: clean(inv.memberUsername, 80), name: clean(inv.memberName, 160), email: clean(inv.memberEmail, 254) },
    companyName: clean(inv.companyName, 160),
    status: "sent",
    emailed: !!inv.emailed,
    createdAt: inv.createdAt || created,
    issuedAt: created,
    expiresAt: new Date(Date.now() + INVITE_DAYS * 864e5).toISOString(),
    acceptedAt: null,
    acceptedUserId: null,
    replaces: inv.replaces || null,
  };
  await put(id, doc);
  await addToList(doc.companyIdentifier, doc.clientId, id);
  return { doc, code };
}

async function getInvitationById(id) {
  const d = id && String(id).startsWith("pinv_") ? await getByKey(id) : null;
  return d && d.docType === "PortalInvitation" ? d : null;
}

async function getInvitationByCode(code) {
  const c = normCode(code);
  if (c.length < 8) return null;
  return getInvitationById(inviteKey(c));
}

// Newest first.
async function listInvitations(companyIdentifier, clientId) {
  const list = await getByKey(listKey(companyIdentifier, clientId));
  const rows = list && Array.isArray(list.ids) && list.ids.length ? await getByKeys(list.ids) : [];
  return rows
    .filter((r) => r && r.docType === "PortalInvitation")
    .map((r) => Object.assign({}, r, { status: effectiveStatus(r) }))
    .sort((a, b) => String(b.issuedAt || b.createdAt).localeCompare(String(a.issuedAt || a.createdAt)));
}

function effectiveStatus(inv) {
  if (!inv) return "expired";
  if (inv.status === "sent" && inv.expiresAt && Date.parse(inv.expiresAt) < Date.now()) return "expired";
  return inv.status;
}

async function setInvitation(id, patch) {
  const cur = await getInvitationById(id);
  if (!cur) return null;
  const doc = Object.assign({}, cur, patch, { updatedAt: now() });
  await put(id, doc);
  return doc;
}

// Resend: a NEW invitation (fresh code, fresh 14 days) carrying the same details;
// the old one is marked 'replaced'. Returns { doc, code } of the new one.
async function reissueInvitation(id) {
  const old = await getInvitationById(id);
  if (!old) return null;
  const fresh = await createInvitation(Object.assign({}, old, {
    memberUsername: old.member && old.member.username, memberName: old.member && old.member.name, memberEmail: old.member && old.member.email,
    emailed: false, replaces: old.id, createdAt: old.createdAt,
  }));
  await setInvitation(old.id, { status: "replaced", replacedAt: now(), replacedBy: fresh.doc.id });
  return fresh;
}

// ---------------------------------------------------------------- accounts
// One per client per inspection company (the cross-company link for clients with
// several inspectors is PR 2). state: see STATES.
async function getAccount(companyIdentifier, clientId) {
  const d = await getByKey(accountKey(companyIdentifier, clientId));
  return d && d.docType === "PortalAccount" ? d : null;
}

async function getAccountById(id) {
  const d = id && String(id).startsWith("pacct_") ? await getByKey(id) : null;
  return d && d.docType === "PortalAccount" ? d : null;
}

async function upsertAccount(acct) {
  const id = acct.id || accountKey(acct.companyIdentifier, acct.clientId);
  const existing = await getAccountById(id);
  const t = now();
  const doc = Object.assign({}, existing || {}, acct, {
    docType: "PortalAccount",
    id,
    state: STATES.includes(acct.state) ? acct.state : ((existing && existing.state) || "trial"),
    log: Array.isArray(acct.log) ? acct.log.slice(-200) : ((existing && existing.log) || []),
    createdAt: (existing && existing.createdAt) || t,
    updatedAt: t,
  });
  await put(id, doc);
  return doc;
}

async function logAccount(acct, event, by, note) {
  const log = (acct.log || []).concat([{ at: now(), event, by: by || "", note: note || "" }]).slice(-200);
  return upsertAccount(Object.assign({}, acct, { log }));
}

module.exports = {
  INVITE_DAYS, STATES,
  newCode, normCode, hashCode, inviteKey, accountKey,
  createInvitation, getInvitationById, getInvitationByCode, listInvitations, effectiveStatus, setInvitation, reissueInvitation,
  getAccount, getAccountById, upsertAccount, logAccount,
};
