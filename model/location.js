"use strict";
var ObjectId = require('mongodb').ObjectId;
var mongo = require('../database/mongo');
const Projects = require('./project');
const SubProjects = require('./subproject');
const Sections = require('./sections');
const couchbase = require("../database/couchbase");


var addLocation = async function (location) {
    var response = {};
    try {
        var result = await mongo.Locations.insertOne(location);

        if (result.insertedId) {
            if (location.parenttype == "subproject")
                var projresult = await mongo.SubProjects.updateOne({ _id: new ObjectId(location.parentid) }, {
                    $push:
                    {
                        children:
                        {
                            "_id": result.insertedId,
                            "name": location.name,
                            "description": location.description,
                            "url": location.url,
                            "type": location.type,
                            "isInvasive": false,
                            "count": 0
                        }
                    }
                });
            else
                var projresult = await mongo.Projects.updateOne({ _id: new ObjectId(location.parentid) }, {
                    $push:
                    {
                        children:
                        {
                            "_id": result.insertedId,
                            "name": location.name,
                            "description": location.description,
                            "url": location.url,
                            "type": location.type,
                            "isInvasive": false,
                            "count": 0
                        }
                    }
                });

            if (projresult.modifiedCount > 0) {
                var msg = "Location inserted successfully,parent updated successfully."
            }
            else
                var msg = "Location inserted successfully,parent failed to updated."

            response = {
                "data": {
                    "id": result.insertedId,
                    "message": msg,
                    "code": 201
                }
            }
        }
        else {
            response = {
                "error": {
                    "code": 500,
                    "message": "No Location inserted."
                }
            }
        }
        return response;
    } catch (error) {
        response = {
            "error": {
                "code": 500,
                "message": "No Location inserted.",
                "err": error
            }
        }
    }

};


