"use strict";
// CLIENT PORTAL REPORTS (David, Nov 1 2026).
//
// Property owners / managers see the inspection REPORTS of their properties in the
// portal - but only once the inspector has SIGNED the report. "Signed" is recorded on
// the report file itself (a ProjectReports record: a Report File or an uploaded
// Document) as `clientRelease`. Today the inspector presses "Signed - release to
// client"; the coming auto-signature step will call the same release() below.
//
//   clientRelease: { released: true, kind, label, signedAt, signedBy, pdfUrl, pdfOf }
//
// Clients never receive a storage address. They get a short-lived, per-login
// download link (/api/preport/<token>) that streams a PDF (Word files are converted
// once and the PDF is kept next to the original).
const jwt = require("jsonwebtoken");
const couchbase = require("../database/couchbase");

const KINDS = {
  final: "Final Report",
  finalcompletion: "Final Report Upon Completion",
  finalrepairs: "Final Repairs Inspection",
  unsafe: "Notice of Unsafe Conditions",
  visual: "Visual Inspection Report",
  other: "Report",
};
const LINK_TTL_S = 15 * 60;
const linkKey = () => String(process.env.TOKEN_KEY || "") + "|portal-report-v1";

function ks(collection) {
  return `\`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.\`${collection}\``;
}
async function q(statement, parameters = []) {
  if (!couchbase.cluster) throw new Error("Cluster connection not initialized.");
  const r = await couchbase.cluster.query(statement, { parameters });
  return r.rows || [];
}
const deleted = (p) => !p || p.isdeleted === true || String(p.isdeleted).toLowerCase() === "true";

// What a report file is, from its name (the inspector can override when releasing).
function guessKind(name) {
  const n = String(name || "").toLowerCase();
  if (/unsafe/.test(n)) return "unsafe";
  if (/final repairs|upon repairs|onsite visit/.test(n)) return "finalrepairs";
  if (/upon (completion|corrections)|owner supplied/.test(n)) return "finalcompletion";
  if (/final/.test(n)) return "final";
  if (/visual/.test(n)) return "visual";
  return "other";
}
const kindOk = (k) => Object.prototype.hasOwnProperty.call(KINDS, k);

// ---------------------------------------------------------------- records
async function getRecord(id) {
  if (!id || typeof id !== "string") return null;
  const rows = await q(`SELECT META(r).id AS id, r.project_id, r.name, r.url, r.timestamp, r.docType, r.clientRelease
    FROM ${ks("ProjectReports")} r USE KEYS $1`, [id]);
  const r = rows[0];
  if (!r || (r.docType && r.docType !== "ProjectReport" && r.docType !== "ProjectDocument")) return null;
  return r;
}
async function getProject(id) {
  if (!id) return null;
  const rows = await q(`SELECT META(p).id AS id, p.name, p.address, p.companyIdentifier, p.ownerClientId, p.managerClientId, p.isdeleted
    FROM ${ks("Project")} p USE KEYS $1`, [String(id)]);
  return rows[0] || null;
}
async function setRelease(id, release) {
  if (release) await q(`UPDATE ${ks("ProjectReports")} AS r USE KEYS $1 SET r.clientRelease = $2`, [id, release]);
  else await q(`UPDATE ${ks("ProjectReports")} AS r USE KEYS $1 UNSET r.clientRelease`, [id]);
}
// Every report file + document of one project, with its release state (staff screen).
async function filesOf(projectId) {
  const rows = await q(`SELECT META(r).id AS id, r.name, r.url, r.timestamp, r.docType, r.clientRelease
    FROM ${ks("ProjectReports")} r WHERE r.project_id = $1
    AND (r.docType IS MISSING OR r.docType IN ['ProjectReport', 'ProjectDocument'])`, [String(projectId)]);
  const failed = (r) => /FAILED/.test(r.name || "") || !r.url;
  return rows.filter((r) => !failed(r)).map((r) => ({
    id: r.id, name: r.name || "", timestamp: r.timestamp || "", source: r.docType === "ProjectDocument" ? "document" : "report",
    pdf: /\.pdf(\?|$)/i.test(r.url || ""), suggestedKind: guessKind(r.name),
    release: r.clientRelease && r.clientRelease.released ? publicRelease(r.clientRelease) : null,
  })).sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
}
function publicRelease(cr) {
  return { kind: cr.kind, label: cr.label, signedAt: cr.signedAt || "", signedBy: cr.signedBy || "" };
}

