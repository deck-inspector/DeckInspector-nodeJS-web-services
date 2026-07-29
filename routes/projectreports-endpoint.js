"use strict";
var express = require('express');
var router = express.Router();

var path = require('path');
const projectReports = require("../model/projectReports");
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
    projectReports.addProjectReport({
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
            res.status(201).json(result);
        }
    });
    
  }catch (err) {
    console.log(err);
  }
  
});

// Stream a report file from blob storage with a friendly download name.
// GET /api/projectreports/downloadfile?u=<blob url>&n=<file name>
// Only files on our own storage account are allowed.
router.route('/downloadfile')
.get(async function (req, res) {
  try {
    const axios = require('axios');
    let u = req.query.u || '';
    let n = (req.query.n || 'report.docx').toString();
    // Original reports live on the older E3 storage account; accept either E3
    // storage account, and tolerate a URL saved without the https scheme.
    if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
    let dlHost = '';
    try { dlHost = new URL(u).hostname.toLowerCase(); } catch (e) { dlHost = ''; }
    const allowedHosts = ['deckinspectorsappdata.blob.core.windows.net', 'deckinspectors.blob.core.windows.net'];
    if (!allowedHosts.includes(dlHost)) {
      return res.status(400).send('Invalid file location.');
    }
    // sanitize the filename for all platforms
    n = n.replace(/[\\/:*?"<>|]/g, '.').replace(/\s+/g, ' ').trim().slice(0, 150);
    const ext = (u.split('?')[0].match(/\.(docx|pdf|xlsx)$/i) || [,'docx'])[1].toLowerCase();
    if (!n.toLowerCase().endsWith('.' + ext)) n = n + '.' + ext;
    const types = {
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      pdf: 'application/pdf',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    };
    const resp = await axios.get(u, { responseType: 'arraybuffer', timeout: 120000 });
    res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${n.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(n)}`);
    res.send(Buffer.from(resp.data));
  } catch (err) {
    console.error('downloadfile error:', err.message);
    res.status(500).send('Could not download the file.');
  }
});

router.route('/:project_id')
.get(async function(req,res){
  try{
    const project_id = req.params.project_id;
    projectReports.getProjectReportsbyProjectId(project_id ,async function(err,records){
      if (err) { res.status(err.status).send(err.message); 
      }
      else {
          if (records){
            res.status(200).json(records); 
          }                     
            else
              res.status(401).send("reports not found.");
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
      projectReports.removeReport(document._id,function(err,result){
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
