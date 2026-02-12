const couchbase = require("couchbase");

// Load environment variables - ensure dotenv is loaded in index.js first
const DB_USERNAME = process.env.DB_USERNAME;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_CONN_STR = process.env.DB_CONN_STR;
const DB_BUCKET_NAME = process.env.DB_BUCKET_NAME;
const DB_SCOPE_NAME = process.env.DB_SCOPE_NAME || "inventory";
const IS_CAPELLA = process.env.IS_CAPELLA === "true";

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
    };

    // Only add configProfile for Capella clusters
    if (IS_CAPELLA) {
      options.configProfile = "wanDevelopment";
    }

    cached.cluster = await couchbase.connect(DB_CONN_STR, options);
    console.log("Successfully connected to Couchbase cluster");

    cached.bucket = cached.cluster.bucket(DB_BUCKET_NAME);
    console.log("Successfully accessed bucket:", DB_BUCKET_NAME);
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


  // Export collections for use in DAOs
  module.exports.cluster = cluster;
  module.exports.bucket = bucket;
  module.exports.scope = scope;

  // Collection exports - using correct collection names
  module.exports.Projects = scope.collection("Project");
  module.exports.SubProjects = scope.collection("SubProject");
  module.exports.Locations = scope.collection("Location");
  module.exports.Sections = scope.collection("VisualSection");
  module.exports.DynamicSections = scope.collection("DynamicVisualSection");
  module.exports.Users = scope.collection("Users");
  module.exports.ProjectDocuments = scope.collection("ProjectDocuments");
  module.exports.ProjectReports = scope.collection("ProjectReports");
  module.exports.InvasiveSections = scope.collection("InvasiveSection");
  module.exports.ConclusiveSections = scope.collection("ConclusiveSection");
  module.exports.ProjectReportHashCode = scope.collection(
    "ProjectReportHashCode",
  );
  module.exports.Tenants = scope.collection("Tenants");
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
  };

  return dbConnection;
}

module.exports.connectToDatabase = connectToDatabase;
