
const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");

async function getInvasiveSectionsCollection() {
    return couchbase.InvasiveSections;
}

module.exports = {
    addInvasiveSection: async (invasiveSection) => {
        const id = uuidv4();
        const collection = await getInvasiveSectionsCollection();
        await collection.insert(id, invasiveSection);
        return { insertedId: id, ok: 1 };
    },
    getAllInvasiveSections: async () => {
        const bucket = process.env.DB_BUCKET_NAME;
        const scope = process.env.DB_SCOPE_NAME || "inventory";
        const cluster = couchbase.cluster;
        const query = `SELECT META(i).id as id, i.* FROM \`${bucket}\`.\`${scope}\`.InvasiveSections i ORDER BY META(i).id DESC LIMIT 50`;
        const result = await cluster.query(query);
        // Remove _id from each result, ensure id is present
        return result.rows.map(row => {
            const { _id, ...rest } = row;
            return { ...rest, id: row.id };
        });
    },
    getInvasiveSectionById: async (id) => {
        const collection = await getInvasiveSectionsCollection();
        const doc = await collection.get(id);
        const { _id, ...rest } = doc.content;
        return { ...rest, id };
    },
    editInvasiveSection: async (id, newData) => {
        const collection = await getInvasiveSectionsCollection();
        const doc = await collection.get(id);
        const updatedDoc = { ...doc.content, ...newData };
        await collection.replace(id, updatedDoc);
        return { ok: 1 };
    },
    deleteInvasiveSection: async (id) => {
        const collection = await getInvasiveSectionsCollection();
        await collection.remove(id);
        return { ok: 1 };
    },
    getInvasiveSectionByParentId: async (parentId) => {
        const bucket = process.env.DB_BUCKET_NAME;
        const scope = process.env.DB_SCOPE_NAME || "inventory";
        const cluster = couchbase.cluster;
        const query = `SELECT META(i).id as id, i.* FROM \`${bucket}\`.\`${scope}\`.InvasiveSection i WHERE i.parentid = $1`;
        const result = await cluster.query(query, { parameters: [parentId] });
        // Remove _id from each result, ensure id is present
        return result.rows.map(row => {
            const { _id, ...rest } = row;
            return { ...rest, id: row.id };
        });
    },
};