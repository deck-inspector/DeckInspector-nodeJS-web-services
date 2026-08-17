const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");
const { orderSectionsByIds } = require("./sectionOrder");

// Helper function to get Locations collection
async function getLocationsCollection() {
  return couchbase.Locations;
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
    addLocation: async (location) => {
        try {
            const locationId = `${uuidv4()}`;
            const collection = await getLocationsCollection();
            const locationDoc = {
                ...location,
                docType: "Location",
                createdAt: new Date().toISOString(),
            };
            await collection.insert(locationId, locationDoc);
            return { insertedId: locationId, ok: 1 };
        } catch (error) {
            console.error("Error adding location:", error);
            throw error;
        }
    },

    getAllLocations: async () => {
        try {
            const query = `SELECT META(l).id as id, l.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_SCOPE_NAME || "inventory"}\`.Location l ORDER BY META(l).id DESC LIMIT 50`;
            const results = await executeQuery(query);
            return results.map(row => ({
                id: row.id,
                ...row
            }));
        } catch (error) {
            console.error("Error getting all locations:", error);
            throw error;
        }
    },

    getLocationById: async (id) => {
        try {
            const collection = await getLocationsCollection();
            const doc = await collection.get(id);
            // Replace _id with id in the response
            const { _id, sections, ...rest } = doc.content;
            let mappedSections = sections;
            if (Array.isArray(sections)) {
                mappedSections = sections.map(section => {
                    if (section && section._id) {
                        const { _id, ...sectionRest } = section;
                        return { ...sectionRest, id: _id };
                    }
                    return section;
                });
            }
            return { ...rest, sections: mappedSections, id };
        } catch (error) {
            if (error.code === 13) {
                // Document not found
                return null;
            }
            console.error("Error getting location by id:", error);
            throw error;
        }
    },

    editLocation: async (id, newData) => {
        try {
            const collection = await getLocationsCollection();
            const doc = await collection.get(id);
            const updatedDoc = { ...doc.content, ...newData };
            await collection.upsert(id, updatedDoc);
            return { ok: 1 };
        } catch (error) {
            console.error("Error editing location:", error);
            throw error;
        }
    },

    deleteLocation: async (id) => {
        try {
            const collection = await getLocationsCollection();
            await collection.remove(id);
            return { ok: 1 };
        } catch (error) {
            console.error("Error deleting location:", error);
            throw error;
        }
    },

    addLocationChild: async (locationId, childId, childData) => {
        try {
            const collection = await getLocationsCollection();
            let doc, docKey;
            
            // Try to get by document key first
            try {
                doc = await collection.get(locationId);
                docKey = locationId;
            } catch (err) {
                // If not found by key, query by id field
                if (err.name === "DocumentNotFoundError") {
                    const query = `SELECT META(l).id as _key, l.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Location l WHERE META(l).id = $1 OR l.id = $1 OR l._id = $1`;
                    const results = await executeQuery(query, [locationId]);
                    if (results.length === 0) {
                        throw new Error(`Location not found: ${locationId}`);
                    }
                    docKey = results[0]._key;
                    doc = await collection.get(docKey);
                } else {
                    throw err;
                }
            }
            
            const sections = doc.content.sections || [];
            
            sections.push({
                "_id": childId,
                "id": childId,
                ...childData
            });
            
            await collection.upsert(docKey, { ...doc.content, sections });
            return { ok: 1 };
        } catch (error) {
            console.error("Error adding location child:", error);
            throw error;
        }
    },

    // Rewrite the order of a location's sections array. That array order IS the
    // order sections appear in the generated report, so this is what makes a
    // reorder stick end to end. Children not named in orderedIds keep their
    // existing relative order and are appended after the ordered ones, so a
    // stale client list can never drop a section.
    reorderLocationChildren: async (locationId, orderedIds) => {
        try {
            const collection = await getLocationsCollection();
            let doc, docKey;

            // Same key-then-query lookup addLocationChild uses: some locations
            // are stored under a document key that differs from their id field.
            try {
                doc = await collection.get(locationId);
                docKey = locationId;
            } catch (err) {
                if (err.name === "DocumentNotFoundError") {
                    const query = `SELECT META(l).id as _key, l.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Location l WHERE META(l).id = $1 OR l.id = $1 OR l._id = $1`;
                    const results = await executeQuery(query, [locationId]);
                    if (results.length === 0) {
                        throw new Error(`Location not found: ${locationId}`);
                    }
                    docKey = results[0]._key;
                    doc = await collection.get(docKey);
                } else {
                    throw err;
                }
            }

            const sections = doc.content.sections || [];

            const reordered = orderSectionsByIds(sections, orderedIds);
            await collection.upsert(docKey, { ...doc.content, sections: reordered });
            return { ok: 1, sections: reordered };
        } catch (error) {
            console.error("Error reordering location children:", error);
            throw error;
        }
    },

    removeLocationChild: async (locationId, childId) => {
        try {
            const collection = await getLocationsCollection();
            const doc = await collection.get(locationId);
            const sections = doc.content.sections || [];
            
            const filteredSections = sections.filter(
                (section) => section._id !== childId
            );
            
            await collection.upsert(locationId, { ...doc.content, sections: filteredSections });
            return { ok: 1 };
        } catch (error) {
            console.error("Error removing location child:", error);
            throw error;
        }
    },

    getLocationByParentId: async (parentId) => {
        try {
            const query = `SELECT META(l).id as id, l.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_SCOPE_NAME || "inventory"}\`.Location l WHERE l.parentid = $1`;
            const results = await executeQuery(query, [parentId]);
            return results.map(row => ({
                id: row.id,
                ...row
            }));
        } catch (error) {
            console.error("Error getting locations by parent id:", error);
            throw error;
        }
    },

    addUpdateLocationChild: async (locationId, childId, childData) => {
        try {
            const collection = await getLocationsCollection();
            const doc = await collection.get(locationId);
            const sections = doc.content.sections || [];
            
            const index = sections.findIndex((section) => section.id === childId);
            if (index !== -1) {
                sections[index] = { ...sections[index], ...childData };
            } else {
                sections.push({ "id":childId, ...childData });
            }
            
            await collection.upsert(locationId, { ...doc.content, sections });
            return { ok: 1 };
        } catch (error) {
            console.error("Error updating location child:", error);
            throw error;
        }
    }
}
