"use strict";
// E3 E-SIGN - the VISIBLE part of a signed report (David, Nov 1 2026).
//
// Approved designs (canvas "E3 Signature Block"):
//   Option B - Seal + QR signature block   -> drawn into the report's own "Signature" cell
//                                             (or on an added signature page when the report
//                                             has no signature table)
//   Certificate of Completion page          -> appended as the last page
//
// Everything is drawn with pdf-lib as vectors (seal, QR code) so it prints crisp. The
// cryptographic seal (service/esign/seal.js) is applied AFTER this, over the finished file.
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const { PDFDocument, StandardFonts, rgb, degrees } = require("pdf-lib");

const INK = rgb(0x1b / 255, 0x24 / 255, 0x33 / 255);
const SOFT = rgb(0x3d / 255, 0x47 / 255, 0x56 / 255);
const MUTED = rgb(0x5a / 255, 0x64 / 255, 0x73 / 255);
const LINE = rgb(0xc9 / 255, 0xd2 / 255, 0xde / 255);
const RULE = rgb(0xe2 / 255, 0xe6 / 255, 0xec / 255);
const PANEL = rgb(0xf7 / 255, 0xf9 / 255, 0xfc / 255);
const SIGINK = rgb(0x12 / 255, 0x20 / 255, 0x3a / 255);
const GREEN = rgb(0x0f / 255, 0x6e / 255, 0x5c / 255);
const RED = rgb(0xb0 / 255, 0x00 / 255, 0x20 / 255);
const ACCENT = rgb(0x1d / 255, 0x5f / 255, 0xa8 / 255);
const IN = 72;
const SEAL_FADE = Number(process.env.ESIGN_SEAL_OPACITY || 0.38); // how faded the seal is under the signature

// Helvetica / Courier only encode WinAnsi - keep every string printable.
function safe(s) {
  return String(s == null ? "" : s)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
    .replace(/·/g, "·").replace(/[^\x20-\x7e -ÿ]/g, "");
}
function fit(font, text, size, maxW) {
  let t = safe(text);
  if (font.widthOfTextAtSize(t, size) <= maxW) return t;
  while (t.length > 1 && font.widthOfTextAtSize(t + "...", size) > maxW) t = t.slice(0, -1);
  return t + "...";
}
function wrap(font, text, size, maxW) {
  const words = safe(text).split(/\s+/).filter(Boolean);
  const lines = []; let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (font.widthOfTextAtSize(t, size) > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}
function pacific(iso) {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "2-digit", day: "2-digit", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
  const tz = d.toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "short" }).split(" ").pop();
  return { date, time, tz, full: `${date} ${time} ${tz}` };
}

// ---------------------------------------------------------------- fonts
async function fonts(doc) {
  const fontkit = require("@pdf-lib/fontkit");
  doc.registerFontkit(fontkit);
  const scriptBytes = fs.readFileSync(path.join(__dirname, "assets", "MrsSaintDelafield.woff"));
  let logo = null;
  for (const n of ["e3-association-logo.png", "e3-association-logo.jpg"]) {
    const p = path.join(__dirname, "assets", n);
    if (!fs.existsSync(p)) continue;
    try { const b = fs.readFileSync(p); logo = n.endsWith(".png") ? await doc.embedPng(b) : await doc.embedJpg(b); } catch (e) { logo = null; }
    if (logo) break;
  }
  return {
    logo: "vector", // the redrawn Association logo (the image file is the fallback reference only)
    serif: await doc.embedFont(StandardFonts.TimesRomanBold),
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
    script: await doc.embedFont(scriptBytes, { subset: true }),
  };
}

