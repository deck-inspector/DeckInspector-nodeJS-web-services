"use strict";
// E3 E-SIGN (David, Nov 1 2026) - sign a report inside E3 instead of uploading it to DocuSign.
//
//   signReport(staff, { id, signerId, kind, release, ip })
//     1. the report file / uploaded document (a ProjectReports record) -> PDF (Word is converted)
//     2. the visible Option B stamp in the report's Signature cell + Certificate of Completion page
//     3. the certificate-based digital seal (service/esign/seal.js - one E3 certificate)
//     4. saved as a new Project Document "<name> - Signed.pdf" (the original is kept, marked signed)
//     5. optional: released to the client portal (service/portalReports.js), Final request closed
//   Works the same for reports printed earlier and never signed ("Sign Existing Report").
//
// Records (ProjectReports collection, never synced to phones):
//   E3Signature     id "e3sig::<Document ID>"   - what the public verify page shows
//   E3SignerImage   id "e3sigimg::<signer id>"  - the signer's adopted signature (private blob)
const crypto = require("crypto");
const couchbase = require("../../database/couchbase");
const stamp = require("./stamp");
const seal = require("./seal");

const VERIFY_BASE = String(process.env.ESIGN_VERIFY_URL || process.env.PORTAL_APP_URL || "https://www.e3-web.com").replace(/\/+$/, "").replace(/^https?:\/\/www\./, "https://");
const SIG_CONTAINER = "e3signatures"; // private: adopted signature images
const PDF_CONTAINER = "e3signedreports";

function ks(c) { return `\`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.\`${c}\``; }
async function q(statement, parameters = []) {
  if (!couchbase.cluster) throw new Error("Cluster connection not initialized.");
  const r = await couchbase.cluster.query(statement, { parameters });
  return r.rows || [];
}
function err(status, message) { const e = new Error(message); e.status = status; return e; }

