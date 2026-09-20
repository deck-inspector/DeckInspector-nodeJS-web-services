// Android APK distribution for the field phones (David, Sep 10 2026).
//
// The GitHub workflow android-apk.yml (repo deckinspectors_flutter-snapshot-jul13,
// branch ios-streamer) builds a signed release APK on every push and uploads it
// to the public blob container "apk" of the app's storage account:
//   apk/E3-Inspections-<version>-build<n>.apk   (every build, kept)
//   apk/E3-Inspections-latest.apk               (copy of the newest)
//   apk/latest.json                             {version, build, file, url, sha, branch, builtAt}
//
// These routes are PUBLIC (no login) and mounted at /apk:
//   GET /apk              install page. Since Sep 18 2026 the app is on Google Play
//                         (package com.e3inspections.multitenant) - the page leads with
//                         "Get it on Google Play" and keeps the direct APK (direct blob link -
//                         a redirect that fails during an app restart saved an HTML error
//                         page as the .apk on a field phone, Sep 10) as the fallback for
//                         phones that cannot use Play.
//   GET /apk/download     302 to the newest APK
//   GET /apk/latest.json  the manifest (no-cache), for the page and for checks
const express = require("express");
const router = express.Router();

const CONTAINER = "apk";
// Public Play Store listing (live since Sep 18 2026, 2.4.9 build 194).
const PLAY_URL = "https://play.google.com/store/apps/details?id=com.e3inspections.multitenant";

function blobBase() {
  const account = process.env.AZURE_STORAGE_ACCOUNT_NAME || "";
  return account ? `https://${account}.blob.core.windows.net/${CONTAINER}` : "";
}

async function readLatest() {
  const base = blobBase();
  if (!base) throw new Error("AZURE_STORAGE_ACCOUNT_NAME not configured");
  const r = await fetch(`${base}/latest.json?nc=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`latest.json ${r.status}`);
  const j = await r.json();
  if (!j || !j.file) throw new Error("latest.json has no file");
  j.url = `${base}/${encodeURIComponent(j.file)}`;
  j.latestUrl = `${base}/E3-Inspections-latest.apk`;
  return j;
}

function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

router.get("/latest.json", async (req, res) => {
  try {
    const j = await readLatest();
    res.set("Cache-Control", "no-store");
    res.json(j);
  } catch (e) {
    res.status(503).set("Cache-Control", "no-store").json({ error: String(e.message || e) });
  }
});

router.get("/download", async (req, res) => {
  try {
    const j = await readLatest();
    res.set("Cache-Control", "no-store");
    res.redirect(302, j.url);
  } catch (e) {
    res.status(503).set("Cache-Control", "no-store").send("No Android build is published yet. " + esc(e.message || e));
  }
});

router.get("/", async (req, res) => {
  let j = null, err = "";
  try { j = await readLatest(); } catch (e) { err = String(e.message || e); }
  const built = j && j.builtAt ? new Date(j.builtAt) : null;
  const when = built && !isNaN(built) ? built.toLocaleString("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "short" }) + " PT" : "";
  res.set("Cache-Control", "no-store");
  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>E3 Inspections for Android</title>
<style>
body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f6fb;color:#0b1220}
.wrap{max-width:560px;margin:0 auto;padding:28px 18px 40px}
h1{font-size:22px;margin:0 0 4px}
.sub{color:#5b6472;margin:0 0 22px;font-size:14px}
.card{background:#fff;border:1px solid #dfe5ef;border-radius:14px;padding:20px;margin-bottom:16px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.ver{font-size:30px;font-weight:800;margin:0}
.meta{color:#5b6472;font-size:13px;margin:4px 0 16px}
.btn{display:block;text-align:center;background:#0b3d91;color:#fff;text-decoration:none;font-weight:700;font-size:17px;padding:15px;border-radius:12px}
.btn.off{background:#9aa3b2}
.btn.play{background:#01875f}
.btn.alt{background:#fff;color:#0b3d91;border:2px solid #0b3d91;padding:13px}
.or{text-align:center;color:#5b6472;font-size:13px;margin:14px 0 10px}
ol{padding-left:20px;line-height:1.55;font-size:15px}
.note{background:#fff7e6;border:1px solid #f2d59b;border-radius:10px;padding:12px 14px;font-size:14px;line-height:1.5}
code{background:#eef2f8;padding:1px 5px;border-radius:5px}
</style></head><body><div class="wrap">
<h1>E3 Inspections for Android</h1>
<p class="sub">Field app for SB 326 / SB 721 inspections</p>
<div class="card">
<a class="btn play" href="${PLAY_URL}" rel="noopener">&#9654; Get it on Google Play</a>
<p class="meta" style="margin:10px 0 0;text-align:center">Recommended. Installs and updates automatically like any other app.</p>
</div>
<div class="card">
<p class="or" style="margin-top:0">Can't use Google Play on this phone? Install the APK directly:</p>
${j ? `<p class="ver">${esc(j.version)} <span style="font-size:16px;font-weight:600;color:#5b6472">(build ${esc(j.build)})</span></p>
<p class="meta">${when ? "Built " + esc(when) : ""}${j.sha ? " &middot; " + esc(String(j.sha).slice(0, 7)) : ""}</p>
<a class="btn alt" href="${esc(j.url)}" download="${esc(j.file)}">&#11015; Download APK</a>
<p class="meta" style="margin:10px 0 0;text-align:center">File: ${esc(j.file)}${j.size ? " &middot; " + esc((j.size / 1048576).toFixed(1)) + " MB" : ""}</p>`
: `<p class="ver">No build published yet</p><p class="meta">${esc(err)}</p><a class="btn off">Download APK</a>`}
</div>
<div class="card">
<b>Installing the APK directly</b>
<ol>
<li>Open this page on the phone and tap <b>Download APK</b>. Wait for the download notification to say it finished (about 40 MB &mdash; if it is only a few KB, delete it and try again).</li>
<li>Tap the finished download to <b>Open</b> it (or open it from Files &rarr; Downloads).</li>
<li>If Android asks, allow this browser to install unknown apps, then tap <b>Install</b>.</li>
<li>Open E3 Inspections and sign in. Existing sign-in and offline data are kept.</li>
</ol>
</div>
<div class="note"><b>Switching from the APK to Google Play (one time):</b> the Play Store copy is signed with a different key, so Android will not update an APK install in place. First open the app and let it <b>sync</b> (SYNC pill ON, wait for it to finish), then <b>uninstall</b> E3 Inspections, then install it from Google Play. Only needed once. The same applies the other way round (Play &rarr; APK), and to phones still on the old 2.2.1 build.</div>
</div></body></html>`);
});

module.exports = router;
