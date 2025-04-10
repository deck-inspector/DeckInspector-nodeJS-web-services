"use strict";

const express = require('express');
const { ObjectId } = require('mongodb');
const InvasiveSectionService = require("../service/invasiveSectionService");

module.exports = async function invasiveSectionSocketHandler(message, ws) {
    try {
        const parsedMessage = JSON.parse(message);

        // Example: Handle different actions for the "projects" collection
        switch (parsedMessage.action) {
            case 'create': 
            try{
                var errResponse; 
                // Get user input
                const { invasiveDescription,parentid,postinvasiverepairsrequired,invasiveimages } = req.body;
                
                // Validate user input
                if (!(parentid)) {
                
                    ws.send(JSON.stringify({ status: 'error', code:400, message:'parentid is required' }));
                  return;
                }
                var newInvasiveSection = {
                    "invasiveDescription":invasiveDescription,
                    "parentid": new ObjectId(parentid), 
                    "postinvasiverepairsrequired":postinvasiverepairsrequired.toLowerCase()==='true' ,
                    "invasiveimages":invasiveimages,
                } 
                var result = await InvasiveSectionService.addInvasiveSection(newInvasiveSection);    
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
                  
                  ws.send(JSON.stringify({ status: 'error', code:500, message:exception.message }));
                  return ;
                }
                break;
            case 'edit':
                try {
                    const { invasivesectionId } = parsedMessage.data;
                    if (!invasivesectionId) {
                      ws.send(JSON.stringify({ status: 'error', code:400, message:'invasivesectionId is required' }));
                      return;
                    }
                    var newData = parsedMessage.data;
                    if (newData.parentid) {
                      newData.parentid = new ObjectId(newData.parentid);
                    }
                
                    if(newData.postinvasiverepairsrequired){
                      newData.postinvasiverepairsrequired = newData.postinvasiverepairsrequired.toLowerCase()==='true' ;
                    }
                
                    var result = await InvasiveSectionService.editInvasiveSection(
                      invasivesectionId,
                      newData
                    );
                
                    if (result.reason) {
                      return  res.status(result.code).json(result);
                    }
                    if (result) {
                      //console.debug(result);
                      return res.status(201).json(result);
                    }
                  } catch (exception) {
                    errResponse = new newErrorResponse(500, false, exception);
                    return res.status(500).json(errResponse);
                  }
                break;
            case 'delete':
                try {
                    var errResponse;
                    const invasivesectionId = parsedMessage.data.invasivesectionId;
                    if (!invasivesectionId) {
                      ws.send(JSON.stringify({ status: 'error', code:400, message:'invasivesectionId is required' }));
                      return;
                    }
                    var result = await InvasiveSectionService.deleteInvasiveSectionPermanently(invasivesectionId);
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
                ws.send(JSON.stringify({ status: 'error', code:400, message:'Invalid action' }));
                break;
        }
    }
    catch (error) {
        console.error('Error processing message:', error);
        ws.send(JSON.stringify({ status: 'error', code:500, message:'Internal server error' }));
    }
}