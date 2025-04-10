"use strict";
const DynamicSectionService = require("../service/dynamicSectionService");
const express = require('express');
const { ObjectId } = require('mongodb');

module.exports = async function dynamicSectionSocketHandler(message, ws) {
    try {
        const parsedMessage = JSON.parse(message);

        // Example: Handle different actions for the "projects" collection
        switch (parsedMessage.action) {
            case 'create':
                try{
                    var errResponse; 
                    // Get user input
                    
                    const { name,additionalconsiderations, questions,
                      additionalconsiderationshtml,furtherinvasivereviewrequired,images,createdby,parentid,parenttype,unitUnavailable, companyIdentifier,creationtime } = req.body;
                    
                    // Validate user input
                    if (!(name&&parentid)) {
                
                      ws.send(JSON.stringify({ status: 'error', code:400, message:'Name and ParentId is required' }));
                      return;
                    }
                    //var creationtime= (new Date(Date.now())).toISOString();
                    var newSection = {
                        "additionalconsiderations":additionalconsiderations,
                        "additionalconsiderationshtml":additionalconsiderationshtml? additionalconsiderationshtml: "",
                        "createdat":creationtime,
                        "createdby":createdby,
                        "editedat":creationtime,
                        "lasteditedby":createdby,
                        "furtherinvasivereviewrequired":furtherinvasivereviewrequired.toLowerCase()==='true',
                        "name":name,
                        "parentid": new ObjectId(parentid),
                        "parenttype":parenttype,
                        "images":images,
                        "questions": questions,
                        "unitUnavailable": unitUnavailable,
                        "companyIdentifier": companyIdentifier
                    } 
                    var result = await DynamicSectionService.addSection(newSection);    
                    if (result.reason) {
                      
                      ws.send(JSON.stringify({ status: 'error', code:result.code, message:result.reason }));
                      return;
                    }
                    if (result) {
                      //console.debug(result);
                      
                      ws.send(JSON.stringify({ status: 'success', code:201, message:result }));
                      return;
                    }
                    }
                    catch (exception) {
                    ws.send(JSON.stringify({ status: 'error', code:500, message:exception.message }));
                    return ;
                    }
                break;
            case 'update':
                try {
                    const { id, updates } = parsedMessage.data;
                    if (!id || !updates) {
                        ws.send(JSON.stringify({ status: 'error', message: 'ID and updates are required' }));
                        return;
                    }
                    
                    const result = await DynamicSectionService.editSetion(id, updates);
                    if (result) {
                        ws.send(JSON.stringify({ status: 'success', message: 'Section updated successfully' }));
                    } else {
                        ws.send(JSON.stringify({ status: 'error', message: 'Failed to update section' }));
                    }
                } catch (exception) {
                    ws.send(JSON.stringify({ status: 'error', message: exception.message }));
                }
                break;
            case 'delete':
                try {
                    const { id } = parsedMessage.data;
                    if (!id) {
                        ws.send(JSON.stringify({ status: 'error', message: 'ID is required' }));
                        return;
                    }
                    
                    const result = await DynamicSectionService.deleteSection(id);
                    if (result) {
                        ws.send(JSON.stringify({ status: 'success', message: 'Section deleted successfully' }));
                    } else {
                        ws.send(JSON.stringify({ status: 'error', message: 'Failed to delete section' }));
                    }
                } catch (exception) {
                    ws.send(JSON.stringify({ status: 'error', message: exception.message }));
                }
                break;
            default:
                ws.send(JSON.stringify({ status: 'error', message: 'Unknown action' }));
        }
    }   
    catch (error) {
        console.error("Error in dynamicSectionSocketHandler:", error);
        ws.send(JSON.stringify({ status: 'error', message: 'Internal server error' }));
    }
}