"use strict";
// PORTAL DATA PROTECTION (David, Oct 27 2026): "anyone other than E3 [the tenant's own
// inspectors] ... a client and a contractor should be prohibited" from taking the
// inspection data into their own systems.
//
// Applies ONLY to client / contractor (portal) logins - staff are untouched.
//
//   1. PHOTOS - a portal login never receives a storage address. Every photo address
//      in a response is swapped for /api/pphoto/<signed link>: it expires (2 h), works
//      only while that login is active, and serves a reduced-size copy stamped with
//      the viewer's name and the date. Grid size 320 px, zoom size 1280 px.
//   2. RATE LIMITS - normal browsing never notices; bulk pulling is stopped (429) and
//      recorded.
//   3. ACTIVITY LOG - who looked at which property, how many photos, from where.
//      Saved every 2 minutes to ProjectReports (never synced to phones) as
//      "portallog::<company>::<username>::<time>" records; admins read it on the
//      client page (GET /api/clients/:id/activity).
//   4. TERMS OF USE - a portal login must accept the current terms before anything
//      else works (enforced in service/clientAccess.js).

const jwt = require("jsonwebtoken");
const couchbase = require("../database/couchbase");

// ------------------------------------------------------------------ terms of use
// Bump TERMS_VERSION whenever the wording changes: every portal login is asked again.
// {{COMPANY}} is filled in by the web page with the inspection company's name.
const TERMS_VERSION = "2026-10-27";
const TERMS = {
  version: TERMS_VERSION,
  title: "Portal Terms of Use",
  intro: "Please read and accept these terms to continue. They apply to you and to the organization you represent.",
  sections: [
    { h: "1. What you are given", p: "Through the E3 Inspection Reporting Solutions platform (\"E3\"), {{COMPANY}} gives you view-only access to inspection information for the properties assigned to you - photographs, observations, conditions and ratings (\"Inspection Data\") - and, for repair work, the ability to add photos of completed repairs." },
    { h: "2. Ownership", p: "E3 - its website, mobile app and software - is owned and controlled by E3 Inspection Reporting Solutions. The Inspection Data, photographs and reports belong to {{COMPANY}} and E3 Inspection Reporting Solutions. Your access is a limited, personal and revocable permission to view. Nothing is sold, assigned or transferred to you." },
    { h: "3. Permitted use", p: "You may use the Inspection Data only to manage, maintain and repair the properties assigned to you." },
    { h: "4. What you may not do", p: "You may not download, copy, export, scrape, screen-capture in bulk or otherwise collect the Inspection Data; load it into any other software, database, inspection or reporting system or AI tool; give, sell or show it to any other inspector, inspection company, consultant or third party; use it to prepare inspections, reports or evaluations by anyone other than {{COMPANY}}; remove or obscure the watermarks on photographs; or share your login with anyone." },
    { h: "5. Not an inspection report", p: "This portal is a working view of the inspection as it is entered. It is not the issued report and may change. Only the signed report issued by {{COMPANY}} is the official inspection document." },
    { h: "6. Monitoring", p: "E3 Inspection Reporting Solutions records use of the portal for itself and {{COMPANY}} - who viewed what, when and from where - and every photograph you open carries your name and the date." },
    { h: "7. Ending access", p: "{{COMPANY}} or E3 Inspection Reporting Solutions may suspend or end your access at any time. Sections 2, 4 and 5 continue to apply after access ends." },
    { h: "8. Your login", p: "Your login is for you alone. You are responsible for everything done with it. Tell {{COMPANY}} right away if you think someone else has used it." },
  ],
};

