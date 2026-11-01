"use strict";
var express = require('express');
var router = express.Router();

var path = require('path');
const projectDocuments = require("../model/projectDocuments");
var jwt = require('jsonwebtoken');
const Role=require('../model/role');

require("dotenv").config();

router.route('/add')
.post( function(req, res)  {  
try {
    // Get document input
    const { project_id, name, url, uploader } = req.body;
    var timestamp = (new Date(Date.now())).toISOString();
    // Validate document input
    if (!(project_id && name && url)) {
      res.status(400).send("All input is required");
    }
 
    // Create document in our database
    projectDocuments.addProjectDocument({
        project_id,
        name,
        url,
        uploader,
        timestamp
    },function(err,result){
        if (err) { 
            res.status(err.status).send(err.message); 
        }
        if (result){
            // Nov 1 2026: an uploaded SIGNED FINAL goes to the client portal automatically
            // (service/portalReports.js autoReleaseSignedFinal). Never blocks the upload.
            (async () => {
              let portal = null;
              try {
                const company = req.user && req.user.company;
                const users = require('../model/user');
                const me = company ? await users.getUserbyUsername(req.user.username) : null;
                const role = String((me && me.role) || '').toLowerCase();
                if (me && role !== 'client' && role !== 'contractor') {
                  const staff = { company, username: me.username, name: [me.first_name, me.last_name].filter(Boolean).join(' ') || me.username };
                  portal = await require('../service/portalReports').autoReleaseSignedFinal(staff, result.insertedId, name, url);
                }
              } catch (e) { console.error('signed final auto-release:', e && e.message); }
              res.status(201).json(Object.assign({}, result, portal ? { portal } : {}));
            })();
        }
    });
    
  }catch (err) {
    console.log(err);
  }
  
});

router.route('/:project_id')
.get(async function(req,res){
  try{
    const project_id = req.params.project_id;
    projectDocuments.getProjectDocumentsbyProjectId(project_id ,async function(err,records){
      if (err) { res.status(err.status).send(err.message); 
      }
      else {
          if (records){
            res.status(200).json(records); 
          }                     
            else
              res.status(401).send("documents not found.");
      }
  });    
  }
  catch{
    res.status(500).send("Internal server error.");
  }
});

router.route('/delete')
.post(async function(req,res){
  try {
      // Get user input
      const document = req.body; 
      projectDocuments.removeDocument(document._id,function(err,result){
        if(err){
          res.status(err.status).send(err.message);
        }
        else{
          res.status(result.status).send(result.message);      
        }
      })          
      
     }     
  catch (err) {    
    console.log(err);
    res.status(500).send(`Internal server error ${err}`)
  }
});

module.exports = router ;