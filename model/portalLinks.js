"use strict";
// CLIENT PORTAL - ONE LOGIN, SEVERAL INSPECTORS (David, Nov 1 2026 - PR 2).
//
// A property owner / manager often works with more than one E3 Certified
// Inspector. Each inspector (tenant) keeps its own Client record and invites the
// same email; the client must NOT need a second password. So a client login
// (Users record, role 'client') has:
//   companyIdentifier + clientId        its first inspector ("primary", unchanged)
//   portalLinks: [ { companyIdentifier, clientId, memberUsername, invitationId,
//                    linkedAt, active } ]   every further inspector
// The portal token names ONE inspector at a time (claims.company / clientId);
// service/clientAccess.js accepts a token for any active link and the client
// switches inspectors from the portal header (POST /api/portal/switch). Every
// read stays tenant-scoped exactly as before - nothing is merged across tenants.
//
// Users live in the PROD scope (same keyspace as model/user.js).

const couchbase = require("../database/couchbase");

const USERS_KS = () => `\`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users`;

async function q(statement, parameters = []) {
  const cluster = couchbase.cluster;
  if (!cluster) throw new Error("Cluster connection not initialized.");
  const result = await cluster.query(statement, { parameters });
  return result.rows || [];
}
function str(v, max = 200) { return String(v == null ? "" : v).trim().slice(0, max); }

// Every inspector a login can see, primary first. Inactive links are kept
// (flagged) so the client can be told why one inspector is missing.
// The LOGIN belongs to the property owner (David, Nov 1 2026): when the first
// ("primary") inspector ends the relationship only `primaryActive` goes false -
// the login, its other inspectors and its billing stay. Only E3 Admin turns the
// whole login off (isActive).
function linksOf(rec) {
  if (!rec) return [];
  const out = [];
  if (rec.companyIdentifier && rec.clientId) {
    out.push({ companyIdentifier: rec.companyIdentifier, clientId: rec.clientId, primary: true, active: rec.isActive !== false && rec.primaryActive !== false, changedAt: rec.primaryChangedAt || null, linkedAt: rec.createdAt || null });
  }
  for (const l of Array.isArray(rec.portalLinks) ? rec.portalLinks : []) {
    if (!l || !l.companyIdentifier || !l.clientId) continue;
    if (out.some((o) => o.companyIdentifier === l.companyIdentifier && o.clientId === l.clientId)) continue;
    out.push(Object.assign({}, l, { primary: false, active: rec.isActive !== false && l.active !== false, changedAt: l.activeChangedAt || null }));
  }
  return out;
}

// The link that a token for `companyIdentifier` (+ clientId when given) resolves to, or null.
function linkFor(rec, companyIdentifier, clientId) {
  return linksOf(rec).find((l) => l.companyIdentifier === companyIdentifier && (!clientId || l.clientId === clientId) && l.active) || null;
}

function hasLink(rec, companyIdentifier, clientId) {
  return linksOf(rec).some((l) => l.companyIdentifier === companyIdentifier && l.clientId === clientId);
}

// Add an inspector to a client login. No-op when already linked (reactivates it).
async function addLink(userId, link) {
  const entry = {
    companyIdentifier: str(link.companyIdentifier, 120),
    clientId: str(link.clientId, 120),
    memberUsername: str(link.memberUsername, 80),
    invitationId: str(link.invitationId, 120),
    linkedAt: new Date().toISOString(),
    active: true,
  };
  // drop any older entry for the same inspector+client, then append the fresh one
  const stmt = `UPDATE ${USERS_KS()} AS u USE KEYS $1
    SET u.portalLinks = ARRAY_APPEND(
      ARRAY l FOR l IN IFMISSINGORNULL(u.portalLinks, []) WHEN NOT (l.companyIdentifier = $2 AND l.clientId = $3) END,
      $4)`;
  await q(stmt, [userId, entry.companyIdentifier, entry.clientId, entry]);
  return entry;
}

