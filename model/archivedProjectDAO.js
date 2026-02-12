// projectDAO.js

const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");

async function getArchivedProjectsCollection() {
  return couchbase.ArchivedProjects;
}

module.exports = {
    addArchivedProject: async (project) => {
  const id = uuidv4();
  const collection = await getArchivedProjectsCollection();
  await collection.insert(id, project);
  return { insertedId: id, ok: 1 };
},
    getAllArchivedProjects: async () => {
  const cluster = couchbase.cluster;
  const bucket = process.env.DB_BUCKET_NAME;
  const scope = process.env.DB_SCOPE_NAME || "inventory";
  const query = `SELECT META(a).id as id, a.* FROM \`${bucket}\`.\`${scope}\`.ArchivedProjects a ORDER BY META(a).id DESC`;
  const result = await cluster.query(query);
  return result.rows;
},
    getArchivedProjectById: async (id) => {
  const collection = await getArchivedProjectsCollection();
  const doc = await collection.get(id);
  return { ...doc.content, id };
},   
};
