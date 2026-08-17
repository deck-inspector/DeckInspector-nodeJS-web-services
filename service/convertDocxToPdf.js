"use strict";

// Convert a Word buffer to PDF using the self-hosted converter (Gotenberg /
// LibreOffice on the e3-couchbase-vm, reachable only from the App Service).
// Extracted to a shared module (Aug 17) so the client-email flow can convert
// uploaded Final Reports to PDF before they are attached to Outlook drafts.
// The same logic lives inline in routes/project-endpoint.js for the client
// forms; new callers should use this module.
async function convertDocxToPdf(buf, filename) {
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

module.exports = { convertDocxToPdf };
