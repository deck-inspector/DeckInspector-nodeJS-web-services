"use strict";
const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");

// Helper function to get SubProjects collection
async function getSubProjectsCollection() {
  return couchbase.SubProjects;
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
    insertSubProject: async (subproject) => {
        try {
            const subProjectId = `subproject_${uuidv4()}`;
            const collection = await getSubProjectsCollection();
            const subProjectDoc = {
                ...subproject,
                type: "SubProject",
                createdAt: new Date().toISOString(),
            };
            await collection.insert(subProjectId, subProjectDoc);
            return { insertedId: subProjectId, ok: 1 };
        } catch (error) {
            console.error("Error inserting subproject:", error);
            throw error;
        }
    },

    findSubProjectById: async (id) => {
        try {
            const collection = await getSubProjectsCollection();
            const doc = await collection.get(id);
            console.log("Couchbase getSubProjectById result:", doc);
            
            if (!doc?.content) return null;
            
            // Helper function to remove nested content properties recursively
            const stripNestedContent = (obj) => {
                if (!obj || typeof obj !== 'object') return obj;
                
                const { content, ...rest } = obj;
                
                // If content exists, use it as the base, otherwise use the object itself
                const base = content || rest;
                
                // Process all properties recursively
                const cleaned = {};
                for (const [key, value] of Object.entries(base)) {
                    if (key === 'content') continue; // Skip any content property
                    if (Array.isArray(value)) {
                        cleaned[key] = value.map(item => stripNestedContent(item));
                    } else if (value && typeof value === 'object') {
                        cleaned[key] = stripNestedContent(value);
                    } else {
                        cleaned[key] = value;
                    }
                }
                return cleaned;
            };
            
            return stripNestedContent(doc.content);
        } catch (error) {
            if (error.code === 13) {
                // Document not found
                return null;
            }
            console.error("Error finding subproject by id:", error);
            throw error;
        }
    },

    editSubProject: async (id, newData) => {
        try {
            const collection = await getSubProjectsCollection();
            const doc = await collection.get(id);
            const updatedDoc = { ...doc.content, ...newData };
            await collection.upsert(id, updatedDoc);
            return { ok: 1 };
        } catch (error) {
            console.error("Error editing subproject:", error);
            throw error;
        }
    },

    deleteSubProject: async (id) => {
        try {
            const collection = await getSubProjectsCollection();
            await collection.remove(id);
            return { ok: 1 };
        } catch (error) {
            console.error("Error deleting subproject:", error);
            throw error;
        }
    },

        findSubProjectsByParentId: async (parentId) => {
        try {
            const query = `SELECT META(s).id as id, s.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_SCOPE_NAME || "inventory"}\`.SubProject s WHERE s.parentid = $1`;
            const results = await executeQuery(query, [parentId]);
            return results.map(row => {
                return {
                    ...row
                };
            });
        } catch (error) {
            console.error("Error finding subprojects by parent id:", error);
            throw error;
        }
    },

    addSubProjectChild: async (subProjectId, childId, childData) => {
        try {
            const collection = await getSubProjectsCollection();
            const doc = await collection.get(subProjectId);
            const children = doc.content.children || [];
            
            children.push({
                "_id": childId,
                ...childData
            });
            
            await collection.upsert(subProjectId, { ...doc.content, children });
            return { ok: 1 };
        } catch (error) {
            console.error("Error adding subproject child:", error);
            throw error;
        }
    },

    removeSubProjectChild: async (subProjectId, childId) => {
        try {
            const collection = await getSubProjectsCollection();
            const doc = await collection.get(subProjectId);
            const children = doc.content.children || [];
            
            const filteredChildren = children.filter(
                (child) => child._id !== childId
            );
            
            await collection.upsert(subProjectId, { ...doc.content, children: filteredChildren });
            return { ok: 1 };
        } catch (error) {
            console.error("Error removing subproject child:", error);
            throw error;
        }
    },

    assignSubprojectToUser: async (subProjectId, username) => {
        try {
            const collection = await getSubProjectsCollection();
            const doc = await collection.get(subProjectId);
            const assignedto = doc.content.assignedto || [];
            
            if (!assignedto.includes(username)) {
                assignedto.push(username);
                await collection.upsert(subProjectId, { ...doc.content, assignedto });
            }
            return { ok: 1 };
        } catch (error) {
            console.error("Error assigning subproject to user:", error);
            throw error;
        }
    },

    unassignSubprojectFromUser: async (subProjectId, username) => {
        try {
            const collection = await getSubProjectsCollection();
            const doc = await collection.get(subProjectId);
            let assignedto = doc.content.assignedto || [];
            
            assignedto = assignedto.filter((user) => user !== username);
            
            await collection.upsert(subProjectId, { ...doc.content, assignedto });
            return { ok: 1 };
        } catch (error) {
            console.error("Error unassigning subproject from user:", error);
            throw error;
        }
    },

    addUpdateSubProjectChild: async (subprojectId, childId, childData) => {
        try {
            const collection = await getSubProjectsCollection();
            const doc = await collection.get(subprojectId);
            const children = doc.content.children || [];
            
            const index = children.findIndex((child) => child._id === childId);
            if (index !== -1) {
                children[index] = { ...children[index], ...childData };
            } else {
                children.push({ "_id": childId, ...childData });
            }
            
            await collection.upsert(subprojectId, { ...doc.content, children });
            return { ok: 1 };
        } catch (error) {
            console.error("Error updating subproject child:", error);
            throw error;
        }
    }
};
