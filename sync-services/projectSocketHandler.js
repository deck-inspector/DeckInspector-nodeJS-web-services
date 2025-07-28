"use strict";
const projectService = require('../service/projectService');
const express = require('express');
const { ObjectId } = require('mongodb');

module.exports = async function projectSocketHandler(message, ws) {
    try {
        const parsedMessage = JSON.parse(message);
        var messageId = parsedMessage.messageId;
        // Example: Handle different actions for the "projects" collection
        switch (parsedMessage.action) {
            case 'create':
                try {
                    // Get user input
                    const { name, description, address, createdby, url, assignedto,createdat, projecttype, editedat,formId,companyIdentifier ,id} = JSON.parse(parsedMessage.data);
                    
                    // Validate user input
                    if (!name || !companyIdentifier) {                      
                      ws.send(JSON.stringify({ status: 'error', code:400,messageId, message:'Name/Company is required' }));
                      return false;
                    }
            
                    // Create a new project object
                    var newProject = {
                      "_id":ObjectId(id),
                      "name": name,
                      "description": description,
                      "address": address,
                      "createdby": createdby,
                      "url": url,
                      "lasteditedby": createdby,
                      "assignedto": assignedto,
                      "editedat": editedat,
                      "children": [],
                      "projecttype": projecttype,
                      "createdat": createdat,
                      "iscomplete":false,
                      "isInvasive":false,
                      "companyIdentifier": companyIdentifier,
                      "formId": formId==null?null:ObjectId(formId)
                    }
            
                    // Save the new project to the database
                    var result = await projectService.addProject(newProject);
            
                    if (result.reason) {
                      
                      ws.send(JSON.stringify({ status: 'error',messageId, code:result.code, message:result.reason }));
                      return false;
                    }
                    if (result) {  
                      ws.send(JSON.stringify({ status: 'success', messageId,code:201, message:result }));
                      return true;
                    }
                  }
                  catch (exception) {
                    console.error(exception);
                    ws.send(JSON.stringify({ status: 'error',messageId, code:500, message:exception.message }));
                    return false;
                  }
                break;

            case 'update':
                try {
            
                    const {id,...newData} = JSON.parse(parsedMessage.data);
                    newData.formId=newData.formId==null?null:ObjectId(newData.formId);
                    
                    // Validate user input
                    var result = await projectService.editProject(id,newData);
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
                    const { id, childId, count,coverUrl } = JSON.parse(parsedMessage.data);
                    
                    // Validate user input
                    if (!id || !childId) {
                      ws.send(JSON.stringify({ status: 'error',messageId, code:400, message: 'ID and Child ID are required' }));
                      return false;
                    }
            
                    // Update the project in the database
                    var result = await projectService.addUpdateProjectChild(id, childId, {"count": count, "coverUrl": coverUrl});

                    if (result.reason) {
                      
                      ws.send(JSON.stringify({ status: 'error',messageId, code:result.code, message:result.reason }));
                      return false;
                    }
                    if (result) {
                      
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

            case 'delete':
                try {
                    
                    const projectId = JSON.parse(parsedMessage.data).id;
                    var result = await projectService.deleteProjectPermanently(projectId);
                    if (result.reason) {                 
                        ws.send(JSON.stringify({ status: 'error',messageId, code:result.code, message:result.reason }));
                        return false;
                    }
                    if (result) {
                    
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

            default:
                ws.send(JSON.stringify({ status: 'error',messageId, message: 'Unknown action' }));
                return false;
                
          
        }
    } catch (error) {
        console.error('Error handling project message:', error);
        ws.send(JSON.stringify({ status: 'error',messageId, message: 'Failed to process project message', details: error.message }));
        return false;
    }
};