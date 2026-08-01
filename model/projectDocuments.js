"use strict";
// Project Documents - CONVERTED FROM MONGO TO COUCHBASE (Aug 1).
// The old implementation called mongo.ProjectDocuments, but the Mongo
// database was retired: mongo.ProjectDocuments is undefined at runtime, so
// listing a project's documents crashed the whole Node process
// ("Cannot read properties of undefined (reading 'find')" - seen live in the
// Azure log stream) and uploads could never be saved.
//
// Documents are stored in the existing ProjectReports Couchbase collection
// with docType 'ProjectDocument' (no new collection needed - the app's DB
// user may not have DDL rights). getProjectReportsbyProjectId excludes this
// docType, so documents never show up in the Report Files list.
const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");

async function executeQuery(statement, parameters = []) {
    const cluster = couchbase.cluster;
    if (!cluster) {
        throw new Error("Cluster connection not initialized. Make sure connectToDatabase() was called.");
    }
    const result = await cluster.query(statement, { parameters });
    return result.rows;
}

var addProjectDocument = async function (projectDocument, callback) {
    try {
        const docId = uuidv4();
        const docWithMeta = {
            id: docId,
            project_id: projectDocument.project_id,
            name: projectDocument.name,
            url: projectDocument.url,
            uploader: projectDocument.uploader,
            timestamp: projectDocument.timestamp,
            docType: "ProjectDocument",
            createdAt: new Date().toISOString(),
        };
        const insertQuery = `INSERT INTO \`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.ProjectReports (KEY, VALUE) VALUES ($1, $2)`;
        await executeQuery(insertQuery, [docId, docWithMeta]);
        console.log(`ProjectDocument added with ID: ${docId}`);
        callback(null, { insertedId: docId, _id: docId, success: true });
    } catch (error) {
        console.error("Error adding ProjectDocument:", error);
        var err = new Error("addProjectDocument()." + error.message);
        err.status = 500;
        callback(err);
    }
};

var getProjectDocumentsbyProjectId = async function (project_id, callback) {
    try {
        const query = `SELECT d.*
          FROM \`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.ProjectReports d
          WHERE d.project_id = $1 AND d.docType = 'ProjectDocument'
          ORDER BY d.timestamp DESC`;
        const results = await executeQuery(query, [project_id]);
        // An empty list is a normal state (project simply has no documents
        // yet) - return it as such, never as an error.
        const mapped = results.map(row => ({ _id: row.id, ...row }));
        callback(null, mapped);
    } catch (error) {
        console.error("Error getting ProjectDocuments by project ID:", error);
        var err = new Error("getProjectDocumentsbyProjectId()." + error.message);
        err.status = 500;
        callback(err);
    }
};

var removeDocument = async function (id, callback) {
    try {
        const query = `DELETE FROM \`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.ProjectReports
          WHERE META().id = $1 AND docType = 'ProjectDocument'`;
        await executeQuery(query, [id]);
        callback(null, { status: 201, message: "Document deleted successfully." });
    } catch (error) {
        console.error("Error removing ProjectDocument:", error);
        var err = new Error("Error occurred. Didn't remove document. " + error.message);
        err.status = 500;
        callback(err);
    }
};

module.exports = {
    addProjectDocument: addProjectDocument,
    getProjectDocumentsbyProjectId: getProjectDocumentsbyProjectId,
    removeDocument: removeDocument
};
