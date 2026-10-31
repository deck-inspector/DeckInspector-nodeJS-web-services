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

const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");

const INVITE_DAYS = 14;
const CODE_LEN = 12;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I - typed by people
const STATES = ["invited", "trial", "active", "past_due", "locked", "complimentary"];

async function q(statement, parameters = []) {
  const cluster = couchbase.cluster;
  if (!cluster) throw new Error("Cluster connection not initialized.");
  const result = await cluster.query(statement, { parameters });
  return result.rows || [];
}
function ks() {
  return `\`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.ProjectReports`;
}
function now() { return new Date().toISOString(); }
function clean(s, max = 200) { return String(s == null ? "" : s).trim().slice(0, max); }

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
// Only the hash is stored; the code itself goes to the client once (email / link).
function hashCode(code) {
  return crypto.createHash("sha256").update(normCode(code)).digest("hex");
}

// ------------------------------------------------------------- invitations
// status: sent -> accepted | revoked | expired
async function createInvitation(inv) {
  const code = newCode();
  const id = `pinv_${uuidv4()}`;
  const created = now();
  const doc = {
    docType: "PortalInvitation",
    id,
    codeHash: hashCode(code),
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
    createdAt: created,
    expiresAt: new Date(Date.now() + INVITE_DAYS * 864e5).toISOString(),
    acceptedAt: null,
    acceptedUserId: null,
  };
  await q(`UPSERT INTO ${ks()} (KEY, VALUE) VALUES ($1, $2)`, [id, doc]);
  return { doc, code };
}

async function getInvitationById(id) {
  const rows = await q(`SELECT r.* FROM ${ks()} r WHERE r.docType = 'PortalInvitation' AND META(r).id = $1 LIMIT 1`, [id]);
  return rows.length ? rows[0] : null;
}

async function getInvitationByCode(code) {
  const h = hashCode(code);
  const rows = await q(`SELECT r.* FROM ${ks()} r WHERE r.docType = 'PortalInvitation' AND r.codeHash = $1 LIMIT 1`, [h]);
  return rows.length ? rows[0] : null;
}

// Newest first; the hash never leaves the server.
async function listInvitations(companyIdentifier, clientId) {
  const rows = await q(
    `SELECT r.* FROM ${ks()} r WHERE r.docType = 'PortalInvitation' AND r.companyIdentifier = $1 AND r.clientId = $2`,
    [companyIdentifier, clientId]
  );
  return rows
    .map((r) => { const o = Object.assign({}, r); delete o.codeHash; o.status = effectiveStatus(o); return o; })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
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
  await q(`UPSERT INTO ${ks()} (KEY, VALUE) VALUES ($1, $2)`, [id, doc]);
  return doc;
}

// Give a pending invitation a fresh code + expiry (resend). Returns the new code.
async function reissueInvitation(id, emailed) {
  const code = newCode();
  await setInvitation(id, {
    codeHash: hashCode(code), status: "sent", emailed: !!emailed,
    expiresAt: new Date(Date.now() + INVITE_DAYS * 864e5).toISOString(), reissuedAt: now(),
  });
  return code;
}

// ---------------------------------------------------------------- accounts
// One per client (per inspection company for now; the cross-company link for
// clients with several inspectors is PR 2). state: see STATES.
async function getAccount(companyIdentifier, clientId) {
  const rows = await q(
    `SELECT r.* FROM ${ks()} r WHERE r.docType = 'PortalAccount' AND r.companyIdentifier = $1 AND r.clientId = $2 LIMIT 1`,
    [companyIdentifier, clientId]
  );
  return rows.length ? rows[0] : null;
}

async function getAccountById(id) {
  const rows = await q(`SELECT r.* FROM ${ks()} r WHERE r.docType = 'PortalAccount' AND META(r).id = $1 LIMIT 1`, [id]);
  return rows.length ? rows[0] : null;
}

async function upsertAccount(acct) {
  const id = acct.id || `pacct_${uuidv4()}`;
  const existing = acct.id ? await getAccountById(id) : null;
  const t = now();
  const doc = Object.assign({}, existing || {}, acct, {
    docType: "PortalAccount",
    id,
    state: STATES.includes(acct.state) ? acct.state : ((existing && existing.state) || "trial"),
    log: Array.isArray(acct.log) ? acct.log.slice(-200) : ((existing && existing.log) || []),
    createdAt: (existing && existing.createdAt) || t,
    updatedAt: t,
  });
  await q(`UPSERT INTO ${ks()} (KEY, VALUE) VALUES ($1, $2)`, [id, doc]);
  return doc;
}

async function logAccount(acct, event, by, note) {
  const log = (acct.log || []).concat([{ at: now(), event, by: by || "", note: note || "" }]).slice(-200);
  return upsertAccount(Object.assign({}, acct, { log }));
}

module.exports = {
  INVITE_DAYS, STATES,
  newCode, normCode, hashCode,
  createInvitation, getInvitationById, getInvitationByCode, listInvitations, effectiveStatus, setInvitation, reissueInvitation,
  getAccount, getAccountById, upsertAccount, logAccount,
};
