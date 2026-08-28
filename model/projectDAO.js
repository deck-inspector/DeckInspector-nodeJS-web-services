// projectDAO.js - Couchbase Implementation

const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");
const { orderSectionsByIds } = require("./sectionOrder");

// Helper function to generate document IDs
function generateProjectId() {
  return `${uuidv4()}`;
}

// Helper function to get Projects collection
async function getProjectsCollection() {
  return couchbase.Projects;
}

// Helper function to execute N1QL queries
async function executeQuery(statement, parameters = []) {
  try {
    const cluster = couchbase.cluster;
    const bucket = couchbase.bucket;
    
    
    if (!cluster) {
      throw new Error("Cluster connection not initialized. Make sure connectToDatabase() was called.");
    }
    
    if (!bucket) {
      throw new Error("Bucket not initialized. Make sure connectToDatabase() was called.");
    }
    
    const result = await cluster.query(statement, { parameters });
    return result.rows;
  } catch (error) {
    console.error("Query execution error:", error);
    console.error("Error message:", error.message);
    console.error("Error code:", error.code);
    console.error("Full error object:", JSON.stringify(error, null, 2));
    throw error;
  }
}


// Read/write a full Project doc through the QUERY service (KV-free).
// getProjectDocByKey returns the doc content (no META wrapper) or null.
async function getProjectDocByKey(id) {
  const rows = await executeQuery(
    `SELECT p.* FROM \`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.\`Project\` AS p USE KEYS $1`,
    [id]
  );
  return rows.length ? rows[0] : null;
}
async function upsertProjectDoc(id, doc) {
  // Was a N1QL UPSERT (KV-timeout era); now a collection upsert so the write
  // routes through Sync Gateway (see database/sgwWrite.js) and phones receive
  // project edits (children[], status, dates). _id kept for mobile parsers.
  doc = { ...doc, _id: id };
  const collection = await getProjectsCollection();
  await collection.upsert(id, doc);
  return { ok: 1 };
}

