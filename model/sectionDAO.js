
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
        // Mobile VisualSection.fromJson reads body `_id` - required.
        await collection.insert(id, { ...section, _id: id });
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
        // Merge newData into the document. Self-heal: always (re)stamp _id
        // (the mobile app parses body._id).
        const updatedDoc = { ...doc.content, ...newData, _id: id };
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
    // Photo attach/remove rewritten from mutateIn to whole-doc upsert so the
    // write routes through Sync Gateway (mutateIn is SDK-only and its writes
    // never reached phones - SGW CE has no import).
    addImageInSection: async (sectionId, url) => {
        const collection = await getSectionsCollection();
        const doc = await collection.get(sectionId);
        const images = Array.isArray(doc.content.images) ? doc.content.images.slice() : [];
        images.push(url);
        await collection.upsert(sectionId, { ...doc.content, images, _id: sectionId });
        return { ok: 1 };
    },
    removeImageInSection: async (sectionId, url) => {
        const collection = await getSectionsCollection();
        const doc = await collection.get(sectionId);
        const newImages = (doc.content.images || []).filter(img => img !== url);
        await collection.upsert(sectionId, { ...doc.content, images: newImages, _id: sectionId });
        return { ok: 1 };
    }
};


