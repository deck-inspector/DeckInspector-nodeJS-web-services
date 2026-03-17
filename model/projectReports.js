"use strict";
const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");
const Role = require('./role');

// Helper function to get ProjectReports collection
async function getProjectReportsCollection() {
  return couchbase.ProjectReports;
}

// Helper function to execute N1QL queries
async function executeQuery(statement, parameters = []) {
  try {
    const cluster = couchbase.cluster;
    const bucket = couchbase.bucket;

    if (!cluster) {
      throw new Error("Cluster connection not initialized. Make sure connectToDatabase() was called.");
    }

    if (!bucket) {
      throw new Error("Bucket not initialized. Make sure connectToDatabase() was called.");
    }

    const result = await cluster.query(statement, { parameters });
    return result.rows;
  } catch (error) {
    console.error("Query execution error:", error);
    throw error;
  }
}

var addProjectReport = async function (projectReport, callback) {
    try {
        const reportId = uuidv4();
        const reportWithMeta = {
            id: reportId,
            ...projectReport,
            docType: "ProjectReport",
            createdAt: new Date().toISOString(),
        };
        const collection = await getProjectReportsCollection();
        await collection.insert(reportId, reportWithMeta);
        console.log(`ProjectReport added with ID: ${reportId}`);
        callback(null, { insertedId: reportId, success: true });
    } catch (error) {
        console.error("Error adding ProjectReport:", error);
        var err = new Error("addProjectReport()." + error.message);
        err.status = 500;
        callback(err);
    }
};

var getProjectReportsbyProjectId = async function (project_id, callback) {
    try {
        const query = `SELECT META(r).id AS id, r.* 
          FROM \`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.ProjectReports r 
          WHERE r.project_id = $1`;
        
        const results = await executeQuery(query, [project_id]);
        
        if (results.length === 0) {
            var error1 = new Error("getProjectReportsbyProjectId(). \nMessage: No Document Found.");
            error1.status = 404;
            callback(error1);
            return;
        }
        
        // Map results to ensure ID is included
        const mappedResults = results.map(row => ({
            _id: row._id || row.id,
            ...row
        }));
        
        callback(null, mappedResults);
    } catch (error) {
        console.error("Error getting ProjectReports by project ID:", error);
        var err = new Error("getProjectReportsbyProjectId()." + error.message);
        err.status = 500;
        callback(err);
    }
};

var removeReport = async function (id, callback) {
    try {
        const query = `DELETE FROM \`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.ProjectReports 
          WHERE META().id = $1`;
        
        await executeQuery(query, [id]);
        callback(null, { status: 201, message: "Document deleted successfully." });
    } catch (error) {
        console.error("Error removing report:", error);
        var error2 = new Error("Error occurred. Didn't remove document. " + error.message);
        error2.status = 500;
        callback(error2);
    }
};

module.exports = {
    addProjectReport: addProjectReport,
    getProjectReportsbyProjectId: getProjectReportsbyProjectId,
    removeReport: removeReport
};