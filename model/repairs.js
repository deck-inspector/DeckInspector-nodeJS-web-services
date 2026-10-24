"use strict";
// REPAIRS PORTAL (David, Oct 23 2026). The client's contractor uploads after-photos
// for each repair item (a Bad / Failed inspection point), the client's supervisor
// accepts each item and presses "Repairs complete", and Deck Inspectors approves the
// items, sends some back for new photos, or calls for an on-site Final.
//
// Records live in the ProjectReports collection (like Clients and Proposals) so they
// never sync to the inspectors' phones:
//   RepairItem  id "repitem::<sectionId>"  - one per repair item (photos + status)
//   RepairJob   id "repjob::<projectId>"   - one per property (overall status)
const couchbase = require("../database/couchbase");

async function q(statement, parameters = []) {
  const cluster = couchbase.cluster;
  if (!cluster) throw new Error("Cluster connection not initialized.");
  const r = await cluster.query(statement, { parameters });
  return r.rows || [];
}
function coll() {
  return `\`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.ProjectReports`;
}
async function upsert(id, doc) {
  await q(`UPSERT INTO ${coll()} (KEY, VALUE) VALUES ($1, $2)`, [id, doc]);
  return doc;
}

// ---- item statuses -------------------------------------------------------
// open      contractor still working (no "done" yet)
// done      contractor marked it done - waiting for the supervisor
// returned  supervisor sent it back to the contractor
// accepted  supervisor accepted it
// approved  Deck Inspectors approved it from the photos
// rephoto   Deck Inspectors wants new photos (back to the contractor)
// onsite    Deck Inspectors will check it on site
const ITEM_STATUSES = ["open", "done", "returned", "accepted", "approved", "rephoto", "onsite"];
// ---- job statuses ----------------------------------------------------------
// open | submitted (waiting for Deck) | approved (all items) | onsite (on-site Final needed)
const JOB_STATUSES = ["open", "submitted", "approved", "onsite"];

const itemId = (sectionId) => `repitem::${sectionId}`;
const jobId = (projectId) => `repjob::${projectId}`;

async function getItems(projectId) {
  return await q(`SELECT r.* FROM ${coll()} r WHERE r.docType = 'RepairItem' AND r.projectId = $1`, [projectId]);
}
async function getItem(sectionId) {
  const rows = await q(`SELECT r.* FROM ${coll()} r USE KEYS $1 WHERE r.docType = 'RepairItem'`, [itemId(sectionId)]);
  return rows[0] || null;
}
async function saveItem(doc) {
  doc.docType = "RepairItem";
  doc.updatedAt = new Date().toISOString();
  return upsert(itemId(doc.sectionId), doc);
}
async function getJob(projectId) {
  const rows = await q(`SELECT r.* FROM ${coll()} r USE KEYS $1 WHERE r.docType = 'RepairJob'`, [jobId(projectId)]);
  return rows[0] || null;
}
async function saveJob(doc) {
  doc.docType = "RepairJob";
  doc.updatedAt = new Date().toISOString();
  return upsert(jobId(doc.projectId), doc);
}
async function getJobs(projectIds) {
  const ids = (projectIds || []).map(String).filter(Boolean);
  if (!ids.length) return [];
  return await q(`SELECT r.* FROM ${coll()} r WHERE r.docType = 'RepairJob' AND r.projectId IN $1`, [ids]);
}
// Count items by status for many projects in one query (list pages).
async function itemCounts(projectIds) {
  const ids = (projectIds || []).map(String).filter(Boolean);
  if (!ids.length) return {};
  const rows = await q(`SELECT r.projectId AS p, r.status AS s, ARRAY_LENGTH(IFMISSINGORNULL(r.photos, [])) AS n
    FROM ${coll()} r WHERE r.docType = 'RepairItem' AND r.projectId IN $1`, [ids]);
  const out = {};
  for (const r of rows) {
    const o = out[r.p] || (out[r.p] = { withPhotos: 0, byStatus: {} });
    if (r.n > 0) o.withPhotos++;
    o.byStatus[r.s || "open"] = (o.byStatus[r.s || "open"] || 0) + 1;
  }
  return out;
}
async function submittedJobs(companyIdentifier) {
  return await q(`SELECT r.* FROM ${coll()} r WHERE r.docType = 'RepairJob' AND r.companyIdentifier = $1
    AND r.status IN ['submitted', 'approved', 'onsite'] ORDER BY r.submittedAt DESC LIMIT 300`, [companyIdentifier]);
}

module.exports = {
  ITEM_STATUSES, JOB_STATUSES, itemId, jobId,
  getItems, getItem, saveItem, getJob, saveJob, getJobs, itemCounts, submittedJobs,
};
