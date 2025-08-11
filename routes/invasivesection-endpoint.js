"use strict";
var express = require('express');
var router = express.Router();
const invasiveSections = require("../model/invasiveSections");
const ErrorResponse = require('../model/error');
const { InvasiveSections } = require('../database/mongo');
var ObjectId = require('mongodb').ObjectId;
const InvasiveSectionService = require("../service/invasiveSectionService");
const newErrorResponse = require('../model/newError');

require("dotenv").config();

router.route('/getInvasiveSectionById')
.post(async function(req, res) {
    try {
      var errResponse;
      const sectionId = req.body.invaisveSectionid; // Use req.body instead of req.params
      const userName = req.body.username; // Use req.body instead of req.params

      const result = await InvasiveSectionService.getInvasiveSectionById(sectionId);
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


router.route("/:id").put(async function (req, res) {
  try {
    var errResponse;
    const invasivesectionId = req.params.id;
    const newData = req.body;

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
});
    


router.route('/add')
  .post(async function (req,res){
  try{
  var errResponse; 
  // Get user input
  const { invasiveDescription,parentid,postinvasiverepairsrequired,invasiveimages } = req.body;
  
  // Validate user input
  if (!(parentid)) {
    errResponse = new ErrorResponse(400,"parentid is required","");
    res.status(400).json(errResponse);
    return;
  }
  const companyIdentifier = req.user.company;
  var newInvasiveSection = {
      "invasiveDescription":invasiveDescription,
      "parentid": new ObjectId(parentid), 
      "postinvasiverepairsrequired":postinvasiverepairsrequired.toLowerCase()==='true' ,
      "invasiveimages":invasiveimages,
  } 
  var result = await InvasiveSectionService.addInvasiveSection(newInvasiveSection);    
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


router.route('/getInvasiveSectionByParentId')
.post(async function(req, res) {
    try {
        var errResponse;
        const parentSectionId = req.body.parentSectionId; // Use req.body instead of req.params
        const userName = req.body.username; // Use req.body instead of req.params
  
        const result = await InvasiveSectionService.getInvasiveSectionByParentId(parentSectionId);
  
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

module.exports = router ;
    