"use strict";

const express = require('express');
const { ObjectId } = require('mongodb');
const LocationService = require('../service/locationService');

module.exports = async function locationSocketHandler(message, ws) {
    try {
        const parsedMessage = JSON.parse(message);
        var messageId = parsedMessage.messageId;
        // Example: Handle different actions for the "locations" collection
        switch (parsedMessage.action) {
            case 'create':
                try {
                    // Get user input
                    const {id, name, description, createdby,url,parentid,parenttype,type,isInvasive,companyIdentifier, sequenceNo,createdat } =JSON.parse( parsedMessage.data);

                    // Validate user input
                    if (!(name && parentid)) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code: 400, message: 'Name and parentid are required' }));
                        return;
                    }

                    // Create a new subproject object
                    var newLocation = {
                        "_id": ObjectId(id),
                        "name":name,
                        "description":description,    
                        "createdby":createdby,
                        "url":url,
                        "createdat":createdat,    
                        "parentid": new ObjectId(parentid),
                        "parenttype": parenttype,
                        "type":type,
                        "sections":[],
                        "lasteditedBy":createdby,
                        "editedat":createdat,
                        "isInvasive":isInvasive,
                        "sequenceNo": sequenceNo,
                        "companyIdentifier": companyIdentifier
                    }

                    // Save the new subproject to the database
                    var result = await LocationService.addLocation(newLocation);  

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
                        ws.send(JSON.stringify({ status: 'error', messageId,code: 400, message: 'ID is required' }));
                        return;
                    }

                    // Update the subproject in the database
                    var result = 
                    await LocationService.editLocation(id, newData);

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
            case 'updateImageCount':
                try {
                    const { id, childId, count, coverUrl } = JSON.parse(parsedMessage.data);
                    
                    // Validate user input
                    if (!id || !childId) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code: 400, message: 'ID and Child ID are required' }));
                        return;
                    }

                    // Update the project in the database
                    var result = await LocationService.addUpdateLocationChild(id, childId, {"count": count, "coverUrl": coverUrl});

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
                    var result = await LocationService.deleteLocationPermanently(id);

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
        ws.send(JSON.stringify({ status: 'error',messageId, code: 500, message: 'Internal server error' }));
    }
}
