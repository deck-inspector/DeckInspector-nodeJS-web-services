"use strict";
const { v4: uuidv4 } = require('uuid');
const couchbase = require('../database/couchbase');
const user = require('./user');
const Projects = require('./project');
const Locations = require('./location');

// Helper function to get SubProjects collection
async function getSubProjectsCollection() {
  return couchbase.SubProjects;
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
    throw error;
  }
}

var addSubProject = async function (subproject) {
    var response = {};
    try {
        const subProjectId = uuidv4();
        const subProjectWithMeta = {
            ...subproject,
            docType: "SubProject",
            createdAt: new Date().toISOString(),
        };
        const collection = await getSubProjectsCollection();
        await collection.insert(subProjectId, subProjectWithMeta);
        console.log(`SubProject inserted with ID: ${subProjectId}`);

        // Update parent project
        var projresult = await Projects.updateProjectChildrenWithAdd(subproject.parentid, subProjectId, subproject);
        if (projresult && projresult.modifiedCount > 0) {
            var msg = "SubProject inserted successfully, parent project updated successfully.";
        } else {
            var msg = "SubProject inserted successfully, parent project failed to update.";
        }

        response = {
            "data": {
                "id": subProjectId,
                "message": msg,
                "code": 201
            }
        };
        return response;
    } catch (error) {
        console.error("Error adding SubProject:", error);
        response = {
            "error": {
                "code": 500,
                "message": "Error inserting SubProject.",
                "errordata": error
            }
        };
        return response;
    }
};


var getSubProjectById = async function (id) {
    var response = {};
    try {
        const collection = await getSubProjectsCollection();
        const doc = await collection.get(id);
        
        if (doc && doc.content) {
            response = {
                "data": {
                    "item": { ...doc.content, _id: id },
                    "message": "SubProject found.",
                    "code": 201
                }
            };
            return response;
        } else {
            response = {
                "error": {
                    "code": 401,
                    "message": "No SubProject found."
                }
            };
            return response;
        }
    }
    catch (err) {
        response = {
            "error": {
                "code": 500,
                "message": "Error fetching subproject.",
                "errordata": err
            }
        };
        return response;
    }
};


var assignSubProjectToUser = async function (id, username) {
    var response = {};
    try {
        const collection = await getSubProjectsCollection();
        const doc = await collection.get(id);

        if (!doc || !doc.content) {
            response = {
                "error": {
                    "code": 409,
                    "message": "No subproject found."
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
                    "message": "SubProject assigned successfully.",
                    "code": 201
                }
            };
            return response;
        } else {
            response = {
                "error": {
                    "code": 409,
                    "message": "Error updating the subproject assignment, user already added"
                }
            };
            return response;
        }
    } catch (error) {
        response = {
            "error": {
                "code": 500,
                "message": "Error assigning subproject.",
                "errordata": error
            }
        };
        return response;
    }
};
var unassignUserFromSubProject = async function (id, username) {
    var response = {};
    try {
        const collection = await getSubProjectsCollection();
        const doc = await collection.get(id);

        if (!doc || !doc.content) {
            response = {
                "error": {
                    "code": 409,
                    "message": "No subproject found."
                }
            };
            return response;
        }

        let assignedto = doc.content.assignedto || [];
        const initialLength = assignedto.length;
        assignedto = assignedto.filter(user => user !== username);

        if (assignedto.length < initialLength) {
            await collection.upsert(id, { ...doc.content, assignedto });
            response = {
                "data": {
                    "message": "User removed from subproject assignment successfully.",
                    "code": 201
                }
            };
            return response;
        } else {
            response = {
                "error": {
                    "code": 405,
                    "message": "Error updating the subproject assignment/or user not assigned."
                }
            };
            return response;
        }
    } catch (error) {
        response = {
            "error": {
                "code": 500,
                "message": "Error unassigning subproject.",
                "errordata": error
            }
        };
        return response;
    }
};


