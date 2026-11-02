"use strict";
// E3 E-SIGN routes (David, Nov 1 2026). See service/esign/index.js.
//
// STAFF (mounted at /api/esign behind authenticateToken - portal logins never get here):
//   GET    /api/esign/status                  is the E3 signing certificate installed? (test mode)
//   GET    /api/esign/signers                 this company's signers + whether each adopted a signature
//   GET    /api/esign/signer-image/:signerId  the adopted signature (PNG/JPG) - own company only
//   POST   /api/esign/signer-image            { signerId, dataUrl }  adopt (drawn or uploaded)
//   DELETE /api/esign/signer-image/:signerId
//   POST   /api/esign/sign                    { id, signerId, kind, title, release }
//
// PUBLIC (anyone holding a signed report - shows no property, client or report content):
//   GET /v/:documentId  and  /verify/:documentId   verification page (the QR code opens /v/...)
//   GET /verify                                     look up a Document ID
//   GET /api/verify/:documentId                     the same as JSON
const express = require("express");
const esign = require("../service/esign");

const staffRouter = express.Router();

async function staffOf(req) {
  const company = req.user && req.user.company;
  if (!company) return null;
  const users = require("../model/user");
  let me = null;
  try { me = await users.getUserbyUsername(req.user.username); } catch (e) { me = null; }
  if (!me) return null;
  const role = String(me.role || "").toLowerCase();
  if (role === "client" || role === "contractor") return null;
  if (me.companyIdentifier && me.companyIdentifier !== company) return null;
  return { company, username: me.username, name: [me.first_name, me.last_name].filter(Boolean).join(" ") || me.username };
}
// 400, never 403: the web app treats 403 as "session expired" and signs the user out.
function fail(res, code, message) { return res.status(code === 403 ? 400 : code).json({ success: false, message }); }
function ipOf(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (xf || req.ip || "").replace(/:\d+$/, "").replace(/^::ffff:/, "");
}

staffRouter.get("/status", async (req, res) => res.status(200).json({ success: true, ...esign.status() }));

staffRouter.get("/signers", async (req, res) => {
  try {
    const staff = await staffOf(req);
    if (!staff) return fail(res, 400, "Not allowed.");
    return res.status(200).json({ success: true, signers: await esign.signersOf(staff.company) });
  } catch (e) { console.error("esign signers:", e && e.message); return fail(res, 500, "Could not load the signers."); }
});

staffRouter.get("/signer-image/:signerId", async (req, res) => {
  try {
    const staff = await staffOf(req);
    if (!staff) return fail(res, 400, "Not allowed.");
    const img = await esign.signerImage(staff.company, String(req.params.signerId || ""));
    if (!img) return fail(res, 404, "No signature adopted yet.");
    res.set({ "Content-Type": img.type, "Cache-Control": "private, no-store" });
    return res.status(200).send(img.buf);
  } catch (e) { return fail(res, 500, "Could not load the signature."); }
});

staffRouter.post("/signer-image", express.json({ limit: "3mb" }), async (req, res) => {
  try {
    const staff = await staffOf(req);
    if (!staff) return fail(res, 400, "Not allowed.");
    const b = req.body || {};
    return res.status(200).json({ success: true, ...(await esign.saveSignerImage(staff, String(b.signerId || ""), b.dataUrl)) });
  } catch (e) {
    if (e && e.status) return fail(res, e.status, e.message);
    console.error("esign signer-image:", e && e.message);
    return fail(res, 500, "Could not save the signature.");
  }
});

staffRouter.delete("/signer-image/:signerId", async (req, res) => {
  try {
    const staff = await staffOf(req);
    if (!staff) return fail(res, 400, "Not allowed.");
    return res.status(200).json({ success: true, ...(await esign.removeSignerImage(staff, String(req.params.signerId || ""))) });
  } catch (e) { return fail(res, 500, "Could not remove the signature."); }
});

const busy = new Set(); // one signing per report at a time
staffRouter.post("/sign", async (req, res) => {
  const b = req.body || {};
  const id = String(b.id || "");
  if (busy.has(id)) return fail(res, 409, "This report is being signed already.");
  busy.add(id);
  try {
    const staff = await staffOf(req);
    if (!staff) return fail(res, 400, "Not allowed.");
    const out = await esign.signReport(staff, { id, signerId: String(b.signerId || ""), kind: b.kind, title: b.title, release: b.release === true, ip: ipOf(req) });
    return res.status(200).json({ success: true, ...out });
  } catch (e) {
    if (e && e.status) return fail(res, e.status, e.message);
    console.error("esign sign:", e && e.stack || e);
    return fail(res, 500, "The report could not be signed: " + (e && e.message || "unknown error"));
  } finally { busy.delete(id); }
});