// ------------------------------------------------------------------ photo links
const PHOTO_TTL_S = 2 * 60 * 60;
const REUSE_MS = 60 * 60 * 1000; // keep a link stable for an hour so the browser can cache it
const BLOB_RE_G = /https:\/\/[a-z0-9-]+\.blob\.core\.windows\.net\/[^\s"'<>\\)]+/gi;
const PPHOTO_RE = /\/api\/pphoto\/([A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+)/;
const linkCache = new Map(); // `${user}|${url}` -> { tok, at }
// Photo links get their OWN signing key: a photo link must never be usable as a
// sign-in token (routes.js authenticateToken accepts anything signed with TOKEN_KEY).
const photoKey = () => String(process.env.TOKEN_KEY || "") + "|portal-photo-v1";

function originOf(req) {
  const h = (req && req.headers) || {};
  const proto = String(h["x-forwarded-proto"] || (req && req.protocol) || "https").split(",")[0].trim() || "https";
  const host = String(h["x-forwarded-host"] || h.host || "").split(",")[0].trim();
  return host ? `${proto}://${host}` : "";
}

function photoToken(url, viewer) {
  const key = `${viewer.username}|${url}`;
  const hit = linkCache.get(key);
  if (hit && Date.now() - hit.at < REUSE_MS) return hit.tok;
  const tok = jwt.sign({ p: "pp", u: url, v: viewer.username, c: viewer.company }, photoKey(), { expiresIn: PHOTO_TTL_S });
  linkCache.set(key, { tok, at: Date.now() });
  if (linkCache.size > 20000) linkCache.delete(linkCache.keys().next().value);
  return tok;
}

// Swap every storage address in a response for a signed, expiring portal link.
function signPhotos(v, viewer, origin, depth = 0) {
  if (depth > 16 || v === null || v === undefined) return v;
  if (typeof v === "string") {
    if (v.indexOf(".blob.core.windows.net/") < 0) return v;
    return v.replace(BLOB_RE_G, (u) => `${origin}/api/pphoto/${photoToken(u, viewer)}`);
  }
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => signPhotos(x, viewer, origin, depth + 1));
  const o = {};
  for (const k of Object.keys(v)) o[k] = signPhotos(v[k], viewer, origin, depth + 1);
  return o;
}

function readPhotoToken(tok) {
  try {
    const p = jwt.verify(tok, photoKey());
    return p && p.p === "pp" && p.u && p.v ? p : null;
  } catch (e) { return null; }
}

// The page sends portal links back (e.g. "remove this photo", thumbnail pre-build):
// turn the viewer's OWN links back into the storage address. Anything else is left
// as it is (and simply will not match).
function unsignPhotos(v, viewer, depth = 0) {
  if (depth > 16 || v === null || v === undefined) return v;
  if (typeof v === "string") {
    const m = PPHOTO_RE.exec(v);
    if (!m) return v;
    const p = readPhotoToken(m[1]);
    return p && String(p.v).toLowerCase() === String(viewer.username).toLowerCase() ? p.u : v;
  }
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = unsignPhotos(v[i], viewer, depth + 1); return v; }
  for (const k of Object.keys(v)) v[k] = unsignPhotos(v[k], viewer, depth + 1);
  return v;
}

// ------------------------------------------------------------------ rate limits
const LIMITS = {
  api: { max: 900, ms: 10 * 60 * 1000 },     // page data requests per 10 minutes
  thumb: { max: 5000, ms: 60 * 60 * 1000 },  // grid photos per hour
  full: { max: 400, ms: 60 * 60 * 1000 },    // full-size (zoom) photos per hour
};
const windows = new Map(); // `${user}|${kind}` -> { start, n }
function allow(username, kind) {
  const L = LIMITS[kind];
  if (!L) return true;
  const key = `${String(username).toLowerCase()}|${kind}`;
  const now = Date.now();
  let w = windows.get(key);
  if (!w || now - w.start > L.ms) { w = { start: now, n: 0 }; windows.set(key, w); }
  w.n++;
  if (windows.size > 20000) windows.delete(windows.keys().next().value);
  return w.n <= L.max;
}

