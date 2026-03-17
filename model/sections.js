"use strict";
const { v4: uuidv4 } = require('uuid');
const couchbase = require('../database/couchbase');
const RatingMapping  = require("./ratingMapping.js");
const Locations = require('./location.js');

// Helper function to get Sections collection
async function getSectionsCollection() {
  return couchbase.Sections;
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

var addSection = async function (section) {
    var response = {};
    try {
        const collection = await getSectionsCollection();
        const sectionId = section.id || uuidv4();
        
        // Insert section
        const newSection = { ...section, id: sectionId };
        await collection.insert(sectionId, newSection);
        
        // Update parent location with section info
        const projresult = await Locations.updateSectionInLocationsAdd(section.parentid, sectionId, {
            name: section.name,
            visualsignsofleak: section.visualsignsofleak,
            furtherinvasivereviewrequired: section.furtherinvasivereviewrequired,
            conditionalassessment: section.conditionalassessment,
            visualreview: section.visualreview,
            count: 0
        });
        
        var msg = projresult && projresult.data ? 
            "Section inserted successfully,parent updated successfully." : 
            "Section inserted successfully,parent failed to updated.";
        
        // Mark invasive in hierarchy
        await markInvasive(newSection);
        
        response = {
            "data": {
                "id": sectionId,
                "message": msg,
                "code": 201
            }
        };
        return response;
    } catch (error) {
        console.log(error);
        response = {
            "error": {
                "code": 500,
                "message": "Error adding section.",
                "errordata": error
            }
        };
        return response;
    }
};


var markInvasive = async function(section) {
    if (section.furtherinvasivereviewrequired === true) {
        var parentId = section.parentid;
        var parentType = section.parenttype ? section.parenttype.toLowerCase().trim() : '';
        
        while (parentId && parentType) {
            if (parentType === 'buildinglocation' ||
                parentType === 'projectlocation' ||
                parentType === 'apartment') {
                try {
                    const locationsColl = await Locations.getLocationsCollection();
                    const locDoc = await locationsColl.get(parentId);
                    if (locDoc && locDoc.content) {
                        const updatedLoc = { ...locDoc.content, isInvasive: true };
                        await locationsColl.upsert(parentId, updatedLoc);
                        parentId = locDoc.content.parentid;
                        parentType = (locDoc.content.parenttype || '').toLowerCase().trim();
                    } else {
                        break;
                    }
                } catch (err) {
                    console.error("Error updating location in markInvasive:", err);
                    break;
                }
            }
            else if (parentType === 'subproject') {
                try {
                    const SubProjects = require('./subproject');
                    const subProjColl = await SubProjects.getSubProjectsCollection();
                    const subDoc = await subProjColl.get(parentId);
                    if (subDoc && subDoc.content) {
                        const updatedSub = { ...subDoc.content, isInvasive: true };
                        await subProjColl.upsert(parentId, updatedSub);
                        parentId = subDoc.content.parentid;
                        parentType = (subDoc.content.parenttype || '').toLowerCase().trim();
                    } else {
                        break;
                    }
                } catch (err) {
                    console.error("Error updating subproject in markInvasive:", err);
                    break;
                }
            }
            else if (parentType === 'project') {
                try {
                    const Projects = require('./project');
                    const projColl = await Projects.getProjectsCollection();
                    const projDoc = await projColl.get(parentId);
                    if (projDoc && projDoc.content) {
                        const updatedProj = { ...projDoc.content, isInvasive: true };
                        await projColl.upsert(parentId, updatedProj);
                    }
                } catch (err) {
                    console.error("Error updating project in markInvasive:", err);
                }
                parentId = undefined;
                parentType = undefined;
            } else {
                break;
            }
        }
    }
    return true;
}


var transformData = function(section) {
      section.visualreview = capitalizeWords(section.visualreview);
      section.visualsignsofleak = capitalizeWords(section.visualsignsofleak.toString());
      section.furtherinvasivereviewrequired = capitalizeWords(section.furtherinvasivereviewrequired.toString());
      section.conditionalassessment = capitalizeWords(section.conditionalassessment.toString());
      section.eee = RatingMapping[section.eee];
      section.lbc = RatingMapping[section.lbc];
      section.awe = RatingMapping[section.awe];

};

var capitalizeWords = function (word) {
    if(word)
    {
    var finalWord = word[0].toUpperCase() + word.slice(1);
    return finalWord;
    }
    return word;
}


var getSectionById = async function (id) {
    var response = {};
    try {
        const collection = await getSectionsCollection();
        const doc = await collection.get(id);
        
        if (doc && doc.content) {
            const result = doc.content;
            transformData(result);
            response = {
                "data": {
                    "item": result,
                    "message": "Section found.",
                    "code": 201
                }
            };
            return response;
        } else {
            response = {
                "error": {
                    "code": 401,
                    "message": "No Section found."
                }
            };
            return response;
        }
    }
    catch (err) {
        response = {
            "error": {
                "code": 500,
                "message": "Error fetching Section.",
                "errordata": err
            }
        };
        return response;
    }
};
//details will be a flexible structure of the form.
//images: array of image urls
var updateSection = async function (section, count) {
    var response = {};
    try {
        const collection = await getSectionsCollection();
        const doc = await collection.get(section.id);
        
        if (!doc || !doc.content) {
            response = {
                "error": {
                    "code": 401,
                    "message": "No Section found."
                }
            };
            return response;
        }
        
        // Update section
        const updatedSection = {
            ...doc.content,
            name: section.name,
            exteriorelements: section.exteriorelements,
            waterproofingelements: section.waterproofingelements,
            lasteditedby: section.lasteditedby,
            editedat: section.editedat,
            additionalconsiderations: section.additionalconsiderations,
            visualreview: section.visualreview,
            visualsignsofleak: section.visualsignsofleak,
            furtherinvasivereviewrequired: section.furtherinvasivereviewrequired,
            conditionalassessment: section.conditionalassessment,
            eee: section.eee,
            lbc: section.lbc,
            awe: section.awe,
            parentid: section.parentid
        };
        
        await collection.upsert(section.id, updatedSection);
        
        // Update parent location
        const projresult = await Locations.updateSectionInLocationsAdd(section.parentid, section.id, {
            name: section.name,
            visualsignsofleak: section.visualsignsofleak,
            furtherinvasivereviewrequired: section.furtherinvasivereviewrequired,
            conditionalassessment: section.conditionalassessment,
            visualreview: section.visualreview
        });
        
        var msg = projresult && projresult.data ? 
            "Section updated successfully,parent updated successfully." :
            "Section updated successfully,parent failed to update.";
        
        response = {
            "data": {
                "message": msg,
                "code": 201
            }
        };
        return response;
    }
    catch (err) {
        response = {
            "error": {
                "code": 500,
                "message": "Error processing Section updates.",
                "errordata": err
            }
        };
        return response;
    }
};

var editSection = async function(sectionId, newSectionData) {
    var response = {};
    try {
        const collection = await getSectionsCollection();
        const doc = await collection.get(sectionId);

        if (!doc || !doc.content) {
            response = {
                "error": {
                    "code": 401,
                    "message": "No Section found."
                }
            };
            return response;
        }

        if (newSectionData.furtherinvasivereviewrequired) {
             newSectionData.furtherinvasivereviewrequired = (newSectionData.furtherinvasivereviewrequired.toLowerCase() === 'true');
        }

        // Apply bulk updates
        const updatedSection = { ...doc.content, ...newSectionData };
        await collection.upsert(sectionId, updatedSection);

        if (newSectionData.furtherinvasivereviewrequired) {
            if (newSectionData.furtherinvasivereviewrequired === true) {
                await markInvasive(updatedSection);
            }
        }

        // Update parent location
        const projectResult = await Locations.updateSectionInLocationsRemove(updatedSection.parentid, sectionId);
        const projectResult2 = await Locations.updateSectionInLocationsAdd(updatedSection.parentid, sectionId, updatedSection);

        response = {
            "data": {
                "message": "Section updated successfully.",
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
                "message": "Error fetching Section.",
                "errordata": err
            }
        };
        return response;
    }
};
//Soft Delete/undelete
var updateSectionVisibilityStatus = async function (id, name, parentId, isVisible) {
    var response = {};
    try {
        const collection = await getSectionsCollection();
        const doc = await collection.get(id);

        if (!doc || !doc.content) {
            response = {
                "error": {
                    "code": 405,
                    "message": "No Section found, invalid id."
                }
            };
            return response;
        }

        const updatedSection = { ...doc.content, isdeleted: !isVisible };
        await collection.upsert(id, updatedSection);

        if (!isVisible) {
            await Locations.updateSectionInLocationsRemove(parentId, id);
        } else {
            const sectionDetails = doc.content;
            await Locations.updateSectionInLocationsAdd(parentId, id, {
                id: id,
                name: name,
                visualsignsofleak: sectionDetails.visualsignsofleak,
                furtherinvasivereviewrequired: sectionDetails.furtherinvasivereviewrequired,
                conditionalassessment: sectionDetails.conditionalassessment,
                visualreview: sectionDetails.visualreview
            });
        }

        var message = `Section state updated successfully, is Visible: ${isVisible}.`;

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
                "message": "Error changing visibility of Section.",
                "errordata": error
            }
        };
        return response;
    }
};