// ---------------------------------------------------------------- pieces
// The E3 Verified seal - the certifying mark of the E3 INSPECTION ASSOCIATION (David, Nov 1:
// "the stamp incorporates the E3 Association Logo - this is the certifying body").
// Two rings, "E3 VERIFIED" around the top, "INSPECTION ASSOCIATION" around the bottom (large
// seals), and the Association logo in the centre. Without the logo file the centre falls back
// to "E3" + check mark.  Logo file: service/esign/assets/e3-association-logo.png (or .jpg).
function arcText(page, font, txt, cx, cy, rr, size, color, bottom, opacity = 1, spacing = 0.16) {
  const widths = [...txt].map((ch) => font.widthOfTextAtSize(ch, size) + size * spacing);
  const total = widths.reduce((a, b) => a + b, 0);
  let a = bottom ? (3 * Math.PI) / 2 - total / rr / 2 : Math.PI / 2 + total / rr / 2;
  for (let i = 0; i < txt.length; i++) {
    const w = widths[i];
    const mid = bottom ? a + w / rr / 2 : a - w / rr / 2;
    const rot = bottom ? mid + Math.PI / 2 : mid - Math.PI / 2;
    const r = bottom ? rr + size * 0.7 : rr; // bottom glyphs hang inside the ring, baseline outward
    const x = cx + r * Math.cos(mid), y = cy + r * Math.sin(mid);
    const half = font.widthOfTextAtSize(txt[i], size) / 2;
    page.drawText(txt[i], {
      x: x - half * Math.cos(rot), y: y - half * Math.sin(rot), size, font, color: typeof color === "function" ? color(i) : color, opacity,
      rotate: degrees((rot * 180) / Math.PI),
    });
    a = bottom ? a + w / rr : a - w / rr;
  }
}
// The E3 INSPECTION ASSOCIATION logo, redrawn as vectors (David, Nov 1 2026: the supplied
// 87 x 77 px image "is poorly created") - crisp at any size and in print:
// "ASSOCIATION OF PROFESSIONAL EXTERIOR ELEVATED ELEMENTS INSPECTORS" around the ring (the three
// E's in red), a navy serif E with a light-blue shadow, and a magnifying glass holding a red 3.
const NAVY = rgb(0x1a / 255, 0x23 / 255, 0x8f / 255);
const SHADE = rgb(0x9a / 255, 0xa6 / 255, 0xe6 / 255);
const LRED = rgb(0xc0 / 255, 0x2b / 255, 0x2b / 255);
const GLASS = rgb(0x8e / 255, 0x95 / 255, 0x9e / 255);
function drawAssocLogo(page, f, cx, cy, d, opacity = 1) {
  const r = d / 2;
  const ring = "ASSOCIATION OF PROFESSIONAL EXTERIOR ELEVATED ELEMENTS INSPECTORS";
  const reds = new Set(); // first letters of Exterior / Elevated / Elements
  for (const w of ["EXTERIOR", "ELEVATED", "ELEMENTS"]) reds.add(ring.indexOf(w));
  const rr = r * 0.86;
  const span = (318 * Math.PI) / 180; // the words run around 300 degrees, open at the bottom
  let size = 10, spacing = 0.06;
  const len = (sz) => [...ring].reduce((a, ch) => a + f.serif.widthOfTextAtSize(ch, sz) + sz * spacing, 0);
  size = (rr * span) / (len(10) / 10);
  arcText(page, f.serif, ring, cx, cy, rr, size, (i) => (reds.has(i) ? LRED : NAVY), false, opacity, spacing);
  // the E (shadow first), a little left of centre
  const eS = d * 0.56;
  const ew = f.serif.widthOfTextAtSize("E", eS);
  const ex = cx - ew / 2 - d * 0.075, ey = cy - eS * 0.31;
  page.drawText("E", { x: ex + d * 0.022, y: ey - d * 0.022, size: eS, font: f.serif, color: SHADE, opacity });
  page.drawText("E", { x: ex, y: ey, size: eS, font: f.serif, color: NAVY, opacity });
  // magnifying glass with the red 3
  const gx = cx + d * 0.2, gy = cy + d * 0.02, gr = d * 0.11;
  const hx = Math.cos(-Math.PI / 4), hy = Math.sin(-Math.PI / 4);
  page.drawLine({ start: { x: gx + hx * gr, y: gy + hy * gr }, end: { x: gx + hx * (gr + d * 0.13), y: gy + hy * (gr + d * 0.13) }, thickness: d * 0.032, color: rgb(0.3, 0.32, 0.35), opacity, lineCap: 1 });
  page.drawCircle({ x: gx, y: gy, size: gr, color: rgb(1, 1, 1), borderColor: GLASS, borderWidth: d * 0.018, opacity, borderOpacity: opacity });
  const tS = d * 0.17, tw = f.serif.widthOfTextAtSize("3", tS);
  page.drawText("3", { x: gx - tw / 2, y: gy - tS * 0.33, size: tS, font: f.serif, color: LRED, opacity });
}

