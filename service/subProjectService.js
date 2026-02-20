"use strict";
const ProjectDAO = require('../model/projectDAO'); 
const subProjectDAO = require('../model/subProjectDAO'); 
const LocationService = require('../service/locationService');
const InvasiveUtil = require('../service/invasiveUtil');
const updateParentHelper = require('../service/updateParentHelper');

const addSubProject = async (subproject) => {
    try {
        const result = await subProjectDAO.insertSubProject(subproject);
        if (result.insertedId) {
            await updateParentHelper.addSubprojectMetaDataInProject(result.insertedId,subproject);
            return {
                success: true,
                id: result.insertedId,
            };
        }
        return {
            code:500,
            success: false,
            reason: 'Insertion failed'
        };
    } catch (error) {
        return handleError(error);
    }
};


var getSubProjectById = async function (subProjectId) {
    try {
        const result = await subProjectDAO.findSubProjectById(subProjectId); 
        console.log("SubProject fetched:", result);
        if (result) {
            return {
                success: true,
                subproject: result ,
            };
        }
        return {
            code:401,
            success: false,
            reason: 'No Subproject found with the given ID'
        };
    } catch (error) {
        return handleError(error);
    }
};

var deleteSubProjectPermanently = async function (subProjectId) {
  try {
    const subProject = await subProjectDAO.findSubProjectById(subProjectId);
    if (subProject) {
      const locationResult = await LocationService.getLocationsByParentId(
        subProjectId
      );
      if (locationResult.locations) {
        for (const location of locationResult.locations) {
          await LocationService.deleteLocationPermanently(location._id);
        }
        console.log(
          "SubProject Locations deleted successfully for subProject Id  : ",
          subProjectId
        );
      }
      const finalResult = await subProjectDAO.deleteSubProject(subProjectId);
      await InvasiveUtil.markProjectNonInvasive(subProject.parentid);

      await updateParentHelper.removeSubprojectMetaDataInProject(subProjectId, subProject);

      

      if (finalResult.deletedCount === 1) {
        return {
          success: true,
        };
      }
    }

    return {
      code: 401,
      success: false,
      reason: "No SubProject found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

var getSubProjectByParentId = async function (parentId) {
    try {
        const result = await subProjectDAO.findSubProjectsByParentId(parentId);
        if (result) {
            return {
                success: true,
                subprojects: result,
            };
        }
        return {
            code:401,
            success: false,
            reason: 'No Subproject found with the given ID'
        };
    } catch (error) {
        return handleError(error);
    }
};


var assignSubProjectToUser = async function (id, username) {
    try {
        const result = await subProjectDAO.assignSubprojectToUser(id, username);
        if (result) {
            return {
                success: true,
            };
        }
        return {
            code:401,
            success: false,
            reason: 'No Subproject found with the given ID'
        };
    }
    catch (error) {
        return handleError(error);
    }
};

var unAssignSubProjectFromUser = async function (id, username) {
    try {
        const result = await subProjectDAO.unassignSubprojectFromUser(id, username);
        if (result) {
            return {
                success: true,
            };
        }
        return {
            code:401,
            success: false,
            reason: 'No Subproject found with the given ID'
        };
    }
    catch (error) {
        return handleError(error);
    }
};

const editSubProject = async (subProjectId,subproject) => {
    try {
        const result = await subProjectDAO.editSubProject(subProjectId, subproject);
        if (result.modifiedCount === 1) {
            const subProjectFromDB = await subProjectDAO.findSubProjectById(subProjectId);
            if(subProjectFromDB)
            {
                // await updateParentHelper.removeSubprojectMetaDataInProject(subProjectId,subProjectFromDB);
                // await updateParentHelper.addSubprojectMetaDataInProject(subProjectId,subProjectFromDB);
                await updateParentHelper.addUpdateSubProjectMetadataInProject(subProjectId,subProjectFromDB);
                return {
                    success: true,
                };
            }
        }
        return {
            code:401,
            success: false,
            reason: 'No Subproject found with the given ID'
        };
    } catch (error) {
        return handleError(error);
    }
};

const handleError = (error) => {
    console.error('An error occurred:', error);
    return {
        code:500,
        success: false,
        reason: `An error occurred: ${error.message}`
    };
};



// ... More service functions

module.exports = {
    addSubProject,
    getSubProjectById,
    deleteSubProjectPermanently,
    getSubProjectByParentId,
    assignSubProjectToUser,
    unAssignSubProjectFromUser,
    editSubProject
};