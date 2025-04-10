"use strict";

const express = require('express');
const { ObjectId } = require('mongodb');
const SectionService = require("../service/sectionService");

module.exports = async function visualSectionSocketHandler(message, ws) {
    try {
        const parsedMessage = JSON.parse(message);

        // Example: Handle different actions for the "locations" collection
        switch (parsedMessage.action) {
            case 'create':
                try {
                    // Get user input
                    const { name, exteriorelements, waterproofingelements,additionalconsiderations,
                        additionalconsiderationshtml,visualreview,visualsignsofleak,furtherinvasivereviewrequired,conditionalassessment,
                      awe,eee,lbc,images,createdby,parentid,parenttype,unitUnavailable,creationtime } = req.body;
                      
                      // Validate user input
                      if (!(name&&parentid)) {
                        ws.send(JSON.stringify({ status: 'error', code:400, message:'Name and parentid is required' }));
                        return;
                      }
                      //var creationtime= (new Date(Date.now())).toISOString();
                      var newSection = {
                          "additionalconsiderations":additionalconsiderations,
                          "additionalconsiderationshtml":additionalconsiderationshtml? additionalconsiderationshtml: "",
                          "awe":awe, 
                          "conditionalassessment":conditionalassessment,
                          "createdat":creationtime,
                          "createdby":createdby,
                          "editedat":creationtime,
                          "lasteditedby":createdby,
                          "eee":eee,
                          "exteriorelements":exteriorelements,
                          "furtherinvasivereviewrequired":furtherinvasivereviewrequired.toLowerCase()==='true',
                          "lbc": lbc,
                          "name":name,
                          "parentid": new ObjectId(parentid),
                          "parenttype":parenttype,
                          "visualreview":visualreview,
                          "visualsignsofleak": visualsignsofleak.toLowerCase()==='true',
                          "waterproofingelements":waterproofingelements,
                          "images":images,
                          "unitUnavailable": unitUnavailable,
                          "isuploading":false,
                      } 
                      var result = await SectionService.addSection(newSection);

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
                    var result = await SectionService.editSetion(id, updates);

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
                    var result = await SectionService.deleteSectionPermanently(id);

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
