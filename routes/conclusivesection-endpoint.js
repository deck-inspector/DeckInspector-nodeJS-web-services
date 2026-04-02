"use strict";
var express = require('express');
var router = express.Router();
const conclusiveSection = require("../model/conclusiveSections");
const ErrorResponse = require('../model/error');
const { ConclusiveSections } = require('../database/mongo');
var ObjectId = require('mongodb').ObjectId;
const ConclusiveSectionService = require("../service/conclusiveSectionService");
const newErrorResponse = require('../model/newError');

require("dotenv").config();


router.route('/getConclusiveSectionById')
.post(async function(req, res) {
    try {
      var errResponse;
      const conclusiveSectionid = req.body.conclusiveSectionid; // Use req.body instead of req.params
      const userName = req.body.username; // Use req.body instead of req.params

      const result = await ConclusiveSectionService.getConclusiveSectionById(conclusiveSectionid);

      if (result.reason) {
        return res.status(result.code).json(result);
      }
      if (result) {
        //console.debug(result);
        return res.status(201).json(result);
      }
    }
    catch (exception) {
      errResponse = new newErrorResponse(500, false, exception);
      return res.status(500).json(errResponse);
    }
  })


router.route('/getConclusiveSectionsByParentId')
.post(async function(req, res) {
    try {
        var errResponse;
        const parentSectionId = req.body.parentSectionId; // Use req.body instead of req.params
        const userName = req.body.username; // Use req.body instead of req.params
  
        const result = await ConclusiveSectionService.getConclusiveSectionByParentId(parentSectionId);
  
        if (result.reason) {
          return res.status(result.code).json(result);
        }
        if (result) {
          //console.debug(result);
          return res.status(201).json(result);
        }
      }
      catch (exception) {
        errResponse = new newErrorResponse(500, false, exception);
        return res.status(500).json(errResponse);
      }
    })

router.route('/add')
.post(async function (req,res){
    try{
        var errResponse; 
        // Get user input
        const { aweconclusive,conclusiveconsiderations,eeeconclusive,
            invasiverepairsinspectedandcompleted,lbcconclusive,
            parentid,propowneragreed,conclusiveimages } = req.body;
        
        // Validate user input
        if (!(parentid)) {
          errResponse = new ErrorResponse(400,"parentid is required","");
          res.status(400).json(errResponse);
          return;
        }
        var newConclusiveSection = {
            "aweconclusive":aweconclusive,
            "conclusiveconsiderations" :conclusiveconsiderations,
            "eeeconclusive":eeeconclusive,
            "invasiverepairsinspectedandcompleted": invasiverepairsinspectedandcompleted.toLowerCase()==='true',
            "parentid": parentid, 
            "propowneragreed": propowneragreed.toLowerCase()==='true',
            "conclusiveimages":conclusiveimages,
            "lbcconclusive":lbcconclusive
        } 
        var result = await ConclusiveSectionService.addConclusiveSection(newConclusiveSection);    
        if (result.reason) {
          return res.status(result.code).json(result);
        }
        if (result) {
          //console.debug(result);
          return res.status(201).json(result);
        }
      }
      catch (exception) {
        errResponse = new newErrorResponse(500, false, exception);
        return res.status(500).json(errResponse);
      }
    })

router.route('/:id')
.put(async function(req,res){
    try{
      var errResponse;
      const conclusiveSectionId = req.params.id;
      const newData = req.body;

      if(newData.parentid){
        newData.parentid = newData.parentid;
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
        return res.status(result.code).json(result);
      }
      if (result) {
        //console.debug(result);
        return res.status(201).json(result);
      }
    }
    catch (exception) {
      errResponse = new newErrorResponse(500, false, exception);
      return res.status(500).json(errResponse);
    }
  })

module.exports = router;