var updateSubProject = async function (subproject) {
    var response = {};
    try {
        const collection = await getSubProjectsCollection();
        const doc = await collection.get(subproject.id);

        if (!doc || !doc.content) {
            response = {
                "error": {
                    "code": 401,
                    "message": "No SubProject found."
                }
            };
            return response;
        }

        // Update the subproject
        const updatedSubProject = {
            ...doc.content,
            name: subproject.name,
            description: subproject.description,
            url: subproject.url,
            lasteditedby: subproject.lasteditedby,
            editedat: subproject.editedat
        };
        
        await collection.upsert(subproject.id, updatedSubProject);

        // Update parent project
        var projresult = await Projects.addUpdateProjectChild(subproject.parentid, subproject.id, updatedSubProject);
        
        response = {
            "data": {
                "message": "SubProject updated successfully.",
                "code": 201
            }
        };
        return response;
    }
    catch (err) {
        response = {
            "error": {
                "code": 500,
                "message": "Error processing subproject updates.",
                "errordata": err
            }
        };
        return response;
    }
};

var editSubProject = async function (subProjectId, newData) {
    var response = {};
    try {
        const collection = await getSubProjectsCollection();
        const doc = await collection.get(subProjectId);
        
        if (!doc || !doc.content) {
            response = {
                "error": {
                    "code": 401,
                    "message": "No SubProject found."
                }
            };
            return response;
        }

        // Update subproject
        const updatedSubProject = { ...doc.content, ...newData };
        await collection.upsert(subProjectId, updatedSubProject);

        // Update parent project child reference
        var projresult = await Projects.addUpdateProjectChild(updatedSubProject.parentid, subProjectId, updatedSubProject);
        
        response = {
            "data": {
                "message": "SubProject updated successfully.",
                "code": 201
            }
        };
        return response;
    }
    catch (err) {
        console.log(err);
        response = {
            "error": {
                "code": 500,
                "message": "Error updating subproject.",
                "errordata": err
            }
        };
        return response;
    }
};

//Soft Delete/undelete
var updateSubProjectVisibilityStatus = async function (id, name, parentId, isVisible) {
    var response = {};
    try {
        const collection = await getSubProjectsCollection();
        const doc = await collection.get(id);

        if (!doc || !doc.content) {
            response = {
                "error": {
                    "code": 405,
                    "message": "No subproject found, invalid id."
                }
            };
            return response;
        }

        // Update the SubProject's visibility
        const updatedSubProject = { ...doc.content, isdeleted: !isVisible };
        await collection.upsert(id, updatedSubProject);

        // Update parent project
        var projresult = await (isVisible 
            ? Projects.updateProjectChildrenWithAdd(parentId, id, { name, type: "subproject", description: doc.content.description, url: doc.content.url })
            : Projects.updateProjectChildrenWithRemove(parentId, id));

        if (projresult && projresult.modifiedCount > 0) {
            var message = `SubProject state updated successfully, is Visible: ${isVisible}. Parent project updated successfully.`;
        } else {
            var message = `SubProject state updated successfully, is Visible: ${isVisible}. Project failed to update.`;
        }

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
                "message": "Error changing visibility of subproject.",
                "errordata": error
            }
        };
        return response;
    }
};

var deleteSubProjectPermanently = async function (id) {
    try {
        
        var subProject = await mongo.SubProjects.findOne({ _id: new ObjectId(id) });

        if(!subProject)
        {
            response = {
                "error": {
                    "code": 401,
                    "message": "No SubProject found."
                }
            }
            return response;
        }

        //Remove all children
        const locations = Locations.getLocationByParentId(id);
        if(locations && locations.data && locations.data.item && locations.data.item.length>0)
        {
            for(location of locations.data.item)
            {
                const result = await Locations.deleteLocationPermanently(location._id);
                if(result.error)
                {
                    return result;
                }
            }
        }

        //Update Parent
        await Projects.updateProjectChildrenWithRemove(subProject.parentid,id);

        //Delete self
        var result = await mongo.SubProjects.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount == 1) {
            
            var response = {
                "data": {
                    "message": "SubProject deleted successfully.",
                    "code": 201
                }
            };
            return response;
        }
        else {
            response = {
                "error": {
                    "code": 401,
                    "message": "No SubProject found."
                }
            }
            return response;
        }


    }
    catch (err) {
        response = {
            "error": {
                "code": 500,
                "message": "Error deleting subproject.",
                "errordata": err
            }
        }
        return response;
    }

};

