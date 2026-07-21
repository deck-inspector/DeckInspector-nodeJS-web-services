"use strict";
const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");
const Location = require("./location");
const SubProject = require("./subproject");

// Helper function to get Projects collection
async function getProjectsCollection() {
  return couchbase.Projects;
}

// Helper function to execute N1QL queries
async function executeQuery(statement, parameters = []) {
  try {
    const cluster = couchbase.cluster;
    if (!cluster) {
      throw new Error("Cluster connection not initialized.");
    }
    const result = await cluster.query(statement, { parameters });
    return result.rows;
  } catch (error) {
    console.error("Query execution error:", error);
    throw error;
  }
}

var addProject = async function (project) {
    try {
        const projectId = `project_${uuidv4()}`;
        const collection = await getProjectsCollection();
        const projectDoc = {
            ...project,
            type: "Project",
            createdAt: new Date().toISOString(),
        };
        await collection.insert(projectId, projectDoc);
        return {
            "data": {
                "id": projectId,
                "message": "Project inserted successfully.",
                "code": 201
            }
        };
    } catch (error) {
        console.error("Error adding project:", error);
        return {
            "error": {
                "code": 500,
                "message": "No Project inserted.",
                "errordata": error
            }
        };
    }
};

var getAllProjects = async function () {   
    var response = {};
    try {
        const query = `SELECT META(p).id as id, p.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_SCOPE_NAME || "inventory"}\`.Project p WHERE p.type = 'Project' ORDER BY META(p).id DESC LIMIT 50`;
        const result = await executeQuery(query);
        
        if (result.length === 0) {
            response = {
                "data": {
                    "projects": [],
                    "message": "No Projects found.",
                    "code": 401
                }
            };
        } else {
            response = {
                "data": {
                    "projects": result.map(item => {
                        delete item.isdeleted;
                        delete item.files;
                        return { id: item.id, ...item };
                    }),
                    "message": "Projects found.",
                    "code": 201
                }
            };
        }
        return response;
    } catch (err) {
        response = {
            "error": {
                "code": 500,
                "message": "Error fetching projects.",
                "errordata": err
            }
        };
        return response;
    }
};

var getProjectById = async function (id) {
  try {
    // KV read (collection.get) has been timing out against the cluster data
    // service while the query service stays responsive (the path getAllProjects
    // uses). Fetch the project by id via N1QL so a slow/unresponsive KV path
    // cannot block report generation. Read-only; no data is modified.
    const query = "SELECT META(p).id as id, p.* FROM `" + process.env.DB_BUCKET_NAME + "`.`" + (process.env.DB_SCOPE_NAME || "inventory") + "`.Project p USE KEYS $1";
    const rows = await executeQuery(query, [id]);
    if (!rows || rows.length === 0) {
      return { success: false, error: { code: 404, message: "No Project found." } };
    }
    const content = rows[0] || {};
    delete content.files;
    return { success: true, project: { ...content } };
  } catch (err) {
    console.error("Error fetching project by ID:", err);

    if (err.name === "DocumentNotFoundError") {
      return {
        success: false,
        error: {
          code: 404,
          message: "No Project found."
        }
      };
    }

    return {
      success: false,
      error: {
        code: 500,
        message: "Error fetching project.",
        errordata: err
      }
    };
  }
};