function drawSeal(page, f, cx, cy, d, color = ACCENT, logo = null, opacity = 1) {
  const r = d / 2;
  if (logo === "vector") {
    page.drawCircle({ x: cx, y: cy, size: r - 0.75, borderColor: color, borderWidth: Math.max(1.2, d / 30), borderOpacity: opacity });
    drawAssocLogo(page, f, cx, cy, d * 0.92, opacity);
    return;
  }
  if (logo) {
    // the Association's own seal, in a blue certifying ring
    page.drawCircle({ x: cx, y: cy, size: r - 0.75, borderColor: color, borderWidth: Math.max(1.2, d / 30), borderOpacity: opacity });
    const box = d * 0.86;
    const sc = Math.min(box / logo.width, box / logo.height);
    const w = logo.width * sc, h = logo.height * sc;
    page.drawImage(logo, { x: cx - w / 2, y: cy - h / 2, width: w, height: h, opacity });
    return;
  }
  page.drawCircle({ x: cx, y: cy, size: r - 0.75, borderColor: color, borderWidth: Math.max(1, d / 36), color: rgb(1, 1, 1) });
  page.drawCircle({ x: cx, y: cy, size: r * 0.74, borderColor: color, borderWidth: Math.max(0.4, d / 110) });
  const big = d >= 0.95 * IN;
  arcText(page, f.bold, "E3 VERIFIED", cx, cy, r * 0.8, d * (big ? 0.085 : 0.1), color, false);
  if (big) arcText(page, f.bold, "INSPECTION ASSOCIATION", cx, cy, r * 0.8, d * 0.06, color, true);
  const e3 = d * 0.2;
  const ew = f.bold.widthOfTextAtSize("E3", e3);
  page.drawText("E3", { x: cx - ew / 2, y: cy - e3 * 0.15, size: e3, font: f.bold, color });
  const s = d / 104; // check mark, from the approved SVG (viewBox 104)
  const pt = (px, py) => ({ x: cx + (px - 52) * s, y: cy - (py - 52) * s });
  const th = Math.max(1.2, d * 0.034);
  page.drawLine({ start: pt(38, 70), end: pt(46, 77), thickness: th, color, lineCap: 1 });
  page.drawLine({ start: pt(46, 77), end: pt(64, 61), thickness: th, color, lineCap: 1 });
}

function drawQR(page, text, x, y, size, color = INK) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const quiet = 1;
  const cell = size / (n + quiet * 2);
  page.drawRectangle({ x, y, width: size, height: size, color: rgb(1, 1, 1) });
  for (let r = 0; r < n; r++) {
    let run = -1;
    for (let c = 0; c <= n; c++) {
      const on = c < n && qr.modules.get(r, c);
      if (on && run < 0) run = c;
      if (!on && run >= 0) {
        page.drawRectangle({ x: x + (quiet + run) * cell, y: y + size - (quiet + r + 1) * cell, width: (c - run) * cell + 0.05, height: cell + 0.05, color });
        run = -1;
      }
    }
  }
}

// The signer's signature: their adopted image, else their name in the script font.
async function drawSignature(page, doc, f, sig, x, y, w, h) {
  if (sig.image && sig.image.length) {
    let img = null;
    try { img = /^\x89PNG/.test(sig.image.slice(0, 4).toString("latin1")) ? await doc.embedPng(sig.image) : await doc.embedJpg(sig.image); } catch (e) { img = null; }
    if (img) {
      const sc = Math.min(w / img.width, h / img.height);
      const iw = img.width * sc, ih = img.height * sc;
      page.drawImage(img, { x: x + (w - iw) / 2 * 0.2, y: y + (h - ih) / 2, width: iw, height: ih });
      return;
    }
  }
  const name = safe(sig.name || "");
  let size = h * 0.95;
  while (size > 8 && f.script.widthOfTextAtSize(name, size) > w) size -= 1;
  page.drawText(name, { x: x + 2, y: y + h * 0.18, size, font: f.script, color: SIGINK });
}

function testMark(page, f, x, y, w) {
  const t = "TEST SIGNATURE - E3 signing certificate not installed - not valid";
  const size = 6.5;
  page.drawText(fit(f.bold, t, size, w), { x, y, size, font: f.bold, color: RED });
}

