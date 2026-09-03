"use strict";
const TenantDAO = require("../model/tenantsDAO");

var addTenant = async function (tenant) {
  try {
    const result = await TenantDAO.addTenant(tenant);
    if (result.ok === 1) {
      return {
        success: true,
        id: tenant.id || result.id,
      };
    }
    return {
      code: 500,
      success: false,
      reason: "Insertion failed",
    };
  } catch (error) {
    return handleError(error);
  }
};

var getTenantById = async function (tenantId) {
  try {
    const result = await TenantDAO.getTenantById(tenantId);
    if (result) {
      return {
        success: true,
        Tenant: result,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

var getTenantByCompanyIdentifier = async function (companyIdentifier) {
  try {
    const result = await TenantDAO.getTenantByCompanyIdentifier(
      companyIdentifier
    );
    if (result) {
      return {
        success: true,
        Tenant: result,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

var deleteTenantPermanently = async function (tenantId) {
  try {
    const result = await TenantDAO.deleteTenantPermanently(tenantId);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};
var getAllTenants = async function () {
  try {
    const result = await TenantDAO.getAllTenants();
    if (result) {
      return {
        success: true,
        Tenants: result,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found",
    };
  } catch (error) {
    return handleError(error);
  }
};

var editTenant = async function (tenantId, newData) {
  try {
    const result = await TenantDAO.editTenant(tenantId, newData);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

var restoreTenant = async function (tenantId) {
  try {
    const result = await TenantDAO.restoreTenant(tenantId);
    if (result.ok === 1) {
      return { success: true };
    }
    return { code: 401, success: false, reason: "No Tenant found with the given ID" };
  } catch (error) {
    return handleError(error);
  }
};

var deleteTenant = async function (tenantId) {
  try {
    const result = await TenantDAO.deleteTenant(tenantId);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

var addDiskSpace = async function (tenantId, space) {
  try {
    const result = await TenantDAO.addTenantDiskSpace(tenantId, space);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "failed to add space to give tenant/or tenant not found.",
    };
  } catch (error) {
    return handleError(error);
  }
};

var addUsedDiskSpace = async function (tenantId, space) {
  try {
    const result = await TenantDAO.addTenantUsedDiskSpace(tenantId, space);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "failed to add space to give tenant/or tenant not found.",
    };
  } catch (error) {
    return handleError(error);
  }
};

var increaseTenantValidity = async function (tenantId, days) {
  try {
    const result = await TenantDAO.increaseTenantValidity(tenantId, days);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "failed to add days to validity/or tenant not found.",
    };
  } catch (error) {
    return handleError(error);
  }
};
var increaseTenantUsers = async function (tenantId, count) {
  try {
    const result = await TenantDAO.increaseTenantUsers(tenantId, count);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "failed to increase users  to validity/or tenant not found.",
    };
  } catch (error) {
    return handleError(error);
  }
};

var addCustomFormCount = async function (tenantId) {
  try {
    const result = await TenantDAO.addCustomFormCount(tenantId);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "failed to increment usedforms /or tenant not found.",
    };
  } catch (error) {
    return handleError(error);
  }
};
var increaseAllowedCustomForms = async function (tenantId, count) {
  try {
    const result = await TenantDAO.increaseAllowedCustomForms(tenantId, count);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "failed to increase allowedform count/or tenant not found.",
    };
  } catch (error) {
    return handleError(error);
  }
};
var updateStorageStats = async function (companyIdentifier, count, fileSize) {
  try {
    const result = await TenantDAO.updateStorageStats(
      companyIdentifier,
      count,
      fileSize
    );
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "failed to increase image count/or tenant not found.",
    };
  } catch (error) {
    return handleError(error);
  }
};

var toggleAccessForTenant = async function (tenantId, isActive) {
  try {
    const result = await TenantDAO.toggleTenantAccess(tenantId, isActive);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found with the given ID/failed to update.",
    };
  } catch (error) {
    return handleError(error);
  }
};

var toggleShowFooterLogo = async function (tenantId, value) {
  try {
    const result = await TenantDAO.toggleShowFooterlogo(tenantId, value);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found with the given ID/failed to update.",
    };
  } catch (error) {
    return handleError(error);
  }
};

var addUpdateAdmin = async function (tenantId, adminDetails) {
  try {
    const result = await TenantDAO.updateAdminDetails(tenantId, adminDetails);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found with the given ID/failed to update.",
    };
  } catch (error) {
    return handleError(error);
  }
};

var updateReportLogoSizes = async function (tenantId, sizes) {
  try {
    const result = await TenantDAO.updateReportLogoSizes(tenantId, sizes);
    if (result.ok === 1) {
      return { success: true };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found with the given ID/failed to update.",
    };
  } catch (error) {
    return handleError(error);
  }
};

var updateAddIconsForTenant = async function (tenantId, iconsData) {
  try {
    const result = await TenantDAO.updateAddIconsForTenant(tenantId, iconsData);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found with the given ID/failed to update.",
    };
  } catch (error) {
    return handleError(error);
  }
};

var updateTenantsAzureStorageDataDetails = async function (
  tenantId,
  azureStorageDetails
) {
  try {
    const result = await TenantDAO.updateTenantsAzureStorageDataDetails(
      tenantId,
      azureStorageDetails
    );
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found with the given ID/failed to update.",
    };
  } catch (error) {
    return handleError(error);
  }
};
var updateLogoURL = async function (tenantId, logoURL) {
  try {
    const result = await TenantDAO.updateTenantLogo(tenantId, logoURL);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found with the given ID/failed to update.",
    };
  } catch (error) {
    return handleError(error);
  }
};
var updateTenantPhone = async function (tenantId, phone) {
  try {
    const result = await TenantDAO.updateTenantPhone(tenantId, phone);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found with the given ID/failed to update.",
    };
  } catch (error) {
    return handleError(error);
  }
};
var updateTenantSignature = async function (tenantId, signature) {
  try {
    const result = await TenantDAO.updateTenantSignature(tenantId, signature);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found with the given ID/failed to update.",
    };
  } catch (error) {
    return handleError(error);
  }
};
var updateTenantWebsite = async function (tenantId, website) {
  try {
    const result = await TenantDAO.updateTenantWebsite(tenantId, website);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found with the given ID/failed to update.",
    };
  } catch (error) {
    return handleError(error);
  }
};