var assignProjectToUser = async function (id, username) {
    var response = {};      
    try {
        const collection = await getProjectsCollection();
        const doc = await collection.get(id);
        
        if (!doc) {
            response = {
                "error": {
                    "code": 409,
                    "message": "No project found."
                }
            };
            return response;   
        }
        
        const assignedto = doc.content.assignedto || [];
        if (!assignedto.includes(username)) {
            assignedto.push(username);
            await collection.upsert(id, { ...doc.content, assignedto });
            response = {
                "data": {                
                    "message": "Project assigned successfully.",
                    "code": 201
                }   
            };
            return response;
        } else {
            response = {
                "error": {
                    "code": 409,
                    "message": "Error updating the project assignment, user already added"
                }
            };
            return response;       
        }
    } catch (error) {
        response = {
            "error": {
                "code": 500,
                "message": "Error assigning project.",
                "errordata": error
            }
        };
        return response;
    }
};
var unassignUserFromProject = async function (id, username) {      
    var response = {};
    try {
        const collection = await getProjectsCollection();
        const doc = await collection.get(id);
        
        if (!doc) {
            response = {
                "error": {
                    "code": 409,
                    "message": "No project found."
                }
            };
            return response;   
        }
        
        let assignedto = doc.content.assignedto || [];
        const initialLength = assignedto.length;
        assignedto = assignedto.filter((user) => user !== username);
        
        if (assignedto.length < initialLength) {
            await collection.upsert(id, { ...doc.content, assignedto });
            response = {
                "data": {                
                    "message": "User removed from project assignment successfully.",
                    "code": 201
                }   
            };
            return response;
        } else {
            response = {
                "error": {
                    "code": 405,
                    "message": "Error updating the project assignment/or user not assigned."
                }
            };
            return response;       
        }
    } catch (error) {
        response = {
            "error": {
                "code": 500,
                "message": "Error assigning project.",
                "errordata": error
            }
        };
        return response;
    }
};
var getProjectsByNameCreatedOnIsCompletedAndDeleted = async function({
    name = "",
    createdon = "",
    iscomplete = false,
    isdeleted = false
} = {}) {
    var response = {};
    try {
        let query = `SELECT META(p).id as id, p.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_SCOPE_NAME || "inventory"}\`.Project p WHERE p.type = 'Project'`;
        const params = [];
        
        if (name !== "") {
            query += ` AND p.name = $${params.length + 1}`;
            params.push(name);
        }
        if (createdon !== "") {
            query += ` AND p.createdon = $${params.length + 1}`;
            params.push(createdon);
        }
        
        query += ` AND p.iscomplete = $${params.length + 1}`;
        params.push(iscomplete);
        query += ` AND p.isdeleted = $${params.length + 1}`;
        params.push(isdeleted);
        query += ` ORDER BY p.editedat DESC LIMIT 25`;
        
        const result = await executeQuery(query, params);
        
        if (result.length === 0) {
            response = {
                "data": {
                    "projects": [],
                    "message": "No Projects matching the filter found.",
                    "code": 401
                }
            };
        } else {
            response = {
                "data": {
                    "projects": result.map(item => {
                        delete item.isdeleted;
                        delete item.files;
                        return { id: item.id, ...item };
                    }),
                    "message": "Projects found matching the criteria.",
                    "code": 201
                }
            };
        }
        return response;
    } catch (error) {
        response = {
            "error": {
                "code": 500,
                "message": "Error fetching project.",
                "errordata": error
            }
        };
        return response;
    }
};



var updateProject = async function (project) {
    var response = {};
    try {
        const collection = await getProjectsCollection();
        const doc = await collection.get(project.id);
        
        if (!doc) {
            response = {
                "error": {
                    "code": 401,
                    "message": "No Project found."
                }
            };
            return response;
        }
        
        const updatedDoc = {
            ...doc.content,
            name: project.name,
            address: project.address,
            description: project.description,
            url: project.url,
            lasteditedby: project.lasteditedby,
            editedat: project.editedat
        };
        
        await collection.upsert(project.id, updatedDoc);
        response = {
            "data": {                   
                "message": "Project updated successfully.",
                "code": 201
            }   
        };
        return response;
    } catch (err) {
        response = {
            "error": {
                "code": 500,
                "message": "Error fetching project.",
                "errordata": err
            }
        };
        return response;
    }
};


var editProject = async function (projectId, newData) {
    var response = {};
    try {
        const collection = await getProjectsCollection();
        const doc = await collection.get(projectId);
        
        if (!doc) {
            response = {
                "error": {
                    "code": 401,
                    "message": "No Project found."
                }
            };
            return response;
        }
        
        const updatedDoc = { ...doc.content, ...newData };
        await collection.upsert(projectId, updatedDoc);
        
        response = {
            "data": {                   
                "message": "Project updated successfully.",
                "code": 201
            }   
        };
        return response;
    } catch (err) {
        response = {
            "error": {
                "code": 500,
                "message": "Error fetching project.",
                "errordata": err
            }
        };
        return response;
    }
};

