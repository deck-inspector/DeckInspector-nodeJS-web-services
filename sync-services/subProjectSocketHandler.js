"use strict";

const express = require('express');
const { ObjectId } = require('mongodb');
var SubProjectService = require('../service/subProjectService');

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
                        return;
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

                    // Save the new subproject to the database
                    var result = await SubProjectService.addSubProject(newSubProject);

                    if (result.reason) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code: result.code, message: result.reason }));
                        return;
                    }
                    if (result) {
                        ws.send(JSON.stringify({ status: 'success',messageId, code: 201, message: result }));
                        return;
                    }
                }
                catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error',messageId, code: 500, message: exception.message }));
                    return;
                }
                break;
            case 'update':
                try {
                    // Get user input
                    const { id, ...newData } = JSON.parse(parsedMessage.data);
                    if(newData.parentid){
                        newData.parentid = new ObjectId(newData.parentid);
                      }
                    // Validate user input
                    if (!id) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code: 400, message: 'ID is required' }));
                        return;
                    }

                    // Update the subproject in the database
                    var result = await SubProjectService.editSubProject(id, newData);

                    if (result.reason) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code: result.code, message: result.reason }));
                        return;
                    }
                    if (result) {
                        ws.send(JSON.stringify({ status: 'success',messageId, code: 200, message: result }));
                        return;
                    }        
                }
                catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error',messageId, code: 500, message: exception.message }));
                    return;
                }
                break;
            case 'delete':
                try {
                    // Get user input
                    const { id } = JSON.parse(parsedMessage.data);

                    // Validate user input
                    if (!id) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code: 400, message: 'ID is required' }));
                        return;
                    }

                    // Delete the subproject from the database
                    var result = await SubProjectService.deleteSubProjectPermanently(id);

                    if (result.reason) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code: result.code, message: result.reason }));
                        return;
                    }
                    if (result) {
                        ws.send(JSON.stringify({ status: 'success',messageId, code: 200, message: result }));
                        return;
                    }
                }
                catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error',messageId, code: 500, message: exception.message }));
                    return;
                }
                break;
            default:
                ws.send(JSON.stringify({ status: 'error',messageId, code: 400, message: 'Unknown action' }));
                return;
        }
    }
    catch (error) {
        console.error('Error processing message:', error);
        ws.send(JSON.stringify({ status: 'error', code: 500, message: 'Internal server error' }));
    }
}