var updateValidityDate = async function (tenantId, endDate) {
  try {
    const result = await TenantDAO.updateEndDate(tenantId, endDate);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found with the given ID/failed to update.",
    };
  } catch (error) {
    return handleError(error);
  }
};

var updateTenantExpenses = async function (tenantId, expense) {
  try {
    const result = await TenantDAO.updateTenantExpenses(tenantId, expense);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found with the given ID/failed to update.",
    };
  } catch (error) {
    return handleError(error);
  }
};
var getDiskWarning = async function (tenantId) {
  try {
    const result = await TenantDAO.diskLimitreaching(tenantId);
    if (result) {
      return {
        success: true,
        limitreaching: result.isLimitreaching,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found with the given ID/failed to get data.",
    };
  } catch (error) {
    return handleError(error);
  }
};

var isTenantActive = async function (identifier) {
  try {
    const result = await TenantDAO.isTenantActive(identifier);
    if (result.success) {
      return {
        success: true,
        allowLogin: result.allowLogin,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Tenant found with the given identifier.",
    };
  } catch (error) {
    return handleError(error);
  }
};

var getTenantDetails = async function (tenantId) {};

const handleError = (error) => {
  console.error("An error occurred:", error);
  return {
    code: 500,
    success: false,
    reason: `An error occurred: ${error.message}`,
  };
};

module.exports = {
  addTenant,
  deleteTenant,
  restoreTenant,
  getTenantById,
  getDiskWarning,
  deleteTenantPermanently,
  getAllTenants,
  editTenant,
  toggleAccessForTenant,
  toggleShowFooterLogo,
  addDiskSpace,
  increaseTenantValidity,
  increaseTenantUsers,
  increaseAllowedCustomForms,
  updateAddIconsForTenant,
  updateReportLogoSizes,
  updateTenantsAzureStorageDataDetails,
  addCustomFormCount,
  updateTenantPhone,
  updateLogoURL,
  updateTenantWebsite,
  updateTenantSignature,
  updateTenantExpenses,
  addUsedDiskSpace,
  updateValidityDate,
  addUpdateAdmin,
  isTenantActive,
  getTenantDetails,
  updateStorageStats,
  getTenantByCompanyIdentifier,
};
