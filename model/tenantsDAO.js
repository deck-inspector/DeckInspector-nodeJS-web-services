const couchbase = require("../database/couchbase");
const { v4: uuidv4 } = require("uuid");

// Helper function to generate tenant ID
function generateTenantId() {
  return `${uuidv4()}`;
}

// Helper to get Tenants collection
async function getTenantsCollection() {
  return couchbase.Tenants;
}

// Helper to execute N1QL queries
async function executeQuery(statement, parameters = []) {
  try {
    const cluster = couchbase.cluster;
    const result = await cluster.query(statement, { parameters });
    return result.rows;
  } catch (error) {
    console.error("Query execution error:", error);
    throw error;
  }
}

module.exports = {
  addTenant: async (tenant) => {
    try {
      const tenantId = generateTenantId();
      const tenantWithId = {
        ...tenant,
        type: "Tenant",
        docType: "Tenant",
        createdAt: new Date().toISOString(),
      };
      const collection = await getTenantsCollection();
      await collection.insert(tenantId, tenantWithId);
      return { insertedId: tenantId, ok: 1 };
    } catch (error) {
      console.error("Error adding tenant:", error);
      throw error;
    }
  },

  diskLimitreaching: async (id) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      const tenant = doc.content;
      if (tenant.allowedDiskSpace - tenant.usedDiskSpace <= 5) {
        return { isLimitreaching: true };
      } else {
        return { isLimitreaching: false };
      }
    } catch (error) {
      console.error("Error checking disk limit:", error);
      throw error;
    }
  },

  getAllTenants: async () => {
    try {
      const query = `SELECT META(p).id AS id, p.*\nFROM \`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.\`Tenants\` AS p\nORDER BY META(p).id DESC;`;
            
      return await executeQuery(query);
    } catch (error) {
      console.error("Error getting all tenants:", error);
      throw error;
    }
  },

  getTenantById: async (id) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      const tenant = doc.content;
      // Exclude files field
      const { files, ...tenantWithoutFiles } = tenant;
      tenantWithoutFiles.id = id;
      return tenantWithoutFiles;
    } catch (error) {
      if (error.code === 13) {
        // Document not found
        return null;
      }
      console.error("Error getting tenant by id:", error);
      throw error;
    }
  },

  getTenantByCompanyIdentifier: async (companyIdentifier) => {
    try {
      const query = `SELECT META(t).id as id, t.* FROM \`${process.env.DB_BUCKET_NAME}\`.${
        process.env.DB_PROD_SCOPE_NAME || "inventory"
      }.Tenants t 
                          WHERE t.companyIdentifier = $1 
                          LIMIT 1`;
      const results = await executeQuery(query, [companyIdentifier]);
      if (results && results.length > 0) {
        const tenant = results[0];
        const { files, ...tenantWithoutFiles } = tenant;
        return tenantWithoutFiles;
      }
      return null;
    } catch (error) {
      console.error("Error getting tenant by company identifier:", error);
      throw error;
    }
  },

  addTenantDiskSpace: async (id, space) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      doc.content.allowedDiskSpace = space;
      await collection.upsert(id, doc.content);
      return { ok: 1 };
    } catch (error) {
      console.error("Error adding tenant disk space:", error);
      throw error;
    }
  },

  addTenantUsedDiskSpace: async (id, space) => {
    try {
      console.log("Image size:", space);
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      doc.content.usedDiskSpace = (doc.content.usedDiskSpace || 0) + parseFloat(space);
      await collection.upsert(id, doc.content);
      return { ok: 1 };
    } catch (error) {
      console.error("Error adding used disk space:", error);
      throw error;
    }
  },

  increaseTenantValidity: async (id, days) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      doc.content.validity = (doc.content.validity || 0) + parseFloat(days);
      await collection.upsert(id, doc.content);
      return { ok: 1 };
    } catch (error) {
      console.error("Error increasing tenant validity:", error);
      throw error;
    }
  },

  increaseTenantUsers: async (id, count) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      doc.content.allowedUsersCount = count;
      await collection.upsert(id, doc.content);
      return { ok: 1 };
    } catch (error) {
      console.error("Error increasing tenant users:", error);
      throw error;
    }
  },

  increaseAllowedCustomForms: async (id, count) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      doc.content.allowedCustomFormCount = count;
      await collection.upsert(id, doc.content);
      return { ok: 1 };
    } catch (error) {
      console.error("Error increasing custom forms:", error);
      throw error;
    }
  },

  addCustomFormCount: async (id) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      doc.content.customFormCount = (doc.content.customFormCount || 0) + 1;
      await collection.upsert(id, doc.content);
      return { ok: 1 };
    } catch (error) {
      console.error("Error adding custom form count:", error);
      throw error;
    }
  },

  updateStorageStats: async (identifier, count, size) => {
    try {
      const collection = await getTenantsCollection();
      const query = `SELECT META(t).id as id, t.* FROM \`${process.env.DB_BUCKET_NAME}\`.${
        process.env.DB_PROD_SCOPE_NAME || "inventory"
      }.Tenants t 
                          WHERE t.companyIdentifier = $1 
                          LIMIT 1`;
      const results = await executeQuery(query, [identifier]);
      if (results && results.length > 0) {
        const tenantId = results[0].id;
        const doc = await collection.get(tenantId);
        doc.content.imageCount = (doc.content.imageCount || 0) + parseFloat(count);
        doc.content.usedDiskSpace = (doc.content.usedDiskSpace || 0) + parseFloat(size);
        await collection.upsert(tenantId, doc.content);
        return { ok: 1 };
      }
      return { ok: 0 };
    } catch (error) {
      console.error("Error updating storage stats:", error);
      throw error;
    }
  },

  editTenant: async (id, newData) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      const updatedContent = { ...doc.content, ...newData };
      await collection.upsert(id, updatedContent);
      return { ok: 1 };
    } catch (error) {
      console.error("Error editing tenant:", error);
      throw error;
    }
  },

  toggleTenantAccess: async (id, isActive) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      doc.content.isActive = isActive;
      await collection.upsert(id, doc.content);
      return { ok: 1 };
    } catch (error) {
      console.error("Error toggling tenant access:", error);
      throw error;
    }
  },

  toggleShowFooterlogo: async (id, value) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      doc.content.showFooterlogo = value;
      await collection.upsert(id, doc.content);
      return { ok: 1 };
    } catch (error) {
      console.error("Error toggling footer logo:", error);
      throw error;
    }
  },

  deleteTenantPermanently: async (id) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      const tenant = doc.content;

      // Delete users associated with this tenant
      try {
        const usersQuery = `DELETE FROM \`${process.env.DB_BUCKET_NAME}\`.${
          process.env.DB_PROD_SCOPE_NAME || "inventory"
        }.Users u 
                                   WHERE u.companyIdentifier = $1`;
        await executeQuery(usersQuery, [tenant.companyIdentifier]);
      } catch (error) {
        console.log("Error deleting users:", error);
      }

      // Delete the tenant
      await collection.remove(id);
      return { ok: 1 };
    } catch (error) {
      console.error("Error deleting tenant permanently:", error);
      throw error;
    }
  },

  deleteTenant: async (id) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      const tenant = doc.content;

      // Delete users associated with this tenant
      try {
        const usersQuery = `DELETE FROM \`${process.env.DB_BUCKET_NAME}\`.${
          process.env.DB_PROD_SCOPE_NAME || "inventory"
        }.Users u 
                                   WHERE u.companyIdentifier = $1`;
        await executeQuery(usersQuery, [tenant.companyIdentifier]);
      } catch (error) {
        console.log("Error deleting users:", error);
      }

      // Mark tenant as deleted
      doc.content.isDeleted = true;
      await collection.upsert(id, doc.content);
      return { ok: 1 };
    } catch (error) {
      console.error("Error deleting tenant:", error);
      throw error;
    }
  },

  updateAddIconsForTenant: async (id, iconsData) => {
    try {
      // KV get/upsert times out against the degraded data service; write
      // through the healthy query service instead (same pattern as the other
      // KV->N1QL conversions).
      const query = `UPDATE \`${couchbase.DB_BUCKET_NAME}\`.\`${process.env.DB_PROD_SCOPE_NAME || "inventory"}\`.Tenants AS t USE KEYS $1 SET t.icons = $2`;
      await executeQuery(query, [id, iconsData]);
      return { ok: 1 };
    } catch (error) {
      console.error("Error updating icons:", error);
      throw error;
    }
  },

  updateAdminDetails: async (id, adminDetails) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      if (!doc.content.adminDetails) {
        doc.content.adminDetails = [];
      }
      doc.content.adminDetails.push(adminDetails);
      await collection.upsert(id, doc.content);
      return { ok: 1 };
    } catch (error) {
      console.error("Error updating admin details:", error);
      throw error;
    }
  },

  updateTenantPhone: async (id, phone) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      doc.content.phone = phone;
      await collection.upsert(id, doc.content);
      return { ok: 1 };
    } catch (error) {
      console.error("Error updating tenant phone:", error);
      throw error;
    }
  },

  // Branded email signature used by the web app's Outlook drafts
  // (company line, phone, website, color, logoUrl) - David, Aug 17.
  updateTenantSignature: async (id, signature) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      doc.content.signature = signature;
      await collection.upsert(id, doc.content);
      return { ok: 1 };
    } catch (error) {
      console.error("Error updating tenant signature:", error);
      throw error;
    }
  },

  updateTenantLogo: async (id, logoURL) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      if (!doc.content.icons) {
        doc.content.icons = {};
      }
      doc.content.icons.logoUrl = logoURL;
      await collection.upsert(id, doc.content);
      return { ok: 1 };
    } catch (error) {
      console.error("Error updating tenant logo:", error);
      throw error;
    }
  },

  updateEndDate: async (id, endDate) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      doc.content.endDate = endDate;
      await collection.upsert(id, doc.content);
      return { ok: 1 };
    } catch (error) {
      console.error("Error updating end date:", error);
      throw error;
    }
  },

  updateTenantWebsite: async (id, website) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      doc.content.website = website;
      await collection.upsert(id, doc.content);
      return { ok: 1 };
    } catch (error) {
      console.error("Error updating tenant website:", error);
      throw error;
    }
  },

  updateTenantsAzureStorageDataDetails: async (id, azureStorageDetails) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      doc.content.azureStorageDetails = azureStorageDetails;
      await collection.upsert(id, doc.content);
      return { ok: 1 };
    } catch (error) {
      console.error("Error updating azure storage details:", error);
      throw error;
    }
  },

  updateTenantExpenses: async (id, expense) => {
    try {
      const collection = await getTenantsCollection();
      const doc = await collection.get(id);
      doc.content.expenses = expense;
      await collection.upsert(id, doc.content);
      return { ok: 1 };
    } catch (error) {
      console.error("Error updating tenant expenses:", error);
      throw error;
    }
  },

  isTenantActive: async (identifier) => {
    try {
      const query = `SELECT META(t).id as id, t.* FROM \`${process.env.DB_BUCKET_NAME}\`.${
        process.env.DB_PROD_SCOPE_NAME || "inventory"
      }.Tenants t 
                          WHERE t.companyIdentifier = $1 
                          LIMIT 1`;
      const results = await executeQuery(query, [identifier]);
      if (results && results.length > 0) {
        const tenant = results[0];
        return {
          success: true,
          allowLogin: tenant.isActive !== false && tenant.isDeleted !== true,
          Tenant: tenant,
        };
      }
      return { success: false, allowLogin: false };
    } catch (error) {
      console.error("Error checking tenant active status:", error);
      return { success: false, allowLogin: false };
    }
  },
};
