const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");
const { MutateInSpec } = require("couchbase");

async function getDynamicSectionsCollection() {
    return couchbase.DynamicSections;
}

module.exports = {
    addSection: async (dynamicSection) => {
        const id = uuidv4();
        const collection = await getDynamicSectionsCollection();
        await collection.insert(id, dynamicSection);
        return { insertedId: id, ok: 1 };
    },

    getAllSections: async () => {
        const bucket = process.env.DB_BUCKET_NAME;
        const scope = process.env.DB_SCOPE_NAME;
        const cluster = couchbase.cluster;
        const query = `SELECT META(d).id as id, d.* FROM \`${bucket}\`.\`${scope}\`.DynamicVisualSection d ORDER BY META(d).id DESC LIMIT 50`;
        const result = await cluster.query(query);
        return result.rows;
    },

    getSectionById: async (id) => {
        const collection = await getDynamicSectionsCollection();
        const doc = await collection.get(id);
        // Always ensure 'id' is present in the response
        return { ...doc.content, id };
    },

    editSection: async (id, newData) => {
        const collection = await getDynamicSectionsCollection();
        // Fetch the current document
        const doc = await collection.get(id);
        // Merge newData into the document
        const updatedDoc = { ...doc.content, ...newData };
        // Replace the whole document
        await collection.replace(id, updatedDoc);
        return { modifiedCount: 1, ok: 1 };
    },

    deleteSection: async (id) => {
        const collection = await getDynamicSectionsCollection();
        await collection.remove(id);
        return { deletedCount: 1, ok: 1 };
    },

    getSectionByParentId: async (parentId) => {
        const bucket = process.env.DB_BUCKET_NAME;
        const scope = process.env.DB_SCOPE_NAME || "inventory";
        const cluster = couchbase.cluster;
        const query = `SELECT META(d).id as id, d.* FROM \`${bucket}\`.\`${scope}\`.DynamicVisualSection d WHERE d.parentid = $1`;
        const result = await cluster.query(query, { parameters: [parentId] });
        return result.rows;
    },

    // mutateIn -> whole-doc upsert so writes route through Sync Gateway
    // (see model/sectionDAO.js note).
    addImageInSection: async (sectionId, url) => {
        const collection = await getDynamicSectionsCollection();
        const doc = await collection.get(sectionId);
        const images = Array.isArray(doc.content.images) ? doc.content.images.slice() : [];
        images.push(url);
        await collection.upsert(sectionId, { ...doc.content, images, _id: sectionId });
        return { modifiedCount: 1, ok: 1 };
    },

    removeImageInSection: async (sectionId, url) => {
        const collection = await getDynamicSectionsCollection();
        const doc = await collection.get(sectionId);
        const newImages = (doc.content.images || []).filter(img => img !== url);
        await collection.upsert(sectionId, { ...doc.content, images: newImages, _id: sectionId });
        return { modifiedCount: 1, ok: 1 };
    }
};


