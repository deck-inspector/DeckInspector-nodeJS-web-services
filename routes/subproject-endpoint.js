"use strict";
var express = require('express');
var router = express.Router();
const subprojects = require("../model/subproject");
const locations = require("../model/location");
const ErrorResponse = require('../model/error');
const Project = require('../model/project');
var ObjectId = require('mongodb').ObjectId;
var SubProjectService = require('../service/subProjectService');
const projectDAO = require('../model/projectDAO');
const LocationService = require('../service/locationService');
const newErrorResponse = require('../model/newError');

require("dotenv").config();


/**
 * name
 * description
 * parentid
 * parenttype
 * isInvasive
 * type:subproject
 * url:
 * createdat
 * createdby
 * editedat
 * lasteditedby
 * assignedto:
 * children:[]
 */
router.route('/add')
.post(async function (req,res){
try{
var errResponse;
// Get user input
var { name, description, parentid,parenttype,isInvasive,url,assignedTo,createdBy, sequenceNo } = req.body;
sequenceNo = String(sequenceNo);
// Validate user input
if (!(name&&parentid)) {
  errResponse = new ErrorResponse(400,"Name and parentid is required","");
  res.status(400).json(errResponse);
  return;
}

const parentProject = await Project.getProjectById(parentid);
if(!parentProject.data){
  errResponse = new ErrorResponse(400,"Invalid Parent Id","");
  res.status(400).json(errResponse);
  return;
}

var creationtime= new Date(Date.now()).toISOString();
const companyIdentifier = req.user.company;
//console.log(creationtime);
try{
  var newSubProject = {
      "name":name,
      "description":description,
      "parentid": new ObjectId(parentid), 
      "parenttype": parenttype,
      "type": "subproject",
      "url":url,    
      "createdat":creationtime,
      "createdby":createdBy,
      "assignedto":assignedTo,
      "editedat":creationtime ,
      "lasteditedby":createdBy,
      "children":[],
      "companyIdentifier": companyIdentifier,
      "isInvasive": isInvasive,
      "sequenceNo": sequenceNo
    } 
}catch(ex){
  console.log(ex);
  errResponse = new ErrorResponse(500, "Internal server error", ex);
  res.status(500).json(errResponse);
  return;
}
var result = await SubProjectService.addSubProject(newSubProject); 
if (result.reason) {
  return res.status(result.code).json(result);
}
if (result) {
  //console.debug(result);
  return res.status(201).json(result);
}
}
catch (exception) {
  console.log(exception);
errResponse = new newErrorResponse(500, false, exception);
return res.status(500).json(errResponse);
}
});


router.route('/getSubProjectById')
.post(async function(req,res){
  try{
    var errResponse;
    const subprojectId = req.body.subprojectid;
    const userName = req.body.username;
    var result = await SubProjectService.getSubProjectById(subprojectId);
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
    return  res.status(500).json(errResponse);
  }
})

router.route('/:id')
.put(async function(req,res){
  try{
    var errResponse;
    const newData = req.body;
    const subprojectId = req.params.id;
    // Validate user input
    if(newData.parentid){
      newData.parentid = new ObjectId(newData.parentid);
    }
    var result = await SubProjectService.editSubProject(subprojectId,newData);
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
    const subprojectId = req.params.id;
    var result = await SubProjectService.deleteSubProjectPermanently(subprojectId);
    console.log(result);
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

router.route('/:id/assign')
.post(async function(req,res){
  try {
    var errResponse;
    const subprojectId = req.params.id;
    const {username} = req.body;
    var result = await SubProjectService.assignSubProjectToUser(subprojectId,username);
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

router.route('/:id/unassign')
.post(async function(req,res){
  try {
    var errResponse;
    const subprojectId = req.params.id;
    const {username} = req.body;
    var result = await SubProjectService.unAssignSubProjectFromUser(subprojectId,username);
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


router.route('/getSubprojectsDataByProjectId')
.post(async function(req,res){
  try {
    var errResponse;
    const projectId = req.body.projectid;
    var result = await SubProjectService.getSubProjectByParentId(projectId);
    
    // const subprojectsData = result.subprojects;
    // for(const subProject of subprojectsData){
    //   const subProjectId = subProject._id;
    //   const locationresult = await LocationService.getLocationsByParentId(subProjectId);
    //   if(locationresult.locations)
    //   {
    //     subProject.children = locationresult.locations;
    //   }
    // }
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