// ---------------------------------------------------------------- Option B, full size
// The approved block: seal | signature over the name line + details | QR "scan to verify".
// Size 6.4in x 1.75in. Returns the height used.
async function drawFullBlock(page, doc, f, info, x, yTop, w = 6.4 * IN) {
  const h = 1.75 * IN;
  const y = yTop - h;
  page.drawRectangle({ x, y, width: w, height: h, color: PANEL, borderColor: LINE, borderWidth: 1.1 });
  const pad = 0.22 * IN;
  const seal = 1.1 * IN;
  const over = info.sealStyle !== "side" && f.logo;
  drawSeal(page, f, x + pad + seal / 2, y + h / 2, seal, ACCENT, f.logo, over ? SEAL_FADE : 1);
  const qr = 0.95 * IN;
  const qx = x + w - pad - qr;
  drawQR(page, info.verifyUrl, qx, y + h / 2 - qr / 2 + 0.12 * IN, qr);
  const cap1 = "Scan to verify at", cap2 = info.verifyHost;
  page.drawText(cap1, { x: qx + qr / 2 - f.reg.widthOfTextAtSize(cap1, 6.5) / 2, y: y + h / 2 - qr / 2 - 0.02 * IN, size: 6.5, font: f.reg, color: SOFT });
  page.drawText(cap2, { x: qx + qr / 2 - f.reg.widthOfTextAtSize(cap2, 6.5) / 2, y: y + h / 2 - qr / 2 - 0.13 * IN, size: 6.5, font: f.reg, color: SOFT });
  const tx = x + pad + seal + 0.25 * IN;
  const tw = qx - 0.25 * IN - tx;
  let ty = y + h - 0.32 * IN;
  page.drawText("DIGITALLY SIGNED & VERIFIED", { x: tx, y: ty, size: 7.5, font: f.bold, color: MUTED });
  const sigH = 0.5 * IN;
  // overlap: the signature starts over the seal's right half and runs on to the right
  const sgx = over ? x + pad + seal * 0.42 : tx;
  await drawSignature(page, doc, f, info.signer, sgx, ty - 0.08 * IN - sigH, tw + (tx - sgx), sigH);
  ty = ty - 0.1 * IN - sigH;
  page.drawLine({ start: { x: tx, y: ty }, end: { x: tx + tw, y: ty }, thickness: 0.7, color: rgb(0.6, 0.65, 0.71) });
  ty -= 0.2 * IN;
  const who = [info.signer.name, info.signer.license ? "License No. " + info.signer.license : ""].filter(Boolean).join(" · ");
  page.drawText(fit(f.bold, who, 10, tw), { x: tx, y: ty, size: 10, font: f.bold, color: INK });
  ty -= 0.17 * IN;
  const line2 = [info.company, info.signer.title].filter(Boolean).join(" · ");
  page.drawText(fit(f.reg, line2, 8.5, tw), { x: tx, y: ty, size: 8.5, font: f.reg, color: SOFT });
  ty -= 0.15 * IN;
  page.drawText(fit(f.reg, "Signed " + pacific(info.signedAt).full, 8.5, tw), { x: tx, y: ty, size: 8.5, font: f.reg, color: SOFT });
  ty -= 0.15 * IN;
  page.drawText(fit(f.mono, "Document ID " + info.documentId, 7.5, tw), { x: tx, y: ty, size: 7.5, font: f.mono, color: MUTED });
  if (info.test) testMark(page, f, x + pad + seal + 0.25 * IN, y + h - 0.16 * IN, w * 0.5);
  return h;
}

