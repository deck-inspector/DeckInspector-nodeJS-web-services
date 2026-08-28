"use strict";
// =============================================================================
// PERMANENT web→mobile sync fix (Aug 28, 2026).
//
// The database VM runs Sync Gateway COMMUNITY Edition, which has no background
// import: documents written straight to Couchbase by this backend (SDK writes)
// are invisible to the phones' sync, and its on-write "import" leaves docs
// half-known (listed but not fetchable). The mobile app has always written
// THROUGH Sync Gateway - that path is fully reliable (the entire 137k-doc
// migration went through it).
//
// This module routes the backend's writes for the 9 phone-synced collections
// through Sync Gateway's public REST API too, so every web-created or
// web-edited document is sync-native from birth. Deletes become proper
// tombstones, so phones also see removals.
//
// Activation: set SGW_USERNAME / SGW_PASSWORD in App Service settings
// (the Sync Gateway user, same one the mobile app uses). Optional overrides:
// SGW_URL (default https://sync.e3-web.com:4984), SGW_DB (default
// e3inspectionsmultitenant). WITHOUT these settings the module is inert and
// every write behaves exactly as before (plain SDK) - safe to deploy first,
// configure later.
//
// Resilience: any Sync Gateway outage/error (other than a genuine document
// conflict) falls back to the plain SDK write and logs a warning, so the app
// keeps working; the VM-side e3-sgbridge timer remains as the safety net for
// docs that slip through that fallback.
// =============================================================================

const SGW_URL = (process.env.SGW_URL || "https://sync.e3-web.com:4984").replace(/\/+$/, "");
const SGW_DB = process.env.SGW_DB || "e3inspectionsmultitenant";
const SCOPE = process.env.DB_SCOPE_NAME || "inventory";
const USER = process.env.SGW_USERNAME || "";
const PASS = process.env.SGW_PASSWORD || "";

// The collections Sync Gateway replicates to phones (see the SGW db config).
const SYNCED_COLLECTIONS = new Set([
  "Project", "SubProject", "Location", "VisualSection", "DynamicVisualSection",
  "LocationForm", "InvasiveSection", "ConclusiveSection", "DeckImage",
]);

function sgwEnabled() { return !!(USER && PASS); }

function authHeader() {
  return "Basic " + Buffer.from(USER + ":" + PASS).toString("base64");
}

async function sgwFetch(method, path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(SGW_URL + path, {
      method,
      signal: ctl.signal,
      headers: { Authorization: authHeader(), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* non-JSON body */ }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function keyspacePath(colName, id) {
  return "/" + SGW_DB + "." + SCOPE + "." + colName + "/" + encodeURIComponent(id);
}

// SGW rejects user-defined top-level properties starting with "_".
function cleanBody(doc) {
  const out = {};
  for (const k of Object.keys(doc || {})) {
    if (!k.startsWith("_")) out[k] = doc[k];
  }
  return out;
}

// Current revision of a doc as SGW knows it, or null when SGW has never seen
// it. GET is the normal path; _all_docs is the fallback because docs that CE
// half-imported can 404 on GET while still carrying a rev in _all_docs.
async function sgwGetRev(colName, id) {
  const r = await sgwFetch("GET", keyspacePath(colName, id));
  if (r.status === 200 && r.json && r.json._rev) return r.json._rev;
  const a = await sgwFetch("POST", "/" + SGW_DB + "." + SCOPE + "." + colName + "/_all_docs", { keys: [id] });
  if (a.status === 200 && a.json && Array.isArray(a.json.rows)) {
    const row = a.json.rows.find((x) => x && x.id === id);
    if (row && row.value && row.value.rev) return row.value.rev;
  }
  return null;
}

// Write (create or update) one doc through SGW. Retries revision races twice.
async function sgwUpsert(colName, id, doc) {
  const body = cleanBody(doc);
  let rev = await sgwGetRev(colName, id);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const path = keyspacePath(colName, id) + (rev ? "?rev=" + encodeURIComponent(rev) : "");
    const r = await sgwFetch("PUT", path, body);
    if (r.status === 200 || r.status === 201) return { ok: 1, rev: r.json && r.json.rev };
    if (r.status === 409) { rev = await sgwGetRev(colName, id); continue; }
    throw new Error("SGW upsert failed (" + r.status + ") for " + colName + "/" + id);
  }
  throw new Error("SGW upsert conflict persisted for " + colName + "/" + id);
}

async function sgwInsert(colName, id, doc) {
  const r = await sgwFetch("PUT", keyspacePath(colName, id), cleanBody(doc));
  if (r.status === 200 || r.status === 201) return { ok: 1, rev: r.json && r.json.rev };
  if (r.status === 409) {
    const err = new Error("document exists: " + colName + "/" + id);
    err.name = "DocumentExistsError";
    throw err;
  }
  throw new Error("SGW insert failed (" + r.status + ") for " + colName + "/" + id);
}

async function sgwRemove(colName, id) {
  let rev = await sgwGetRev(colName, id);
  if (!rev) {
    const err = new Error("document not found: " + colName + "/" + id);
    err.name = "DocumentNotFoundError";
    throw err;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await sgwFetch("DELETE", keyspacePath(colName, id) + "?rev=" + encodeURIComponent(rev));
    if (r.status === 200) return { ok: 1 };
    if (r.status === 409) { rev = await sgwGetRev(colName, id); continue; }
    throw new Error("SGW remove failed (" + r.status + ") for " + colName + "/" + id);
  }
  throw new Error("SGW remove conflict persisted for " + colName + "/" + id);
}

// Wrap a real SDK Collection so insert/upsert/replace/remove go through SGW
// when configured. Everything else (get, exists, lookupIn, ...) passes through
// untouched. A genuine conflict propagates; any other SGW failure falls back
// to the SDK write so the app never hard-depends on SGW being up.
function wrapSyncedCollection(realCol, colName) {
  if (!SYNCED_COLLECTIONS.has(colName)) return realCol;
  const route = (op, sdkCall) => async (id, ...rest) => {
    if (!sgwEnabled()) return sdkCall(id, ...rest);
    try {
      if (op === "remove") return await sgwRemove(colName, id);
      if (op === "insert") return await sgwInsert(colName, id, rest[0]);
      return await sgwUpsert(colName, id, rest[0]); // upsert + replace
    } catch (err) {
      if (err && (err.name === "DocumentExistsError" || err.name === "DocumentNotFoundError")) throw err;
      console.warn("SGW write fallback to SDK for", colName + "/" + id + ":", err.message);
      return sdkCall(id, ...rest);
    }
  };
  const overrides = {
    insert: route("insert", (...a) => realCol.insert(...a)),
    upsert: route("upsert", (...a) => realCol.upsert(...a)),
    replace: route("replace", (...a) => realCol.replace(...a)),
    remove: route("remove", (...a) => realCol.remove(...a)),
  };
  return new Proxy(realCol, {
    get(target, prop, receiver) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

module.exports = { wrapSyncedCollection, sgwEnabled, sgwUpsert, sgwInsert, sgwRemove };
