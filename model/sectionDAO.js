
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
        const query = `SELECT META(s).id as id, s.* FROM \`${bucket}\`.\`${scope}\`.VisualSection s LIMIT 50`;
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
        const query = `SELECT META(s).id as id, s.* FROM \`${bucket}\`.\`${scope}\`.VisualSection s WHERE s.parentid = $1`;
        const result = await cluster.query(query, { parameters: [parentId] });
        return result.rows;
    },
    // Persist the display/report position of a section on the section document
    // itself, so getSectionByParentId can return an ordered list. The parent
    // document's own sections array is reordered separately (that array is what
    // the report generator walks) - both are kept in step by
    // sectionService.reorderSections.
    // ⚠️ N1QL, not KV: this cluster's key-value service intermittently returns
    // "unambiguous timeout" while the query service stays healthy (a KV
    // mutateIn here failed in production on Aug 17). One statement sets every
    // section's position, so a reorder is a single round trip that either
    // lands or doesn't - no half-written order.
    setSequenceNos: async (orderedIds) => {
        const ids = (Array.isArray(orderedIds) ? orderedIds : []).map(String).filter(Boolean);
        if (!ids.length) return { ok: 1, updated: 0 };
        const bucket = process.env.DB_BUCKET_NAME;
        const scope = process.env.DB_SCOPE_NAME || "inventory";
        const cluster = couchbase.cluster;
        const cases = ids.map((id, index) => `WHEN $id${index} THEN ${index}`).join(" ");
        const params = { ids };
        ids.forEach((id, index) => { params[`id${index}`] = id; });
        const query = `UPDATE \`${bucket}\`.\`${scope}\`.VisualSection s USE KEYS $ids ` +
            `SET s.sequenceNo = CASE META(s).id ${cases} ELSE s.sequenceNo END ` +
            `RETURNING META(s).id`;
        const result = await cluster.query(query, { parameters: params });
        return { ok: 1, updated: (result.rows || []).length };
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


