"use strict";

const express = require('express');
const { ObjectId } = require('mongodb');
var SubProjectService = require('../service/subProjectService');
const { v4: uuidv4 } = require('uuid');
const redisManager = require('./redisService');

module.exports = async function subProjectSocketHandler(message, ws) {
    try {
        const parsedMessage = JSON.parse(message);
        var messageId = parsedMessage.messageId;
        // Example: Handle different actions for the "projects" collection
        switch (parsedMessage.action) {
            case 'create':
                try {
                    // Get user input
                    const { id,name, description, parentid, parenttype, isInvasive, url, assignedto, createdby,companyIdentifier, sequenceNo,createdat,editedat,lasteditedby } = JSON.parse(parsedMessage.data); 
                    if (!(name && parentid)) {
                        ws.send(JSON.stringify({ status: 'error', code: 400,messageId, message: 'Name and parentid are required' }));
                        return false;
                    }

                    // Create a new subproject object
                    var newSubProject = {
                        "_id": ObjectId(id),
                        "name": name,
                        "description": description,
                        "parentid": new ObjectId(parentid),
                        "parenttype": parenttype,
                        "isInvasive": isInvasive,
                        "url": url,
                        "createdat": createdat,
                        "createdby": createdby,
                        "lasteditedby": lasteditedby,
                        "assignedto": assignedto,
                        "sequenceNo": sequenceNo,
                        "children": [],
                        "companyIdentifier": companyIdentifier,
                        "editedat": editedat,
                        "type": "subproject",
                        "editedat": createdat
                    }

                    // attach operation metadata so change stream can exclude origin
                    const opId = uuidv4();
                    newSubProject.__lastOpId = opId;
                    newSubProject.__lastOpClient = `${ws.clientId}.${companyIdentifier}`;

                    // Save the new subproject to the database
                    var result = await SubProjectService.addSubProject(newSubProject);

                    if (result.reason) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code: result.code, message: result.reason }));
                        return false;
                    }
                    if (result) {
                        ws.send(JSON.stringify({ status: 'success',messageId, code: 201, message: result }));
                        return true;
                    }
                }
                catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error',messageId, code: 500, message: exception.message }));
                    return false;
                }
                break;
            case 'update':
                try {
                    // Get user input
                    const { id, ...newData } = JSON.parse(parsedMessage.data);
                    if(newData.parentid){
                        newData.parentid = new ObjectId(newData.parentid);
                      }

                    // attach op metadata
                    const opId = uuidv4();
                    newData.__lastOpId = opId;
                    newData.__lastOpClient = `${ws.clientId}.${newData.companyIdentifier}`;

                    // Validate user input
                    if (!id) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code: 400, message: 'ID is required' }));
                        return false;
                    }

                    // Update the subproject in the database
                    var result = await SubProjectService.editSubProject(id, newData);

                    if (result.reason) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code: result.code, message: result.reason }));
                        return false;
                    }
                    if (result) {
                        ws.send(JSON.stringify({ status: 'success',messageId, code: 200, message: result }));
                        return true;
                    }        
                }
                catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error',messageId, code: 500, message: exception.message }));
                    return false;
                }
                break;
            case 'updateImageUrl':
                try {
                    const {id,url,companyIdentifier} = JSON.parse(parsedMessage.data);

                    // attach op metadata
                    const opId = uuidv4();
                    // newData.__lastOpId = opId;
                    // newData.__lastOpClient = `${ws.clientId}.${companyIdentifier}`;
                    
                    // Validate user input
                    var editedat = (new Date(Date.now())).toISOString();
                    var result = await SubProjectService.updateImageUrl(id,url,ws.clientId,editedat,'subproject','project');
                    if (result.reason) {
                        
                        ws.send(JSON.stringify({ status: 'error',messageId, code:result.code, message:result.reason }));
                        return false;
                    }
                    if (result) {
                        //console.debug(result);
                        ///return res.status(201).json(result);
                        ws.send(JSON.stringify({ status: 'success',messageId, code:201, message:result }));
                        return true;
                    }
                    }
                    catch (exception) {
                    console.error(exception);                   
                    ws.send(JSON.stringify({ status: 'error',messageId, code:500, message:exception.message }));
                    return false;
                    }
                break;
            case 'delete':
                try {
                    // Get user input
                    const { id, companyIdentifier } = JSON.parse(parsedMessage.data);

                    // Validate user input
                    if (!id) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code: 400, message: 'ID is required' }));
                        return false;
                    }

                    // mark pending origin so change stream can read origin for deletes
                    const origin = `${ws.clientId}.${companyIdentifier}`;
                    await redisManager.markPendingOrigin('subProject', id, origin, companyIdentifier, 60);

                    // Delete the subproject from the database
                    var result = await SubProjectService.deleteSubProjectPermanently(id);

                    if (result.reason) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code: result.code, message: result.reason }));
                        return false;
                    }
                    if (result) {
                        ws.send(JSON.stringify({ status: 'success',messageId, code: 200, message: result }));
                        return true;
                    }
                }
                catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error',messageId, code: 500, message: exception.message }));
                    return false;
                }
                break;
            default:
                ws.send(JSON.stringify({ status: 'error',messageId, code: 400, message: 'Unknown action' }));
                return false;
        }
    }
    catch (error) {
        console.error('Error processing message:', error);
        ws.send(JSON.stringify({ status: 'error', code: 500, message: 'Internal server error' }));
        return false;
    }
}