// ---------------------------------------------------------------- Option B, in the report's Signature table
// The report's own Signature cell gets the seal + the signature. The details + QR code sit in
// a panel just right of the table (outside it) when the page has room there; otherwise a
// compact line of details goes under the signature inside the cell.
async function drawCellBlock(page, doc, f, info, box, side) {
  const { x, y, w, h } = box;
  const pad = Math.min(4, h * 0.07);
  const seal = Math.min(h - pad * 2, 0.8 * IN);
  // "overlap" (David, Nov 1): the signature is written ACROSS a faded Association seal, like an
  // engineer's stamp signed over. "side": seal and signature next to each other.
  const over = info.sealStyle !== "side" && f.logo;
  drawSeal(page, f, x + pad + seal / 2, y + h / 2, seal, ACCENT, f.logo, over ? SEAL_FADE : 1);
  const sx = over ? x + pad + seal * 0.38 : x + pad + seal + 7;
  const sw = x + w - pad - sx;
  const d = pacific(info.signedAt);
  if (side) {
    const lineY = y + pad + 5;
    await drawSignature(page, doc, f, info.signer, sx, lineY + 2, sw, h - pad * 2 - 9);
    page.drawLine({ start: { x: sx, y: lineY }, end: { x: sx + sw, y: lineY }, thickness: 0.5, color: rgb(0.6, 0.65, 0.71) });
    if (info.test) page.drawText("TEST - NOT VALID", { x: sx, y: y + h - pad - 6, size: 6, font: f.bold, color: RED });
    // details panel beside the table
    const P = side;
    page.drawRectangle({ x: P.x, y: P.y, width: P.w, height: P.h, color: PANEL, borderColor: LINE, borderWidth: 0.9 });
    const q = Math.min(P.h - 14, 0.78 * IN);
    const qx = P.x + P.w - 7 - q;
    drawQR(page, info.verifyUrl, qx, P.y + P.h - 7 - q, q);
    const cap = "Scan to verify";
    page.drawText(cap, { x: qx + q / 2 - f.reg.widthOfTextAtSize(cap, 5.8) / 2, y: P.y + P.h - 7 - q - 7.5, size: 5.8, font: f.reg, color: SOFT });
    const tx = P.x + 8, tw = qx - 6 - tx;
    let ty = P.y + P.h - 13;
    page.drawText(fit(f.bold, "DIGITALLY SIGNED & VERIFIED", 6.2, tw), { x: tx, y: ty, size: 6.2, font: f.bold, color: MUTED });
    ty -= 12;
    page.drawText(fit(f.bold, info.signer.name, 8.5, tw), { x: tx, y: ty, size: 8.5, font: f.bold, color: INK });
    if (info.signer.license) { ty -= 10; page.drawText(fit(f.reg, "License No. " + info.signer.license, 7, tw), { x: tx, y: ty, size: 7, font: f.reg, color: SOFT }); }
    ty -= 10;
    page.drawText(fit(f.reg, info.company, 7, tw), { x: tx, y: ty, size: 7, font: f.reg, color: SOFT });
    ty -= 10;
    page.drawText(fit(f.reg, `Signed ${d.date} ${d.time} ${d.tz}`, 7, tw), { x: tx, y: ty, size: 7, font: f.reg, color: SOFT });
    const by = P.y + 7;
    page.drawText("Document ID", { x: tx, y: by + 8.5, size: 5.8, font: f.bold, color: MUTED });
    let ms = 6.4; while (ms > 4.6 && f.mono.widthOfTextAtSize(info.documentId, ms) > P.w - 16) ms -= 0.2;
    page.drawText(info.documentId, { x: tx, y: by, size: ms, font: f.mono, color: INK });
    page.drawText(fit(f.reg, "Certified through the E3 Inspection Association", 5.6, tw), { x: tx, y: by + 19, size: 5.6, font: f.reg, color: ACCENT });
    if (info.test) page.drawText("TEST SIGNATURE - NOT VALID", { x: tx, y: by + 28, size: 6, font: f.bold, color: RED });
    return;
  }
  // compact: everything in the cell
  const meta = 5.8;
  const lineY = y + pad + meta * 2 + 3;
  await drawSignature(page, doc, f, info.signer, sx, lineY + 1, sw, y + h - pad - lineY - 1);
  page.drawLine({ start: { x: sx, y: lineY }, end: { x: sx + sw, y: lineY }, thickness: 0.5, color: rgb(0.6, 0.65, 0.71) });
  page.drawText(fit(f.reg, `E3 Verified \u00b7 Signed ${d.date} ${d.time} ${d.tz} \u00b7 verify at ${info.verifyHost}`, meta, sw), { x: sx, y: y + pad + meta + 1, size: meta, font: f.reg, color: SOFT });
  let ms = meta; while (ms > 4.4 && f.mono.widthOfTextAtSize(info.documentId, ms) > sw) ms -= 0.2;
  page.drawText(info.documentId, { x: sx, y: y + pad, size: ms, font: f.mono, color: MUTED });
  if (info.test) page.drawText("TEST SIGNATURE - NOT VALID", { x: sx, y: y + h - pad - 6, size: 6, font: f.bold, color: RED });
}