var addRemoveChildren = async function (subprojectId, isAdd, { id, name, type }) {
    var response = {};
    try {
        const collection = await getSubProjectsCollection();
        const doc = await collection.get(subprojectId);

        if (!doc || !doc.content) {
            response = {
                "error": {
                    "code": 409,
                    "message": "No subproject found."
                }
            };
            return response;
        }

        let children = doc.content.children || [];
        if (isAdd) {
            // Add child if not already present
            if (!children.find(c => c.id === id)) {
                children.push({ id, name, type });
            }
        } else {
            // Remove child
            children = children.filter(c => c.id !== id);
        }

        await collection.upsert(subprojectId, { ...doc.content, children });

        response = {
            "data": {
                "message": "Common location added/removed to/from the subproject successfully.",
                "code": 201
            }
        };
        return response;
    } catch (error) {
        response = {
            "error": {
                "code": 500,
                "message": "Error adding/removing common location to/from the subproject.",
                "errordata": error
            }
        };
        return response;
    }
};

var getSubProjectsByParentId = async function(parentId) {
    try {
        const query = `SELECT META(s).id as id, s.* FROM \`${couchbase.DB_BUCKET_NAME}\`.\`${couchbase.DB_SCOPE_NAME}\`.SubProject s WHERE s.parentid = $1`;
        const results = await executeQuery(query, [parentId]);
        console.log("Couchbase SubProjects Query Results:", results);
        if (results && results.length > 0) {
            return {
                data: {
                    item: results.map(row => ({ ...row, _id: row.id })),
                    message: "SubProjects found.",
                    code: 201
                }
            };
        } else {
            return {
                error: {
                    code: 401,
                    message: "No SubProjects found."
                }
            };
        }
    } catch (error) {
        return {
            error: {
                code: 500,
                message: "Error fetching SubProjects.",
                errordata: error
            }
        };
    }
}

var updateSubProjectChildrenWithAdd = async function(subprojectId, childrenId, childrenData) {
    try {
        const collection = await getSubProjectsCollection();
        const doc = await collection.get(subprojectId);
        
        if (!doc || !doc.content) {
            return { modifiedCount: 0 };
        }

        let children = doc.content.children || [];
        // Add child if not already present
        if (!children.find(c => c._id === childrenId || c.id === childrenId)) {
            children.push({
                "_id": childrenId,
                "description": childrenData.description,
                "name": childrenData.name,
                "type": childrenData.type,
                "url": childrenData.url,
                "isInvasive": false,
                "count": 0
            });
        }
        
        await collection.upsert(subprojectId, { ...doc.content, children });
        return { modifiedCount: 1 };
    } catch (error) {
        console.error("Error adding children to subproject:", error);
        return { modifiedCount: 0 };
    }
};

var updateSubProjectChildrenWithRemove = async function(subprojectId, childrenId) {
    try {
        const collection = await getSubProjectsCollection();
        const doc = await collection.get(subprojectId);
        
        if (!doc || !doc.content) {
            return { modifiedCount: 0 };
        }

        let children = doc.content.children || [];
        const initialLength = children.length;
        children = children.filter(c => c._id !== childrenId && c.id !== childrenId);
        
        if (children.length < initialLength) {
            await collection.upsert(subprojectId, { ...doc.content, children });
            return { modifiedCount: 1 };
        }
        return { modifiedCount: 0 };
    } catch (error) {
        console.error("Error removing children from subproject:", error);
        return { modifiedCount: 0 };
    }
};

module.exports = {
    addSubProject,
    updateSubProjectVisibilityStatus,
    deleteSubProjectPermanently,
    updateSubProject,
    getSubProjectById,
    assignSubProjectToUser,
    unassignUserFromSubProject,
    addRemoveChildren,
    getSubProjectsByParentId,
    editSubProject,
    updateSubProjectChildrenWithAdd,
    updateSubProjectChildrenWithRemove
};