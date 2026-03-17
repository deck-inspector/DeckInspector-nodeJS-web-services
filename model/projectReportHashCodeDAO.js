"use strict";
const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");

// Helper function to get ProjectReportHashCode collection
async function getProjectReportHashCodeCollection() {
  return couchbase.ProjectReportHashCode;
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

module.exports = {
    addProjectReportHashCode: async (project) => {
      try {
        const hashCodeId = `ProjectReportHashCode-${uuidv4()}`;
        const hashCodeWithMeta = {
          ...project,
          docType: "ProjectReportHashCode",
          createdAt: new Date().toISOString(),
        };
        const collection = await getProjectReportHashCodeCollection();
        await collection.insert(hashCodeId, hashCodeWithMeta);
        console.log(`ProjectReportHashCode added with ID: ${hashCodeId}`);
        return { insertedId: hashCodeId, success: true };
      } catch (error) {
        console.error("Error adding ProjectReportHashCode:", error);
        throw error;
      }
    },
    getProjectReportHashCodeById: async (projectId) => {
      try {
        const query = `SELECT META(h).id AS id, h.* 
          FROM \`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.ProjectReportHashCode h 
          WHERE h.projectId = $1`;
        
        const results = await executeQuery(query, [projectId]);
        
        if (results && results.length > 0) {
          return results[0];
        }
        return null;
      } catch (error) {
        console.error("Error getting ProjectReportHashCode by ID:", error);
        throw error;
      }
    },
    deleteProjectReportHashCodeById: async (projectId) => {
      try {
        const query = `DELETE FROM \`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.ProjectReportHashCode 
          WHERE projectId = $1`;
        
        await executeQuery(query, [projectId]);
        return { ok: 1 };
      } catch (error) {
        console.error("Error deleting ProjectReportHashCode by ID:", error);
        throw error;
      }
    },
    getProjectReportHashCodeByIdAndReportType: async (projectId, reportType) => {
      try {
        const query = `SELECT META(h).id AS id, h.* 
          FROM \`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.ProjectReportHashCode h 
          WHERE h.projectId = $1 AND h.reportType = $2`;
        
        const results = await executeQuery(query, [projectId, reportType]);
        
        if (results && results.length > 0) {
          return results[0];
        }
        return null;
      } catch (error) {
        console.error("Error getting ProjectReportHashCode by ID and ReportType:", error);
        throw error;
      }
    },
    deleteProjectReportHashCodeByIdAndReportType: async (projectId, reportType) => {
      try {
        const query = `DELETE FROM \`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.ProjectReportHashCode 
          WHERE projectId = $1 AND reportType = $2`;
        
        await executeQuery(query, [projectId, reportType]);
        return { ok: 1 };
      } catch (error) {
        console.error("Error deleting ProjectReportHashCode by ID and ReportType:", error);
        throw error;
      }
    }
}