// SCHEDULING ORDER (David, Aug 15, approved on the web app; applied to the
// MOBILE-facing endpoints Aug 23: "the project order by date is jumbled up in
// the app but on the website it works great"): upcoming inspections first -
// furthest out down to today - then past ones most-recent first, undated at
// the bottom. Dates partition against midnight LOS ANGELES time, same as the
// web app on David's screen.
function schedulingOrder(list) {
  if (!Array.isArray(list)) return list;
  const laNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  laNow.setHours(0, 0, 0, 0);
  const today = laNow.getTime();
  const when = (p) => { const v = new Date(p && p.editedat).getTime(); return isNaN(v) ? -Infinity : v; };
  return list.slice().sort((a, b) => {
    const wa = when(a), wb = when(b);
    const ua = wa >= today, ub = wb >= today;
    if (ua !== ub) return ua ? -1 : 1;
    return wb - wa;
  });
}

"use strict";
const ProjectDAO = require("../model/projectDAO");
const ArchivedProjectDAO = require("../model/archivedProjectDAO");
const LocationDAO = require("../model/locationDAO");
const SubprojectService = require("../service/subProjectService");
const LocationService = require("../service/locationService");
const SectionService = require("../service/sectionService");
/**
 *
 * @param {*} project
 * @returns
 *
 * Umesh TODO :
 * 1. Add validation
 * 2. Add error handling
 * 4. Add methods for assign,unassign,getProjectsByNameCreatedOnIsCompletedAndDeleted,getAllFilesOfProject etc.
 */

var addProject = async function (project) {
  try {
    const result = await ProjectDAO.addProject(project);
    if (result.success === true) {
      return {
        success: true,
        id: project.id || result.insertedId,
      };
    }
    return {
      code: 500,
      success: false,
      reason: "Insertion failed",
    };
  } catch (error) {
    return handleError(error);
  }};

var getProjectById = async function (projectId) {
  try {
    const result = await ProjectDAO.getProjectById(projectId);
    if (result) {
      // Attach Couchbase document key as id and _id
      return {
        success: true,
        project: result,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No project found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};
//UMESH TODO -- ADD transaction in this
var deleteProjectPermanently = async function (projectId) {
  try {
    
    //For single level Projects
    const sectionsResult = SectionService.getSectionsByParentId(projectId);
    if (sectionsResult.sections) {
      for (const section of sectionsResult.sections) {
        await SectionService.deleteSectionPermanently(section.id);
      }
    }
    //Delete projectLocations
    const locationResult = await LocationService.getLocationsByParentId(
      projectId
    );

    if (locationResult.locations) {
      for (const location of locationResult.locations) {
        await LocationService.deleteLocationPermanently(location.id);
      }
    }

    //Delete Subprojects
    const subProjectResult = await SubprojectService.getSubProjectByParentId(
      projectId
    );

    if (subProjectResult.subprojects) {
      for (const subProject of subProjectResult.subprojects) {
        await SubprojectService.deleteSubProjectPermanently(subProject.id);
      }
    }

    const result = await ProjectDAO.deleteProjectPermanently(projectId);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No project found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

var archiveProject = async function(projectId){
  try {
    const result = await ProjectDAO.getProjectById(projectId);
    if (result) {
      const {...rest} = result.id ? { ...result, id: result.id } : result; // Ensure id is included in the rest object
      var archivedProj = await ArchivedProjectDAO.addArchivedProject({...rest});
      if (archivedProj.ok === 1) {
        //delete the project
        const result = await ProjectDAO.deleteProjectPermanently(projectId);
        if (result.ok === 1) {
        return {
          success: true,
         };
        }else{
          return {
            code: 401,
            success: false,
            reason: "Failed to remove project.",
          };
        }
      }    
    }
    return {
      code: 401,
      success: false,
      reason: "No project found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};
var getProjectsByUser = async function (username) {
  try {
    const result = await ProjectDAO.getProjectByAssignedToUserId(username);
    if (result) {
      return {
        success: true,
        projects: result,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No project found with the given username",
    };
  } catch (error) {
    return handleError(error);
  }
};

var getAllProjects = async function () {
  try {
    const result = await ProjectDAO.getAllProjects();
    if (result) {
      return {
        success: true,
        projects: result,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No project found",
    };
  } catch (error) {
    return handleError(error);
  }
};

var editProject = async function (projectId, newData) {
  try {
    const result = await ProjectDAO.editProject(projectId, newData);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No project found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

var assignProjectToUser = async function (projectId, username) {
  try {
    const result = await ProjectDAO.assignProjectToUser(projectId, username);
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No project found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

var unassignUserFromProject = async function (projectId, username) {
  try {
    const result = await ProjectDAO.unassignUserFromProject(
      projectId,
      username
    );
    if (result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No project found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

var getProjectByAssignedToUserId = async function (userId) {
  try {
    const result = await ProjectDAO.getProjectByAssignedToUserId(userId);
    if (result) {
      return {
        success: true,
        projects: schedulingOrder(result),
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No project found with the given username",
    };
  } catch (error) {
    return handleError(error);
  }
};

var getProjectsByNameCreatedOnIsCompletedAndDeleted = async function ({
  name = null,
  createdon = null,
  iscomplete = false,
  isdeleted = false,
} = {}) {
  try {
    const result =
      await ProjectDAO.getProjectsByNameCreatedOnIsCompletedAndDeleted({
        name,
        createdon,
        iscomplete,
        isdeleted,
      });
    if (result) {
      return {
        success: true,
        projects: result,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No project found for given criteria",
    };
  } catch (error) {
    return handleError(error);
  }
};

var toggleProjectstatus = async function (projectId,iscomplete) {
    try {
        const result = await ProjectDAO.updateProjectStatus(projectId,iscomplete);
        // projectDAO returns { ok: 1 } on success and THROWS on failure
        // (model/project.js, unused here, returns { data }/{ error } — accept
        // both shapes so a future DAO swap cannot silently break the toggle).
        if (result && (result.ok === 1 || result.data)) {
            return {
                success: true,
            };
        }
        return {
            code: (result && result.error && result.error.code === 405) ? 404 : 500,
            success: false,
            reason: (result && result.error && result.error.message) || 'Could not update the project status.'
        };
    } catch (error) {
        return handleError(error);
    }
};


const handleError = (error) => {
  console.error("An error occurred:", error);
  return {
    code: 500,
    success: false,
    reason: `An error occurred: ${error.message}`,
  };
};

module.exports = {
  addProject,
  getProjectById,
  deleteProjectPermanently,
  getProjectsByUser,
  getAllProjects,
  editProject,
  assignProjectToUser,
  unassignUserFromProject,
  getProjectByAssignedToUserId,
  getProjectsByNameCreatedOnIsCompletedAndDeleted,
  toggleProjectstatus,
  archiveProject
};
