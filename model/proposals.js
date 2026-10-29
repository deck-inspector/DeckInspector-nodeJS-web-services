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

// PROPOSAL NUMBERS (David, Oct 22 2026): every proposal gets a permanent
// per-tenant number (1001, 1002, ... shown as "P-1001"). The counter is one
// doc per tenant ("propseq::<company>") advanced with a CAS-checked N1QL
// UPDATE, retried on a clash, so two people saving at once never share a
// number. A number, once given, never changes.
const PROPNO_START = 1001;
function seqKey(companyIdentifier) { return "propseq::" + String(companyIdentifier || "").trim(); }
function formatProposalNo(n) { return n ? "P-" + n : ""; }

async function nextProposalNo(companyIdentifier) {
  const key = seqKey(companyIdentifier);
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const rows = await executeQuery(
        `UPDATE ${collectionPath()} s USE KEYS $1 SET s.n = s.n + 1 RETURNING s.n`, [key]);
      if (rows && rows.length) return rows[0].n;
      // First proposal number for this tenant: start above any number already used.
      const mx = await executeQuery(
        `SELECT MAX(r.proposalNo) AS m FROM ${collectionPath()} r
         WHERE r.docType = "Proposal" AND r.companyIdentifier = $1`, [companyIdentifier]);
      const start = Math.max(PROPNO_START, ((mx && mx[0] && mx[0].m) || 0) + 1);
      await executeQuery(
        `INSERT INTO ${collectionPath()} (KEY, VALUE) VALUES ($1, $2)`,
        [key, { id: key, docType: "ProposalSeq", companyIdentifier, n: start }]);
      return start;
    } catch (e) {
      // CAS mismatch / duplicate key = someone else just took a number: retry.
      await new Promise(r => setTimeout(r, 40 + Math.random() * 120));
    }
  }
  throw new Error("Could not assign a proposal number.");
}

// Insert or update a proposal. `proposal` = { id?, companyIdentifier, name,
// status, form, linkedProjectId, createdBy, parentProposalId?, propertyIndex? }
var upsertProposal = async function (proposal) {
  const id = proposal.id || uuidv4();
  // Keep what the web app does not send back: the number and the creation date.
  const prev = proposal.id ? await getProposalById(proposal.id) : null;
  const doc = Object.assign({}, proposal, {
    id: id,
    docType: "Proposal",
    updatedAt: new Date().toISOString(),
  });
  if (prev && prev.createdAt) doc.createdAt = prev.createdAt;
  if (prev && prev.proposalNo) doc.proposalNo = prev.proposalNo;
  // MULTIPLE PROPERTIES (Oct 29 2026): each extra property of an accepted
  // proposal is stored as its own accepted "child" proposal linked to that
  // property's project (so invoicing, the Reports/Inspection proposal buttons
  // and the number search all work per project). A child shares its parent's
  // number with a property suffix ("P-1162-2") and never takes a new number.
  let suffix = '';
  if (doc.parentProposalId) {
    if (!doc.proposalNo) {
      const parent = await getProposalById(doc.parentProposalId);
      if (parent && parent.proposalNo) doc.proposalNo = parent.proposalNo;
    }
    const idx = parseInt(doc.propertyIndex, 10);
    if (idx > 1) suffix = '-' + idx;
  }
  if (!doc.proposalNo) doc.proposalNo = await nextProposalNo(doc.companyIdentifier);
  doc.proposalNumber = formatProposalNo(doc.proposalNo) + suffix;
  if (!doc.createdAt) doc.createdAt = doc.updatedAt;
  const q = `UPSERT INTO ${collectionPath()} (KEY, VALUE) VALUES ($1, $2)`;
  await executeQuery(q, [id, doc]);
  console.log(`Proposal upserted with ID: ${id} (${doc.proposalNumber})`);
  return { id: id, success: true, proposalNo: doc.proposalNo, proposalNumber: doc.proposalNumber };
};

var getProposalsByCompany = async function (companyIdentifier) {
  const q = `SELECT r.* FROM ${collectionPath()} r
    WHERE r.docType = 'Proposal' AND r.companyIdentifier = $1
    ORDER BY r.updatedAt DESC`;
  const rows = await executeQuery(q, [companyIdentifier]);
  // One-time backfill: proposals made before numbering get numbers in the
  // order they were made (oldest = lowest). Only touches the number fields.
  const missing = rows.filter(r => !r.proposalNo)
    .sort((a, b) => String(a.createdAt || a.updatedAt || "").localeCompare(String(b.createdAt || b.updatedAt || "")));
  for (const r of missing) {
    try {
      const n = await nextProposalNo(companyIdentifier);
      await executeQuery(
        `UPDATE ${collectionPath()} r USE KEYS $1 SET r.proposalNo = $2, r.proposalNumber = $3`,
        [r.id, n, formatProposalNo(n)]);
      r.proposalNo = n; r.proposalNumber = formatProposalNo(n);
    } catch (e) { console.error("Proposal number backfill failed for", r.id, e && e.message); }
  }
  return rows;
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
