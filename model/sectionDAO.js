
const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");
const { MutateInSpec } = require("couchbase");

async function getSectionsCollection() {
    return couchbase.Sections;
}

module.exports = {
    addSection: async (section) => {
        const id = uuidv4();
        const collection = await getSectionsCollection();
        await collection.insert(id, section);
        return { insertedId: id, ok: 1 };
    },
    getAllSections: async () => {
        const bucket = process.env.DB_BUCKET_NAME;
        const scope = process.env.DB_SCOPE_NAME || "inventory";
        const cluster = couchbase.cluster;
        const query = `SELECT META(s).id as id, s.* FROM \`${bucket}\`.\`${scope}\`.Sections s LIMIT 50`;
        const result = await cluster.query(query);
        return result.rows;
    },
    getSectionById: async (id) => {
        const collection = await getSectionsCollection();
        const doc = await collection.get(id);
        // Always ensure 'id' is present in the response
        return { ...doc.content, id };
    },
        editSection: async (id, newData) => {
        const collection = await getSectionsCollection();
        // Fetch the current document
        const doc = await collection.get(id);
        // Merge newData into the document
        const updatedDoc = { ...doc.content, ...newData };
        // Replace the whole document
        await collection.replace(id, updatedDoc);
        return { ok: 1 };
    },
    deleteSection: async (id) => {
        const collection = await getSectionsCollection();
        await collection.remove(id);
        return { ok: 1 };
    },
    getSectionByParentId: async (parentId) => {
        const bucket = process.env.DB_BUCKET_NAME;
        const scope = process.env.DB_SCOPE_NAME || "inventory";
        const cluster = couchbase.cluster;
        const query = `SELECT META(s).id as id, s.* FROM \`${bucket}\`.\`${scope}\`.Sections s WHERE s.parentid = $1`;
        const result = await cluster.query(query, { parameters: [parentId] });
        return result.rows;
    },
    addImageInSection: async (sectionId, url) => {
        const collection = await getSectionsCollection();
        await collection.mutateIn(sectionId, [
            MutateInSpec.arrayAppend("images", url)
        ]);
        return { ok: 1 };
    },
    removeImageInSection: async (sectionId, url) => {
        const collection = await getSectionsCollection();
        const doc = await collection.get(sectionId);
        const newImages = (doc.content.images || []).filter(img => img !== url);
        await collection.mutateIn(sectionId, [
            MutateInSpec.replace("images", newImages)
        ]);
        return { ok: 1 };
    }
};


