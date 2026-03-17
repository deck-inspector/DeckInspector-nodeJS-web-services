"use strict";
var ObjectId = require('mongodb').ObjectId;

var mongo = require('../database/mongo');
const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");
const { MutateInSpec } = require("couchbase");


var getInvasiveSectionById = async function(id){
    var response = {};
    try {
        const result = await mongo.InvasiveSections.findOne({ _id: new ObjectId(id) });

        if (result) {
            response = {
                "data": {
                    "item": result,
                    "message": "Invasive Section found.",
                    "code": 201
                }
            };
            return response;
        } else {
            response = {
                "error": {
                    "code": 401,
                    "message": "No Invasive Section found."
                }
            }
            return response;
        }
    }
    catch (err) {
        response = {
            "error": {
                "code": 500,
                "message": "Error fetching Invasive Section.",
                "errordata": err
            }
        }
        return response;
    }
}

var addInvasiveSection = async function(invasiveSection){
    var response = {};
    try {
        var result = await mongo.InvasiveSections.insertOne(invasiveSection);
        var insertedId = result.insertedId;
        if(insertedId){
            response = {
                "data": {
                    "id": insertedId,
                    "message": "Invasive Section inserted Successfully",
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

var getInvasiveSectionByParentId = async function (id) {
    var response = {};

    try {
        const bucket = process.env.DB_BUCKET_NAME;
        const scope = process.env.DB_SCOPE_NAME || "inventory";
        const collection = "InvasiveSection";
        const cluster = couchbase.cluster;

        const query = `
            SELECT META(s).id AS id, s.*
            FROM \`${bucket}\`.\`${scope}\`.\`${collection}\` s
            WHERE s.parentid = $1
            LIMIT 1
        `;

        const result = await cluster.query(query, {
            parameters: [id]
        });

        if (result.rows && result.rows.length > 0) {
            response = {
                data: {
                    item: result.rows[0],
                    message: "Invasive Section found.",
                    code: 201
                }
            };
            return response;
        } else {
            response = {
                error: {
                    code: 401,
                    message: "No Invasive Section found."
                }
            };
            return response;
        }

    } catch (err) {
        response = {
            error: {
                code: 500,
                message: "Error fetching Invasive Section.",
                errordata: err
            }
        };
        return response;
    }
}

var editInvasiveSection = async function(invasiveSectionId,newInvasiveData)
{
    var response ={};
    try{
        const updateObject = { $set: newInvasiveData };
        var result = await mongo.InvasiveSections.updateOne({ _id: new ObjectId(invasiveSectionId) },updateObject,{upsert:false});    
        
        if(result.modifiedCount<1){
            response = {
                "error": {
                    "code": 401,
                    "message": "No Invasive Section found."
                  }
            }
            return response;
        } else{
            if(result.modifiedCount==1){
                response = {
                    "data" :{                   
                        "message": "Invasive Section updated successfully.",
                        "code":201
                    }   
                };
                return response;
            }           
            else{
                response = {
                    "data" :{                    
                        "message": "Failed to update the Invasive details.",
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
                "message": "Error fetching Invasive.",
                "errordata": err
              }
        }
        return response;
    }
    
};

module.exports = {
    getInvasiveSectionById,
    getInvasiveSectionByParentId,
    addInvasiveSection,
    editInvasiveSection
};