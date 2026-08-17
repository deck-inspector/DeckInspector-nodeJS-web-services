"use strict";
const { v4: uuidv4 } = require('uuid');
const couchbase = require('../database/couchbase');
const Projects = require('./project');
const SubProjects = require('./subproject');
const Sections = require('./sections');

// Helper function to get Locations collection
async function getLocationsCollection() {
  return couchbase.Locations;
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


var addLocation = async function (location) {
    var response = {};
    try {
        const locationId = uuidv4();
        const locationWithMeta = {
            ...location,
            docType: "Location",
            createdAt: new Date().toISOString(),
        };
        const collection = await getLocationsCollection();
        await collection.insert(locationId, locationWithMeta);
        console.log(`Location inserted with ID: ${locationId}`);

        // Update parent
        if (location.parenttype == "subproject")
            var projresult = await SubProjects.updateSubProjectChildrenWithAdd(location.parentid, locationId, location);
        else
            var projresult = await Projects.updateProjectChildrenWithAdd(location.parentid, locationId, location);

        if (projresult && projresult.modifiedCount > 0) {
            var msg = "Location inserted successfully, parent updated successfully.";
        } else {
            var msg = "Location inserted successfully, parent failed to update.";
        }

        response = {
            "data": {
                "id": locationId,
                "message": msg,
                "code": 201
            }
        };
        return response;
    } catch (error) {
        console.error("Error adding Location:", error);
        response = {
            "error": {
                "code": 500,
                "message": "No Location inserted.",
                "err": error
            }
        };
        return response;
    }
};


var getLocationById = async function (id) {
    var response = {};
    try {
        // KV get was timing out against the data service and crashed report
        // generation ('.data.item' on an error object). Reroute to the query
        // service (N1QL), keeping the exact same return shape. Read-only.
        const query = "SELECT l.* FROM `" + process.env.DB_BUCKET_NAME + "`.`" + (process.env.DB_SCOPE_NAME || "inventory") + "`.Location l USE KEYS $1";
        const rows = await executeQuery(query, [id]);

        if (rows && rows.length > 0) {
            response = {
                "data": {
                    "item": { ...rows[0], _id: id },
                    "message": "Location found.",
                    "code": 201
                }
            };
            return response;
        } else {
            response = {
                "error": {
                    "code": 401,
                    "message": "No Location found."
                }
            };
            return response;
        }
    }
    catch (err) {
        response = {
            "error": {
                "code": 500,
                "message": "Error fetching location.",
                "errordata": err
            }
        };
        return response;
    }
};

var updateLocation = async function (location) {
    var response = {};
    try {
        const collection = await getLocationsCollection();
        const doc = await collection.get(location.id);

        if (!doc || !doc.content) {
            response = {
                "error": {
                    "code": 401,
                    "message": "No Location found."
                }
            };
            return response;
        }

        // Update the location
        const updatedLocation = {
            ...doc.content,
            name: location.name,
            description: location.description,
            url: location.url,
            lasteditedby: location.lasteditedby,
            editedat: location.editedat
        };
        
        await collection.upsert(location.id, updatedLocation);

        // Update parent
        if (location.parentType == "subproject") {
            var projresult = await SubProjects.updateSubProjectChildrenWithAdd(location.parentid, location.id, updatedLocation);
        } else {
            var projresult = await Projects.updateProjectChildrenWithAdd(location.parentid, location.id, updatedLocation);
        }

        response = {
            "data": {
                "message": "Location updated successfully.",
                "code": 201
            }
        };
        return response;
    }
    catch (err) {
        response = {
            "error": {
                "code": 500,
                "message": "Error processing location updates.",
                "errordata": err
            }
        };
        return response;
    }
};
var updateLocationVisibilityStatus = async function (id, type, name, parentId, parentType, isVisible) {
    var response = {};
    try {
        const collection = await getLocationsCollection();
        const doc = await collection.get(id);

        if (!doc || !doc.content) {
            response = {
                "error": {
                    "code": 405,
                    "message": "No location found, invalid id."
                }
            };
            return response;
        }

        // Update location visibility
        const updatedLocation = { ...doc.content, isdeleted: !isVisible };
        await collection.upsert(id, updatedLocation);

        // Update parent
        if (!isVisible) {
            if (parentType == "subproject")
                var projresult = await SubProjects.updateSubProjectChildrenWithRemove(parentId, id);
            else
                var projresult = await Projects.updateProjectChildrenWithRemove(parentId, id);
        } else {
            if (parentType == "subproject")
                var projresult = await SubProjects.updateSubProjectChildrenWithAdd(parentId, id, { name, type, description: doc.content.description, url: doc.content.url });
            else
                var projresult = await Projects.updateProjectChildrenWithAdd(parentId, id, { name, type: "location", description: doc.content.description, url: doc.content.url });
        }

        if (projresult && projresult.modifiedCount > 0) {
            var message = `Location state updated successfully, is Visible: ${isVisible}. Parent project updated successfully.`;
        } else {
            var message = `Location state updated successfully, is Visible: ${isVisible}. Project failed to update.`;
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
                "message": "Error changing visibility of location.",
                "errordata": error
            }
        };
        return response;
    }
};