module.exports = {
    // ...existing code...
    addProject: async (project) => {
      try {
        const projectId = generateProjectId();
        const projectWithMeta = {
          ...project,
          // Mobile Project.fromJson reads body `_id` - required (see upsertProjectDoc).
          _id: projectId,
          docType: "Project",
          createdAt: new Date().toISOString(),
          channels: ["Project"],
        };
        const collection = await getProjectsCollection();
        await collection.insert(projectId, projectWithMeta);
        return { insertedId: projectId, success: true };
      } catch (error) {
        console.error("Error adding project:", error);
        throw error;
      }
    },

  getAllProjects: async () => {
    try {
      const query = `SELECT META(p).id AS id, p.*\nFROM \`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.\`Project\` AS p\nORDER BY META(p).id DESC;`;
      
      const results = await executeQuery(query);

      
      const mappedResults = results.map(row => ({
        _id: row.id,
        ...row
      }));
      return mappedResults;
    } catch (error) {
      console.error("Error getting all projects:", error);
      throw error;
    }
  },

 getProjectById: async (id) => {
  try {
    const collection = await getProjectsCollection();
    console.log(`Fetching project with ID: ${id}`);
    const doc = await collection.get(id);
    console.log("Couchbase getProjectById result:", doc);
    console.log("Project document content:", doc.content);
    // Return without files field, and always include _id
    const { files, ...docWithoutFiles } = doc.content;
    return {
      ...docWithoutFiles,
      id: id,
    };
  } catch (error) {
    if (error.code === 13) {
      // Document not found
      return null;
    }
    console.error("Error getting project by id:", error);
    throw error;
  }
},

  // N1QL only (Aug 17): assignment must RELIABLY reach the database because
  // Sync Gateway imports every Project write and the inspectors' phones sync
  // from it - a KV timeout here silently breaks web AND mobile assignment.
  assignProjectToUser: async (id, username) => {
    try {
      const doc = await getProjectDocByKey(id);
      if (!doc) throw new Error(`Project not found: ${id}`);
      const assignedto = doc.assignedto || [];
      if (!assignedto.includes(username)) {
        assignedto.push(username);
        await upsertProjectDoc(id, { ...doc, assignedto, channels: doc.channels || ["Project"] });
      }
      return { ok: 1 };
    } catch (error) {
      console.error("Error assigning project to user:", error);
      throw error;
    }
  },

  unassignUserFromProject: async (id, username) => {
    try {
      const doc = await getProjectDocByKey(id);
      if (!doc) throw new Error(`Project not found: ${id}`);
      let assignedto = doc.assignedto || [];
      assignedto = assignedto.filter(u => u !== username);
      await upsertProjectDoc(id, { ...doc, assignedto, channels: doc.channels || ["Project"] });
      return { ok: 1 };
    } catch (error) {
      console.error("Error unassigning project from user:", error);
      throw error;
    }
  },

  getProjectsByNameCreatedOnIsCompletedAndDeleted: async function ({
    name = null,
    createdon = null,
    iscomplete = false,
    isdeleted = false,
  } = {}) {
    try {
      let query = `SELECT META(p).id as id, p.* FROM \`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.Project p WHERE p.type = 'Project'`;
      const params = [];

      if (name !== null) {
        query += ` AND p.name = $${params.length + 1}`;
        params.push(name);
      }
      if (createdon !== null) {
        query += ` AND p.createdon = $${params.length + 1}`;
        params.push(createdon);
      }
      query += ` AND p.iscomplete = $${params.length + 1}`;
      params.push(iscomplete);
      query += ` AND p.isdeleted = $${params.length + 1}`;
      params.push(isdeleted);

      query += ` ORDER BY p.editedat DESC LIMIT 25`;

      const results = await executeQuery(query, params);
      return results.map(row => ({
        id: row.id,
        ...row
      }));
    } catch (error) {
      console.error("Error getting projects by filters:", error);
      throw error;
    }
  },

  // N1QL only (Aug 17) - same reliability reasoning as assignProjectToUser.
  // Merge semantics preserved: newData fields overlay the stored doc.
  editProject: async (projectId, newData) => {
    try {
      const doc = await getProjectDocByKey(projectId);
      if (!doc) throw new Error(`Project not found: ${projectId}`);
      const updatedDoc = { ...doc, ...newData };
      await upsertProjectDoc(projectId, { ...updatedDoc, channels: doc.channels || ["Project"] });
      return { ok: 1 };
    } catch (error) {
      console.error("Error editing project:", error);
      throw error;
    }
  },

  updateProjectVisibilityStatus: async (id, isVisible) => {
    try {
      const collection = await getProjectsCollection();
      const doc = await collection.get(id);
      await collection.upsert(id, { ...doc.content, isdeleted: isVisible, channels: doc.content.channels || ["Project"] });
      return { ok: 1 };
    } catch (error) {
      console.error("Error updating project visibility:", error);
      throw error;
    }
  },

  updateProjectStatus: async (id, isComplete) => {
    try {
      // N1QL UPDATE instead of KV get+upsert: the KV data service times out
      // intermittently while the query service stays responsive (the original
      // cause of failing complete/reopen toggles). Touches only iscomplete and
      // keeps the channels default the old code maintained for mobile sync.
      // Completing a project also ends any Final Inspection After Repairs
      // cycle (Aug 18): the blue re-inspection flag is cleared in the same
      // UPDATE so the card returns to plain Complete. Reopening keeps it.
      const query = `UPDATE \`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.\`Project\` AS p USE KEYS $1 SET p.iscomplete = $2, p.finalinspection = CASE WHEN $2 THEN false ELSE IFMISSING(p.finalinspection, false) END, p.channels = IFMISSINGORNULL(p.channels, ["Project"]) RETURNING META(p).id`;
      const rows = await executeQuery(query, [id, isComplete]);
      if (!rows || rows.length === 0) {
        throw new Error("No project found with id " + id);
      }
      return { ok: 1 };
    } catch (error) {
      console.error("Error updating project status:", error);
      throw error;
    }
  },

  deleteProjectPermanently: async (id) => {
    try {
      const collection = await getProjectsCollection();
      await collection.remove(id);
      return { ok: 1 };
    } catch (error) {
      console.error("Error deleting project:", error);
      throw error;
    }
  },

  getAllFilesOfProject: async (id) => {
    try {
      const collection = await getProjectsCollection();
      const doc = await collection.get(id);
      return { files: doc.content.files || [] };
    } catch (error) {
      console.error("Error getting project files:", error);
      throw error;
    }
  },

  getProjectByAssignedToUserId: async (userId) => {
    try {
      console.log("=== Debug Query Parameters ===");
      console.log("Bucket:", couchbase.DB_BUCKET_NAME);
      console.log("Scope:", couchbase.DB_SCOPE_NAME);
      console.log("UserId:", userId);
      
      const query = `SELECT META(p).id as id, p.*
        FROM \`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.\`Project\` AS p
        WHERE $1 IN p.assignedto`;

      console.log("Generated Query:", query);
      console.log("=============================");

      const results = await executeQuery(query, [userId]);
      console.log("Couchbase Query Results:", results);
      return results.map(row => ({
        id: row.id,
        ...row
      }));
    } catch (error) {
      console.error("Error getting projects by assigned user:", error);
      throw error;
    }
  },

  addProjectChild: async (projectId, childId, childData) => {
    try {
      const collection = await getProjectsCollection();
      const doc = await collection.get(projectId);
      const children = doc.content.children || [];

      children.push({
        id: childId,
        ...childData,
      });

      await collection.upsert(projectId, { ...doc.content, children, channels: doc.content.channels || ["Project"] });
      return { ok: 1 };
    } catch (error) {
      console.error("Error adding project child:", error);
      throw error;
    }
  },

  removeProjectChild: async (projectId, childId) => {
    try {
      const collection = await getProjectsCollection();
      const doc = await collection.get(projectId);
      const children = doc.content.children || [];

      const filteredChildren = children.filter(
        (child) => child.id !== childId,
      );
      await collection.upsert(projectId, {
        ...doc.content,
        children: filteredChildren,
        channels: doc.content.channels || ["Project"],
      });
      return { ok: 1 };
    } catch (error) {
      console.error("Error removing project child:", error);
      throw error;
    }
  },

  addChildInSingleLevelProject: async (projectId, childId, childData) => {
    try {
      const collection = await getProjectsCollection();
      const doc = await collection.get(projectId);
      const sections = doc.content.sections || [];

      sections.push({
        id: childId,
        ...childData,
      });

      await collection.upsert(projectId, { ...doc.content, sections, channels: doc.content.channels || ["projects"] });
      return { ok: 1 };
    } catch (error) {
      console.error("Error adding child in single level project:", error);
      throw error;
    }
  },

  // Single-level projects hang sections directly off the project document.
  // Same contract as locationDAO.reorderLocationChildren: array order is report
  // order, unnamed children are preserved at the end.
  // ⚠️ N1QL only — KV get+upsert times out intermittently on this cluster
  // (see locationDAO.reorderLocationChildren). channels is preserved for
  // mobile sync via IFMISSINGORNULL, same as updateProjectStatus.
  reorderSingleLevelProjectChildren: async (projectId, orderedIds) => {
    try {
      const bucket = couchbase.DB_BUCKET_NAME || process.env.DB_BUCKET_NAME;
      const scope = couchbase.DB_SCOPE_NAME || process.env.DB_SCOPE_NAME || "inventory";

      const found = await executeQuery(
        `SELECT p.sections FROM \`${bucket}\`.\`${scope}\`.\`Project\` AS p USE KEYS $1`,
        [projectId]
      );
      if (!found.length) {
        throw new Error(`Project not found: ${projectId}`);
      }

      const reordered = orderSectionsByIds(found[0].sections || [], orderedIds);
      await executeQuery(
        `UPDATE \`${bucket}\`.\`${scope}\`.\`Project\` AS p USE KEYS $1 ` +
        `SET p.sections = $2, p.channels = IFMISSINGORNULL(p.channels, ["Project"])`,
        [projectId, reordered]
      );
      return { ok: 1, sections: reordered };
    } catch (error) {
      console.error("Error reordering single level project children:", error);
      throw error;
    }
  },

  removeChildFromSingleLevelProject: async (projectId, childId) => {
    try {
      const collection = await getProjectsCollection();
      const doc = await collection.get(projectId);
      const sections = doc.content.sections || [];

      const filteredSections = sections.filter(
        (section) => section.id !== childId,
      );
      await collection.upsert(projectId, {
        ...doc.content,
        sections: filteredSections,
        channels: doc.content.channels || ["Project"],
      });
      return { ok: 1 };
    } catch (error) {
      console.error("Error removing child from single level project:", error);
      throw error;
    }
  },

  addUpdateChildInSingleLevelProject: async (projectId, childId, childData) => {
    try {
      const collection = await getProjectsCollection();
      const doc = await collection.get(projectId);
      const sections = doc.content.sections || [];

      const index = sections.findIndex((section) => section.id === childId);
      if (index !== -1) {
        sections[index] = { ...sections[index], ...childData };
      } else {
        sections.push({ id: childId, ...childData });
      }

      await collection.upsert(projectId, { ...doc.content, sections, channels: doc.content.channels || ["Project"] });
      return { ok: 1 };
    } catch (error) {
      console.error("Error updating child in single level project:", error);
      throw error;
    }
  },

  addUpdateProjectChild: async (projectId, childId, childData) => {
    try {
      const collection = await getProjectsCollection();
      const doc = await collection.get(projectId);
      const children = doc.content.children || [];

      const index = children.findIndex((child) => child.id === childId);
      if (index !== -1) {
        children[index] = { ...children[index], ...childData };
      } else {
        children.push({ id: childId, ...childData });
      }

      await collection.upsert(projectId, { ...doc.content, children, channels: doc.content.channels || ["Project"] });
      return { ok: 1 };
    } catch (error) {
      console.error("Error updating project child:", error);
      throw error;
    }
  },
};