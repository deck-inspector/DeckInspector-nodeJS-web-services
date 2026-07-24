"use strict";
const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");

// Proposals live in the existing ProjectReports collection under their own
// docType ("Proposal") so no new Couchbase collection has to be provisioned.
// A proposal exists BEFORE a project does; once accepted it is converted to a
// project and the signed document is uploaded to that project's Documents.

async function executeQuery(statement, parameters = []) {
  const cluster = couchbase.cluster;
  if (!cluster) {
    throw new Error("Cluster connection not initialized. Make sure connectToDatabase() was called.");
  }
  const result = await cluster.query(statement, { parameters });
  return result.rows;
}

function collectionPath() {
  return `\`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.ProjectReports`;
}

// Insert or update a proposal. `proposal` = { id?, companyIdentifier, name,
// status, form, linkedProjectId, createdBy }
var upsertProposal = async function (proposal) {
  const id = proposal.id || uuidv4();
  const doc = Object.assign({}, proposal, {
    id: id,
    docType: "Proposal",
    updatedAt: new Date().toISOString(),
  });
  if (!doc.createdAt) doc.createdAt = doc.updatedAt;
  const q = `UPSERT INTO ${collectionPath()} (KEY, VALUE) VALUES ($1, $2)`;
  await executeQuery(q, [id, doc]);
  console.log(`Proposal upserted with ID: ${id}`);
  return { id: id, success: true };
};

var getProposalsByCompany = async function (companyIdentifier) {
  const q = `SELECT r.* FROM ${collectionPath()} r
    WHERE r.docType = 'Proposal' AND r.companyIdentifier = $1
    ORDER BY r.updatedAt DESC`;
  return await executeQuery(q, [companyIdentifier]);
};

var getProposalById = async function (id) {
  const q = `SELECT r.* FROM ${collectionPath()} r
    WHERE r.docType = 'Proposal' AND META(r).id = $1 LIMIT 1`;
  const rows = await executeQuery(q, [id]);
  return rows.length ? rows[0] : null;
};

var removeProposal = async function (id) {
  const q = `DELETE FROM ${collectionPath()} WHERE docType = 'Proposal' AND META().id = $1`;
  await executeQuery(q, [id]);
  return { success: true };
};

module.exports = {
  upsertProposal,
  getProposalsByCompany,
  getProposalById,
  removeProposal,
};
