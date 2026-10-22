"use strict";
const couchbase = require("../database/couchbase");

// QuickBooks Online connection per tenant. Stored in the existing
// ProjectReports collection under docType "QboConnection" (same pattern as
// Proposals) so no new Couchbase collection has to be provisioned.
// Doc: { id: "qbo::<companyIdentifier>", docType, companyIdentifier,
//        realmId, accessToken, refreshToken, accessExpiresAt,
//        refreshExpiresAt, qboCompanyName, updatedAt }

async function executeQuery(statement, parameters = []) {
  const cluster = couchbase.cluster;
  if (!cluster) throw new Error("Cluster connection not initialized.");
  const result = await cluster.query(statement, { parameters });
  return result.rows;
}

function collectionPath() {
  return `\`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.ProjectReports`;
}

function keyFor(companyIdentifier) {
  return "qbo::" + String(companyIdentifier || "").trim();
}

async function upsertConnection(companyIdentifier, conn) {
  const id = keyFor(companyIdentifier);
  const doc = Object.assign({}, conn, {
    id,
    docType: "QboConnection",
    companyIdentifier,
    updatedAt: new Date().toISOString(),
  });
  await executeQuery(`UPSERT INTO ${collectionPath()} (KEY, VALUE) VALUES ($1, $2)`, [id, doc]);
  return doc;
}

async function getConnection(companyIdentifier) {
  const rows = await executeQuery(
    `SELECT r.* FROM ${collectionPath()} r USE KEYS $1`, [keyFor(companyIdentifier)]);
  return rows && rows.length ? rows[0] : null;
}

async function deleteConnection(companyIdentifier) {
  await executeQuery(`DELETE FROM ${collectionPath()} r USE KEYS $1`, [keyFor(companyIdentifier)]);
  return true;
}

// BILLING CYCLES (David, Oct 22 2026): a project's original Visual
// Inspection is cycle "" (the legacy keys, unchanged). Every "Schedule Final
// Inspection" starts a new cycle (the project's finalcycle timestamp) with its
// OWN proposal and its OWN invoice, so the final can be proposed and billed
// from inside the same project exactly like the visual inspection was.
function cycleKey(cycle) { return String(cycle || "").trim(); }
function invoiceKey(projectId, cycle) {
  const c = cycleKey(cycle);
  return "qboinv::" + projectId + (c ? "::" + c : "");
}

// The proposal that was converted into this project (linkedProjectId is set
// by the web app when a proposal is accepted). With a cycle: that Final
// Inspection's proposal only. Without: the original (cycle-less) proposal.
async function getProposalByProjectId(projectId, cycle) {
  const c = cycleKey(cycle);
  const cycleWhere = c ? `AND r.\`cycle\` = $2` : `AND IFMISSINGORNULL(r.\`cycle\`, "") = ""`;
  const rows = await executeQuery(
    `SELECT r.* FROM ${collectionPath()} r
     WHERE r.docType = "Proposal" AND r.linkedProjectId = $1 ${cycleWhere}
     ORDER BY r.updatedAt DESC LIMIT 1`, c ? [projectId, c] : [projectId]);
  return rows && rows.length ? rows[0] : null;
}

// Invoice reference per project + cycle (which QBO invoice bills it).
async function upsertInvoiceRef(projectId, data, cycle) {
  const id = invoiceKey(projectId, cycle);
  const doc = Object.assign({}, data, {
    id, docType: "QboInvoiceRef", projectId, cycle: cycleKey(cycle),
    updatedAt: new Date().toISOString(),
  });
  await executeQuery(`UPSERT INTO ${collectionPath()} (KEY, VALUE) VALUES ($1, $2)`, [id, doc]);
  return doc;
}
async function getInvoiceRef(projectId, cycle) {
  const rows = await executeQuery(
    `SELECT r.* FROM ${collectionPath()} r USE KEYS $1`, [invoiceKey(projectId, cycle)]);
  return rows && rows.length ? rows[0] : null;
}
// Every invoice reference of one tenant - feeds the paid badge on the cards.
async function listInvoiceRefs(companyIdentifier) {
  return await executeQuery(
    `SELECT r.* FROM ${collectionPath()} r
     WHERE r.docType = "QboInvoiceRef" AND r.companyIdentifier = $1`, [companyIdentifier]);
}
// Remember the last known balance on the reference. Once PAID it is never
// asked of QuickBooks again (keeps the home screen fast).
async function setInvoiceRefStatus(refId, st) {
  await executeQuery(
    `UPDATE ${collectionPath()} r USE KEYS $1
     SET r.paid = $2, r.balance = $3, r.total = $4, r.statusAt = $5`,
    [refId, !!st.paid, st.balance == null ? null : Number(st.balance), st.total == null ? null : Number(st.total), new Date().toISOString()]);
}

module.exports = { upsertConnection, getConnection, deleteConnection, getProposalByProjectId, upsertInvoiceRef, getInvoiceRef, listInvoiceRefs, setInvoiceRefStatus, invoiceKey };
