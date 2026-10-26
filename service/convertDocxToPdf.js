"use strict";

// Word -> PDF conversion for every E3 tenant.
//
// 1) Microsoft 365 (preferred, Oct 26 2026): the .docx is uploaded to a
//    OneDrive folder through Microsoft Graph, fetched back with ?format=pdf
//    (rendered by Microsoft's own Word engine - same layout as "Save as PDF"
//    in Word), then the temporary file is deleted. LibreOffice reflowed the
//    report tables, clipped fixed-size boxes and dropped checkbox glyphs.
//    Enabled when these App Service settings are present:
//      GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET,
//      GRAPH_PDF_USER   (UPN of the OneDrive used for the temp files)
//      GRAPH_PDF_FOLDER (optional, default "E3-PDF-Conversion")
// 2) Fallback: the self-hosted converter (Gotenberg / LibreOffice on the
//    e3-couchbase-vm, CONVERT_URL + CONVERT_TOKEN), used when Graph is not
//    configured or a Graph conversion fails, so PDFs never stop working.

const crypto = require("crypto");

const GRAPH = "https://graph.microsoft.com/v1.0";
const CHUNK = 320 * 1024 * 16; // 5 MiB, a multiple of 320 KiB as Graph requires

let tokenCache = { value: "", expires: 0 };

function graphConfigured() {
  return !!(process.env.GRAPH_TENANT_ID && process.env.GRAPH_CLIENT_ID &&
            process.env.GRAPH_CLIENT_SECRET && process.env.GRAPH_PDF_USER);
}

async function graphToken() {
  if (tokenCache.value && Date.now() < tokenCache.expires - 60000) return tokenCache.value;
  const body = new URLSearchParams({
    client_id: process.env.GRAPH_CLIENT_ID,
    client_secret: process.env.GRAPH_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const resp = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(process.env.GRAPH_TENANT_ID)}/oauth2/v2.0/token`,
    { method: "POST", body }
  );
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok || !j.access_token) {
    throw new Error("graph token " + resp.status + " " + String(j.error_description || j.error || "").slice(0, 200));
  }
  tokenCache = { value: j.access_token, expires: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenCache.value;
}

async function graphFetch(url, opts = {}, tries = 3) {
  for (let i = 1; ; i++) {
    const token = await graphToken();
    const resp = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + token } });
    // 429 / 5xx are transient on Graph - back off and retry.
    if ((resp.status === 429 || resp.status >= 500) && i < tries) {
      const wait = Math.min(Number(resp.headers.get("retry-after")) * 1000 || 2000 * i, 15000);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    return resp;
  }
}

async function convertViaGraph(buf, filename) {
  const user = encodeURIComponent(process.env.GRAPH_PDF_USER);
  const folder = (process.env.GRAPH_PDF_FOLDER || "E3-PDF-Conversion").replace(/^\/+|\/+$/g, "");
  const name = `${crypto.randomUUID()}.docx`; // never the client's file name
  const drive = `${GRAPH}/users/${user}/drive`;
  let itemId = "";
  try {
    // Upload session works for any size (reports with photos run 20 MB+).
    const s = await graphFetch(`${drive}/root:/${encodeURI(folder)}/${name}:/createUploadSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }),
    });
    const sj = await s.json().catch(() => ({}));
    if (!s.ok || !sj.uploadUrl) throw new Error("graph upload session " + s.status + " " + JSON.stringify(sj.error || "").slice(0, 200));
    let item = null;
    for (let start = 0; start < buf.length; start += CHUNK) {
      const end = Math.min(start + CHUNK, buf.length);
      // The upload URL is pre-authorized: no Authorization header on chunks.
      const r = await fetch(sj.uploadUrl, {
        method: "PUT",
        headers: { "Content-Length": String(end - start), "Content-Range": `bytes ${start}-${end - 1}/${buf.length}` },
        body: buf.subarray(start, end),
      });
      if (!r.ok) throw new Error("graph upload chunk " + r.status + " " + (await r.text().catch(() => "")).slice(0, 200));
      if (end === buf.length) item = await r.json().catch(() => null);
    }
    if (!item || !item.id) throw new Error("graph upload returned no item");
    itemId = item.id;
    const p = await graphFetch(`${drive}/items/${itemId}/content?format=pdf`, { redirect: "follow" });
    if (!p.ok) throw new Error("graph pdf " + p.status + " " + (await p.text().catch(() => "")).slice(0, 200));
    const pdf = Buffer.from(await p.arrayBuffer());
    if (pdf.subarray(0, 4).toString() !== "%PDF") throw new Error("graph pdf: response is not a PDF");
    return pdf;
  } finally {
    if (itemId) {
      graphFetch(`${drive}/items/${itemId}`, { method: "DELETE" })
        .catch(e => console.warn("graph temp delete failed:", e && e.message));
    }
  }
}

async function convertViaGotenberg(buf, filename) {
  const base = (process.env.CONVERT_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("CONVERT_URL not configured");
  const token = process.env.CONVERT_TOKEN || "";
  const fd = new FormData();
  fd.append(
    "files",
    new Blob([buf], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    filename
  );
  const headers = token ? { "X-Convert-Token": token } : {};
  const resp = await fetch(base + "/forms/libreoffice/convert", {
    method: "POST",
    headers,
    body: fd,
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error("converter " + resp.status + " " + t.slice(0, 200));
  }
  return Buffer.from(await resp.arrayBuffer());
}

async function convertDocxToPdf(buf, filename) {
  buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (graphConfigured()) {
    const t0 = Date.now();
    try {
      const pdf = await convertViaGraph(buf, filename);
      console.log(`PDF via Microsoft 365 (${filename}, ${buf.length} -> ${pdf.length} bytes, ${Date.now() - t0} ms)`);
      return pdf;
    } catch (e) {
      console.error("PDF via Microsoft 365 failed - falling back to LibreOffice:", e && e.message);
    }
  }
  return convertViaGotenberg(buf, filename);
}

module.exports = { convertDocxToPdf, graphConfigured, convertViaGraph, convertViaGotenberg };
