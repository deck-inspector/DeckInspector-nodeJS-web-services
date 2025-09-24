"use strict";

const express = require('express');
const { ObjectId } = require('mongodb');
const InvasiveSectionService = require("../service/invasiveSectionService");
const { v4: uuidv4 } = require('uuid');
const redisManager = require('./redisService');

module.exports = async function invasiveSectionSocketHandler(message, ws) {
    try {
        const parsedMessage = JSON.parse(message);
        //check if section is existing if not update the action to create
        var id = parsedMessage.id;
        var existingSection = await InvasiveSectionService.getInvasiveSectionById(id);
        if (!existingSection.success) {
            parsedMessage.action = 'create';
        }
        var messageId = parsedMessage.messageId;
        messageId;
        switch (parsedMessage.action) {
            case 'create':
                try{
                    const data = typeof parsedMessage.data === 'string' ? JSON.parse(parsedMessage.data) : parsedMessage.data || {};
                    const { invasiveDescription, parentid, postinvasiverepairsrequired, invasiveimages, companyIdentifier, id, createdby, creationtime } = data;

                    // Validate user input
                    if (!parentid) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code:400, message:'parentid is required' }));
                        return false;
                    }

                    const newInvasiveSection = {
                        invasiveDescription: invasiveDescription,
                        parentid: new ObjectId(parentid),
                        postinvasiverepairsrequired: String(postinvasiverepairsrequired || '').toLowerCase() === 'true',
                        invasiveimages: invasiveimages,
                        companyIdentifier: companyIdentifier,
                        createdat: creationtime,
                        createdby: createdby,
                        editedat: creationtime,
                        lasteditedby: createdby,
                        _id: id ? new ObjectId(id) : undefined
                    };

                    // attach op metadata
                    const opId = uuidv4();
                    newInvasiveSection.__lastOpId = opId;
                    newInvasiveSection.__lastOpClient = `${ws.clientId}.${companyIdentifier}`;

                    const result = await InvasiveSectionService.addInvasiveSection(newInvasiveSection);
                    if (result && result.reason) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code: result.code, message: result.reason }));
                        return false;
                    }
                    ws.send(JSON.stringify({ status: 'success',messageId, code:201, message:result }));
                    return true;
                }
                catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error',messageId, code:500, message:exception.message }));
                    return false;
                }
            case 'update':
                try {
                    const data = typeof parsedMessage.data === 'string' ? JSON.parse(parsedMessage.data) : parsedMessage.data || {};
                    const { id, ...newDataRaw } = data;
                    if (!id) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code:400, message:'invasivesectionId is required' }));
                        return false;
                    }
                    let newData = typeof newDataRaw === 'string' ? JSON.parse(newDataRaw) : newDataRaw;

                    if (newData.parentid) {
                        try { newData.parentid = new ObjectId(newData.parentid); } catch (e) { /* ignore invalid id */ }
                    }

                    if (newData.postinvasiveRepairsRequired !== undefined) {
                        newData.postinvasiveRepairsRequired = String(newData.postinvasiveRepairsRequired).toLowerCase() === 'true';
                    }

                    // attach op metadata
                    const opId2 = uuidv4();
                    newData.__lastOpId = opId2;
                    newData.__lastOpClient = `${ws.clientId}.${newData.companyIdentifier || data.companyIdentifier}`;
                    //check if its existing
                    
                    const result = await InvasiveSectionService.editInvasiveSection(id, newData);
                    if (result && result.reason) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code: result.code, message: result.reason }));
                        return false;
                    }
                    ws.send(JSON.stringify({ status: 'success',messageId, code:200, message:result }));
                    return true;
                } catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error',messageId, code:500, message:exception.message }));
                    return false;
                }
            case 'addImages':
                try {
                    // Get user input
                    const { id, images } = JSON.parse(parsedMessage.data);

                    // Validate user input
                    if (!id || !images || !Array.isArray(images)) {
                        ws.send(JSON.stringify({ status: 'error', messageId, code: 400, message: 'ID and Images are required' }));
                        return false;
                    }
                    // Add image to the section in the database
                    var result = await InvasiveSectionService.addImagesInInvasiveSection(id, images);

                    if (result.reason) {
                        ws.send(JSON.stringify({ status: 'error', messageId, code: result.code, message: result.reason }));
                        return false;
                    }
                    if (result) {
                        ws.send(JSON.stringify({ status: 'success', messageId, code: 200, message: result }));
                        return true;
                    }
                }
                catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error', messageId, code: 500, message: exception.message }));
                    return false;
                }
                break;
            case 'delete':
                try {
                    const parsedData = typeof parsedMessage.data === 'string' ? JSON.parse(parsedMessage.data) : parsedMessage.data || {};
                    const invasivesectionId = parsedData.invasivesectionId || parsedData.id || null;
                    const companyIdentifier = parsedData.companyIdentifier;

                    if (!invasivesectionId) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code:400, message:'invasivesectionId is required' }));
                        return false;
                    }

                    // mark pending origin
                    const origin = `${ws.clientId}.${companyIdentifier}`;
                    await redisManager.markPendingOrigin('invasiveSection', invasivesectionId, origin, companyIdentifier, 60);

                    const result = await InvasiveSectionService.deleteInvasiveSectionPermanently(invasivesectionId);
                    if (result && result.reason) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code: result.code, message: result.reason }));
                        return false;
                    }
                    ws.send(JSON.stringify({ status: 'success',messageId, code:200, message:result }));
                    return true;
                }
                catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error',messageId, code:500, message:exception.message }));
                    return false;
                }
            default:
                ws.send(JSON.stringify({ status: 'error',messageId, code:400, message:'Invalid action' }));
                return false;
        }
    }
    catch (error) {
        console.error('Error processing message:', error);
        ws.send(JSON.stringify({ status: 'error',messageId, code:500, message:'Internal server error' }));
        return false;
    }
}