// ---------------------------------------------------------------- Document ID
function newDocumentId(at) {
  const y = new Date(at).getUTCFullYear();
  const n = String(crypto.randomInt(0, 100000)).padStart(5, "0");
  return `E3-${y}-${n}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}
const ID_RE = /^E3-\d{4}-\d{5}-[0-9A-F]{8}$/;

// ---------------------------------------------------------------- private blob (signature images)
function blobService() {
  const { BlobServiceClient } = require("@azure/storage-blob");
  return BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING);
}
async function putPrivate(name, buf, type) {
  const c = blobService().getContainerClient(SIG_CONTAINER);
  await c.createIfNotExists(); // no public access
  await c.getBlockBlobClient(name).uploadData(buf, { blobHTTPHeaders: { blobContentType: type } });
}
async function getPrivate(name) {
  const c = blobService().getContainerClient(SIG_CONTAINER);
  return await c.getBlockBlobClient(name).downloadToBuffer();
}

// ---------------------------------------------------------------- signers (tenant list) + images
async function tenantOf(company) {
  const tenantsDAO = require("../../model/tenantsDAO");
  return await tenantsDAO.getTenantByCompanyIdentifier(company);
}
async function signersOf(company) {
  const t = await tenantOf(company);
  const list = (t && Array.isArray(t.signers) ? t.signers : []).filter((s) => s && s.id && s.name);
  const imgs = await q(`SELECT r.signerId, r.updatedAt FROM ${ks("ProjectReports")} r WHERE r.docType = 'E3SignerImage' AND r.company = $1`, [company]);
  const has = new Map(imgs.map((r) => [r.signerId, r.updatedAt]));
  return list.map((s) => ({ id: s.id, name: s.name, title: s.title || "", license: s.license || "", hasImage: has.has(s.id), imageUpdatedAt: has.get(s.id) || "" }));
}
async function companyName(company) {
  try { const t = await tenantOf(company); return (t && (t.name || (t.Tenant && t.Tenant.name))) || company; } catch (e) { return company; }
}

// dataUrl: "data:image/png;base64,..." (drawn pad or uploaded file), <= 1.5 MB
async function saveSignerImage(staff, signerId, dataUrl) {
  const list = await signersOf(staff.company);
  if (!list.some((s) => s.id === signerId)) throw err(404, "Save the signer first, then add the signature.");
  const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) throw err(400, "The signature must be a PNG or JPG image.");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length < 200 || buf.length > 1.5 * 1024 * 1024) throw err(400, "The signature image must be under 1.5 MB.");
  const type = m[1] === "png" ? "image/png" : "image/jpeg";
  const name = `${crypto.createHash("sha256").update(staff.company).digest("hex").slice(0, 16)}/${signerId}-${crypto.randomBytes(8).toString("hex")}.${m[1] === "png" ? "png" : "jpg"}`;
  await putPrivate(name, buf, type);
  const doc = { docType: "E3SignerImage", company: staff.company, signerId, blob: name, type, updatedAt: new Date().toISOString(), updatedBy: staff.username };
  await q(`UPSERT INTO ${ks("ProjectReports")} (KEY, VALUE) VALUES ($1, $2)`, [`e3sigimg::${signerId}`, doc]);
  return { ok: 1, updatedAt: doc.updatedAt };
}
async function removeSignerImage(staff, signerId) {
  await q(`DELETE FROM ${ks("ProjectReports")} r USE KEYS $1 WHERE r.docType = 'E3SignerImage' AND r.company = $2`, [`e3sigimg::${signerId}`, staff.company]);
  return { ok: 1 };
}
async function signerImage(company, signerId) {
  const rows = await q(`SELECT r.* FROM ${ks("ProjectReports")} r USE KEYS $1 WHERE r.docType = 'E3SignerImage'`, [`e3sigimg::${signerId}`]);
  const r = rows[0];
  if (!r || r.company !== company) return null;
  try { return { buf: await getPrivate(r.blob), type: r.type }; } catch (e) { return null; }
}

// ---------------------------------------------------------------- the report as PDF
async function reportPdf(rec) {
  const axios = require("axios");
  const resp = await axios.get(rec.url, { responseType: "arraybuffer", timeout: 120000, maxContentLength: 200 * 1024 * 1024 });
  const buf = Buffer.from(resp.data);
  if (buf.slice(0, 5).toString("latin1") === "%PDF-") return buf;
  if (/\.(docx?|docm)(\?|$)/i.test(rec.url || rec.name || "") || buf.slice(0, 2).toString("latin1") === "PK") {
    const { convertDocxToPdf } = require("../convertDocxToPdf");
    const ext = (/\.(docm|docx|doc)(\?|$)/i.exec(rec.url || "") || [, "docx"])[1];
    return Buffer.from(await convertDocxToPdf(buf, "report." + ext));
  }
  throw err(400, "Only PDF and Word reports can be signed.");
}

async function uploadPublic(name, buf) {
  const fs = require("fs"), os = require("os"), path = require("path");
  const tmp = path.join(os.tmpdir(), `esign_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.pdf`);
  fs.writeFileSync(tmp, buf);
  try {
    const uploadBlob = require("../../database/uploadimage");
    const r = JSON.parse(await uploadBlob.uploadFile(PDF_CONTAINER, name, tmp, {
      blobHTTPHeaders: { blobContentType: "application/pdf" }, metadata: { kind: "e3-signed-report" },
    }));
    if (!r || !r.url) throw new Error((r && r.error) || "upload returned no url");
    return r.url;
  } finally { try { fs.unlinkSync(tmp); } catch (e) { /* temp only */ } }
}

// ---------------------------------------------------------------- sign
// staff = { company, username, name }
async function signReport(staff, { id, signerId, kind, title, release = false, ip = "" }) {
  const reports = require("../portalReports");
  const rec = await reports.getRecord(String(id || ""));
  if (!rec) throw err(404, "Report not found.");
  const p = await reports.getProject(rec.project_id);
  const deleted = (x) => !x || x.isdeleted === true || String(x.isdeleted).toLowerCase() === "true";
  if (!p || deleted(p) || p.companyIdentifier !== staff.company) throw err(404, "Report not found.");
  if (!rec.url) throw err(400, "This report has no file.");
  const done = await q(`SELECT r.e3Signed FROM ${ks("ProjectReports")} r USE KEYS $1`, [rec.id]);
  if (done[0] && done[0].e3Signed && done[0].e3Signed.documentId && !done[0].e3Signed.test) throw err(409, `Already signed (${done[0].e3Signed.documentId}).`);

  const signers = await signersOf(staff.company);
  const s = signers.find((x) => x.id === signerId);
  if (!s) throw err(400, "Pick the signing inspector (Manage Signers on the project's Reports page).");
  const img = s.hasImage ? await signerImage(staff.company, s.id) : null;

  const st = seal.status();
  if (st.mode === "error") throw err(503, "The E3 signing certificate is set up wrong: " + st.error);
  const test = !!st.test;

  const k = Object.prototype.hasOwnProperty.call(reports.KINDS, kind) ? kind : reports.guessKind(rec.name);
  const label = String(title || reports.KINDS[k] || "Report").slice(0, 120);
  const signedAt = new Date().toISOString();
  const documentId = newDocumentId(signedAt);
  const company = await companyName(staff.company);
  const src = await reportPdf(rec);
  const originalSha256 = crypto.createHash("sha256").update(src).digest("hex");
  const info = {
    documentId, signedAt, test,
    verifyUrl: `${VERIFY_BASE}/v/${documentId}`, verifyHost: VERIFY_BASE.replace(/^https?:\/\//, "") + "/verify",
    title: label, property: [p.name, p.address].filter(Boolean).join(", "), company,
    approvedBy: `${staff.name || staff.username} (${staff.username})`,
    signer: { name: s.name, title: s.title, license: s.license, image: img ? img.buf : null },
    originalSha256, certLabel: st.certificate || "",
    events: [
      { what: "Report prepared", at: rec.timestamp || "", where: "E3 web app" },
      { what: "Reviewed & approved", at: signedAt, where: `${staff.username}${ip ? " · IP " + ip : ""}` },
      { what: `Signed - ${s.name}`, at: signedAt, where: "E3 E-Sign" },
      { what: "Certificate seal applied", at: signedAt, where: test ? "TEST certificate" : "E3 signing certificate" },
    ],
  };
  const { doc, placement, pages } = await stamp.stampReport(src, info);
  doc.setTitle(`${label} - ${p.name || ""}`.trim());
  doc.setAuthor(s.name);
  doc.setSubject(`E3 Document ID ${documentId}`);
  const signed = await seal.sealPdf(doc, {
    reason: `${label} - signed by ${s.name}${s.license ? ", License No. " + s.license : ""}. E3 Document ID ${documentId}`,
    location: "California", name: s.name, contactInfo: info.verifyUrl, signedAt,
  });
  const signedSha256 = crypto.createHash("sha256").update(signed).digest("hex");

  const base = String(rec.name || label).replace(/\.(pdf|docx?|docm)$/i, "").replace(/\s*-\s*signed$/i, "");
  const fileName = `${base}${test ? " - TEST SIGNED" : " - Signed"}.pdf`;
  const url = await uploadPublic(`${documentId}${test ? "-TEST" : ""}.pdf`, signed);
  const projectDocuments = require("../../model/projectDocuments");
  const added = await new Promise((resolve, reject) => projectDocuments.addProjectDocument({
    project_id: rec.project_id, name: fileName, url, uploader: `E3 E-Sign (${staff.name || staff.username})`, timestamp: signedAt,
  }, (e, r) => (e ? reject(e) : resolve(r))));
  const signedRecordId = added.insertedId;
  await q(`UPDATE ${ks("ProjectReports")} AS r USE KEYS $1 SET r.e3SignedCopy = $2`, [signedRecordId, { documentId, sourceId: rec.id, test }]);
  await q(`UPDATE ${ks("ProjectReports")} AS r USE KEYS $1 SET r.e3Signed = $2`, [rec.id, { documentId, signedRecordId, signedAt, signer: s.name, test }]);

  const sig = {
    docType: "E3Signature", documentId, company: staff.company, companyName: company, projectId: String(rec.project_id),
    sourceId: rec.id, signedRecordId, kind: k, title: label, pages, placement,
    signer: { id: s.id, name: s.name, title: s.title, license: s.license, adoptedImage: !!img },
    approvedBy: { username: staff.username, name: staff.name || "" }, ip: String(ip || "").slice(0, 64),
    signedAt, originalSha256, signedSha256, test, certificate: st.certificate || "", certMode: st.mode, status: "valid",
  };
  await q(`UPSERT INTO ${ks("ProjectReports")} (KEY, VALUE) VALUES ($1, $2)`, [`e3sig::${documentId}`, sig]);

  let portal = null;
  if (release && !test) {
    try { portal = await reports.releaseSigned(staff, signedRecordId, k, label); }
    catch (e) { console.error("esign release:", e && e.message); portal = { released: false, error: e.message }; }
  }
  return { ok: 1, documentId, signedRecordId, fileName, url, placement, pages, test, portal, verifyUrl: info.verifyUrl };
}

// ---------------------------------------------------------------- verify (public)
async function lookup(documentId) {
  const idn = String(documentId || "").trim().toUpperCase();
  if (!ID_RE.test(idn)) return null;
  const rows = await q(`SELECT r.* FROM ${ks("ProjectReports")} r USE KEYS $1 WHERE r.docType = 'E3Signature'`, [`e3sig::${idn}`]);
  const r = rows[0];
  if (!r) return null;
  // What anyone holding the Document ID may see - no property, client or report content.
  return {
    documentId: r.documentId, status: r.status || "valid", test: !!r.test, title: r.title, issuedBy: r.companyName,
    signer: { name: r.signer && r.signer.name, title: r.signer && r.signer.title, license: r.signer && r.signer.license },
    signedAt: r.signedAt, pages: r.pages, signedSha256: r.signedSha256, originalSha256: r.originalSha256, certificate: r.certificate,
  };
}

module.exports = { signReport, signersOf, saveSignerImage, removeSignerImage, signerImage, lookup, status: seal.status, newDocumentId, ID_RE, VERIFY_BASE };