// ---------------------------------------------------------------- staff: sign + release
// staff = { company, username, name }. Returns { ok, release } or throws {status,message}.
function err(status, message) { const e = new Error(message); e.status = status; return e; }

async function release(staff, { id, kind, title, released = true, notify = true }) {
  const rec = await getRecord(id);
  if (!rec) throw err(404, "Report not found.");
  const p = await getProject(rec.project_id);
  if (!p || deleted(p) || p.companyIdentifier !== staff.company) throw err(404, "Report not found.");
  if (!released) {
    await setRelease(rec.id, null);
    return { ok: 1, release: null };
  }
  if (!rec.url) throw err(400, "This report has no file.");
  const k = kindOk(kind) ? kind : guessKind(rec.name);
  const prev = rec.clientRelease || {};
  const rel = {
    released: true, kind: k, label: String(title || KINDS[k]).slice(0, 120),
    signedAt: new Date().toISOString(), signedBy: String(staff.name || staff.username || "").slice(0, 120),
    signedByUser: String(staff.username || ""),
    // keep a PDF made earlier from the same file
    pdfUrl: prev.pdfOf === rec.url ? (prev.pdfUrl || "") : "", pdfOf: prev.pdfOf === rec.url ? rec.url : "",
  };
  await setRelease(rec.id, rel);
  let emailed = null;
  if (notify && !prev.released) {
    try { emailed = await notifyClients(p, rel); } catch (e) { console.error("portal report notify:", e && e.message); }
  }
  return { ok: 1, release: publicRelease(rel), emailed };
}

// ---------------------------------------------------------------- client side
// viewer = req.clientViewer. The client's portfolio decides what it may see.
async function portfolioIds(viewer) {
  const clients = require("../model/clients");
  const rows = await clients.getPortfolio(viewer.company, viewer.clientId);
  return new Map((rows || []).map((p) => [String(p.id), p]));
}

async function clientList(viewer, projectId) {
  const mine = await portfolioIds(viewer);
  let ids = [...mine.keys()];
  if (projectId) { if (!mine.has(String(projectId))) throw err(403, "This property is not in your portfolio."); ids = [String(projectId)]; }
  if (!ids.length) return [];
  const rows = await q(`SELECT META(r).id AS id, r.project_id, r.clientRelease FROM ${ks("ProjectReports")} r
    WHERE r.project_id IN $1 AND r.clientRelease.released = true`, [ids]);
  return rows.map((r) => {
    const p = mine.get(String(r.project_id)) || {};
    return { id: r.id, projectId: String(r.project_id), property: p.name || "", address: p.address || "", ...publicRelease(r.clientRelease) };
  }).sort((a, b) => new Date(b.signedAt || 0) - new Date(a.signedAt || 0));
}

// The record, if this viewer may download it.
async function clientRecord(viewer, id) {
  const rec = await getRecord(id);
  if (!rec || !rec.clientRelease || !rec.clientRelease.released) return null;
  const p = await getProject(rec.project_id);
  if (!p || deleted(p) || p.companyIdentifier !== viewer.company) return null;
  if (p.ownerClientId !== viewer.clientId && p.managerClientId !== viewer.clientId) return null;
  return { rec, project: p };
}

async function clientLink(viewer, id, origin) {
  const ok = await clientRecord(viewer, id);
  if (!ok) throw err(404, "Report not found.");
  const tok = jwt.sign({ p: "pr", r: ok.rec.id, v: viewer.username, c: viewer.company, k: viewer.clientId }, linkKey(), { expiresIn: LINK_TTL_S });
  return { url: `${origin || ""}/api/preport/${tok}`, expiresInSeconds: LINK_TTL_S };
}