var editLocation = async function (locationId, newData) {
    var response = {};
    try {
        const collection = await getLocationsCollection();
        const doc = await collection.get(locationId);

        if (!doc || !doc.content) {
            response = {
                "error": {
                    "code": 401,
                    "message": "No Location found."
                }
            };
            return response;
        }

        // Apply bulk updates
        const updatedLocation = { ...doc.content, ...newData };
        await collection.upsert(locationId, updatedLocation);

        // Update parent with new location data
        if (updatedLocation.parenttype === 'project') {
            await Projects.updateProjectChildrenWithRemove(updatedLocation.parentid, locationId);
            await Projects.updateProjectChildrenWithAdd(updatedLocation.parentid, locationId, updatedLocation);
        } else if (updatedLocation.parenttype === 'subproject') {
            await SubProjects.updateSubProjectChildrenWithRemove(updatedLocation.parentid, locationId);
            await SubProjects.updateSubProjectChildrenWithAdd(updatedLocation.parentid, locationId, updatedLocation);
        }

        response = {
            "data": {
                "message": "Location updated successfully.",
                "code": 201
            }
        };
        return response;
    } catch (err) {
        console.log(err);
        response = {
            "error": {
                "code": 500,
                "message": "Error fetching Location.",
                "errordata": err
            }
        };
        return response;
    }
};


var deleteLocationPermanently = async function (id) {
    try {
        const collection = await getLocationsCollection();
        const doc = await collection.get(id);

        if (!doc || !doc.content) {
            var response = {
                "error": {
                    "code": 401,
                    "message": "No Location found."
                }
            };
            return response;
        }

        const locationData = doc.content;

        // Delete sections within this location
        if (locationData.sections && locationData.sections.length > 0) {
            const Sections = require('./sections');
            for (let section of locationData.sections) {
                const result = await Sections.deleteSectionPermanently(section.id);
                if (result && result.error) {
                    return result;
                }
            }
        }

        // Update Parent
        if (locationData.parenttype === "subproject") {
            await SubProjects.updateSubProjectChildrenWithRemove(locationData.parentid, id);
        } else if (locationData.parenttype === "project") {
            await Projects.updateProjectChildrenWithRemove(locationData.parentid, id);
        }

        // Delete self
        await collection.remove(id);

        var response = {
            "data": {
                "message": "Location deleted successfully.",
                "code": 201
            }
        };
        return response;
    }
    catch (err) {
        var response = {
            "error": {
                "code": 500,
                "message": "Error deleting location.",
                "errordata": err
            }
        };
        return response;
    }
};

var addRemoveSections = async function (locationId, isAdd, { id, name }) {
    var response = {};
    try {
        const collection = await getLocationsCollection();
        const doc = await collection.get(locationId);

        if (!doc || !doc.content) {
            response = {
                "error": {
                    "code": 409,
                    "message": "No location found."
                }
            };
            return response;
        }

        const location = doc.content;
        let sections = location.sections || [];
        
        if (isAdd) {
            // Add section to sections array if not already present
            if (!sections.find(s => s.id === id)) {
                sections.push({ "id": id, "name": name });
            }
        } else {
            // Remove section from sections array
            sections = sections.filter(s => s.id !== id);
        }

        // Update location with modified sections
        const updatedLocation = { ...location, sections };
        await collection.upsert(locationId, updatedLocation);

        response = {
            "data": {
                "message": "Location sections added/removed successfully.",
                "code": 201
            }
        };
        return response;
    } catch (error) {
        response = {
            "error": {
                "code": 500,
                "message": "Error adding/removing sections to the location.",
                "errordata": error
            }
        };
        return response;
    }
}


