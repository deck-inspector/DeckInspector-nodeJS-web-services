"use strict";
var express = require('express');
var router = express.Router();
const locations = require("../model/location");
const sections = require("../model/sections");
const ErrorResponse = require('../model/error');
var ObjectId = require('mongodb').ObjectId;
const LocationService = require('../service/locationService');
const newErrorResponse = require('../model/newError');



require("dotenv").config();

router.route('/add')
.post(async function (req,res){
try{
var errResponse;
// Get user input
var { name, description, createdBy,url,parentid,parenttype,type,isInvasive, sequenceNo} = req.body;
sequenceNo = String(sequenceNo);
// Validate user input
if (!(name&&parentid)) {
  errResponse = new ErrorResponse(400,"Name,parenttype and parentid is required","");
  res.status(400).json(errResponse);
  return;
}
var creationtime= (new Date(Date.now())).toISOString();
const companyIdentifier = req.user.company;
try{
  var newLocation = {
      "name":name,
      "description":description,    
      "createdby":createdBy,
      "url":url,
      "createdat":creationtime,    
      "parentid": new ObjectId(parentid),
      "parenttype": parenttype,
      "type":type,
      "sections":[],
      "lasteditedBy":createdBy,
      "editedat":creationtime,
      "isInvasive":isInvasive,
      "sequenceNo": sequenceNo,
      "companyIdentifier": companyIdentifier,
      "__lastOpClient": "webapp"
  }
}catch(ex){
  console.log(ex);
  errResponse = new ErrorResponse(500, "Internal server error", ex);
  res.status(500).json(errResponse);
  return;
} 
var result = await LocationService.addLocation(newLocation);    
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
    const locationId = req.params.id;
    var result = await LocationService.getLocationById( locationId);
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
    const newData = req.body;
    const locationId = req.params.id;
    if(newData.parentid){
      newData.parentid = new ObjectId(newData.parentid);
    }
    newData.__lastOpClient = "webapp";
    var result = await LocationService.editLocation(locationId,newData);
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
    const locationId = req.params.id;
    var result = await LocationService.deleteLocationPermanently(locationId);
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

router.route('/getLocationById').
post(async function(req,res){
  try{
    var errResponse;
    const locationId = req.body.locationid;
    const userName = req.body.username;
    var result = await LocationService.getLocationById( locationId);
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

// UMESH TODO - -to cofnirm and remove this

// router.route('/getLocationSectionsMetaData')
// .post(async function(req,res){
//   try{
//     var errResponse;
//     const locationId = req.body.locationid;
//     const userId = req.body.username;
//     const result = await sections.getSectionMetaDataForLocationId(locationId);
//     if (result.reason) {
//       res.status(result.code).json(result.reason);
//     }
//     if (result) {
//       //console.debug(result);
//       res.status(201).json(result);
//     }
//   }
//   catch (exception) {
//     errResponse = new newErrorResponse(500, false, err);
//     res.status(500).json(errResponse);
//   }
// })

router.route('/getLocationsByProjectId')
.post(async function(req,res){
try{
  var errResponse;
  const projectId = req.body.projectid;
  const username = req.body.username;
  var result = await LocationService.getLocationsByParentId(projectId);
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