"use strict";
const DynamicSectionService = require("../service/dynamicSectionService");
const express = require('express');
const { ObjectId } = require('mongodb');
const { v4: uuidv4 } = require('uuid');
const redisManager = require('./redisService');

module.exports = async function dynamicSectionSocketHandler(message, ws) {
    try {
        const parsedMessage = JSON.parse(message);
        var messageId = parsedMessage.messageId;
        // Handle different actions for dynamic sections
        switch (parsedMessage.action) {
            case 'create':
                try{
                    const data = typeof parsedMessage.data === 'string' ? JSON.parse(parsedMessage.data) : parsedMessage.data || {};
                    const { name, additionalconsiderations, questions, additionalconsiderationshtml, furtherinvasivereviewrequired, images, createdby, parentid, parenttype, unitUnavailable, companyIdentifier, creationtime, id } = data;
                    if (!(name && parentid)) {
                      ws.send(JSON.stringify({ status: 'error', code:400,messageId, message:'Name and ParentId are required' }));
                      return false;
                    }
                    const newSection = {
                        additionalconsiderations: additionalconsiderations,
                        additionalconsiderationshtml: additionalconsiderationshtml || "",
                        createdat: creationtime,
                        createdby: createdby,
                        editedat: creationtime,
                        lasteditedby: createdby,
                        furtherinvasivereviewrequired: (String(furtherinvasivereviewrequired || '').toLowerCase() === 'true'),
                        name: name,
                        parentid: new ObjectId(parentid),
                        parenttype: parenttype,
                        images: images,
                        questions: questions,
                        unitUnavailable: unitUnavailable,
                        companyIdentifier: companyIdentifier,
                        _id: id ? new ObjectId(id) : undefined
                    };

                    // attach op metadata
                    const opId = uuidv4();
                    newSection.__lastOpId = opId;
                    newSection.__lastOpClient = `${ws.clientId}.${companyIdentifier}`;

                    const result = await DynamicSectionService.addSection(newSection);
                    if (result.reason) {
                      ws.send(JSON.stringify({ status: 'error',messageId, code:result.code, message:result.reason }));
                      return false;
                    }
                    ws.send(JSON.stringify({ status: 'success',messageId, code:201, message:result }));
                    return true;
                } catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error',messageId, code:500, message:exception.message }));
                    return false;
                }
            case 'update':
                try {
                    const data = typeof parsedMessage.data === 'string' ? JSON.parse(parsedMessage.data) : parsedMessage.data || {};
                    const { id, updates } = data;
                    if (!id) {
                      ws.send(JSON.stringify({ status: 'error',messageId, code:400, message:'ID is required' }));
                      return false;
                    }
                    let newData = updates || data.updates || data;
                    // attach op metadata
                    const opId2 = uuidv4();
                    newData.__lastOpId = opId2;
                    newData.__lastOpClient = `${ws.clientId}.${newData.companyIdentifier || data.companyIdentifier}`;

                    const result = await DynamicSectionService.editSetion(id, newData);
                    if (result.reason) {
                      ws.send(JSON.stringify({ status: 'error',messageId, code:result.code, message:result.reason }));
                      return false;
                    }
                    ws.send(JSON.stringify({ status: 'success',messageId, code:200, message:result }));
                    return true;
                } catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error',messageId, code:500, message:exception.message }));
                    return false;
                }
            case 'delete':
                try {
                    const data = typeof parsedMessage.data === 'string' ? JSON.parse(parsedMessage.data) : parsedMessage.data || {};
                    const id = data.id || data.dynamicSectionId || null;
                    const companyIdentifier = data.companyIdentifier;
                    if (!id) {
                      ws.send(JSON.stringify({ status: 'error',messageId, code:400, message:'ID is required' }));
                      return false;
                    }
                    // mark pending origin so change stream can read origin for deletes
                    const origin = `${ws.clientId}.${companyIdentifier}`;
                    await redisManager.markPendingOrigin('dynamicSection', id, origin, 60);

                    const result = await DynamicSectionService.deleteSection(id);
                    if (result.reason) {
                      ws.send(JSON.stringify({ status: 'error',messageId, code:result.code, message:result.reason }));
                      return false;
                    }
                    ws.send(JSON.stringify({ status: 'success',messageId, code:200, message:result }));
                    return true;
                } catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error',messageId, code:500, message:exception.message }));
                    return false;
                }
            default:
                ws.send(JSON.stringify({ status: 'error',messageId, code:400, message:'Unknown action' }));
                return false;
        }
    } catch (error) {
        console.error("Error in dynamicSectionSocketHandler:", error);
        ws.send(JSON.stringify({ status: 'error',messageId, code:500, message:'Internal server error' }));
        return false;
    }
}