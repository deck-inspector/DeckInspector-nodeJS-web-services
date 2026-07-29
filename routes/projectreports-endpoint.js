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
    // Some original reports (e.g. certain Aggregate Construction projects) were
    // saved with a developer-machine URL (https://localhost:3000/...) instead of
    // a real storage location. The file was never persisted anywhere we can
    // reach: the old legacy report service only holds legacy single-tenant
    // reports and HANGS (no clean 404) on any name it doesn't have, so probing
    // it just spins. We still try it as a best effort (some names DO resolve
    // there) but with a SHORT timeout so the user gets a clear, fast answer
    // instead of a 2-minute spin, and we tell them to regenerate.
    let wasLocalhost = false;
    try {
      const parsed = new URL(u);
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        wasLocalhost = true;
        parsed.protocol = 'https:';
        parsed.host = 'deckmultireportingapp.azurewebsites.net';
        parsed.port = '';
        u = parsed.toString();
      }
    } catch (e) { /* leave u as-is; the allowlist check below will reject it */ }
    let dlHost = '';
    try { dlHost = new URL(u).hostname.toLowerCase(); } catch (e) { dlHost = ''; }
    const allowedHosts = ['deckinspectorsappdata.blob.core.windows.net', 'deckinspectors.blob.core.windows.net', 'deckmultireportingapp.azurewebsites.net'];
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
    // Real blob downloads can be large (~50MB) and need a generous timeout;
    // dead localhost-origin records only hang the legacy service, so cap those
    // short and fail with a helpful message.
    const dlTimeout = wasLocalhost ? 30000 : 120000;
    const resp = await axios.get(u, { responseType: 'arraybuffer', timeout: dlTimeout });
    res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${n.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(n)}`);
    res.send(Buffer.from(resp.data));
  } catch (err) {
    console.error('downloadfile error:', err.message);
    // A localhost-origin record whose file can't be retrieved: tell the user
    // how to recover instead of a generic error.
    const rewrittenLocalhost = /localhost|127\.0\.0\.1/.test(req.query.u || '');
    if (rewrittenLocalhost) {
      return res.status(502).send('This original report is no longer stored anywhere we can retrieve (its saved location was a temporary address). Please re-open the project and use "Create Visual Report" to regenerate it.');
    }
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