function fileName(project, rel) {
  const base = `${project.name || "Property"} - ${rel.label || "Report"}`;
  return base.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150) + ".pdf";
}

// The PDF of a released record (made once from a Word file, then kept).
// Returns { url } or, right after converting, { url, buf } so the first download skips a fetch.
const making = new Map(); // id -> promise
async function pdfOf(rec) {
  const rel = rec.clientRelease || {};
  if (/\.pdf(\?|$)/i.test(rec.url || "")) return { url: rec.url };
  if (rel.pdfUrl && rel.pdfOf === rec.url) return { url: rel.pdfUrl };
  if (making.has(rec.id)) return making.get(rec.id);
  const job = (async () => {
    const axios = require("axios");
    const { convertDocxToPdf } = require("./convertDocxToPdf");
    const fs = require("fs"), os = require("os"), path = require("path");
    const resp = await axios.get(rec.url, { responseType: "arraybuffer", timeout: 120000 });
    const pdf = await convertDocxToPdf(Buffer.from(resp.data), "report.docx");
    const tmp = path.join(os.tmpdir(), `preport_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.pdf`);
    fs.writeFileSync(tmp, pdf);
    try {
      const uploadBlob = require("../database/uploadimage");
      const name = `${rec.id}-${Math.random().toString(36).slice(2, 12)}.pdf`;
      const r = JSON.parse(await uploadBlob.uploadFile("portalreports", name, tmp, {
        blobHTTPHeaders: { blobContentType: "application/pdf" }, metadata: { kind: "portal-report-pdf" },
      }));
      if (!r || !r.url) throw new Error("PDF upload returned no url");
      await setRelease(rec.id, { ...rel, pdfUrl: r.url, pdfOf: rec.url });
      return { url: r.url, buf: pdf };
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { /* temp only */ }
    }
  })();
  making.set(rec.id, job);
  try { return await job; } finally { making.delete(rec.id); }
}

// GET /api/preport/:tok - streams the PDF to the login named in the link.
function makeDownloadHandler(lookupUser) {
  const shield = require("./portalShield");
  const links = require("../model/portalLinks");
  return async function reportHandler(req, res) {
    let t = null;
    try { t = jwt.verify(req.params.tok, linkKey()); } catch (e) { t = null; }
    if (!t || t.p !== "pr" || !t.r || !t.v) return res.status(410).type("text/plain").send("This download link has expired. Open the report again from the portal.");
    let rec;
    try { rec = await lookupUser(t.v); } catch (e) { return res.status(503).type("text/plain").send("Please try again in a moment."); }
    if (!rec || rec.isActive === false || String(rec.role || "").toLowerCase() !== "client") return res.status(403).type("text/plain").send("This login no longer has access.");
    const link = links.linkFor(rec, t.c, t.k);
    if (!link) return res.status(403).type("text/plain").send("This login no longer has access.");
    const viewer = { username: rec.username, company: link.companyIdentifier, clientId: link.clientId, role: "client", name: [rec.first_name, rec.last_name].filter(Boolean).join(" ") };
    if (!shield.allow(rec.username, "api")) return res.status(429).type("text/plain").send("Too many downloads - please slow down.");
    try {
      const ok = await clientRecord(viewer, t.r);
      if (!ok) return res.status(404).type("text/plain").send("This report is no longer available.");
      shield.note(viewer, "api", { req, projectIds: [ok.project.id] });
      const made = await pdfOf(ok.rec);
      let body = made.buf;
      if (!body) {
        const axios = require("axios");
        const resp = await axios.get(made.url, { responseType: "arraybuffer", timeout: 120000 });
        body = Buffer.from(resp.data);
      }
      const fname = fileName(ok.project, ok.rec.clientRelease);
      res.set({
        "Content-Type": "application/pdf", "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex",
        "Content-Disposition": `${req.query && req.query.dl ? "attachment" : "inline"}; filename="${fname.replace(/[^\x20-\x7E]/g, "").replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(fname)}`,
      });
      return res.status(200).send(Buffer.from(body));
    } catch (e) {
      console.error("preport:", e && e.message);
      return res.status(502).type("text/plain").send("The report could not be prepared. Please try again in a few minutes.");
    }
  };
}

