const couchbase = require("couchbase");

// Load environment variables - ensure dotenv is loaded in index.js first
const DB_USERNAME = process.env.DB_USERNAME;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_CONN_STR = process.env.DB_CONN_STR;
const DB_BUCKET_NAME = process.env.DB_BUCKET_NAME;
const DB_SCOPE_NAME = process.env.DB_SCOPE_NAME || "inventory-qa";
const DB_PROD_SCOPE_NAME = process.env.DB_PROD_SCOPE_NAME || "inventory";
const IS_CAPELLA = process.env.IS_CAPELLA === "true";

// Export constants immediately so DAOs can use them
module.exports.DB_BUCKET_NAME = DB_BUCKET_NAME;
module.exports.DB_SCOPE_NAME = DB_SCOPE_NAME;
module.exports.DB_PROD_SCOPE_NAME = DB_PROD_SCOPE_NAME;

if (!DB_USERNAME) {
  throw new Error(
    "Please define the DB_USERNAME environment variable inside .env file",
  );
}

if (!DB_PASSWORD) {
  throw new Error(
    "Please define the DB_PASSWORD environment variable inside .env file",
  );
}

if (!DB_CONN_STR) {
  throw new Error(
    "Please define the DB_CONN_STR environment variable inside .env file (e.g., couchbases://your-cluster.cloud.couchbase.com)",
  );
}

if (!DB_BUCKET_NAME) {
  throw new Error(
    "Please define the DB_BUCKET_NAME environment variable inside .env file",
  );
}

/**
 * Global is used here to maintain a cached connection across hot reloads
 * in development. This prevents connections growing exponentially
 * during API Route usage.
 */
let cached = global.couchbaseConnection;

if (!cached) {
  cached = global.couchbaseConnection = { cluster: null, bucket: null };
}

async function createCouchbaseCluster() {
  if (cached.cluster && cached.bucket) {
    console.log("Reusing cached Couchbase connection");
    return { cluster: cached.cluster, bucket: cached.bucket };
  }

  try {
    console.log("Connecting to Couchbase cluster at:", DB_CONN_STR);

    const options = {
      username: DB_USERNAME,
      password: DB_PASSWORD,
      // KV "unambiguous timeout" fix (Aug 17): every App Service restart
      // (i.e. every deploy) leaves a window where the SDK is still opening
      // its KV sockets; KV ops racing that bootstrap threw at the default
      // 2.5s kvTimeout while N1QL (HTTP to the query service) rode it out.
      // Give KV ops room to outlast a re-bootstrap instead of failing the
      // user's click. Query/management stay generous for report generation.
      timeouts: {
        connectTimeout: 15000,
        bootstrapTimeout: 15000,
        kvTimeout: 10000,
        kvDurableTimeout: 15000,
        queryTimeout: 75000,
        managementTimeout: 75000,
      },
    };

    // Only add configProfile for Capella clusters
    if (IS_CAPELLA) {
      options.configProfile = "wanDevelopment";
    }

    cached.cluster = await couchbase.connect(DB_CONN_STR, options);
    console.log("Successfully connected to Couchbase cluster");

    // READ-YOUR-OWN-WRITES for every N1QL query (Aug 3): all writes go through
    // N1QL, and list screens re-query immediately after saving. The default
    // scan consistency (not_bounded) lets the GSI index lag a few seconds, so a
    // newly created project / just-saved inspection didn't appear until the user
    // pressed F5. RequestPlus makes each query wait for the index to include
    // all mutations pending at request time. USE KEYS lookups don't use the
    // index, so report generation's per-doc reads are unaffected.
    const rawQuery = cached.cluster.query.bind(cached.cluster);
    cached.cluster.query = (statement, queryOptions) => {
      const opts = Object.assign({}, queryOptions || {});
      if (opts.scanConsistency === undefined) {
        opts.scanConsistency = couchbase.QueryScanConsistency.RequestPlus;
      }
      return rawQuery(statement, opts);
    };

    cached.bucket = cached.cluster.bucket(DB_BUCKET_NAME);
    console.log("Successfully accessed bucket:", DB_BUCKET_NAME);

    // Warm the KV connections BEFORE declaring the connection ready.
    // couchbase.connect() resolves before the bucket's KV sockets are open;
    // this SDK (4.6) has no waitUntilReady, but bucket.ping() exercises the
    // KV service and forces the bootstrap to finish. Without this, the first
    // requests after every deploy raced the bootstrap and hit
    // "unambiguous timeout" (seen in production Aug 17). Best-effort with
    // retries - a failed ping logs but never blocks startup (index.js already
    // retries the whole connect if the DB is down).
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const t0 = Date.now();
        await cached.bucket.ping();
        console.log(`KV warm-up ping ok in ${Date.now() - t0}ms (attempt ${attempt})`);
        break;
      } catch (pingError) {
        console.warn(`KV warm-up ping attempt ${attempt} failed:`, pingError.message);
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          // Aug 17 hardening TODO, built Aug 28: a KV connection that is born
          // dead stays dead in SDK 4.6. Do NOT continue with it - throw, so
          // index.js's 60s connect-retry loop rebuilds from scratch.
          try { await cached.cluster.close(); } catch (e) { /* ignore */ }
          cached.cluster = null;
          cached.bucket = null;
          throw new Error(`KV warm-up failed after ${attempt} attempts: ${pingError.message}`);
        }
      }
    }
  } catch (error) {
    console.error("Error connecting to Couchbase cluster:", error.message);
    console.error("Connection string:", DB_CONN_STR);
    console.error("Bucket name:", DB_BUCKET_NAME);
    throw new Error(`Couchbase connection failed: ${error.message}`);
  }

  return { cluster: cached.cluster, bucket: cached.bucket };
}