// ---------------------------------------------------------------- where the report's Signature cell is
// The E3 masters print a 2-column table:   Signature      | (empty cell)
//                                          Inspector Name | <name>
// Found from the text positions (pdf.js), the LAST page that has both. Returns
// { pageIndex, box:{x,y,w,h} } in PDF points, or null (then a signature page is added).
async function findSignatureCell(bytes) {
  let pdfjs;
  try { pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); } catch (e) { return null; }
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0 });
  const pdf = await task.promise;
  try {
    for (let p = pdf.numPages; p >= 1; p--) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const items = tc.items.filter((i) => i.str && i.str.trim()).map((i) => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5], h: Math.abs(i.transform[3]) || i.height || 10, w: i.width }));
      const labels = items.filter((i) => /^signature:?$/i.test(i.s));
      for (const lab of labels.reverse()) {
        const insp = items.filter((i) => /^inspector name/i.test(i.s) && i.y < lab.y && lab.y - i.y < 2.2 * IN && Math.abs(i.x - lab.x) < 0.6 * IN)
          .sort((a, b) => b.y - a.y)[0];
        if (!insp) continue;
        // value column: an item on the Inspector Name baseline, right of the label column
        const val = items.filter((i) => Math.abs(i.y - insp.y) < 2 && i.x > insp.x + insp.w + 6).sort((a, b) => a.x - b.x)[0];
        const left = (val ? val.x : lab.x + 1.3 * IN) - 3;
        const rowTop = insp.y + insp.h * 1.0 + 1.5; // top of the Inspector Name row = bottom of the signature cell
        const labMid = lab.y + lab.h * 0.35;
        let top = labMid + (labMid - rowTop);
        if (top - rowTop < 0.45 * IN) top = rowTop + 0.45 * IN;
        const right = Math.min(lab.x + 3.72 * IN, page.view[2] - 0.5 * IN);
        const box = { x: left + 2, y: rowTop + 2, w: right - left - 4, h: top - rowTop - 4 };
        if (box.w < 1.6 * IN || box.h < 0.4 * IN) continue;
        // the table's last row (License #) -> side panel beside the whole table, when there is room
        const lic = items.filter((i) => /^license/i.test(i.s) && i.y < insp.y && insp.y - i.y < 1 * IN && Math.abs(i.x - insp.x) < 0.3 * IN).sort((a, b) => a.y - b.y)[0];
        const tableBottom = (lic || insp).y - 4;
        const sideX = lab.x + 3.75 * IN + 0.16 * IN;
        const sideW = Math.min(2.75 * IN, page.view[2] - 0.55 * IN - sideX);
        const sideTop = box.y + box.h + 2;
        const sideH = Math.min(sideTop - tableBottom, 1.45 * IN);
        const side = sideW >= 2.1 * IN && sideH >= 0.95 * IN ? { x: sideX, y: sideTop - sideH, w: sideW, h: sideH } : null;
        return { pageIndex: p - 1, box, side };
      }
    }
    return null;
  } finally {
    try { await pdf.destroy(); } catch (e) { /* */ }
  }
}