var getLocationByParentId = async function(parentId){
    try {
        const cluster = couchbase.cluster;
        const query = `SELECT META(l).id as _id, l.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_SCOPE_NAME || "inventory"}\`.Location l WHERE l.parentid = $1`;
        const result = await cluster.query(query, { parameters: [parentId] });
        if (result.rows.length > 0) {
            return {
                data: {
                    item: result.rows,
                    message: "locations found.",
                    code: 201
                }
            };
        } else {
            return {
                error: {
                    code: 401,
                    message: "No locations found."
                }
            };
        }
    } catch (error) {
        return {
            error: {
                code: 500,
                message: "Error fetching locations.",
                errordata: error
            }
        };
    }
}

// Does this project have any actual inspection data yet? True when at least
// one location under the project (directly, or under one of its subprojects)
// has one or more sections recorded. Used by the web app's project list to
// turn a scheduled (green) project yellow once the inspection has started,
// until the Final Report is on file (David, Aug 17).
var hasInspectionData = async function (projectId) {
    try {
        const cluster = couchbase.cluster;
        const bucket = process.env.DB_BUCKET_NAME;
        const scope = process.env.DB_SCOPE_NAME || "inventory";
        // parent ids = the project itself + its subprojects
        const subQuery = `SELECT META(s).id AS metaId, s.id AS docId, s._id AS legacyId FROM \`${bucket}\`.\`${scope}\`.SubProject s WHERE s.parentid = $1`;
        const subs = await cluster.query(subQuery, { parameters: [projectId] });
        const parentIds = [projectId];
        for (const row of (subs.rows || [])) {
            for (const v of [row.metaId, row.docId, row.legacyId]) {
                if (v && parentIds.indexOf(v) === -1) parentIds.push(v);
            }
        }
        const locQuery = `SELECT RAW COUNT(1) FROM \`${bucket}\`.\`${scope}\`.Location l WHERE l.parentid IN $1 AND ARRAY_LENGTH(IFMISSINGORNULL(l.sections, [])) > 0`;
        const result = await cluster.query(locQuery, { parameters: [parentIds] });
        const count = (result.rows && result.rows[0]) || 0;
        return { data: { hasData: count > 0, code: 200 } };
    } catch (error) {
        return { error: { code: 500, message: "Error checking inspection data.", errordata: error } };
    }
}

var updateSectionInLocationsAdd = async function (locationId, sectionId, sectionData) {
    try {
        const collection = await getLocationsCollection();
        const doc = await collection.get(locationId);

        if (!doc || !doc.content) {
            return {
                error: {
                    code: 404,
                    message: "Location not found."
                }
            };
        }

        const location = doc.content;
        let sections = location.sections || [];

        // Add or update section
        const existingIndex = sections.findIndex(s => s._id === sectionId || s.id === sectionId);
        const newSection = {
            "_id": sectionId,
            "id": sectionId,
            "name": sectionData.name,
            "visualsignsofleak": sectionData.visualsignsofleak,
            "furtherinvasivereviewrequired": sectionData.furtherinvasivereviewrequired,
            "conditionalassessment": sectionData.conditionalassessment,
            "visualreview": sectionData.visualreview
        };

        if (existingIndex >= 0) {
            sections[existingIndex] = newSection;
        } else {
            sections.push(newSection);
        }

        const updatedLocation = { ...location, sections };
        await collection.upsert(locationId, updatedLocation);

        return {
            data: {
                message: "Section added to location successfully.",
                code: 201,
                modifiedCount: 1
            }
        };
    } catch (error) {
        return {
            error: {
                code: 500,
                message: "Error updating section in location.",
                errordata: error
            }
        };
    }
}

var updateSectionInLocationsRemove = async function (locationId, sectionId) {
    try {
        const collection = await getLocationsCollection();
        const doc = await collection.get(locationId);

        if (!doc || !doc.content) {
            return {
                error: {
                    code: 404,
                    message: "Location not found."
                }
            };
        }

        const location = doc.content;
        let sections = location.sections || [];

        // Remove section from sections array
        sections = sections.filter(s => s._id !== sectionId && s.id !== sectionId);

        const updatedLocation = { ...location, sections };
        await collection.upsert(locationId, updatedLocation);

        return {
            data: {
                message: "Section removed from location successfully.",
                code: 201,
                modifiedCount: 1
            }
        };
    } catch (error) {
        return {
            error: {
                code: 500,
                message: "Error removing section from location.",
                errordata: error
            }
        };
    }
}

module.exports = {
    addLocation,
    updateLocationVisibilityStatus,
    deleteLocationPermanently,
    updateLocation,
    getLocationById,
    addRemoveSections,
    getLocationByParentId,
    hasInspectionData,
    editLocation,
    updateSectionInLocationsAdd,
    updateSectionInLocationsRemove
};