async function connectToDatabase() {
  const { cluster, bucket } = await createCouchbaseCluster();
  const scope = bucket.scope(DB_SCOPE_NAME);
  const prod_scope = bucket.scope(DB_PROD_SCOPE_NAME);

  // Export collections for use in DAOs
  module.exports.cluster = cluster;
  module.exports.bucket = bucket;
  module.exports.scope = scope;
  module.exports.prod_scope = prod_scope;

  // Collection exports - using correct collection names
  module.exports.Projects = scope.collection("Project");
  module.exports.SubProjects = scope.collection("SubProject");
  module.exports.Locations = scope.collection("Location");
  module.exports.Sections = scope.collection("VisualSection");
  module.exports.DynamicSections = scope.collection("DynamicVisualSection");
  module.exports.Users = prod_scope.collection("Users");
  module.exports.ProjectDocuments = scope.collection("ProjectDocuments");
  module.exports.ProjectReports = scope.collection("ProjectReports");
  module.exports.InvasiveSections = scope.collection("InvasiveSection");
  module.exports.ConclusiveSections = scope.collection("ConclusiveSection");
  module.exports.ProjectReportHashCode = scope.collection(
    "ProjectReportHashCode",
  );
  module.exports.Tenants = prod_scope.collection("Tenants");
  module.exports.SuperUsers = scope.collection("SuperUsers");
  module.exports.ArchivedProjects = scope.collection("ArchivedProjects");
  module.exports.DynamicVisualSection = scope.collection(
    "DynamicVisualSection",
  );
  module.exports.LocationsForms = scope.collection("LocationForm");

  let dbConnection = {
    cluster,
    bucket,
    scope,
    prod_scope,
  };

  return dbConnection;
}

module.exports.connectToDatabase = connectToDatabase;

// ---------------------------------------------------------------------------
// KV WATCHDOG (Aug 28): the network flows between the App Service and the DB
// VM's KV port (11210) can silently die mid-life (memcached logs "reading /
// Connection timed out" for our peer), after which EVERY KV op times out at
// 10s while N1QL stays healthy - and SDK 4.6 never rebuilds the dead sockets.
// Previously the only cure was a manual App Service restart. This watchdog
// runs a REAL KV op (exists on a dummy key) every 30s; after 2 consecutive
// failures it tears down the cached cluster and reconnects, refreshing every
// exported collection handle. Recovery is automatic within ~1-2 minutes.
// ---------------------------------------------------------------------------
if (!global.__kvWatchdog) {
  global.__kvWatchdog = { failures: 0, rebuilding: false };
  const wd = global.__kvWatchdog;
  setInterval(async () => {
    if (wd.rebuilding) return;
    const col = module.exports.Projects;
    if (!col || !cached.cluster) return; // not connected yet
    try {
      await col.exists("__kv_watchdog__", { timeout: 5000 });
      if (wd.failures > 0) console.log("KV watchdog: healthy again after", wd.failures, "failure(s)");
      wd.failures = 0;
    } catch (err) {
      wd.failures += 1;
      console.warn(`KV watchdog: probe failed (${wd.failures} consecutive):`, err.message);
      if (wd.failures >= 2) {
        wd.rebuilding = true;
        console.warn("KV watchdog: rebuilding Couchbase connection...");
        try {
          try { await cached.cluster.close(); } catch (e) { /* ignore */ }
          cached.cluster = null;
          cached.bucket = null;
          await connectToDatabase();
          wd.failures = 0;
          console.log("KV watchdog: connection rebuilt successfully");
        } catch (reErr) {
          console.error("KV watchdog: rebuild failed:", reErr.message);
        } finally {
          wd.rebuilding = false;
        }
      }
    }
  }, 30000).unref();
}