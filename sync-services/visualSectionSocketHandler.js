"use strict";

const express = require('express');
const { ObjectId } = require('mongodb');
const SectionService = require("../service/sectionService");

module.exports = async function visualSectionSocketHandler(message, ws) {
    try {
        const parsedMessage = JSON.parse(message);
        var messageId = parsedMessage.messageId;
        // Example: Handle different actions for the "locations" collection
        switch (parsedMessage.action) {
            case 'create':
                try {
                    // Get user input
                    const {id, name, exteriorelements, waterproofingelements,additionalconsiderations,
                        additionalconsiderationshtml,visualreview,visualsignsofleak,furtherinvasivereviewrequired,conditionalassessment,
                      awe,eee,lbc,images,createdby,parentid,parenttype,unitUnavailable,createdat,editedat,lasteditedby } = JSON.parse(parsedMessage.data);
                      
                      // Validate user input
                      if (!(name && parentid)) {
                        ws.send(JSON.stringify({ status: 'error',messageId, code: 400, message: 'Name and parentid is required' }));
                        return;
                      }
                      //var creationtime= (new Date(Date.now())).toISOString();
                      var newSection = {
                        "_id": new ObjectId(id),
                          "additionalconsiderations":additionalconsiderations,
                          "additionalconsiderationshtml":additionalconsiderationshtml? additionalconsiderationshtml: "",
                          "awe":awe, 
                          "conditionalassessment":conditionalassessment,
                          "createdat":createdat,
                          "createdby":createdby,
                          "editedat":editedat,
                          "lasteditedby":lasteditedby,
                          "eee":eee,
                          "exteriorelements":exteriorelements,
                          "furtherinvasivereviewrequired":furtherinvasivereviewrequired,
                          "lbc": lbc,
                          "name":name,
                          "parentid": new ObjectId(parentid),
                          "parenttype":parenttype,
                          "visualreview":visualreview,
                          "visualsignsofleak": visualsignsofleak,
                          "waterproofingelements":waterproofingelements,
                          "images":images,
                          "unitUnavailable": unitUnavailable,
                          "isuploading":false,
                      } 
                      var result = await SectionService.addSection(newSection);

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
                    const { id, ...updates } = JSON.parse(parsedMessage.data);

                    // Validate user input
                    if (!id) {
                        ws.send(JSON.stringify({ status: 'error', messageId, code: 400, message: 'ID is required' }));
                        return;
                    }
                    // Update the subproject in the database
                    var result = await SectionService.editSetion(id, updates);

                    if (result.reason) {
                        ws.send(JSON.stringify({ status: 'error', messageId, code: result.code, message: result.reason }));
                        return;
                    }
                    if (result) {
                        ws.send(JSON.stringify({ status: 'success', messageId, code: 200, message: result }));
                        return;
                    }
                }
                catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error', messageId, code: 500, message: exception.message }));
                    return;
                }
                break;
            case 'addImage':
                try {
                    // Get user input
                    const { sectionId, imageUrl } = JSON.parse(parsedMessage.data);

                    // Validate user input
                    if (!sectionId || !imageUrl) {
                        ws.send(JSON.stringify({ status: 'error', messageId, code: 400, message: 'Section ID and Image URL are required' }));
                        return;
                    }
                    // Add image to the section in the database
                    var result = await SectionService.addImageInSection(sectionId, imageUrl);

                    if (result.reason) {
                        ws.send(JSON.stringify({ status: 'error', messageId, code: result.code, message: result.reason }));
                        return;
                    }
                    if (result) {
                        ws.send(JSON.stringify({ status: 'success', messageId, code: 200, message: result }));
                        return;
                    }
                }
                catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error', messageId, code: 500, message: exception.message }));
                    return;
                }
                break;
            case 'delete':
                try {
                    // Get user input
                    const { id } = JSON.parse(parsedMessage.data);

                    // Validate user input
                    if (!id) {
                        ws.send(JSON.stringify({ status: 'error', messageId, code: 400, message: 'ID is required' }));
                        return;
                    }
                    // Delete the subproject from the database
                    var result = await SectionService.deleteSectionPermanently(id);

                    if (result.reason) {
                        ws.send(JSON.stringify({ status: 'error', messageId, code: result.code, message: result.reason }));
                        return;
                    }
                    if (result) {
                        ws.send(JSON.stringify({ status: 'success', messageId, code: 200, message: result }));
                        return;
                    }
                }
                catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error', messageId, code: 500, message: exception.message }));
                    return;
                }
                break;
            default:
                ws.send(JSON.stringify({ status: 'error', messageId, code: 400, message: 'Unknown action' }));
                return;
        }
    }
    catch (error) {
        console.error('Error processing message:', error);
        ws.send(JSON.stringify({ status: 'error', messageId, code: 500, message: 'Internal server error' }));
    }
}