var getLocationById = async function (id) {
    var response = {};
    try {
        const result = await mongo.Locations.findOne({ _id: new ObjectId(id) });

        if (result) {
            response = {
                "data": {
                    "item": result,
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
            }
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
        }
        return response;
    }
};

var updateLocation = async function (location) {
    var response = {};
    try {
        var result = await mongo.Locations.updateOne({ _id: new ObjectId(location.id) }, {
            $set: {
                name: location.name,
                description: location.description,
                url: location.url,
                lasteditedby: location.lasteditedby,
                editedat: location.editedat
            },
        });

        if (result.matchedCount < 1) {
            response = {
                "error": {
                    "code": 401,
                    "message": "No Location found."
                }
            }
            return response;
        } else {
            if (result.modifiedCount == 1) {
                if (location.parentType == "subproject") {
                    var projresult = await mongo.SubProjects.updateOne(
                        {
                            "children.id": new ObjectId(location.id)
                        },
                        {
                            $set:
                            {
                                "children.$.name": location.name,
                                "children.$.description": location.description,
                                "children.$.url": location.url,
                            }
                        },
                        { upsert: false });
                }
                else {
                    var projresult = await mongo.Projects.updateOne(
                        {
                            "children.id": new ObjectId(location.id)
                        },
                        {
                            $set:
                            {
                                "children.$.name": location.name,
                                "children.$.description": location.description,
                                "children.$.url": location.url,
                            }
                        },
                        { upsert: false });
                }

                response = {
                    "data": {
                        "message": "Location updated successfully.",
                        "code": 201
                    }
                };
                return response;
            }
            else {
                response = {
                    "data": {
                        "message": "Failed to update the location details.",
                        "code": 409
                    }
                };
                return response;
            }
        }
    }
    catch (err) {
        response = {
            "error": {
                "code": 500,
                "message": "Error processing location updates.",
                "errordata": err
            }
        }
        return response;
    }

};
//Soft Delete/undelete
var updateLocationVisibilityStatus = async function (id,type, name, parentId, parentType, isVisible) {
    var response = {};
    try {
        //update the Projects collection as well.        
        var result = await mongo.Locations.updateOne({ _id: new ObjectId(id) }, { $set: { isdeleted: !isVisible } });
        if (result.matchedCount == 0) {
            response = {
                "error": {
                    "code": 405,
                    "message": "No location found, invalid id."
                }
            }
            return response;
        }
        if (result.modifiedCount == 1) {
            if (!isVisible) {
                if (parentType == "subproject")
                    var projresult = await mongo.SubProjects.updateOne({ _id: new ObjectId(parentId) }, { $pull: { children: { "id": new ObjectId(id) } } });
                else
                    var projresult = await mongo.Projects.updateOne({ _id: new ObjectId(parentId) }, { $pull: { children: { "id": new ObjectId(id) } } });
            }

            else {
                const result = await mongo.Locations.findOne({ _id: new ObjectId(id) });
                if (parentType == "subproject")
                    var projresult = await mongo.SubProjects.updateOne({ _id: new ObjectId(parentId) },
                        {
                            $push: {
                                children:
                                {
                                    "id": new ObjectId(id),
                                    "name": name,
                                    "type": type,
                                    "description": result.description,
                                    "url": result.url
                                }
                            }
                        });
                else
                    var projresult = await mongo.Projects.updateOne({ _id: new ObjectId(parentId) },
                        {
                            $push: {
                                children:
                                {
                                    "id": new ObjectId(id),
                                    "name": name,
                                    "type": "location",
                                    "description": result.description,
                                    "url": result.url
                                }
                            }
                        });
            }

            if (projresult.modifiedCount > 0) {
                var message = `Location state updated successfully,is Visible:${isVisible}.parent project updated successfully.`;
            }
            else
                var message = `Location state updated successfully,is Visible:${isVisible}.project failed to update.`;

            response = {
                "data": {
                    "message": message,
                    "code": 201
                }
            };
            return response;

        }
        else {
            response = {
                "error": {
                    "code": 405,
                    "message": "No location modified, try with changed visibility state."
                }
            }
            return response;
        }
    } catch (error) {
        response = {
            "error": {
                "code": 500,
                "message": "Error changing visibility of location.",
                "errordata": err
            }
        }
        return response;
    }
};

var editLocation = async function (locationId,newData) {
    var response ={};
    try{
        const updateObject = { $set: newData };
        var result = await mongo.Locations.updateOne({ _id: new ObjectId(locationId) },updateObject,{upsert:false});    
        console.log(result.modifiedCount);
        if(result.modifiedCount<1){
            response = {
                "error": {
                    "code": 401,
                    "message": "No Location found."
                  }
            }
            return response;
        } else{
            if(result.modifiedCount==1){
                var location = await mongo.Locations.findOne({ _id: new ObjectId(locationId) });

                console.log(location);
                if(location.parenttype == 'project')
                {
                    var projresult = await Projects.updateProjectChildrenWithRemove(location.parentid,locationId);
                    var projresult2 = await Projects.updateProjectChildrenWithAdd(location.parentid,locationId,location);
                }
                else if(location.parenttype == 'subproject')
                {
                    var projresult = await SubProjects.updateSubProjectChildrenWithRemove(location.parentid,locationId);
                    var projresult2 = await SubProjects.updateSubProjectChildrenWithAdd(location.parentid,locationId,location);
                }
                response = {
                    "data" :{                   
                        "message": "Location updated successfully.",
                        "code":201
                    }   
                };
                return response;
            }           
            else{
                response = {
                    "data" :{                    
                        "message": "Failed to update the Location details.",
                        "code":409
                    }   
                };
                return response;
            }                   
        }   
    }
    catch(err){
        console.log(err);
        response = {
            "error": {
                "code": 500,
                "message": "Error fetching Location.",
                "errordata": err
              }
        }
        return response;
    }
    
};


var deleteLocationPermanently = async function (id) {
    try {
        var locationData = await mongo.Locations.findOne({ _id: new ObjectId(id) });

        if(!locationData)
        {
            response = {
                "error": {
                    "code": 401,
                    "message": "No Location found."
                }
            }
            return response;
        }

        if(locationData.sections && locationData.sections.length>0)
        {
            //Delete Children 
            for(section of locationData.sections)
            {
                const result = await Sections.deleteSectionPermanently(section._id);   
                if(result.error)
                {
                    return result;
                }
            }
        }
        

        //Update Parent
        if(locationData.parenttype == "subproject")
        {
            await SubProjects.updateSubProjectChildrenWithRemove(locationData.parentid,locationData._id);
        }
        else if(locationData.parenttype == "project")
        {
            await Projects.updateProjectChildrenWithRemove(locationData.parentid,locationData._id);
        }

        //Delete self
        var result = await mongo.Locations.deleteOne({ _id: new ObjectId(id) });

        if (result.deletedCount == 1) {

            var response = {
                "data": {
                    "message": "Location deleted successfully.",
                    "code": 201
                }
            };
            return response;
        }
        else {
            response = {
                "error": {
                    "code": 401,
                    "message": "No Location found."
                }
            }
            return response;
        }
    }
    catch (err) {
        response = {
            "error": {
                "code": 500,
                "message": "Error deleting location.",
                "errordata": err
            }
        }
        return response;
    }

};

var addRemoveSections = async function (locationId, isAdd, { id, name }) {
    var response = {};
    try {
        if (isAdd)
            var result = await mongo.Locations.updateOne({ _id: new ObjectId(locationId) }, { $push: { sections: { "id": id, "name": name } } });
        else
            var result = await mongo.Locations.updateOne({ _id: new ObjectId(locationId) }, { $pull: { sections: { "id": id, "name": name } } });

        if (result.matchedCount == 0) {
            response = {
                "error": {
                    "code": 409,
                    "message": "No location found."
                }
            }
            return response;
        }
        if (result.modifiedCount == 1) {
            response = {
                "data": {
                    "message": "Location added/removed to/from the location successfully.",
                    "code": 201
                }
            };
            return response;
        }
        else {
            response = {
                "error": {
                    "code": 409,
                    "message": "Error adding/removing common location to/from the location."
                }
            }
            return response;
        }
    } catch (error) {
        response = {
            "error": {
                "code": 500,
                "message": "Error adding common location to the location.",
                "errordata": err
            }
        }
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

var updateSectionInLocationsAdd = async function(locationId,sectionId,sectionData)
{
    return await mongo.Locations.updateOne({ _id: new ObjectId(locationId) }, {
        $push: {
            sections: {
                "_id": new ObjectId(sectionId),
                "name": sectionData.name,
                "visualsignsofleak": sectionData.visualsignsofleak,
                "furtherinvasivereviewrequired": sectionData.furtherinvasivereviewrequired,
                "conditionalassessment": sectionData.conditionalassessment,
                "visualreview"  : sectionData.visualreview,
            }
        }
    });
}

var updateSectionInLocationsRemove = async function(locationId,sectionId)
{
    return await mongo.Locations.updateOne({ _id: new ObjectId(locationId) }, {
        $pull: {
            sections: {
                "_id": new ObjectId(sectionId),
            }
        }
    });
}

module.exports = {
    addLocation,
    updateLocationVisibilityStatus,
    deleteLocationPermanently,
    updateLocation,
    getLocationById,
    addRemoveSections,
    getLocationByParentId,
    editLocation,
    updateSectionInLocationsAdd,
    updateSectionInLocationsRemove
};