// ------------------------------------------------------------------ activity log
const buf = new Map(); // lower(username) -> entry
function ipOf(req) {
  const h = (req && req.headers) || {};
  const raw = String(h["x-forwarded-for"] || (req && req.socket && req.socket.remoteAddress) || "").split(",")[0].trim();
  // Azure appends the port ("1.2.3.4:5678"); keep IPv6 intact
  return /^\d+\.\d+\.\d+\.\d+:\d+$/.test(raw) ? raw.replace(/:\d+$/, "") : raw;
}
function note(viewer, kind, opts = {}) {
  if (!viewer || !viewer.username) return;
  const key = String(viewer.username).toLowerCase();
  let e = buf.get(key);
  const now = new Date().toISOString();
  if (!e) {
    e = { username: viewer.username, company: viewer.company, clientId: viewer.clientId || "", role: viewer.role || "",
      name: viewer.name || "", from: now, to: now, api: 0, thumb: 0, full: 0, throttled: 0, projects: {}, ips: [] };
    buf.set(key, e);
  }
  e.to = now;
  if (kind === "throttled") e.throttled++;
  else if (e[kind] !== undefined) e[kind]++;
  for (const pid of opts.projectIds || []) e.projects[pid] = (e.projects[pid] || 0) + 1;
  const ip = opts.req ? ipOf(opts.req) : "";
  if (ip && e.ips.length < 5 && !e.ips.includes(ip)) e.ips.push(ip);
}
function logColl() {
  return `\`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.ProjectReports`;
}
async function flush() {
  if (!buf.size || !couchbase.cluster) return;
  const entries = [...buf.values()];
  buf.clear();
  for (const e of entries) {
    const id = `portallog::${e.company}::${String(e.username).toLowerCase()}::${Date.now()}::${Math.random().toString(36).slice(2, 8)}`;
    try {
      await couchbase.cluster.query(`UPSERT INTO ${logColl()} (KEY, VALUE) VALUES ($1, $2)`,
        { parameters: [id, Object.assign({ type: "PortalActivity" }, e)] });
    } catch (err) {
      console.error("portal activity flush:", err && err.message);
    }
  }
}
const flushTimer = setInterval(() => { flush().catch(() => {}); }, 2 * 60 * 1000);
if (flushTimer.unref) flushTimer.unref();

// Activity of one client's portal logins (its people and its contractors), newest first.
async function activityFor(company, clientId, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const r = await couchbase.cluster.query(
    `SELECT d.* FROM ${logColl()} d WHERE META(d).id LIKE $1 AND d.type = "PortalActivity" AND d.clientId = $2 AND d.\`to\` >= $3 ORDER BY d.\`to\` DESC LIMIT 5000`,
    { parameters: [`portallog::${company}::%`, clientId, since] });
  const rows = r.rows || [];
  // include what is still waiting in memory on this server
  for (const e of buf.values()) if (e.company === company && e.clientId === clientId) rows.unshift(Object.assign({ type: "PortalActivity" }, e));
  const by = new Map();
  for (const d of rows) {
    const k = String(d.username || "").toLowerCase();
    let a = by.get(k);
    if (!a) { a = { username: d.username, name: d.name || "", role: d.role || "", lastSeen: "", days: new Set(), api: 0, thumb: 0, full: 0, throttled: 0, projects: {}, ips: new Set() }; by.set(k, a); }
    if (!a.lastSeen || d.to > a.lastSeen) a.lastSeen = d.to;
    if (d.to) a.days.add(String(d.to).slice(0, 10));
    a.api += d.api || 0; a.thumb += d.thumb || 0; a.full += d.full || 0; a.throttled += d.throttled || 0;
    for (const [pid, n] of Object.entries(d.projects || {})) a.projects[pid] = (a.projects[pid] || 0) + n;
    for (const ip of d.ips || []) a.ips.add(ip);
  }
  return [...by.values()]
    .map((a) => Object.assign(a, { days: a.days.size, ips: [...a.ips] }))
    .sort((x, y) => String(y.lastSeen).localeCompare(String(x.lastSeen)));
}

