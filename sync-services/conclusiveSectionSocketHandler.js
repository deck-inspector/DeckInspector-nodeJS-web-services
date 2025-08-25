"use strict";
const ConclusiveSectionService = require("../service/conclusiveSectionService");
const express = require('express');
const { ObjectId } = require('mongodb');
const { v4: uuidv4 } = require('uuid');
const redisManager = require('./redisService');

module.exports = async function conclusiveSectionSocketHandler(message, ws) {
    try {
        const parsedMessage = JSON.parse(message);
        var messageId = parsedMessage.messageId;
        switch (parsedMessage.action) {
            case 'create':
                try{
                    const data = typeof parsedMessage.data === 'string' ? JSON.parse(parsedMessage.data) : parsedMessage.data || {};
                    const { aweconclusive,conclusiveconsiderations,eeeconclusive,
                        invasiverepairsinspectedandcompleted,lbcconclusive,
                        parentid,propowneragreed,conclusiveimages, companyIdentifier } = data;
                    
                    // Validate user input
                    if (!(parentid)) {
                      ws.send(JSON.stringify({ status: 'error',messageId, code:400, message:'parentid is required' }));
                      return false;
                    }
                    const newConclusiveSection = {
                        "aweconclusive":aweconclusive,
                        "conclusiveconsiderations" :conclusiveconsiderations,
                        "eeeconclusive":eeeconclusive,
                        "invasiverepairsinspectedandcompleted": String(invasiverepairsinspectedandcompleted || '').toLowerCase()==='true',
                        "parentid": new ObjectId(parentid), 
                        "propowneragreed": String(propowneragreed || '').toLowerCase()==='true',
                        "conclusiveimages":conclusiveimages,
                        "lbcconclusive":lbcconclusive,
                        companyIdentifier: companyIdentifier
                    } 
                    // attach op metadata
                    const opId = uuidv4();
                    newConclusiveSection.__lastOpId = opId;
                    newConclusiveSection.__lastOpClient = `${ws.clientId}.${companyIdentifier}`;

                    const result = await ConclusiveSectionService.addConclusiveSection(newConclusiveSection);    
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
                    const { conclusiveSectionId,...newData } = data;
                    if(newData.parentid){
                      newData.parentid = new ObjectId(newData.parentid);
                    }
            
                    if(newData.propowneragreed){
                      newData.propowneragreed = newData.propowneragreed.toLowerCase()==='true' ;
                    }
            
                    if(newData.invasiverepairsinspectedandcompleted)
                    {
                      newData.invasiverepairsinspectedandcompleted = newData.invasiverepairsinspectedandcompleted.toLowerCase()==='true' ;
                    }
                    // attach op metadata
                    const opId2 = uuidv4();
                    newData.__lastOpId = opId2;
                    newData.__lastOpClient = `${ws.clientId}.${newData.companyIdentifier || data.companyIdentifier}`;

                    const result = await ConclusiveSectionService.editConclusiveSection(conclusiveSectionId, newData);
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
                    const id = data.id || data.conclusiveSectionId || null;
                    const companyIdentifier = data.companyIdentifier;
                    if (!id) {
                      ws.send(JSON.stringify({ status: 'error',messageId, code:400, message:'ID is required' }));
                      return false;
                    }
                    // mark pending origin so change stream can read origin for deletes
                    const origin = `${ws.clientId}.${companyIdentifier}`;
                    await redisManager.markPendingOrigin('conclusiveSection', id, origin, 60);

                    const result = await ConclusiveSectionService.archiveConclusiveSection(id);
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
        console.error("Error in conclusiveSectionSocketHandler:", error);
        ws.send(JSON.stringify({ status: 'error',messageId, code:500, message:'Internal server error' }));
        return false;
    }
}