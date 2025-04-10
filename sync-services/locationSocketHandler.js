"use strict";

const express = require('express');
const { ObjectId } = require('mongodb');
const LocationService = require('../service/locationService');

module.exports = async function locationSocketHandler(message, ws) {
    try {
        const parsedMessage = JSON.parse(message);

        // Example: Handle different actions for the "locations" collection
        switch (parsedMessage.action) {
            case 'create':
                try {
                    // Get user input
                    const { name, description, createdBy,url,parentid,parenttype,type,isInvasive, sequenceNo } = parsedMessage.data;

                    // Validate user input
                    if (!(name && parentid)) {
                        ws.send(JSON.stringify({ status: 'error', code: 400, message: 'Name and parentid are required' }));
                        return;
                    }

                    // Create a new subproject object
                    var newLocation = {
                        "name":name,
                        "description":description,    
                        "createdby":createdBy,
                        "url":url,
                        "createdat":creationtime,    
                        "parentid": new ObjectId(parentid),
                        "parenttype": parenttype,
                        "type":type,
                        "sections":[],
                        "lasteditedBy":createdBy,
                        "editedat":creationtime,
                        "isInvasive":isInvasive,
                        "sequenceNo": sequenceNo
                    }

                    // Save the new subproject to the database
                    var result = await LocationService.addLocation(newLocation);  

                    if (result.reason) {
                        ws.send(JSON.stringify({ status: 'error', code: result.code, message: result.reason }));
                        return;
                    }
                    if (result) {
                        ws.send(JSON.stringify({ status: 'success', code: 201, message: result }));
                        return;
                    }
                }
                catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error', code: 500, message: exception.message }));
                    return;
                }
                break;
            case 'update':
                try {
                    // Get user input
                    const { id, updates } = parsedMessage.data;

                    // Validate user input
                    if (!id) {
                        ws.send(JSON.stringify({ status: 'error', code: 400, message: 'ID is required' }));
                        return;
                    }

                    // Update the subproject in the database
                    var result = await LocationService.editLocation(id, updates);

                    if (result.reason) {
                        ws.send(JSON.stringify({ status: 'error', code: result.code, message: result.reason }));
                        return;
                    }
                    if (result) {
                        ws.send(JSON.stringify({ status: 'success', code: 200, message: result }));
                        return;
                    }
                }
                catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error', code: 500, message: exception.message }));
                    return;
                }
                break;
            case 'delete':
                try {
                    // Get user input
                    const { id } = parsedMessage.data;

                    // Validate user input
                    if (!id) {
                        ws.send(JSON.stringify({ status: 'error', code: 400, message: 'ID is required' }));
                        return;
                    }

                    // Delete the subproject from the database
                    var result = await LocationService.deleteLocationPermanently(id);

                    if (result.reason) {
                        ws.send(JSON.stringify({ status: 'error', code: result.code, message: result.reason }));
                        return;
                    }
                    if (result) {
                        ws.send(JSON.stringify({ status: 'success', code: 200, message: result }));
                        return;
                    }
                }
                catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error', code: 500, message: exception.message }));
                    return;
                }
                break;
            default:
                ws.send(JSON.stringify({ status: 'error', code: 400, message: 'Unknown action' }));
                return;
        }
    }
    catch (error) {
        console.error('Error processing message:', error);
        ws.send(JSON.stringify({ status: 'error', code: 500, message: 'Internal server error' }));
    }
}