// ------------------------------------------------------------------ watermarked photo
const SIZES = { t: 320, f: 1280 };
let BUILDS = 0;
const out = new Map(); // finished jpegs: key -> Buffer (small LRU)
const OUT_MAX = 160;
let fonts = null;
async function loadFonts() {
  if (fonts) return fonts;
  const Jimp = require("jimp");
  const [w16, b16, w32, b32] = await Promise.all([
    Jimp.loadFont(Jimp.FONT_SANS_16_WHITE), Jimp.loadFont(Jimp.FONT_SANS_16_BLACK),
    Jimp.loadFont(Jimp.FONT_SANS_32_WHITE), Jimp.loadFont(Jimp.FONT_SANS_32_BLACK),
  ]);
  fonts = { t: { w: w16, b: b16, size: 16 }, f: { w: w32, b: b32, size: 32 } };
  return fonts;
}
function jimpRead(buffer) {
  const Jimp = require("jimp");
  return new Promise((ok, bad) => Jimp.read(buffer, (e, i) => (e ? bad(e) : ok(i))));
}
function jpeg(img, quality) {
  const Jimp = require("jimp");
  if (quality) img.quality(quality);
  return new Promise((ok, bad) => img.getBuffer(Jimp.MIME_JPEG, (e, b) => (e ? bad(e) : ok(b))));
}
async function getBuf(url) {
  const axios = require("axios");
  const r = await axios.get(url, { responseType: "arraybuffer", timeout: 20000, validateStatus: (s) => s === 200 });
  return Buffer.from(r.data);
}
function sizedName(u, px) {
  const parts = u.pathname.split("/").filter(Boolean);
  const container = parts.shift();
  const blob = decodeURIComponent(parts.join("/"));
  const name = `t${px}-` + blob.replace(/\.[a-zA-Z0-9]+$/, "") + ".jpg";
  return { container, name, url: `https://${u.hostname}/${container}/${encodeURIComponent(name)}` };
}
async function gate() {
  const until = Date.now() + 25000;
  while (BUILDS >= 2) {
    if (Date.now() > until) throw new Error("busy");
    await new Promise((r) => setTimeout(r, 300));
  }
  BUILDS++;
}

// A reduced copy of the photo (never the original): the banked t320- / t1280- copy
// when it exists, otherwise built now (and banked beside the original for next time).
async function reducedImage(orig, size) {
  const px = SIZES[size];
  const u = new URL(orig);
  const isSized = /^t\d+-/i.test(decodeURIComponent(u.pathname.split("/").pop() || ""));
  if (!isSized) {
    const s = sizedName(u, px);
    try { return await jimpRead(await getBuf(s.url)); } catch (e) { /* not banked yet */ }
    await gate();
    try {
      const raw = await getBuf(u.href);
      if (raw.length > 25 * 1024 * 1024) throw new Error("photo too large");
      const img = await jimpRead(raw);
      if (img.bitmap.width > px) img.resize(px, Math.max(1, Math.round(img.bitmap.height * (px / img.bitmap.width))));
      // bank it in the background - the next view skips the big decode
      jpeg(img.clone(), 82).then((b) => {
        const os = require("os"), path = require("path"), fs = require("fs");
        const tmp = path.join(os.tmpdir(), `pp-${Date.now()}-${Math.floor(Math.random() * 1e5)}.jpg`);
        fs.writeFileSync(tmp, b);
        return require("../database/uploadimage").uploadFile(s.container, s.name, tmp, { metadata: { thumbOf: s.name }, tags: { kind: "thumb" } })
          .finally(() => { try { fs.unlinkSync(tmp); } catch (e) { /* temp */ } });
      }).catch(() => {});
      return img;
    } finally { BUILDS--; }
  }
  const img = await jimpRead(await getBuf(u.href));
  if (img.bitmap.width > px) img.resize(px, Math.max(1, Math.round(img.bitmap.height * (px / img.bitmap.width))));
  return img;
}

