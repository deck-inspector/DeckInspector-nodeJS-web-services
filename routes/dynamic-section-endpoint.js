"use strict";
var express = require('express');
var router = express.Router();
const ErrorResponse = require('../model/error');
var ObjectId = require('mongodb').ObjectId;
const newErrorResponse = require('../model/newError');
const DynamicSectionService = require("../service/dynamicSectionService");
const dynamicSectionDAO = require('../model/dynamicSectionDAO');
const redisManager = require('../sync-services/redisService.js');

require("dotenv").config();

router.route('/add')
.post(async function (req,res){
try{
var errResponse; 
// Get user input

const { name,additionalconsiderations, questions,
  additionalconsiderationshtml,furtherinvasivereviewrequired,images,createdby,parentid,parenttype,unitUnavailable, companyIdentifier } = req.body;

// Validate user input
if (!(name&&parentid)) {
  errResponse = new ErrorResponse(400,"Name and parentid is required","");
  res.status(400).json(errResponse);
  return;
}
var creationtime= (new Date(Date.now())).toISOString();
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
    "companyIdentifier": companyIdentifier,
    "__lastOpClient": "webapp"
} 
var result = await DynamicSectionService.addSection(newSection);    
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
});


router.route('/:id')
.get(async function(req,res){
  try{
    var errResponse;
    const sectionId = req.params.id;
    var result = await DynamicSectionService.getSectionById(sectionId);
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
    const sectionId = req.params.id;
    const newData = req.body;
    if(newData.parentid){
      newData.parentid = new ObjectId(newData.parentid);
    }
    newData.__lastOpClient = "webapp";
    if(newData.furtherinvasivereviewrequired){
      newData.furtherinvasivereviewrequired = newData.furtherinvasivereviewrequired.toLowerCase()==='true'
    }
    
    var result = await DynamicSectionService.editSetion(sectionId,newData);

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
.delete(async function(req,res){
  try{
    var errResponse;
    const sectionId = req.params.id;
    const deletedSection = await DynamicSectionService.getSectionById(sectionId);
  const origin = `webapp.${deletedSection.companyIdentifier}`;
  await redisManager.markPendingOrigin('dynamicSection', sectionId, origin, deletedSection.companyIdentifier, 60);

    var result = await DynamicSectionService.deleteSectionPermanently(sectionId);
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
});

router.route('/:id/addimage')
.post(async function(req,res){
  try {
    var errResponse;
    const sectionId = req.params.id;
    const {url} = req.body;
    var result = await DynamicSectionService.addImageInSection(sectionId,url);
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
});

router.route('/:id/removeimage')
.post(async function(req,res){
  try {
    var errResponse;
    const sectionId = req.params.id;
    const {url} = req.body
    var result = await DynamicSectionService.removeImageFromSection(sectionId,url);
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
});

router.route('/getSectionById')
  .post(async function(req, res) {
    try {
      const sectionId = req.body.sectionid; // Use req.body instead of req.params
      const userName = req.body.username; // Use req.body instead of req.params

      const result = await DynamicSectionService.getSectionById(sectionId);

      if (result.reason) {
        return res.status(result.code).json(result);
      }
      if (result) {
        //console.debug(result);
        return res.status(201).json(result);
      }
    }
    catch (exception) {
      const errResponse = new newErrorResponse(500, false, exception);
      return res.status(500).json(errResponse);
    }
  });

router.route('/getSectionsByParentId')
.post(async function(req,res){
try{
  var errResponse;
  const parentId = req.body.parentid;
  const username = req.body.username;
  var result = await DynamicSectionService.getSectionsByParentId(parentId);
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

router.route('/moveSection')
.post(async function(req, res){
  try{
    const sectionId = req.body.sectionId;
    const newParentId = req.body.newParentId;

    if (!(sectionId && newParentId)) {
      const errResponse = new ErrorResponse(400,"Invalid move operation","");
      res.status(400).json(errResponse);
      return;
    }

    //Get the section object by id
    const result = await dynamicSectionDAO.getSectionById(sectionId);
    if (!result) {
      return res.status(result).json(result);
    }

    const section = result;
    //Remove the section from the original parent
    const isSectionRemoved = await DynamicSectionService.deleteSectionPermanently(sectionId);
    if (isSectionRemoved.reason) {
      return res.status(isSectionRemoved.code).json(isSectionRemoved);
    }
    if (isSectionRemoved) {
      //update the section parent id with new parent id
      section.parentid = new ObjectId(newParentId);
      //add the section to the new parent
      const isSectionAdded = await DynamicSectionService.addSection(section);    

      if (isSectionAdded.reason) {
        return res.status(isSectionAdded.code).json(isSectionAdded);
      }
      if (isSectionAdded) {
        return res.status(201).json(isSectionAdded);
      }
    }

  }
  catch (exception){
    console.log(exception);
    const errResponse = new ErrorResponse(500, false, exception);
    return res.status(500).json(errResponse);
  }
})

module.exports = router ;