// ---------------------------------------------------------------- public verify
const publicRouter = express.Router();

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
:root{--ink:#1b2433;--soft:#3d4756;--muted:#5a6473;--line:#c9d2de;--panel:#f7f9fc;--accent:#1d5fa8;--ok:#0f6e5c;--bad:#b00020;--bg:#eef2f7}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 "Segoe UI",Inter,Arial,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 48px}
.brand{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:0 0 4px}
h1{font-size:26px;margin:0 0 20px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:22px 22px;margin:0 0 18px}
.st{display:flex;gap:12px;align-items:center;font-size:19px;font-weight:700;margin:0 0 6px}
.st .dot{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;color:#fff;flex:0 0 30px;font-size:17px}
.ok .dot{background:var(--ok)}.ok{color:var(--ok)}.bad .dot{background:var(--bad)}.bad{color:var(--bad)}
dl{display:grid;grid-template-columns:minmax(120px,170px) 1fr;gap:8px 16px;margin:14px 0 0}
dt{font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;padding-top:2px}dd{margin:0;overflow-wrap:anywhere}
.mono{font-family:Consolas,"Courier New",monospace;font-size:14px}
.hint{color:var(--soft);font-size:14px}
label.drop{display:block;border:2px dashed var(--line);border-radius:10px;padding:18px;text-align:center;cursor:pointer;background:var(--panel);margin-top:10px}
input[type=text]{width:100%;padding:12px;border:1.5px solid var(--line);border-radius:8px;font:inherit}
button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:12px 20px;font:inherit;font-weight:700;cursor:pointer;margin-top:10px}
#res{font-weight:700;margin-top:12px}
@media (max-width:520px){dl{grid-template-columns:1fr}dt{padding-top:6px}}
</style></head><body><main>
<p class="brand">E3 Inspection Reporting Solutions</p>${body}
<p class="hint">Reports are signed through E3 and sealed with a certificate-based digital signature; the signing inspector is certified through the E3 Inspection Association. Opening the PDF in Adobe Acrobat or Reader also shows the signature panel.</p>
</main></body></html>`;
}

function lookupPage(msg) {
  return page("Verify an E3 signed report", `<h1>Verify a signed report</h1>
<div class="card"><p class="hint" style="margin-top:0">Enter the Document ID printed in the signature block or on the Certificate of Completion page.</p>
${msg ? `<p class="bad" style="font-weight:700">${esc(msg)}</p>` : ""}
<form onsubmit="var v=document.getElementById('i').value.trim().toUpperCase();if(v)location.href='/v/'+encodeURIComponent(v);return false">
<input type="text" id="i" placeholder="E3-2026-00000-XXXXXXXX" autocomplete="off" autocapitalize="characters"><button type="submit">Verify</button></form></div>`);
}

function resultPage(r) {
  const valid = r.status === "valid" && !r.test;
  const head = valid
    ? `<div class="st ok"><span class="dot">&#10003;</span>Authentic E3 signed report</div><p class="hint" style="margin:0">This Document ID was issued by E3 when the report below was signed.</p>`
    : r.test
      ? `<div class="st bad"><span class="dot">!</span>Test signature - not a valid report</div><p class="hint" style="margin:0">This copy was signed while the E3 signing certificate was not yet installed.</p>`
      : `<div class="st bad"><span class="dot">&#10005;</span>This signature has been withdrawn</div><p class="hint" style="margin:0">Ask the inspection company for the current copy of the report.</p>`;
  const sg = r.signer || {};
  return page(`Verify ${r.documentId}`, `<h1>Signed report verification</h1>
<div class="card">${head}
<dl>
<dt>Document ID</dt><dd class="mono">${esc(r.documentId)}</dd>
<dt>Document</dt><dd>${esc(r.title)}</dd>
<dt>Issued by</dt><dd>${esc(r.issuedBy)}</dd>
<dt>Signed by</dt><dd>${esc(sg.name)}${sg.title ? " &middot; " + esc(sg.title) : ""}${sg.license ? "<br>License No. " + esc(sg.license) : ""}</dd>
<dt>Signed</dt><dd>${esc(when(r.signedAt))}</dd>
<dt>Pages</dt><dd>${esc(r.pages)}</dd>
<dt>Certificate</dt><dd>${esc(r.certificate)}</dd>
<dt>Fingerprint</dt><dd class="mono">${esc(r.signedSha256)}</dd>
</dl></div>
<div class="card"><b>Check your copy</b>
<p class="hint" style="margin:4px 0 0">Choose the PDF you received. It is checked here in your browser - the file is not uploaded anywhere.</p>
<label class="drop"><input type="file" id="f" accept="application/pdf,.pdf" style="display:none">Choose the PDF&hellip;</label>
<div id="res" aria-live="polite"></div></div>
<script>
document.getElementById('f').addEventListener('change',async function(ev){
  var f=ev.target.files[0];var out=document.getElementById('res');if(!f)return;
  out.className='';out.textContent='Checking...';
  try{var h=await crypto.subtle.digest('SHA-256',await f.arrayBuffer());
  var hex=Array.from(new Uint8Array(h)).map(function(b){return b.toString(16).padStart(2,'0')}).join('');
  if(hex===${JSON.stringify(String(r.signedSha256 || ""))}){out.className='ok';out.textContent='\\u2713 This file is exactly the report E3 signed - it has not been changed.';}
  else{out.className='bad';out.textContent='\\u2715 This file is NOT the signed original - it was changed, re-saved or is a different report.';}}
  catch(e){out.className='bad';out.textContent='Could not read the file.';}
});
</script>`);
}

async function verifyHtml(req, res) {
  res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
  try {
    const r = await esign.lookup(req.params.documentId);
    if (!r) return res.status(404).type("html").send(lookupPage("No signed report has this Document ID. Check the ID and try again."));
    return res.status(200).type("html").send(resultPage(r));
  } catch (e) {
    console.error("verify:", e && e.message);
    return res.status(503).type("html").send(lookupPage("Verification is unavailable for a moment. Please try again shortly."));
  }
}
publicRouter.get("/v/:documentId", verifyHtml);
publicRouter.get("/verify/:documentId", verifyHtml);
publicRouter.get("/verify", (req, res) => res.status(200).type("html").send(lookupPage("")));
publicRouter.get("/api/verify/:documentId", async (req, res) => {
  try {
    const r = await esign.lookup(req.params.documentId);
    if (!r) return res.status(404).json({ success: false, message: "Not found." });
    return res.status(200).json({ success: true, ...r });
  } catch (e) { return res.status(503).json({ success: false, message: "Try again shortly." }); }
});

module.exports = { staffRouter, publicRouter, _pages: { resultPage, lookupPage } };
