"use strict";
var ObjectId = require('mongodb').ObjectId;
const { JsonWebTokenError } = require('jsonwebtoken');
var mongo = require('../database/mongo');
const RatingMapping  = require("./ratingMapping.js");


var getConclusiveSectionById = async function(id){
    var response = {};
    try {
        const result = await mongo.ConclusiveSections.findOne({ _id: new ObjectId(id) });
        if (result) {
            transformData(result);
            response = {
                "data": {
                    "item": result,
                    "message": "Conclusive Section found.",
                    "code": 201
                }
            };
            return response;
        } else {
            response = {
                "error": {
                    "code": 401,
                    "message": "No Conclusive Section found."
                }
            }
            return response;
        }
    }
    catch (err) {
        console.log(err);
        response = {
            "error": {
                "code": 500,
                "message": "Error fetching Conclusive Section.",
                "errordata": err
            }
        }
        return response;
    }

}


var transformData = function(conclusiveSection) {
    // Pass through values that are already display labels (see model/sections.js).
    conclusiveSection.eeeconclusive = RatingMapping[conclusiveSection.eeeconclusive] || conclusiveSection.eeeconclusive;
    conclusiveSection.lbcconclusive = RatingMapping[conclusiveSection.lbcconclusive] || conclusiveSection.lbcconclusive;
    conclusiveSection.aweconclusive = RatingMapping[conclusiveSection.aweconclusive] || conclusiveSection.aweconclusive;
};

var getConclusiveSectionByParentId = async function(id){
    var response = {};
    try {
        const result = await mongo.ConclusiveSections.findOne({ parentid: new ObjectId(id) });
        
        if (result) {
            transformData(result);
            response = {
                "data": {
                    "item": result,
                    "message": "Conclusive Section found.",
                    "code": 201
                }
            };
            return response;
        } else {
            response = {
                "error": {
                    "code": 401,
                    "message": "No Conclusive Section found."
                }
            }
            return response;
        }
    }
    catch (err) {
        response = {
            "error": {
                "code": 500,
                "message": "Error fetching Conclusive Section.",
                "errordata": err
            }
        }
        return response;
    }

}

var addConclusiveSection = async function(conclusiveSection){
    var response = {};
    try {
        var result = await mongo.ConclusiveSections.insertOne(conclusiveSection);
        var insertedId = result.insertedId;
        if(insertedId){
            response = {
                "data": {
                    "id": insertedId,
                    "message": "Conclusive Section inserted Successfully",
                    "code": 201
                }
            }
        }
        else {
            response = {
                "error": {
                    "code": 500,
                    "message": "No Section inserted."
                }
            }
        }
        return response;
    } catch (error) {
        console.log(error);
    }
};

var editConclusiveSection = async function(conclusiveSectionId,newConclusiveData)
{
    var response ={};
    try{
        const updateObject = { $set: newConclusiveData };
        var result = await mongo.ConclusiveSections.updateOne({ _id: new ObjectId(conclusiveSectionId) },updateObject,{upsert:false});    
        
        if(result.modifiedCount<1){
            response = {
                "error": {
                    "code": 401,
                    "message": "No Conclusive Section found."
                  }
            }
            return response;
        } else{
            if(result.modifiedCount==1){
                response = {
                    "data" :{                   
                        "message": "Conclusive Section updated successfully.",
                        "code":201
                    }   
                };
                return response;
            }           
            else{
                response = {
                    "data" :{                    
                        "message": "Failed to update the Conclusive details.",
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
                "message": "Error fetching Conclusive.",
                "errordata": err
              }
        }
        return response;
    }
    
};

module.exports = {
    getConclusiveSectionById,
    getConclusiveSectionByParentId,
    addConclusiveSection,
    editConclusiveSection
};