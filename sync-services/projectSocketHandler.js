"use strict";
const projectService = require('../service/projectService');
const express = require('express');
const { ObjectId } = require('mongodb');

module.exports = async function projectSocketHandler(message, ws) {
    try {
        const parsedMessage = JSON.parse(message);

        // Example: Handle different actions for the "projects" collection
        switch (parsedMessage.action) {
            case 'create':
                try {
                    // Get user input
                    const { name, description, address, createdBy, url, assignedTo, projecttype, editedat,formId,companyIdentifier } = parsedMessage.data;
                    
                    // Validate user input
                    if (!name || !companyIdentifier) {                      
                      ws.send(JSON.stringify({ status: 'error', code:400, message:'Name/Company is required' }));
                      return;
                    }
            
                    // Create a new project object
                    var newProject = {
                      "name": name,
                      "description": description,
                      "address": address,
                      "createdby": createdBy,
                      "url": url,
                      "lasteditedby": createdBy,
                      "assignedto": assignedTo,
                      "editedat": new Date(editedat).toISOString(),
                      "children": [],
                      "projecttype": projecttype,
                      "createdat": new Date(editedat).toISOString(),
                      "iscomplete":false,
                      "isInvasive":false,
                      "companyIdentifier": companyIdentifier,
                      "formId": formId==null?null:ObjectId(formId)
                    }
            
                    // Save the new project to the database
                    var result = await projectService.addProject(newProject);
            
                    if (result.reason) {
                      
                      ws.send(JSON.stringify({ status: 'error', code:result.code, message:result.reason }));
                      return;
                    }
                    if (result) {
                      
                      ws.send(JSON.stringify({ status: 'success', code:201, message:result }));
                      return;
                    }
                  }
                  catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error', code:500, message:exception.message }));
                    return ;
                  }
                break;

            case 'update':
                try {
            
                    const {projectId,...newData} = parsedMessage.data;
                    newData.formId=newData.formId==null?null:ObjectId(newData.formId);
                    
                    // Validate user input
                    var result = await projectService.editProject(projectId,newData);
                    if (result.reason) {
                      
                      ws.send(JSON.stringify({ status: 'error', code:result.code, message:result.reason }));
                    }
                    if (result) {
                      //console.debug(result);
                      ///return res.status(201).json(result);
                      ws.send(JSON.stringify({ status: 'success', code:201, message:result }));
                    }
                  }
                  catch (exception) {
                    console.error(exception);                   
                    ws.send(JSON.stringify({ status: 'error', code:500, message:exception.message }));
                  }
                break;

            case 'delete':
                try {
                    
                    const projectId = parsedMessage.data.projectId;
                    var result = await projectService.deleteProjectPermanently(projectId);
                    if (result.reason) {                 
                        ws.send(JSON.stringify({ status: 'error', code:result.code, message:result.reason }));
                    }
                    if (result) {
                    
                    ws.send(JSON.stringify({ status: 'success', code:201, message:result }));
                    }
                  }
                  catch (exception) {
                    console.error(exception);                   
                    ws.send(JSON.stringify({ status: 'error', code:500, message:exception.message }));
                  }
                break;

            default:
                ws.send(JSON.stringify({ status: 'error', message: 'Unknown action' }));
        }
    } catch (error) {
        console.error('Error handling project message:', error);
        ws.send(JSON.stringify({ status: 'error', message: 'Failed to process project message', details: error.message }));
    }
};