var updateProjectVisibilityStatus = async function (id, isVisible) {
    var response = {};
    try {
        const collection = await getProjectsCollection();
        const doc = await collection.get(id);
        
        if (!doc) {
            response = {
                "error": {
                    "code": 405,
                    "message": "No project found, invalid id."                    
                }
            };
            return response;
        }
        
        await collection.upsert(id, { ...doc.content, isdeleted: isVisible });
        var message = `Project state updated successfully, is Visible: ${isVisible}.`;
        response = {
            "data": {                
                "message": message,
                "code": 201
            }   
        };
        return response;
    } catch (error) {
        response = {
            "error": {
                "code": 500,
                "message": "Error changing visibility of project.",
                "errordata": error
            }
        };
        return response;
    }    
};
var updateProjectOfflineAvailabilityStatus = async function (id, isavailableoffline) {
    var response = {};
    try {
        const collection = await getProjectsCollection();
        const doc = await collection.get(id);
        
        if (!doc) {
            response = {
                "error": {
                    "code": 405,
                    "message": "No project found, invalid id."                    
                }
            };
            return response;
        }
        
        await collection.upsert(id, { ...doc.content, isavailableoffline: isavailableoffline });
        var message = `Project state updated successfully, can download offline: ${isavailableoffline}.`;
        response = {
            "data": {                
                "message": message,
                "code": 201
            }   
        };
        return response;
    } catch (error) {
        response = {
            "error": {
                "code": 500,
                "message": "Error assigning project.",
                "errordata": error
            }
        };
        return response;
    }   
};

var updateProjectStatus = async function (id, iscomplete) {
    var response = {};
    try {
        const collection = await getProjectsCollection();
        const doc = await collection.get(id);
        
        if (!doc) {
            response = {
                "error": {
                    "code": 405,
                    "message": "No project found, invalid id."                    
                }
            };
            return response;
        }
        
        await collection.upsert(id, { ...doc.content, iscomplete: iscomplete });
        var message = `Project state updated successfully, is project complete: ${iscomplete}.`;
        response = {
            "data": {                
                "message": message,
                "code": 201
            }   
        };
        return response;
    } catch (err) {
        response = {
            "error": {
                "code": 500,
                "message": "Error updating completion state of the project.",
                "errordata": err
            }
        };
        return response;
    }   
};

var deleteProjectPermanently = async function (id) {
    try {
        const collection = await getProjectsCollection();
        const projectData = await collection.get(id);
        
        if (!projectData) {
            const response = {
                "error": {
                    "code": 401,
                    "message": "No Project found."
                }
            };
            return response;
        }

        // Delete Project Locations
        const locations = await Location.getLocationByParentId(id);
        if (locations && locations.data && locations.data.item && locations.data.item.length > 0) {
            for (let location of locations.data.item) {
                const locationId = location.id || location._id;
                const result = await Location.deleteLocationPermanently(locationId);
                if (result.error) {
                    return result;
                }
            }
            console.log("Project Locations deleted successfully for project Id: ", id);
        } 
         
        // Delete SubProjects
        const subProjects = await SubProject.getSubProjectsByParentId(id);
        if (subProjects && subProjects.data && subProjects.data.item && subProjects.data.item.length > 0) {
            for (let subProject of subProjects.data.item) {
                const subProjectId = subProject.id || subProject._id;
                const result = await SubProject.deleteSubProjectPermanently(subProjectId);
                if (result.error) {
                    return result;
                }
            }
            console.log("SubProjects deleted successfully for project Id: ", id);
        }

        await collection.remove(id);

        const response = {
            "data": {                    
                "message": "Project deleted successfully.",
                "code": 201
            }   
        };
        return response;
    } catch (err) {
        console.log(err);
        const response = {
            "error": {
                "code": 500,
                "message": "Error deleting project.",
                "errordata": err
            }
        };
        return response;
    }  
};
var getAllFilesOfProject = async function (id) {    
    try {
        const collection = await getProjectsCollection();
        const result = await collection.get(id);
        
        if (result) {
            return JSON.stringify(result.content.files || []);
        } else {
            const error = new Error("No project found.");
            error.status = 401;    
            return JSON.stringify(error);
        }
    } catch (err) {
        const error = new Error("No project found.");
        error.status = 401;
        return JSON.stringify(error);
    }
};

