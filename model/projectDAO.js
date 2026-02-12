// projectDAO.js - Couchbase Implementation

const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");

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

module.exports = {
    // ...existing code...
    addProject: async (project) => {
      try {
        const projectId = generateProjectId();
        const projectWithMeta = {
          ...project,
          type: "Project",
          createdAt: new Date().toISOString(),
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

      
      const bucketName = process.env.DB_BUCKET_NAME;
      const scopeName = process.env.DB_SCOPE_NAME || "inventory";
      const query = `SELECT META(p).id AS id, p.*\nFROM \`${bucketName}\`.\`${scopeName}\`.\`Project\` AS p\nORDER BY META(p).id DESC;`;
      
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

  assignProjectToUser: async (id, username) => {
    try {
      const collection = await getProjectsCollection();
      const doc = await collection.get(id);
      const assignedto = doc.content.assignedto || [];

      if (!assignedto.includes(username)) {
        assignedto.push(username);
        await collection.upsert(id, { ...doc.content, assignedto });
      }
      return { ok: 1 };
    } catch (error) {
      console.error("Error assigning project to user:", error);
      throw error;
    }
  },

  unassignUserFromProject: async (id, username) => {
    try {
      const collection = await getProjectsCollection();
      const doc = await collection.get(id);
      let assignedto = doc.content.assignedto || [];

      assignedto = assignedto.filter((user) => user !== username);
      await collection.upsert(id, { ...doc.content, assignedto });
      return { ok: 1 };
    } catch (error) {
      console.error("Error unassigning user from project:", error);
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
      let query = `SELECT META(p).id as id, p.* FROM \`${process.env.DB_BUCKET_NAME}\`.${process.env.DB_SCOPE_NAME || "inventory"}.Project p WHERE p.type = 'Project'`;
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

  editProject: async (projectId, newData) => {
    try {
      const collection = await getProjectsCollection();
      const doc = await collection.get(projectId);
      const updatedDoc = { ...doc.content, ...newData };
      await collection.upsert(projectId, updatedDoc);
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
      await collection.upsert(id, { ...doc.content, isdeleted: isVisible });
      return { ok: 1 };
    } catch (error) {
      console.error("Error updating project visibility:", error);
      throw error;
    }
  },

  updateProjectStatus: async (id, isComplete) => {
    try {
      const collection = await getProjectsCollection();
      const doc = await collection.get(id);
      await collection.upsert(id, { ...doc.content, iscomplete: isComplete });
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
      const query = `SELECT META(p).id as id, p.*
        FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_SCOPE_NAME || "inventory"}\`.\`Project\` AS p
        WHERE $1 IN p.assignedto`;

        console.log("Couchbase Query:", query);

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
        _id: childId,
        ...childData,
      });

      await collection.upsert(projectId, { ...doc.content, children });
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
        (child) => child._id !== childId,
      );
      await collection.upsert(projectId, {
        ...doc.content,
        children: filteredChildren,
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
        _id: childId,
        ...childData,
      });

      await collection.upsert(projectId, { ...doc.content, sections });
      return { ok: 1 };
    } catch (error) {
      console.error("Error adding child in single level project:", error);
      throw error;
    }
  },

  removeChildFromSingleLevelProject: async (projectId, childId) => {
    try {
      const collection = await getProjectsCollection();
      const doc = await collection.get(projectId);
      const sections = doc.content.sections || [];

      const filteredSections = sections.filter(
        (section) => section._id !== childId,
      );
      await collection.upsert(projectId, {
        ...doc.content,
        sections: filteredSections,
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

      const index = sections.findIndex((section) => section._id === childId);
      if (index !== -1) {
        sections[index] = { ...sections[index], ...childData };
      } else {
        sections.push({ _id: childId, ...childData });
      }

      await collection.upsert(projectId, { ...doc.content, sections });
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

      const index = children.findIndex((child) => child._id === childId);
      if (index !== -1) {
        children[index] = { ...children[index], ...childData };
      } else {
        children.push({ _id: childId, ...childData });
      }

      await collection.upsert(projectId, { ...doc.content, children });
      return { ok: 1 };
    } catch (error) {
      console.error("Error updating project child:", error);
      throw error;
    }
  },
};
