"use strict";

const express = require('express');
const { ObjectId } = require('mongodb');
const InvasiveSectionService = require("../service/invasiveSectionService");
const { v4: uuidv4 } = require('uuid');
const redisManager = require('./redisService');

module.exports = async function invasiveSectionSocketHandler(message, ws) {
    try {
        const parsedMessage = JSON.parse(message);

        switch (parsedMessage.action) {
            case 'create':
                try{
                    const data = typeof parsedMessage.data === 'string' ? JSON.parse(parsedMessage.data) : parsedMessage.data || {};
                    const { invasiveDescription, parentid, postinvasiverepairsrequired, invasiveimages, companyIdentifier, id, createdby, creationtime } = data;

                    // Validate user input
                    if (!parentid) {
                        ws.send(JSON.stringify({ status: 'error', code:400, message:'parentid is required' }));
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
                        ws.send(JSON.stringify({ status: 'error', code: result.code, message: result.reason }));
                        return false;
                    }
                    ws.send(JSON.stringify({ status: 'success', code:201, message:result }));
                    return true;
                }
                catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error', code:500, message:exception.message }));
                    return false;
                }
            case 'edit':
                try {
                    const data = typeof parsedMessage.data === 'string' ? JSON.parse(parsedMessage.data) : parsedMessage.data || {};
                    const { invasivesectionId, ...newDataRaw } = data;
                    if (!invasivesectionId) {
                        ws.send(JSON.stringify({ status: 'error', code:400, message:'invasivesectionId is required' }));
                        return false;
                    }
                    let newData = typeof newDataRaw === 'string' ? JSON.parse(newDataRaw) : newDataRaw;

                    if (newData.parentid) {
                        try { newData.parentid = new ObjectId(newData.parentid); } catch (e) { /* ignore invalid id */ }
                    }

                    if (newData.postinvasiverepairsrequired !== undefined) {
                        newData.postinvasiverepairsrequired = String(newData.postinvasiverepairsrequired).toLowerCase() === 'true';
                    }

                    // attach op metadata
                    const opId2 = uuidv4();
                    newData.__lastOpId = opId2;
                    newData.__lastOpClient = `${ws.clientId}.${newData.companyIdentifier || data.companyIdentifier}`;

                    const result = await InvasiveSectionService.editInvasiveSection(invasivesectionId, newData);
                    if (result && result.reason) {
                        ws.send(JSON.stringify({ status: 'error', code: result.code, message: result.reason }));
                        return false;
                    }
                    ws.send(JSON.stringify({ status: 'success', code:200, message:result }));
                    return true;
                } catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error', code:500, message:exception.message }));
                    return false;
                }
            case 'delete':
                try {
                    const parsedData = typeof parsedMessage.data === 'string' ? JSON.parse(parsedMessage.data) : parsedMessage.data || {};
                    const invasivesectionId = parsedData.invasivesectionId || parsedData.id || null;
                    const companyIdentifier = parsedData.companyIdentifier;

                    if (!invasivesectionId) {
                        ws.send(JSON.stringify({ status: 'error', code:400, message:'invasivesectionId is required' }));
                        return false;
                    }

                    // mark pending origin
                    const origin = `${ws.clientId}.${companyIdentifier}`;
                    await redisManager.markPendingOrigin('invasiveSection', invasivesectionId, origin, 60);

                    const result = await InvasiveSectionService.deleteInvasiveSectionPermanently(invasivesectionId);
                    if (result && result.reason) {
                        ws.send(JSON.stringify({ status: 'error', code: result.code, message: result.reason }));
                        return false;
                    }
                    ws.send(JSON.stringify({ status: 'success', code:200, message:result }));
                    return true;
                }
                catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error', code:500, message:exception.message }));
                    return false;
                }
            default:
                ws.send(JSON.stringify({ status: 'error', code:400, message:'Invalid action' }));
                return false;
        }
    }
    catch (error) {
        console.error('Error processing message:', error);
        ws.send(JSON.stringify({ status: 'error', code:500, message:'Internal server error' }));
        return false;
    }
}