var addRemoveChildren = async function(projectId, isAdd, {id, name, type}) {
    var response = {};
    try {
        console.log(projectId + JSON.stringify({id, name, type}));
        const collection = await getProjectsCollection();
        const doc = await collection.get(projectId);
        
        if (!doc) {
            response = {
                "error": {
                    "code": 409,
                    "message": "No project found."
                }
            };
            return response;   
        }
        
        let children = doc.content.children || [];
        
        if (isAdd) {
            children.push({ id, name, type });
        } else {
            children = children.filter(child => !(child.id === id && child.name === name && child.type === type));
        }
        
        await collection.upsert(projectId, { ...doc.content, children });
        response = {
            "data": {                                   
                "message": "Common location added/removed to/from the project successfully.",
                "code": 201
            }   
        };
        return response;
    } catch (error) {
        response = {
            "error": {
                "code": 500,
                "message": "Error adding common location to the project.",
                "errordata": error
            }
        };
        return response;
    }
};

var getProjectByAssignedToUserId = async function(userId) {
    try {
        const query = `SELECT META(p).id as id, p.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_SCOPE_NAME || "inventory"}\`.Project p WHERE p.type = 'Project' AND ANY user IN p.assignedto SATISFIES user = $1 END`;
        const result = await executeQuery(query, [userId]);
        
        var response = {};
        if (result.length === 0) {
            response = {
                "data": {
                    "projects": [],
                    "message": "No Projects found.",
                    "code": 401
                }
            };
        } else {
            response = {
                "data": {
                    "projects": result.map(item => {
                        delete item.isdeleted;
                        delete item.files;
                        return { id: item.id, ...item };
                    }),
                    "message": "Projects found.",
                    "code": 201
                }
            };
        }
        return response;
    } catch (err) {
        console.log("Error is: ", err);
        const response = {
            "error": {
                "code": 500,
                "message": "Error fetching projects.",
                "errordata": err
            }
        };
        return response;
    }   
};



var updateProjectChildrenWithAdd = async function(projectId, childrenId, childrenData) {
    try {
        const collection = await getProjectsCollection();
        const doc = await collection.get(projectId);
        const children = doc.content.children || [];
        
        children.push({
            "_id": childrenId,
            "description": childrenData.description,
            "name": childrenData.name,
            "type": childrenData.type,
            "url": childrenData.url
        });
        
        await collection.upsert(projectId, { ...doc.content, children });
        return { ok: 1 };
    } catch (error) {
        console.error("Error updating project children:", error);
        throw error;
    }
}

var updateProjectChildrenWithRemove = async function(projectId, childrenId) {
    try {
        const collection = await getProjectsCollection();
        const doc = await collection.get(projectId);
        const children = doc.content.children || [];
        
        const filteredChildren = children.filter((child) => child._id !== childrenId);
        
        await collection.upsert(projectId, { ...doc.content, children: filteredChildren });
        return { ok: 1 };
    } catch (error) {
        console.error("Error removing project children:", error);
        throw error;
    }
}



module.exports = {
    addProject,
    updateProjectOfflineAvailabilityStatus,
    updateProjectVisibilityStatus,
    deleteProjectPermanently,
    updateProjectStatus,
    updateProject,  
    getProjectById,
    getProjectsByNameCreatedOnIsCompletedAndDeleted,
    getAllProjects,assignProjectToUser,
    getAllFilesOfProject,unassignUserFromProject,
    addRemoveChildren,
    getProjectByAssignedToUserId,
    editProject,
    updateProjectChildrenWithAdd,
    updateProjectChildrenWithRemove
    
};