// ---------------------------------------------------------------- email
async function clientRecipients(project) {
  const links = require("../model/portalLinks");
  const users = require("../model/user");
  const out = new Map();
  for (const cid of [project.ownerClientId, project.managerClientId].filter(Boolean)) {
    let rows = [];
    try { rows = rows.concat(await users.getClientUsers(project.companyIdentifier, cid)); } catch (e) { /* */ }
    try { rows = rows.concat(await links.linkedUsers(project.companyIdentifier, cid)); } catch (e) { /* */ }
    for (const u of rows) {
      const email = String(u.email || (/@/.test(u.username || "") ? u.username : "") || "").trim().toLowerCase();
      if (!email || u.isActive === false) continue;
      if (u.linkActive === false || u.primaryActive === false) continue;
      if (!out.has(email)) out.set(email, u.first_name || "");
    }
  }
  return [...out].map(([email, first]) => ({ email, first }));
}

async function inspectorName(company) {
  try {
    const t = await require("./tenantService").getTenantByCompanyIdentifier(company);
    return (t && t.Tenant && t.Tenant.name) || company;
  } catch (e) { return company; }
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function mailBody({ heading, lines, button, url }) {
  const text = lines.concat(["", `${button}: ${url}`]).join("\n");
  const html = `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;color:#1c2733;line-height:1.5;max-width:620px;margin:0 auto;padding:24px">
<p style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#51616f;margin:0 0 6px">E3 Property Owner Portal</p>
<h2 style="margin:0 0 16px;color:#292c74">${esc(heading)}</h2>
${lines.filter(Boolean).map((l) => `<p>${esc(l)}</p>`).join("\n")}
<p style="margin:22px 0"><a href="${esc(url)}" style="background:#292c74;color:#fff;text-decoration:none;padding:13px 24px;border-radius:10px;font-weight:700;display:inline-block">${esc(button)}</a></p>
</body></html>`;
  return { text, html };
}

// "A signed report is in your portal" - to every active portal login of the property's clients.
async function notifyClients(project, rel) {
  const mail = require("./portalMail");
  if (!mail.configured()) return { sent: 0, reason: "email not configured" };
  const to = await clientRecipients(project);
  const who = await inspectorName(project.companyIdentifier);
  let sent = 0;
  for (const r of to) {
    const body = mailBody({
      heading: `${rel.label} is ready`,
      lines: [`Hello${r.first ? " " + r.first : ""},`, `${who} has signed the ${rel.label} for ${project.name || "your property"}${project.address ? " (" + project.address + ")" : ""}.`, "You can open and download it in your E3 Property Owner Portal."],
      button: "Open the property", url: `${mail.APP}/?property=${encodeURIComponent(project.id)}&why=report`,
    });
    const res = await mail.send({ to: r.email, subject: `${rel.label} - ${project.name || "your property"}`, text: body.text, html: body.html, kind: "report" });
    if (res && res.sent) sent++;
  }
  return { sent, recipients: to.length };
}

// The inspection company's admins - told when a client requests a Final.
async function companyAdmins(company) {
  const rows = await q(`SELECT u.email, u.username, u.first_name FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Users u
    WHERE u.companyIdentifier = $1 AND LOWER(u.\`role\`) = 'admin' AND (u.isActive IS MISSING OR u.isActive != false)`, [company]);
  const out = new Map();
  for (const u of rows) {
    const email = String(u.email || (/@/.test(u.username || "") ? u.username : "") || "").trim().toLowerCase();
    if (email && !out.has(email)) out.set(email, u.first_name || "");
  }
  return [...out].map(([email, first]) => ({ email, first }));
}

// "A client has requested a Final Report" - to the inspection company's admins.
async function notifyFinalRequested(project, job, clientName) {
  const mail = require("./portalMail");
  if (!mail.configured()) return { sent: 0, reason: "email not configured" };
  const to = await companyAdmins(project.companyIdentifier);
  let sent = 0;
  for (const r of to) {
    const body = mailBody({
      heading: "Final Report requested",
      lines: [
        `Hello${r.first ? " " + r.first : ""},`,
        `${job.submittedBy || "The property owner"}${clientName ? " (" + clientName + ")" : ""} reports that the repairs at ${project.name || "a property"}${project.address ? " (" + project.address + ")" : ""} are complete and requests the Final Report.`,
        job.method === "onsite"
          ? `They request an ON-SITE Final Inspection${job.methodReason === "unsafe" ? " - required: unsafe conditions were reported here, so the repairs must be inspected on site and reported to the local building department" : " (usually needed for a mortgage lender)"}. Schedule the visit from Final Reports in E3 Web.`
          : "They request the Final Report Upon Completion from the owner-supplied photos (inspector sign-off for the building department).",
        `${job.itemsTotal || 0} repair item${job.itemsTotal === 1 ? "" : "s"} with photos are waiting for your review under Final Reports in E3 Web.`,
        job.note ? `Note from the client: ${job.note}` : "",
      ],
      button: "Open the property in E3 Web", url: `${mail.APP}/?property=${encodeURIComponent(project.id)}&why=final`,
    });
    const res = await mail.send({ to: r.email, subject: `${job.method === "onsite" ? "On-site Final Inspection" : "Final Report (owner photos)"} requested - ${project.name || "property"}`, text: body.text, html: body.html, kind: "final-request" });
    if (res && res.sent) sent++;
  }
  return { sent, recipients: to.length };
}

// SIGNED FINAL UPLOADED (David, Nov 1 2026): when the client calls or emails instead of using
// the portal, the inspector runs the normal process and uploads the signed Final under the
// project's Documents. That upload is the "Final is done" signal: release it to the client
// portal (PDF, email) and close any open repair request for the property as "Final issued".
const FINAL_KINDS = ["final", "finalcompletion", "finalrepairs"];
function isSignedFinalName(name, url) {
  const n = String(name || "");
  if (!/final/i.test(n) || /proposal|invoice|template|draft/i.test(n)) return false;
  return /\.(pdf|docx?|docm)(\?|$)/i.test(String(url || n)) || /\.(pdf|docx?|docm)$/i.test(n);
}
async function autoReleaseSignedFinal(staff, docId, name, url) {
  if (!isSignedFinalName(name, url)) return null;
  const rec = await getRecord(docId);
  if (!rec) return null;
  const repairs = require("../model/repairs");
  const job = await repairs.getJob(String(rec.project_id)).catch(() => null);
  let kind = guessKind(name);
  if (!FINAL_KINDS.includes(kind)) kind = "final";
  if (kind === "final" && job && job.method === "onsite") kind = "finalrepairs";
  if (kind === "final" && job && job.method === "photos") kind = "finalcompletion";
  const out = await release(staff, { id: rec.id, kind, notify: true });
  let closed = false;
  if (job && job.status !== "issued") {
    job.status = "issued"; job.finalReportId = rec.id;
    job.issuedAt = new Date().toISOString(); job.issuedBy = staff.name || staff.username || "";
    job.history = (job.history || []).slice(-60);
    job.history.push({ at: job.issuedAt, by: job.issuedBy, role: "staff", what: "Signed Final uploaded - issued to the client", note: "" });
    await repairs.saveJob(job);
    closed = true;
  }
  return { released: true, kind, label: out.release && out.release.label, emailed: out.emailed || null, requestClosed: closed };
}

module.exports = {
  autoReleaseSignedFinal, isSignedFinalName,
  KINDS, guessKind, getRecord, getProject, filesOf, release, clientList, clientLink, makeDownloadHandler,
  notifyClients, notifyFinalRequested, companyAdmins, clientRecipients,
  // tests
  _pdfOf: pdfOf, _fileName: fileName, _linkKey: linkKey,
};
