"use strict";
const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");

// Helper function to get ConclusiveSections collection
async function getConclusiveSectionsCollection() {
  return couchbase.ConclusiveSections;
}

// Helper function to execute N1QL queries
async function executeQuery(statement, parameters = []) {
  try {
    const cluster = couchbase.cluster;
    if (!cluster) {
      throw new Error("Cluster connection not initialized.");
    }
    const result = await cluster.query(statement, { parameters });
    return result.rows;
  } catch (error) {
    console.error("Query execution error:", error);
    throw error;
  }
}

module.exports = {
    addConclusiveSection: async (conclusiveSection) => {
        try {
            const sectionId = `${uuidv4()}`;
            const collection = await getConclusiveSectionsCollection();
            const sectionDoc = {
                ...conclusiveSection,
                docType: "ConclusiveSection",
                createdAt: new Date().toISOString(),
            };
            await collection.insert(sectionId, sectionDoc);
            return { insertedId: sectionId, ok: 1 };
        } catch (error) {
            console.error("Error adding conclusive section:", error);
            throw error;
        }
    },

    getAllConclusiveSections: async () => {
        try {
            const query = `SELECT META(cs).id AS id, cs.*
            FROM \`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.\`ConclusiveSection\` AS cs
            ORDER BY META(cs).id DESC LIMIT 50`;
            
            const results = await executeQuery(query);
            return results.map(row => ({
                id: row.id,
                ...row
            }));
        } catch (error) {
            console.error("Error getting all conclusive sections:", error);
            throw error;
        }
    },

    getConclusiveSectionById: async (id) => {
        try {
            const collection = await getConclusiveSectionsCollection();
            const doc = await collection.get(id);
            console.log("Couchbase getConclusiveSectionById result:", doc);
            
            if (!doc?.content) return null;
            
            return { ...doc.content, id };
        } catch (error) {
            if (error.code === 13) {
                // Document not found
                return null;
            }
            console.error("Error getting conclusive section by id:", error);
            throw error;
        }
    },

    editConclusiveSection: async (id, newData) => {
        try {
            const collection = await getConclusiveSectionsCollection();
            const doc = await collection.get(id);
            const updatedDoc = { ...doc.content, ...newData };
            await collection.upsert(id, updatedDoc);
            return { ok: 1 };
        } catch (error) {
            console.error("Error editing conclusive section:", error);
            throw error;
        }
    },

    deleteConclusiveSection: async (id) => {
        try {
            const collection = await getConclusiveSectionsCollection();
            await collection.remove(id);
            return { ok: 1 };
        } catch (error) {
            console.error("Error deleting conclusive section:", error);
            throw error;
        }
    },

    getConclusiveSectionByParentId: async (parentId) => {
        try {
            const query = `SELECT META(cs).id as id, cs.* FROM \`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.\`ConclusiveSection\` cs WHERE cs.parentid = $1`;
            const results = await executeQuery(query, [parentId]);
            return results.map(row => ({
                id: row.id,
                ...row
            }));
        } catch (error) {
            console.error("Error getting conclusive sections by parent id:", error);
            throw error;
        }
    },
}