// ---------------------------------------------------------------- Certificate of Completion page
async function addCertificatePage(doc, f, info, size) {
  const [W, H] = size;
  const page = doc.addPage([W, H]);
  const m = 0.85 * IN;
  const cw = W - m * 2;
  let y = H - m;
  page.drawText("E3 INSPECTION REPORTING SOLUTIONS", { x: m, y: y - 9, size: 8, font: f.bold, color: ACCENT });
  page.drawText("Certificate of Completion", { x: m, y: y - 34, size: 21, font: f.bold, color: INK });
  // Completed pill
  const pill = "Completed", pw = f.bold.widthOfTextAtSize(pill, 9) + 30;
  page.drawRectangle({ x: m + cw - pw, y: y - 32, width: pw, height: 20, borderColor: GREEN, borderWidth: 1.1, color: rgb(1, 1, 1) });
  page.drawLine({ start: { x: m + cw - pw + 9, y: y - 22 }, end: { x: m + cw - pw + 12, y: y - 25.5 }, thickness: 1.5, color: GREEN });
  page.drawLine({ start: { x: m + cw - pw + 12, y: y - 25.5 }, end: { x: m + cw - pw + 18, y: y - 18 }, thickness: 1.5, color: GREEN });
  page.drawText(pill, { x: m + cw - pw + 21, y: y - 25.5, size: 9, font: f.bold, color: GREEN });
  y -= 46;
  page.drawRectangle({ x: m, y, width: cw, height: 2.2, color: ACCENT });
  y -= 14;
  // the certifying body (David, Nov 1 2026)
  const lg = 0.62 * IN;
  drawSeal(page, f, m + lg / 2, y - lg / 2, lg, ACCENT, f.logo);
  page.drawText("Certified through the E3 Inspection Association", { x: m + lg + 12, y: y - lg / 2 + 3, size: 10.5, font: f.bold, color: INK });
  page.drawText("Association of Professional Exterior Elevated Elements Inspectors - the certifying body", { x: m + lg + 12, y: y - lg / 2 - 10, size: 8.5, font: f.reg, color: SOFT });
  y -= lg + 18;
  if (info.test) {
    page.drawRectangle({ x: m, y: y - 22, width: cw, height: 26, color: rgb(1, 0.93, 0.93), borderColor: RED, borderWidth: 0.8 });
    page.drawText("TEST SIGNATURE - the E3 signing certificate is not installed yet. This copy is not valid.", { x: m + 8, y: y - 13, size: 8.5, font: f.bold, color: RED });
    y -= 36;
  }
  // facts grid (2 columns)
  const facts = [
    ["DOCUMENT", info.title], ["DOCUMENT ID", info.documentId],
    ["PROPERTY", info.property || "-"], ["PAGES", String(info.pages)],
    ["ISSUED BY", info.company], ["TIME ZONE", "Pacific (America/Los_Angeles)"],
  ];
  const colW = (cw - 24) / 2;
  for (let i = 0; i < facts.length; i += 2) {
    for (let j = 0; j < 2; j++) {
      const [k, v] = facts[i + j];
      const fx = m + j * (colW + 24);
      page.drawText(k, { x: fx, y, size: 7.5, font: f.bold, color: MUTED });
      const font = k === "DOCUMENT ID" ? f.mono : f.reg;
      const lines = wrap(font, v, 9.5, colW).slice(0, 2);
      lines.forEach((ln, n) => page.drawText(ln, { x: fx, y: y - 13 - n * 11.5, size: 9.5, font, color: INK }));
    }
    y -= 40;
  }
  // Signer card
  y -= 4;
  page.drawText("Signer", { x: m, y, size: 11.5, font: f.bold, color: INK });
  y -= 12;
  const cardH = 1.15 * IN;
  page.drawRectangle({ x: m, y: y - cardH, width: cw, height: cardH, color: PANEL, borderColor: LINE, borderWidth: 1 });
  const cx = m + 14;
  let cy = y - 20;
  page.drawText(fit(f.bold, info.signer.name, 11.5, cw * 0.55), { x: cx, y: cy, size: 11.5, font: f.bold, color: INK });
  cy -= 15;
  const t2 = [info.signer.title, info.signer.license ? "License No. " + info.signer.license : ""].filter(Boolean).join(" · ");
  if (t2) { page.drawText(fit(f.reg, t2, 9, cw * 0.55), { x: cx, y: cy, size: 9, font: f.reg, color: SOFT }); cy -= 13; }
  page.drawText(fit(f.reg, info.company, 9, cw * 0.55), { x: cx, y: cy, size: 9, font: f.reg, color: SOFT });
  cy -= 13;
  page.drawText(fit(f.reg, `Approved by E3 login: ${info.approvedBy}`, 9, cw * 0.55), { x: cx, y: cy, size: 9, font: f.reg, color: SOFT });
  const sx = m + cw * 0.6, sw = cw * 0.4 - 16;
  await drawSignature(page, doc, f, info.signer, sx, y - 0.72 * IN, sw, 0.5 * IN);
  page.drawLine({ start: { x: sx, y: y - 0.76 * IN }, end: { x: sx + sw, y: y - 0.76 * IN }, thickness: 0.7, color: rgb(0.6, 0.65, 0.71) });
  page.drawText(info.signer.image ? "Signature adopted in E3" : "Signature adopted in E3 (typed)", { x: sx, y: y - 0.9 * IN, size: 7.5, font: f.reg, color: MUTED });
  y -= cardH + 22;
  // Event history
  page.drawText("Event history", { x: m, y, size: 11.5, font: f.bold, color: INK });
  y -= 10;
  page.drawLine({ start: { x: m, y }, end: { x: m + cw, y }, thickness: 0.7, color: RULE });
  for (const ev of info.events) {
    y -= 15;
    page.drawText(fit(f.bold, ev.what, 9, cw / 3 - 8), { x: m, y, size: 9, font: f.bold, color: INK });
    page.drawText(ev.at ? pacific(ev.at).full : "-", { x: m + cw / 3, y, size: 9, font: f.reg, color: SOFT });
    page.drawText(fit(f.reg, ev.where || "", 9, cw / 3), { x: m + (cw * 2) / 3, y, size: 9, font: f.reg, color: SOFT });
    y -= 8;
    page.drawLine({ start: { x: m, y }, end: { x: m + cw, y }, thickness: 0.7, color: RULE });
  }
  y -= 24;
  // Integrity
  page.drawText("Document integrity", { x: m, y, size: 11.5, font: f.bold, color: INK });
  y -= 16;
  page.drawText("Fingerprint of the report as approved (SHA-256):", { x: m, y, size: 8.5, font: f.bold, color: INK });
  y -= 12;
  page.drawText(info.originalSha256.slice(0, 32), { x: m, y, size: 8.5, font: f.mono, color: SOFT });
  y -= 11;
  page.drawText(info.originalSha256.slice(32), { x: m, y, size: 8.5, font: f.mono, color: SOFT });
  y -= 15;
  page.drawText("Signing certificate:", { x: m, y, size: 8.5, font: f.bold, color: INK });
  page.drawText(fit(f.reg, info.certLabel, 8.5, cw - 90), { x: m + 84, y, size: 8.5, font: f.reg, color: info.test ? RED : SOFT });
  // Footer
  const fy = m - 0.1 * IN;
  page.drawLine({ start: { x: m, y: fy + 0.95 * IN }, end: { x: m + cw, y: fy + 0.95 * IN }, thickness: 0.7, color: RULE });
  const qr = 0.8 * IN;
  drawQR(page, info.verifyUrl, m + cw - qr, fy, qr);
  const foot = `This report was signed electronically through E3 and sealed with a certificate-based digital signature. Any change to the document after signing invalidates the signature. Verify this document at ${info.verifyHost} using the Document ID above, or scan the code.`;
  wrap(f.reg, foot, 8, cw - qr - 24).forEach((ln, n) => page.drawText(ln, { x: m, y: fy + qr - 10 - n * 11, size: 8, font: f.reg, color: MUTED }));
  return page;
}