// Turn one inspector's access on/off for a shared login (the login itself stays).
async function setLinkActive(userId, companyIdentifier, clientId, active) {
  const stmt = `UPDATE ${USERS_KS()} AS u USE KEYS $1
    SET u.portalLinks = ARRAY (CASE WHEN l.companyIdentifier = $2 AND l.clientId = $3
        THEN OBJECT_PUT(OBJECT_PUT(l, 'active', $4), 'activeChangedAt', $5) ELSE l END)
      FOR l IN IFMISSINGORNULL(u.portalLinks, []) END`;
  await q(stmt, [userId, companyIdentifier, clientId, !!active, new Date().toISOString()]);
  return { ok: 1 };
}

// The first inspector's access on/off for a client login (the login itself stays).
async function setPrimaryActive(userId, active) {
  await q(`UPDATE ${USERS_KS()} AS u USE KEYS $1 SET u.primaryActive = $2, u.primaryChangedAt = $3`, [userId, !!active, new Date().toISOString()]);
  return { ok: 1 };
}

// Switch one inspector's access for a login, whichever kind of link it is.
async function setAccess(rec, companyIdentifier, clientId, active) {
  if (rec.companyIdentifier === companyIdentifier && rec.clientId === clientId) return setPrimaryActive(rec.id, active);
  return setLinkActive(rec.id, companyIdentifier, clientId, active);
}

// Every client (property owner) login, for E3 Admin's Portal Clients page.
async function allClientLogins() {
  return q(`SELECT META(u).id AS id, u.username, u.formerUsername, u.first_name, u.last_name, u.email, u.mobile,
      u.isActive, u.primaryActive, u.primaryChangedAt, u.createdAt, u.companyIdentifier, u.clientId, u.portalLinks,
      u.adminDisabledAt, u.adminDisabledBy
    FROM ${USERS_KS()} u WHERE u.\`role\` = 'client'`);
}
async function clientLoginById(id) {
  const rows = await q(`SELECT META(u).id AS id, u.* FROM ${USERS_KS()} u USE KEYS $1 WHERE u.\`role\` = 'client'`, [String(id || "")]);
  return rows.length ? rows[0] : null;
}
// E3 Admin only: the whole login on/off. The email is kept (unlike staff logins) so the
// owner's billing record and history stay attached and the login can be turned back on.
async function setLoginActive(id, active, by) {
  const t = new Date().toISOString();
  if (active) await q(`UPDATE ${USERS_KS()} AS u USE KEYS $1 SET u.isActive = true, u.reactivatedAt = $2 UNSET u.adminDisabledAt, u.adminDisabledBy`, [id, t]);
  else await q(`UPDATE ${USERS_KS()} AS u USE KEYS $1 SET u.isActive = false, u.adminDisabledAt = $2, u.adminDisabledBy = $3`, [id, t, String(by || "")]);
  return { ok: 1 };
}

// Client logins that reach this inspector's client THROUGH A LINK (their primary
// inspector is someone else). Same shape as model/user.getClientUsers + link info.
async function linkedUsers(companyIdentifier, clientId) {
  const stmt = `SELECT META(u).id AS id, u.username, u.formerUsername, u.first_name, u.last_name, u.email, u.mobile,
      u.isActive, u.createdAt, u.companyIdentifier AS primaryCompany,
      FIRST l FOR l IN u.portalLinks WHEN l.companyIdentifier = $1 AND l.clientId = $2 END AS link
    FROM ${USERS_KS()} u
    WHERE u.\`role\` = 'client' AND ANY l IN u.portalLinks SATISFIES l.companyIdentifier = $1 AND l.clientId = $2 END`;
  const rows = await q(stmt, [companyIdentifier, clientId]);
  return rows.map((r) => Object.assign({}, r, {
    linked: true,
    linkActive: !!(r.link && r.link.active !== false),
    linkedAt: r.link && r.link.linkedAt,
  }));
}

// An ACTIVE client login holding this email (any inspector), else null.
async function activeClientByEmail(email) {
  const e = str(email, 254).toLowerCase();
  if (!e) return null;
  const rows = await q(`SELECT META(u).id AS id, u.* FROM ${USERS_KS()} u WHERE LOWER(u.email) = $1 AND u.\`role\` = 'client' AND IFMISSINGORNULL(u.isActive, true) = true LIMIT 1`, [e]);
  return rows.length ? rows[0] : null;
}

module.exports = { linksOf, linkFor, hasLink, addLink, setLinkActive, setPrimaryActive, setAccess, linkedUsers, activeClientByEmail, allClientLogins, clientLoginById, setLoginActive };