function ascii(s) {
  return String(s || "").normalize("NFKD").replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim();
}
// The text layer is the slow part - build it once per viewer + photo shape and reuse it.
const layers = new Map();
async function textLayer(label, size, W, H) {
  const key = `${label}|${size}|${W}x${H}`;
  const hit = layers.get(key);
  if (hit) return hit;
  const Jimp = require("jimp");
  const F = (await loadFonts())[size];
  const layer = await new Promise((ok, bad) => new Jimp(W, H, 0x00000000, (e, i) => (e ? bad(e) : ok(i))));
  const text = ascii(label);
  const tw = Jimp.measureText(F.w, text) + F.size * 2;
  const rowGap = Math.max(F.size * 3, Math.round(H / (size === "t" ? 3 : 5)));
  let row = 0;
  for (let y = Math.round(rowGap / 3); y < H - F.size; y += rowGap, row++) {
    for (let x = -((row % 2) * Math.round(tw / 2)); x < W; x += tw) {
      layer.print(F.b, x + 1, y + 1, text);
      layer.print(F.w, x, y, text);
    }
  }
  // keep only the inked pixels (offset, colour, strength) - blending those alone is
  // far cheaper than compositing a whole transparent layer
  const op = size === "t" ? 0.36 : 0.42;
  const d = layer.bitmap.data;
  const offs = [], vals = [];
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]) { offs.push(i); vals.push(d[i], d[i + 1], d[i + 2], (d[i + 3] / 255) * op); }
  }
  const ink = { offs: Int32Array.from(offs), vals: Float32Array.from(vals) };
  layers.set(key, ink);
  if (layers.size > 40) layers.delete(layers.keys().next().value);
  return ink;
}
async function stamp(img, label, size) {
  const ink = await textLayer(label, size, img.bitmap.width, img.bitmap.height);
  const d = img.bitmap.data, o = ink.offs, v = ink.vals;
  for (let k = 0, j = 0; k < o.length; k++, j += 4) {
    const i = o[k], a = v[j + 3], b = 1 - a;
    d[i] = v[j] * a + d[i] * b;
    d[i + 1] = v[j + 1] * a + d[i + 1] * b;
    d[i + 2] = v[j + 2] * a + d[i + 2] * b;
  }
  return jpeg(img, size === "t" ? 70 : 80);
}

function labelFor(rec) {
  const name = [rec.first_name, rec.last_name].filter(Boolean).join(" ") || rec.username;
  const d = new Date();
  const date = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  return `${name} | ${date} | E3 licensed view - do not copy`;
}

// GET /api/pphoto/:tok[?s=t]   (no Authorization header: <img> tags can't send one -
// the link itself is the permission)
function makePhotoHandler(lookupUser) {
  return async function photoHandler(req, res) {
    const p = readPhotoToken(req.params.tok);
    if (!p) return res.status(410).type("text/plain").send("This photo link has expired. Reload the page.");
    let rec;
    try { rec = await lookupUser(p.v); } catch (e) { return res.status(503).type("text/plain").send("Please try again in a moment."); }
    if (!rec || rec.isActive === false) return res.status(403).type("text/plain").send("This login no longer has access.");
    let viaClientId = rec.clientId;
    if (String(rec.role || "").toLowerCase() === "client") {
      // a client login may view several inspectors; the one named in the link must still be active
      const link = require("../model/portalLinks").linkFor(rec, p.c);
      if (!link) return res.status(403).type("text/plain").send("This login no longer has access.");
      viaClientId = link.clientId;
    } else if (rec.companyIdentifier !== p.c) return res.status(403).type("text/plain").send("This login no longer has access.");
    const size = req.query && req.query.s === "t" ? "t" : "f";
    const viewer = { username: rec.username, company: p.c, clientId: viaClientId, role: String(rec.role || "").toLowerCase(), name: [rec.first_name, rec.last_name].filter(Boolean).join(" ") };
    if (!allow(rec.username, size === "t" ? "thumb" : "full")) {
      note(viewer, "throttled", { req });
      return res.status(429).type("text/plain").send("Too many photos opened - please slow down.");
    }
    note(viewer, size === "t" ? "thumb" : "full", { req });
    const day = new Date().toISOString().slice(0, 10);
    const key = `${p.u}|${size}|${String(rec.username).toLowerCase()}|${day}`;
    const headers = { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600", "X-Robots-Tag": "noindex, noimageindex", "Content-Disposition": 'inline; filename="e3-licensed-photo.jpg"' };
    try {
      let jpg = out.get(key);
      if (!jpg) {
        const img = await reducedImage(p.u, size);
        jpg = await stamp(img, labelFor(rec), size);
        out.set(key, jpg);
        if (out.size > OUT_MAX) out.delete(out.keys().next().value);
      }
      res.set(headers);
      return res.status(200).send(jpg);
    } catch (e) {
      console.error("pphoto:", e && e.message);
      return res.status(e && e.message === "busy" ? 503 : 502).type("text/plain").send("The photo could not be prepared.");
    }
  };
}

module.exports = {
  TERMS, TERMS_VERSION, LIMITS,
  signPhotos, unsignPhotos, readPhotoToken, originOf,
  allow, note, flush, activityFor, makePhotoHandler, ipOf,
  // tests
  _stamp: stamp, _labelFor: labelFor, _windows: windows, _buf: buf,
};
