"use strict";
const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");

// Client portfolios (David, Sep 19 2026): a Client is an Owner or a Property
// Manager of properties. Clients live in the existing ProjectReports collection
// under docType "Client" (same trick as proposals) so nothing new has to be
// provisioned in Couchbase and - important - Client docs never reach the phones,
// which only sync the Project collection. A project links to clients through two
// slots (ownerClientId / managerClientId) plus a small name+contact snapshot
// (clientInfo) that the phone shows read-only. Clients are never deleted; an
// empty client can be archived (isActive:false) which hides it from pickers.

async function executeQuery(statement, parameters = []) {
  const cluster = couchbase.cluster;
  if (!cluster) throw new Error("Cluster connection not initialized.");
  const result = await cluster.query(statement, { parameters });
  return result.rows;
}

function collectionPath() {
  return `\`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.ProjectReports`;
}
function projectPath() {
  return `\`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.Project`;
}

const TYPES = ["owner", "manager", "other"];

function clean(s, max = 200) {
  return String(s == null ? "" : s).trim().slice(0, max);
}

// The part of a client the phone needs. Kept tiny on purpose - it is copied onto
// every project in the client's portfolio.
function snapshotOf(c) {
  if (!c) return null;
  return {
    id: c.id,
    name: c.name || "",
    contactName: c.contactName || "",
    phone: c.phone || "",
    email: c.email || "",
  };
}

var upsertClient = async function (client) {
  const id = client.id || `client_${uuidv4()}`;
  const existing = client.id ? await getClientById(id) : null;
  const now = new Date().toISOString();
  const doc = {
    docType: "Client",
    id,
    companyIdentifier: client.companyIdentifier,
    clientType: TYPES.includes(client.clientType) ? client.clientType : "owner",
    name: clean(client.name),
    contactName: clean(client.contactName),
    phone: clean(client.phone, 60),
    email: clean(client.email),
    address: {
      street: clean(client.address && client.address.street),
      city: clean(client.address && client.address.city),
      stateZip: clean(client.address && client.address.stateZip, 40),
    },
    notes: clean(client.notes, 2000),
    isActive: client.isActive === false ? false : true,
    createdBy: (existing && existing.createdBy) || client.createdBy || "",
    createdAt: (existing && existing.createdAt) || now,
    updatedAt: now,
  };
  if (!doc.name) throw new Error("Client name is required");
  const q = `UPSERT INTO ${collectionPath()} (KEY, VALUE) VALUES ($1, $2)`;
  await executeQuery(q, [id, doc]);
  return doc;
};

var getClientsByCompany = async function (companyIdentifier, opts = {}) {
  const params = [companyIdentifier];
  let where = `r.docType = 'Client' AND r.companyIdentifier = $1`;
  if (opts.type && TYPES.includes(opts.type)) { params.push(opts.type); where += ` AND r.clientType = $${params.length}`; }
  if (!opts.includeArchived) where += ` AND r.isActive = true`;
  const q = `SELECT r.* FROM ${collectionPath()} r WHERE ${where} ORDER BY LOWER(r.name)`;
  const rows = await executeQuery(q, params);
  // property counts in one query (owner or manager slot)
  const cq = `SELECT p.ownerClientId AS o, p.managerClientId AS m FROM ${projectPath()} p
    WHERE p.type = 'Project' AND p.companyIdentifier = $1 AND IFMISSINGORNULL(p.isdeleted, false) = false
      AND (p.ownerClientId IS NOT MISSING OR p.managerClientId IS NOT MISSING)`;
  const counts = {};
  try {
    for (const r of await executeQuery(cq, [companyIdentifier])) {
      if (r.o) counts[r.o] = (counts[r.o] || 0) + 1;
      if (r.m && r.m !== r.o) counts[r.m] = (counts[r.m] || 0) + 1;
    }
  } catch (e) { console.error("client counts failed:", e && e.message); }
  return rows.map(r => ({ ...r, projectCount: counts[r.id] || 0 }));
};

var getClientById = async function (id) {
  const q = `SELECT r.* FROM ${collectionPath()} r WHERE r.docType = 'Client' AND META(r).id = $1 LIMIT 1`;
  const rows = await executeQuery(q, [id]);
  return rows.length ? rows[0] : null;
};

// All projects where the client is owner and/or manager.
var getPortfolio = async function (companyIdentifier, clientId) {
  const q = `SELECT META(p).id AS id, p.name, p.address, p.projecttype, p.iscomplete, p.editedat, p.createdat,
      p.assignedto, p.url, p.ownerClientId, p.managerClientId, p.clientInfo, p.finalinspection
    FROM ${projectPath()} p
    WHERE p.type = 'Project' AND p.companyIdentifier = $1 AND IFMISSINGORNULL(p.isdeleted, false) = false
      AND (p.ownerClientId = $2 OR p.managerClientId = $2)
    ORDER BY LOWER(p.name)`;
  return await executeQuery(q, [companyIdentifier, clientId]);
};

var portfolioCount = async function (companyIdentifier, clientId) {
  const q = `SELECT COUNT(*) AS n FROM ${projectPath()} p
    WHERE p.type = 'Project' AND p.companyIdentifier = $1 AND IFMISSINGORNULL(p.isdeleted, false) = false
      AND (p.ownerClientId = $2 OR p.managerClientId = $2)`;
  const rows = await executeQuery(q, [companyIdentifier, clientId]);
  return rows.length ? rows[0].n : 0;
};

// Build the clientInfo snapshot for a project from its two slot ids.
var buildClientInfo = async function (ownerClientId, managerClientId) {
  const owner = ownerClientId ? await getClientById(ownerClientId) : null;
  const manager = managerClientId ? await getClientById(managerClientId) : null;
  return { owner: snapshotOf(owner), manager: snapshotOf(manager) };
};

// After a client is edited: refresh the snapshot on every project in its
// portfolio. Goes through the project edit path so the SGW write-through keeps
// the phones in sync. Returns the number of projects touched.
var fanOutSnapshot = async function (client, editProjectFn) {
  const rows = await getPortfolio(client.companyIdentifier, client.id);
  const snap = snapshotOf(client);
  let n = 0;
  for (const p of rows) {
    const info = Object.assign({ owner: null, manager: null }, p.clientInfo || {});
    if (p.ownerClientId === client.id) info.owner = snap;
    if (p.managerClientId === client.id) info.manager = snap;
    try { await editProjectFn(p.id, { clientInfo: info }); n++; }
    catch (e) { console.error("clientInfo fan-out failed for", p.id, e && e.message); }
  }
  return n;
};

module.exports = {
  TYPES,
  upsertClient,
  getClientsByCompany,
  getClientById,
  getPortfolio,
  portfolioCount,
  buildClientInfo,
  fanOutSnapshot,
  snapshotOf,
};