// ---------------------------------------------------------------- main
// info: { documentId, verifyUrl, verifyHost, signedAt, title, property, company, approvedBy,
//         signer:{name,title,license,image}, events:[{what,at,where}], originalSha256,
//         certLabel, test }
// Returns { bytes, placement: 'cell' | 'page', pages }
async function stampReport(srcBytes, info) {
  const doc = await PDFDocument.load(srcBytes, { ignoreEncryption: false, updateMetadata: false });
  const f = await fonts(doc);
  let placement = "page";
  const cell = await findSignatureCell(srcBytes).catch(() => null);
  if (cell && doc.getPage(cell.pageIndex)) {
    await drawCellBlock(doc.getPage(cell.pageIndex), doc, f, info, cell.box, cell.side);
    placement = "cell";
  } else {
    const last = doc.getPage(doc.getPageCount() - 1);
    const { width: W, height: H } = last.getSize();
    const page = doc.addPage([W, H]);
    const m = 0.85 * IN;
    page.drawText("Signature", { x: m, y: H - m - 16, size: 16, font: f.bold, color: INK });
    page.drawText(fit(f.reg, info.title + (info.property ? " - " + info.property : ""), 10, W - m * 2), { x: m, y: H - m - 34, size: 10, font: f.reg, color: SOFT });
    await drawFullBlock(page, doc, f, info, m, H - m - 52, Math.min(6.4 * IN, W - m * 2));
  }
  const last = doc.getPage(doc.getPageCount() - 1).getSize();
  info.pages = doc.getPageCount() + 1;
  await addCertificatePage(doc, f, info, [last.width, last.height]);
  doc.setProducer("E3 Inspection Reporting Solutions - E3 E-Sign");
  doc.setModificationDate(new Date(info.signedAt));
  return { doc, placement, pages: info.pages };
}

module.exports = { stampReport, findSignatureCell, drawFullBlock, drawCellBlock, addCertificatePage, drawSeal, drawQR, pacific, safe };
