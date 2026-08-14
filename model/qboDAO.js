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

// The proposal that was converted into this project (linkedProjectId is set
// by the web app when a proposal is accepted).
async function getProposalByProjectId(projectId) {
  const rows = await executeQuery(
    `SELECT r.* FROM ${collectionPath()} r
     WHERE r.docType = "Proposal" AND r.linkedProjectId = $1
     ORDER BY r.updatedAt DESC LIMIT 1`, [projectId]);
  return rows && rows.length ? rows[0] : null;
}

// Invoice reference per project (which QBO invoice bills this inspection).
async function upsertInvoiceRef(projectId, data) {
  const id = "qboinv::" + projectId;
  const doc = Object.assign({}, data, {
    id, docType: "QboInvoiceRef", projectId,
    updatedAt: new Date().toISOString(),
  });
  await executeQuery(`UPSERT INTO ${collectionPath()} (KEY, VALUE) VALUES ($1, $2)`, [id, doc]);
  return doc;
}
async function getInvoiceRef(projectId) {
  const rows = await executeQuery(
    `SELECT r.* FROM ${collectionPath()} r USE KEYS $1`, ["qboinv::" + projectId]);
  return rows && rows.length ? rows[0] : null;
}

module.exports = { upsertConnection, getConnection, deleteConnection, getProposalByProjectId, upsertInvoiceRef, getInvoiceRef };