var deleteSectionPermanently = async function (id) {
    try {
        const collection = await getSectionsCollection();
        const doc = await collection.get(id);

        if (!doc || !doc.content) {
            var response = {
                "error": {
                    "code": 401,
                    "message": "No Section found."
                }
            };
            return response;
        }

        const section = doc.content;

        // Update Parent
        await Locations.updateSectionInLocationsRemove(section.parentid, id);

        // Delete self
        await collection.remove(id);

        var response = {
            "data": {
                "message": "Section deleted successfully.",
                "code": 201
            }
        };
        return response;
    }
    catch (err) {
        var response = {
            "error": {
                "code": 500,
                "message": "Error deleting Section.",
                "errordata": err
            }
        };
        return response;
    }
};

var addRemoveImages = async function (sectionId, count, isAdd, url) {
    var response = {};
    try {
        const collection = await getSectionsCollection();
        const doc = await collection.get(sectionId);

        if (!doc || !doc.content) {
            response = {
                "error": {
                    "code": 409,
                    "message": "No Section found."
                }
            };
            return response;
        }

        let images = doc.content.images || [];
        let newCount = count;

        if (isAdd) {
            if (!images.includes(url)) {
                images.push(url);
                newCount = ++count;
            }
        } else {
            images = images.filter(img => img !== url);
            newCount = --count;
        }

        const updatedSection = { ...doc.content, images };
        await collection.upsert(sectionId, updatedSection);

        // Update parent location with new count
        await Locations.updateSectionInLocationsAdd(doc.content.parentid, sectionId, {
            ...updatedSection,
            count: newCount
        });

        response = {
            "data": {
                "message": "Image added/removed to/from the Section successfully.",
                "code": 201
            }
        };
        return response;
    } catch (error) {
        response = {
            "error": {
                "code": 500,
                "message": "Error adding/removing image from Section.",
                "errordata": error
            }
        };
        return response;
    }
}

var getSectionMetaDataForLocationId = async function(locationId) {
    try {
        var response = {};
        const statement = `SELECT META(s).id as _id, s.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_SCOPE_NAME || "inventory"}\`.Section s WHERE s.parentid = $1`;
        const sectionDetails = await executeQuery(statement, [locationId]);

        if (sectionDetails.length > 0) {
            response = {
                "data": {
                    "item": sectionDetails,
                    "message": "Section found.",
                    "code": 201
                }
            };
            return response;
        } else {
            response = {
                "error": {
                    "code": 401,
                    "message": "No Section found."
                }
            };
            return response;
        }    
    } catch (error) {
        response = {
            "error": {
                "code": 500,
                "message": "Error fetching Section.",
                "errordata": error
            }
        };
        return response;
    }
}
module.exports = {
    addSection,
    updateSectionVisibilityStatus,
    deleteSectionPermanently,
    updateSection,
    getSectionById,
    addRemoveImages,
    getSectionMetaDataForLocationId,
    editSection,
    getSectionsCollection,
    executeQuery
};