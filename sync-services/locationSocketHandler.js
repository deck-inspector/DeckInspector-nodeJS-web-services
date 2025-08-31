"use strict";

const express = require('express');
const { ObjectId } = require('mongodb');
const LocationService = require('../service/locationService');
const { v4: uuidv4 } = require('uuid');
const redisManager = require('./redisService');

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
                        return false;
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

                    // attach op metadata
                    const opId = uuidv4();
                    newLocation.__lastOpId = opId;
                    newLocation.__lastOpClient = `${ws.clientId}.${companyIdentifier}`;

                    // Save the new subproject to the database
                    var result = await LocationService.addLocation(newLocation);  

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
                        ws.send(JSON.stringify({ status: 'error', messageId,code: 400, message: 'ID is required' }));
                        return false;
                    }

                    // Update the subproject in the database
                    var result = 
                    await LocationService.editLocation(id, newData);

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
                    const {id,url,parenttype,companyIdentifier} = JSON.parse(parsedMessage.data);

                    // attach op metadata
                    const opId = uuidv4();
                    // newData.__lastOpId = opId;
                    // newData.__lastOpClient = `${ws.clientId}.${companyIdentifier}`;
                    
                    // Validate user input
                    var editedat = (new Date(Date.now())).toISOString();
                    var result = await LocationService.updateImageUrl(id,url,ws.clientId,editedat,'location',parenttype);
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
            case 'updateImageCount':
                try {
                    const { id, childId, count, coverUrl } = JSON.parse(parsedMessage.data);
                    
                    // Validate user input
                    if (!id || !childId) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code: 400, message: 'ID and Child ID are required' }));
                        return false;
                    }

                    // Update the project in the database
                    var result = await LocationService.updateImageCount(id, childId, {"count": count, "coverUrl": coverUrl});

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
            case 'delete':
                try {
                    // Get user input
                    const { id } = JSON.parse(parsedMessage.data);

                    // Validate user input
                    if (!id) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code: 400, message: 'ID is required' }));
                        return false;
                    }

                    // mark pending origin so change stream can read origin for deletes
                    const origin = `${ws.clientId}.${JSON.parse(parsedMessage.data).companyIdentifier}`;
                    await redisManager.markPendingOrigin('location', id, origin, 60);

                    // Delete the subproject from the database
                    var result = await LocationService.deleteLocationPermanently(id);

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
        ws.send(JSON.stringify({ status: 'error',messageId, code: 500, message: 'Internal server error' }));
        return false;
    }
}
