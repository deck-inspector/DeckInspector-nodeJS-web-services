"use strict";
var express = require('express');
var router = express.Router();
const ErrorResponse = require('../model/error');

const newErrorResponse = require('../model/newError');
const SectionService = require("../service/sectionService");
const sectionDAO = require('../model/sectionDAO');

require("dotenv").config();

router.route('/add')
.post(async function (req,res){
try{
var errResponse; 
// Get user input

const { name, exteriorelements, waterproofingelements,additionalconsiderations,
  additionalconsiderationshtml,visualreview,visualsignsofleak,furtherinvasivereviewrequired,conditionalassessment,
awe,eee,lbc,images,createdby,parentid,parenttype,unitUnavailable } = req.body;

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
    "parentid": parentid,
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
    var result = await SectionService.getSectionById( sectionId);
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
    // Couchbase: parentid is a string, no ObjectId wrapping

    // Normalize to boolean. Accept booleans and Yes/No as well as true/false:
    // the backend itself SERVES these fields as "Yes"/"No" (transformData), so
    // the web app naturally sends "Yes" back - the old ==='true' check turned
    // "Yes" into FALSE, silently clearing the invasive flag on every web save
    // (which then excluded the section from Invasive reports).
    const toBool = v => v === true || /^(true|yes)$/i.test(String(v));
    if(newData.furtherinvasivereviewrequired !== undefined && newData.furtherinvasivereviewrequired !== null){
      newData.furtherinvasivereviewrequired = toBool(newData.furtherinvasivereviewrequired);
    }
    if(newData.visualsignsofleak !== undefined && newData.visualsignsofleak !== null)
    {
      newData.visualsignsofleak = toBool(newData.visualsignsofleak);
    }

    var result = await SectionService.editSetion(sectionId,newData);

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
    var result = await SectionService.deleteSectionPermanently(sectionId);
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
    var result = await SectionService.addImageInSection(sectionId,url);
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
    var result = await SectionService.removeImageFromSection(sectionId,url);
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

//TODO Umesh to delete 
// router.route('/:id/toggleVisibility/')
// .post(async function(req,res){
//   try {
//     var errResponse;
//     const locationId = req.params.id;
//     const {parentId,isVisible,name} = req.body;
    
//     var result = await sections.updateSectionVisibilityStatus(locationId,name,parentId,isVisible);
//     if(result.error){
//         res.status(result.error.code).json(result.error);
//     }
//     if(result.data){
//       //console.debug(result);                                          
//       res.status(result.data.code).json(result.data);
//     }
//   } catch (error) {
//     errResponse = new ErrorResponse(500, "Internal server error", error);
//       res.status(500).json(errResponse);
//   }
// });

router.route('/getSectionById')
  .post(async function(req, res) {
    try {
      const sectionId = req.body.sectionid; // Use req.body instead of req.params
      const userName = req.body.username; // Use req.body instead of req.params

      const result = await SectionService.getSectionById(sectionId);

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
  var result = await SectionService.getSectionsByParentId(parentId);
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
    const result = await sectionDAO.getSectionById(sectionId);
    if (!result) {
      return res.status(404).json({ code: 404, message: "Section not found" });
    }

    const section = result;
    //Remove the section from the original parent
    const isSectionRemoved = await SectionService.deleteSectionPermanently(sectionId);
    if (isSectionRemoved.reason) {
      return res.status(isSectionRemoved.code).json(isSectionRemoved);
    }
    if (isSectionRemoved) {
      //update the section parent id with new parent id
      section.parentid = newParentId;
      //add the section to the new parent
      const isSectionAdded = await SectionService.addSection(section);

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
