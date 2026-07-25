"use strict";
// TEMPORARY one-off data-migration endpoint. Copies document bodies from the
// SOURCE cluster (current DB_* env vars = old paid Capella cluster) to the
// DESTINATION cluster (DEST_* env vars = new free-tier Azure Capella cluster).
// Protected by MIGRATE_TOKEN. REMOVE THIS FILE + its route after the migration.
const express = require("express");
const couchbase = require("couchbase");
const router = express.Router();

const SCOPE = process.env.DB_PROD_SCOPE_NAME || process.env.DB_SCOPE_NAME || "inventory";
const BUCKET = process.env.DB_BUCKET_NAME || "inspections-data";

// All 17 collections in the inventory scope.
const COLLECTIONS = [
  "Project", "SubProject", "Location", "VisualSection", "InvasiveSection",
  "ConclusiveSection", "DynamicVisualSection", "LocationForm", "DeckImage",
  "LocationForms", "ProjectDocuments", "ProjectReports", "ProjectReportHashCode",
  "Users", "SuperUsers", "Tenants", "ArchivedProjects",
];

let srcCluster = null;
let dstCluster = null;

async function connect(connStr, username, password) {
  const options = { username, password };
  // Capella (couchbases://) needs the wanDevelopment profile.
  if (/^couchbases:\/\//.test(connStr)) options.configProfile = "wanDevelopment";
  return couchbase.connect(connStr, options);
}

async function getSource() {
  if (srcCluster) return srcCluster;
  srcCluster = await connect(process.env.DB_CONN_STR, process.env.DB_USERNAME, process.env.DB_PASSWORD);
  return srcCluster;
}

async function getDest() {
  if (dstCluster) return dstCluster;
  if (!process.env.DEST_CONN_STR || !process.env.DEST_USERNAME || !process.env.DEST_PASSWORD) {
    throw new Error("DEST_CONN_STR / DEST_USERNAME / DEST_PASSWORD env vars are not set");
  }
  dstCluster = await connect(process.env.DEST_CONN_STR, process.env.DEST_USERNAME, process.env.DEST_PASSWORD);
  return dstCluster;
}

function checkToken(req, res) {
  const expected = process.env.MIGRATE_TOKEN;
  const got = req.query.token || req.headers["x-migrate-token"];
  if (!expected) { res.status(500).json({ error: "MIGRATE_TOKEN not configured" }); return false; }
  if (got !== expected) { res.status(403).json({ error: "bad token" }); return false; }
  return true;
}

async function countAll(cluster) {
  const out = {};
  for (const c of COLLECTIONS) {
    try {
      const q = "SELECT RAW COUNT(*) FROM `" + BUCKET + "`.`" + SCOPE + "`.`" + c + "`";
      const r = await cluster.query(q);
      out[c] = r.rows[0] || 0;
    } catch (e) {
      out[c] = "ERR:" + e.message;
    }
  }
  return out;
}

// GET /api/migrate/status?token=XXX  -> per-collection counts on both clusters
router.get("/status", async function (req, res) {
  if (!checkToken(req, res)) return;
  try {
    const src = await getSource();
    const dst = await getDest();
    const [source, dest] = await Promise.all([countAll(src), countAll(dst)]);
    res.json({ ok: true, bucket: BUCKET, scope: SCOPE, source, dest });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Copies a bounded window [offset, offset+limit) of one collection so a single
// HTTP request stays well under Azure's ~230s front-end timeout. Returns
// progress so the caller can loop until done.
async function copyWindow(src, dst, name, offset, limit) {
  const srcColl = src.bucket(BUCKET).scope(SCOPE).collection(name);
  const dstColl = dst.bucket(BUCKET).scope(SCOPE).collection(name);
  const q = "SELECT RAW META().id FROM `" + BUCKET + "`.`" + SCOPE + "`.`" + name + "` LIMIT $lim OFFSET $off";
  const r = await src.query(q, { parameters: { lim: limit, off: offset } });
  const ids = r.rows;
  let copied = 0, errors = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    await Promise.all(batch.map(async (id) => {
      try {
        const doc = await srcColl.get(id);
        await dstColl.upsert(id, doc.content);
        copied++;
      } catch (e) { errors++; }
    }));
  }
  return { scanned: ids.length, copied, errors, nextOffset: offset + ids.length, done: ids.length < limit };
}

// POST /api/migrate/run?token=XXX&collection=Name&offset=N&limit=M
//   Copies a bounded window and returns progress {scanned,copied,errors,nextOffset,done}.
// POST /api/migrate/run?token=XXX   (no collection)
//   Copies every SMALL collection fully in one request (each looped to done),
//   and reports per-collection totals. Use the windowed form for big collections.
router.post("/run", async function (req, res) {
  if (!checkToken(req, res)) return;
  try {
    const src = await getSource();
    const dst = await getDest();
    const only = req.query.collection;
    if (only) {
      const offset = parseInt(req.query.offset || "0", 10);
      const limit = parseInt(req.query.limit || "500", 10);
      const w = await copyWindow(src, dst, only, offset, limit);
      return res.json({ ok: true, collection: only, offset, limit, ...w });
    }
    // No collection: loop each collection to completion in this request.
    const result = {};
    for (const c of COLLECTIONS) {
      let off = 0, copied = 0, errors = 0;
      for (;;) {
        const w = await copyWindow(src, dst, c, off, 1000);
        copied += w.copied; errors += w.errors; off = w.nextOffset;
        if (w.done) break;
      }
      result[c] = { copied, errors };
    }
    res.json({ ok: true, bucket: BUCKET, scope: SCOPE, result });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

module.exports = router;
