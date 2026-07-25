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

async function copyCollection(src, dst, name, pageSize) {
  const srcColl = src.bucket(BUCKET).scope(SCOPE).collection(name);
  const dstColl = dst.bucket(BUCKET).scope(SCOPE).collection(name);
  let offset = 0, copied = 0, errors = 0;
  // Pull ids page by page, then KV-get + KV-upsert (preserves the full doc body).
  for (;;) {
    const q = "SELECT RAW META().id FROM `" + BUCKET + "`.`" + SCOPE + "`.`" + name + "` LIMIT $lim OFFSET $off";
    const r = await src.query(q, { parameters: { lim: pageSize, off: offset } });
    const ids = r.rows;
    if (!ids.length) break;
    // process in small concurrent batches
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      await Promise.all(batch.map(async (id) => {
        try {
          const doc = await srcColl.get(id);
          await dstColl.upsert(id, doc.content);
          copied++;
        } catch (e) {
          errors++;
        }
      }));
    }
    offset += ids.length;
    if (ids.length < pageSize) break;
  }
  return { copied, errors };
}

// POST /api/migrate/run?token=XXX[&collection=Name]  -> copies one or all collections
router.post("/run", async function (req, res) {
  if (!checkToken(req, res)) return;
  const pageSize = parseInt(req.query.pageSize || "1000", 10);
  const only = req.query.collection;
  try {
    const src = await getSource();
    const dst = await getDest();
    const list = only ? [only] : COLLECTIONS;
    const result = {};
    for (const c of list) {
      result[c] = await copyCollection(src, dst, c, pageSize);
    }
    res.json({ ok: true, bucket: BUCKET, scope: SCOPE, result });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

module.exports = router;
