"use strict";
const ConclusiveSectionService = require("../service/conclusiveSectionService");
const express = require('express');
const { ObjectId } = require('mongodb');

module.exports = async function conclusiveSectionSocketHandler(message, ws) {
    try {
        const parsedMessage = JSON.parse(message);

        // Example: Handle different actions for the "projects" collection
        switch (parsedMessage.action) {
            case 'create':
                try{
                    
                    const { aweconclusive,conclusiveconsiderations,eeeconclusive,
                        invasiverepairsinspectedandcompleted,lbcconclusive,
                        parentid,propowneragreed,conclusiveimages } = req.body;
                    
                    // Validate user input
                    if (!(parentid)) {
                      ws.send(JSON.stringify({ status: 'error', code:400, message:'parentid is required' }));
                      return;
                    }
                    var newConclusiveSection = {
                        "aweconclusive":aweconclusive,
                        "conclusiveconsiderations" :conclusiveconsiderations,
                        "eeeconclusive":eeeconclusive,
                        "invasiverepairsinspectedandcompleted": invasiverepairsinspectedandcompleted.toLowerCase()==='true',
                        "parentid": new ObjectId(parentid), 
                        "propowneragreed": propowneragreed.toLowerCase()==='true',
                        "conclusiveimages":conclusiveimages,
                        "lbcconclusive":lbcconclusive
                    } 
                    var result = await ConclusiveSectionService.addConclusiveSection(newConclusiveSection);    
                    if (result.reason) {
                      
                      ws.send(JSON.stringify({ status: 'error', code:result.code, message:result.reason }));
                        return;
                    }
                    if (result) {
                      //console.debug(result);
                      //return res.status(201).json(result);
                      ws.send(JSON.stringify({ status: 'success', code:201, message:result }));
                      return;
                    }
                  }
                  catch (exception) {
            
                    ws.send(JSON.stringify({ status: 'error', code:500, message:exception.message }));
                    return ;
                  }
            case 'update':  
                try{
                    
                    const {conclusiveSectionId,...newData} = parsedMessage.data;
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
              
                    var result = await ConclusiveSectionService.editConclusiveSection(conclusiveSectionId,newData);
                    
                    if (result.reason) {
                      ws.send(JSON.stringify({ status: 'error', code:result.code, message:result.reason }));
                      return;
                    }
                    if (result) {
                      //console.debug(result);
                      //return res.status(201).json(result);
                      ws.send(JSON.stringify({ status: 'success', code:201, message:result }));
                      return;
                    }
                  }
                  catch (exception) {
                    ws.send(JSON.stringify({ status: 'error', code:500, message:exception.message }));
                    return ;
                  }
            case 'delete':
                try{
                    const conclusiveSectionId = parsedMessage.data.conclusiveSectionId;
                    var result = await ConclusiveSectionService.archiveConclusiveSection(conclusiveSectionId);
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
            default:
                ws.send(JSON.stringify({ status: 'error', code:400, message:'Invalid action' }));
                return;
        }
    }
    catch (error) {
        console.error('Error processing message:', error);
        ws.send(JSON.stringify({ status: 'error', code:500, message:'Invalid message format' }));
    }
}