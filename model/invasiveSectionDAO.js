
const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");

// ALL operations use N1QL through the query service. The Capella cluster's KV
// data service is degraded (get/insert/replace time out on port 11207) while
// N1QL is healthy — same conversion as model/user.js, tenantsDAO.js, etc.
// (The KV versions of these functions made the web invasive editor time out, Aug 3.)

const KS = () => {
    const bucket = process.env.DB_BUCKET_NAME;
    const scope = process.env.DB_SCOPE_NAME || "inventory";
    return `\`${bucket}\`.\`${scope}\`.\`InvasiveSection\``;
};

module.exports = {
    addInvasiveSection: async (invasiveSection) => {
        const id = uuidv4();
        const doc = { docType: "InvasiveSection", ...invasiveSection };
        await couchbase.cluster.query(
            `INSERT INTO ${KS()} (KEY, VALUE) VALUES ($1, $2)`,
            { parameters: [id, doc] }
        );
        return { insertedId: id, ok: 1 };
    },
    getAllInvasiveSections: async () => {
        // NOTE: collection is `InvasiveSection` (singular) — the old query hit a
        // non-existent `InvasiveSections` collection and always failed.
        const result = await couchbase.cluster.query(
            `SELECT META(i).id as id, i.* FROM ${KS()} i ORDER BY META(i).id DESC LIMIT 50`
        );
        return result.rows.map(row => {
            const { _id, ...rest } = row;
            return { ...rest, id: row.id };
        });
    },
    getInvasiveSectionById: async (id) => {
        const result = await couchbase.cluster.query(
            `SELECT META(i).id as id, i.* FROM ${KS()} i USE KEYS $1`,
            { parameters: [id] }
        );
        if (!result.rows || !result.rows.length) {
            const err = new Error("document not found");
            err.code = 13; // behaves like DocumentNotFound for callers
            throw err;
        }
        const { _id, ...rest } = result.rows[0];
        return { ...rest, id };
    },
    editInvasiveSection: async (id, newData) => {
        const existing = await couchbase.cluster.query(
            `SELECT i.* FROM ${KS()} i USE KEYS $1`,
            { parameters: [id] }
        );
        if (!existing.rows || !existing.rows.length) {
            return { ok: 0 };
        }
        const { _id, ...current } = existing.rows[0];
        const updatedDoc = { ...current, ...newData };
        await couchbase.cluster.query(
            `UPSERT INTO ${KS()} (KEY, VALUE) VALUES ($1, $2)`,
            { parameters: [id, updatedDoc] }
        );
        return { ok: 1 };
    },
    deleteInvasiveSection: async (id) => {
        await couchbase.cluster.query(
            `DELETE FROM ${KS()} USE KEYS $1`,
            { parameters: [id] }
        );
        return { ok: 1 };
    },
    getInvasiveSectionByParentId: async (parentId) => {
        const result = await couchbase.cluster.query(
            `SELECT META(i).id as id, i.* FROM ${KS()} i WHERE i.parentid = $1`,
            { parameters: [parentId] }
        );
        return result.rows.map(row => {
            const { _id, ...rest } = row;
            return { ...rest, id: row.id };
        });
    },
};
