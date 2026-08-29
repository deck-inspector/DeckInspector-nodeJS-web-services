"use strict";
var express = require('express');
var router = express.Router();
const projects = require("../model/project");
const ErrorResponse = require('../model/error');
const newErrorResponse = require('../model/newError');
const path = require('path');
const fs = require('fs');
const {generateProjectReport,getProjectHtml}= require('../service/projectreportgeneration.js');
const {getProjectHierarchyMetadata,getSingleProjectMetadata} = require('../service/projectmetadata/getProjectMetaData.js');
const {generateExcelForProject} = require('../service/generateExcelForProject.js');
const projectService = require('../service/projectService');
require("dotenv").config();
const multer = require('multer');
const upload = multer({ dest: path.join(__dirname, '..') });
const {v4 : uuidv4} = require('uuid');
var uploadBlob = require('../database/uploadimage');
const projectReports = require("../model/projectReports");
const {generateLocationReportDoc} = require("../service/projectreportgeneration");
const FinalReportGenerator = require("../service/ReportGeneration/FinalReportGenerator.js");
const FinalRepairsGenerator = require("../service/ReportGeneration/FinalRepairsGenerator.js");
const FinalInspectionService = require("../service/finalInspectionService.js");
const ProposalGenerator = require("../service/ReportGeneration/ProposalGenerator.js");
const proposals = require("../model/proposals");
const locationModel = require("../model/location");
const cbase = require("../database/couchbase");

router.route('/add')
    .post(async function (req, res) {
      try {
        // Get user input
        const { name, description, address, createdby, url, assignedto, projecttype, editedat,formId } = req.body;
        console.log(req.user);
        const companyIdentifier = req.user.company;
        console.log(`Company Identifier: ${companyIdentifier}`);
        // Validate user input
        if (!name) {
          const errResponse = new ErrorResponse(400, "Name is required", "");
          res.status(400).json(errResponse);
          return;
        }

        // Create a new project object
        var newProject = {
          "name": name,
          "description": description,
          "address": address,
          "createdby": createdby,
          "url": url,
          "lasteditedby": createdby,
          "assignedto": assignedto,
          "editedat": new Date(editedat).toISOString(),
          "children": [],
          "projecttype": projecttype,
          "createdat": new Date(editedat).toISOString(),
          "iscomplete":false,
          "isInvasive":false,
          "companyIdentifier": companyIdentifier,
          "formId": formId || null,
          "type": "Project"
        }

        // Save the new project to the database
        var result = await projectService.addProject(newProject);

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

router.route('/allprojects')
    .get(async function (req, res) {
      try {
        var errResponse;
        var result = await projectService.getAllProjects();
        var companyIdentifier = req.user.company;
        result.projects = result.projects.filter(project => project.companyIdentifier === companyIdentifier);

        // INSPECTOR-SCOPED VISIBILITY (David, Aug 17): non-admin users see
        // ONLY the projects assigned to them - including legacy shorthand
        // assignment tags ("Gabe" for Gabriel), matched with the same rules
        // the acceptance-click feature uses. Users with role 'admin' see
        // everything. If the requester's record can't be loaded, fail SAFE
        // (restricted view) rather than exposing the whole list.
        // NOTE: this governs the WEB list only - mobile sync channels are
        // unchanged and still deliver all projects to phones.
        try {
          const usersModel = require('../model/user');
          const { projectAssignedToUser } = require('../service/assignmentMatch');
          const me = await usersModel.getUserbyUsername(req.user.username);
          const isAdmin = !!(me && String(me.role || '').toLowerCase() === 'admin');
          if (!isAdmin) {
            const all = await usersModel.getAllUser();
            const others = (all.users || []).filter(u =>
              u && u.companyIdentifier === companyIdentifier && u.username !== req.user.username);
            result.projects = result.projects.filter(p => projectAssignedToUser(p, me, others));
          }
        } catch (visErr) {
          // Fail safe: an error while scoping must not expose everything.
          console.error('allprojects visibility scoping error:', visErr && visErr.message);
          result.projects = [];
        }

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

router.route('/filterprojects')
    .post(async function (req, res) {
      try {
        var errResponse;
        const { name, isdeleted, iscomplete, createdon } = req.body;
        const companyIdentifier = req.user.company;
        var result = await projectService.getProjectsByNameCreatedOnIsCompletedAndDeleted({ name, isdeleted, iscomplete, createdon });
        result.projects = result.projects.filter(project => project.companyIdentifier === companyIdentifier);
        if (result.reason) {
          return res.status(result.code).json(result);
        }
        if (result) {
          return res.status(201).json(result);
        }
      }
      catch (exception) {
        errResponse = new newErrorResponse(500, false, exception);
        return res.status(500).json(errResponse);
      }
    });


router.route('/getProjectById')
    .post(async function (req, res) {
      try {
        console.log("Inside getProjectById route",req.body);
        var errResponse;
        const projectId = req.body.projectid;
        var result = await projectService.getProjectById(projectId);
        if (result.reason) {
          return res.status(result.code).json(result);
        }
        if (result) {
          //console.debug(result);
          return res.status(201).json(result);
        }
      }
      catch {
        errResponse = new newErrorResponse(500, false, exception);
        return  res.status(500).json(errResponse);
      }
    })

//UMESH todo: to refactor this
router.route('/generateexcel')
    .post(async function (req, res) {
      try {
        const projectId = req.body.projectid;
        //Umesh TODO: to move this into ProjectService class
        const fullexcelPath = await generateExcelForProject(projectId);

        // Set headers and status
        console.log(fullexcelPath);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=' + path.basename(fullexcelPath));
        res.sendFile(fullexcelPath, {}, (err) => {
          if (err) {
            console.error('Error sending file:', err);
          } else {
            console.log('excel sent successfully');
            fs.unlinkSync(fullexcelPath);
          }
        });
      } catch (err) {
        console.error('Error generating Excel:', err);
        return res.status(500).send('Error generating Excel');
      }
    });

router.route('/:id')
    .put(async function (req, res) {
      try {
        var errResponse;
        const newData = req.body;
        newData.formId = newData.formId || null;
        const projectId = req.params.id;
        // Validate user input
        var result = await projectService.editProject(projectId,newData);
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
    .delete(async function (req, res) {
      try {
        var errResponse;
        const projectId = req.params.id;
        var result = await projectService.archiveProject(projectId);
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

router.route('/:id/assign')
    .post(async function (req, res) {
      try {
        var errResponse;
        const projectId = req.params.id;
        const { username } = req.body;
        var result = await projectService.assignProjectToUser(projectId, username);
        if (result.reason) {
          return res.status(result.code).json(result);
        }
        if (result) {
          return res.status(201).json(result);
        }
      }
      catch (exception) {
        errResponse = new newErrorResponse(500, false, exception);
        return res.status(500).json(errResponse);
      }
    });



router.route('/:id/unassign')
    .post(async function (req, res) {
      try {
        var errResponse;
        const projectId = req.params.id;
        const { username } = req.body;
        var result = await projectService.unassignUserFromProject(projectId, username);
        if (result.reason) {
          return res.status(result.code).json(result);
        }
        if (result) {
          return res.status(201).json(result);
        }
      }
      catch (exception) {
        errResponse = new newErrorResponse(500, false, exception);
        return res.status(500).json(errResponse);
      }
    });




// Assignment acceptance: the assigned inspector clicks their own name to
// accept (green) or decline (red) the assignment; the state is stored on the
// project so every user sees it. status: accepted | declined | none.
// (Re-added Aug 17 — the route went missing from this file while the model
// function and the webapp caller both survived, so every click 404'd and the
// app showed "Could not save your response.")
router.route('/:id/assignmentstatus')
    .post(async function (req, res) {
      try {
        const projectId = req.params.id;
        const { username, status } = req.body;

        if (!projectId || !username || !status) {
          return res.status(400).json(new newErrorResponse(400, false, "projectId, username and status are required"));
        }
        const allowed = ['accepted', 'declined', 'none'];
        if (!allowed.includes(String(status))) {
          return res.status(400).json(new newErrorResponse(400, false, "status must be accepted, declined or none"));
        }

        const result = await projects.setAssignmentStatus(projectId, username, String(status));
        if (result.error) {
          return res.status(result.error.code || 500).json(result.error);
        }
        return res.status(201).json(result.data);
      }
      catch (exception) {
        const errResponse = new newErrorResponse(500, false, exception);
        return res.status(500).json(errResponse);
      }
    });

// FINAL INSPECTION AFTER REPAIRS - phone prep (Aug 18): mark BAD units red,
// write original findings into their descriptions, pre-create the REPAIRS
// records carrying the repair-form questions. cleanup restores names on
// complete/cancel (the filled REPAIRS records stay for the report).
router.route('/:id/finalinspection/prepare')
    .post(async function (req, res) {
      try {
        const username = (req.body && req.body.username) || (req.user && req.user.username) || 'system';
        const result = await FinalInspectionService.prepare(req.params.id, username);
        return res.status(200).json(result);
      } catch (exception) {
        return res.status(500).json(new newErrorResponse(500, false, String(exception && exception.message || exception)));
      }
    });
router.route('/:id/finalinspection/cleanup')
    .post(async function (req, res) {
      try {
        const result = await FinalInspectionService.cleanup(req.params.id);
        return res.status(200).json(result);
      } catch (exception) {
        return res.status(500).json(new newErrorResponse(500, false, String(exception && exception.message || exception)));
      }
    });

router.route('/:id/toggleprojectstatus/:state')
    .post(async function (req, res) {
      try {
        var errResponse;
        const projectId = req.params.id;
        const state = req.params.state;
        const iscomplete = state == 1 ? true : false;
        var result = await projectService.toggleProjectstatus(projectId, iscomplete);
        if (result.reason) {
          return res.status(result.code).json(result);
        }
        if (result) {
          return res.status(201).json(result);
        }
      }
      catch (exception) {
        errResponse = new newErrorResponse(500, false, exception);
        return res.status(500).json(errResponse);
      }
    });

router.route('/getProjectsByUser/:username')
    .get(async function(req,res){
      try{
        var errResponse;
        const username = req.params.username;
        var result = await projectService.getProjectByAssignedToUserId(username);
        if (result.reason) {
          return res.status(result.code).json(result);
        }
        if (result) {
          return res.status(201).json(result);
        }
      }
      catch (exception) {
        errResponse = new newErrorResponse(500, false, exception);
        return res.status(500).json(errResponse);
      }
    })

//Umesh TODO: To refactor this entire thing
router.route('/getProjectsMetaDataByUserName/:username')
    .get(async function(req,res){
      try{
        var errResponse;
        const username = req.params.username;
        var result = await getProjectHierarchyMetadata(username);
        if (result.error) {
          return res.status(result.error.code).json(result.error);
        }
        if (result.data) {
          return res.status(201).json(result.data);
        }
      }catch(error)
      {
        console.log(error);
        errResponse = new ErrorResponse(500, "Internal server error", error);
        return res.status(500).json(errResponse);
      }
    });

//Umesh TODO: To refactor this entire thing
router.route('/getProjectMetadata/:id')
    .get(async function(req,res){
      try{
        var errResponse;
        const projectId = req.params.id;
        var result = await getSingleProjectMetadata(projectId);
        if (result.error) {
          return res.status(result.error.code).json(result.error);
        }
        if (result.data) {
          return res.status(201).json(result.data);
        }
      }catch(error)
      {
        console.log(error);
        errResponse = new ErrorResponse(500, "Internal server error", error);
        return res.status(500).json(errResponse);
      }
    });


// Lightweight check for the web app's project list: does this project have
// any actual inspection data (any location with sections) yet? Drives the
// yellow "needs Final Report" highlight (David, Aug 17).
router.route('/:id/hasinspectiondata')
    .get(async function (req, res) {
      try {
        const result = await locationModel.hasInspectionData(req.params.id);
        if (result.error) return res.status(result.error.code).json(result.error);
        return res.status(200).json(result.data);
      } catch (error) {
        console.log(error);
        return res.status(500).json(new ErrorResponse(500, "Internal server error", error));
      }
    });

// Repair photo references that were left as device-local paths by the old
// (MongoDB-era) post-upload rewrite. The blobs were uploaded to Azure fine;
// this walks the project's sections, maps each local path to its blob URL
// (same container/name rules as routes/images-endpoint.js), verifies the blob
// exists, and rewrites the section doc. (David, Aug 17: "photo sync is not
// working on 1518 E. 51st St.")
router.route('/:id/repairphotos')
    .post(async function (req, res) {
      try {
        const projectId = req.params.id;
        const bucket = process.env.DB_BUCKET_NAME;
        const scope = process.env.DB_SCOPE_NAME || "inventory";
        const account = process.env.AZURE_STORAGE_ACCOUNT_NAME;
        if (!account) return res.status(500).json({ error: "AZURE_STORAGE_ACCOUNT_NAME not configured" });
        const cluster = cbase.cluster;
        // parent ids = project + subprojects
        const subs = await cluster.query(
          `SELECT META(s).id AS metaId, s.id AS docId FROM \`${bucket}\`.\`${scope}\`.SubProject s WHERE s.parentid = $1`,
          { parameters: [projectId] });
        const parentIds = [projectId];
        for (const r of (subs.rows || [])) for (const v of [r.metaId, r.docId]) if (v && parentIds.indexOf(v) === -1) parentIds.push(v);
        // locations under those parents
        const locs = await cluster.query(
          `SELECT META(l).id AS lid, l.name, l.url, l.parentid, l.parenttype FROM \`${bucket}\`.\`${scope}\`.Location l WHERE l.parentid IN $1`,
          { parameters: [parentIds] });
        const locRows = locs.rows || [];
        const locIds = locRows.map((r) => r.lid);
        if (!locIds.length) return res.status(200).json({ sections: 0, repaired: 0, unresolved: [] });
        // section docs under those locations
        const secs = await cluster.query(
          `SELECT META(v).id AS sid, v.* FROM \`${bucket}\`.\`${scope}\`.VisualSection v WHERE v.parentid IN $1`,
          { parameters: [locIds] });
        const sanitize = (n) => String(n || "").replace(/[^a-zA-Z0-9 ]/g, "").toLowerCase().split(" ").join("");
        const base = "https://" + account + ".blob.core.windows.net/";
        const exists = async (url) => {
          try { const r = await fetch(url, { method: "HEAD" }); return r.ok; } catch (e) { return false; }
        };
        let repaired = 0; const unresolved = []; let sectionsTouched = 0;
        const secColl = cbase.Sections, locColl = cbase.Locations;
        for (const row of (secs.rows || [])) {
          const sid = row.sid; const images = Array.isArray(row.images) ? row.images.slice() : [];
          let changed = false;
          for (let i = 0; i < images.length; i++) {
            const img = String(images[i] || "");
            if (/^https?:\/\//i.test(img)) continue;
            const parts = img.split("/").filter(Boolean);
            const file = parts[parts.length - 1];
            const pathSeg = parts.length > 1 ? parts[parts.length - 2] : "";
            // candidate containers: path segment (what the app sent), then section name
            const candidates = [];
            for (const nm of [pathSeg, row.name]) {
              const c = sanitize(nm);
              if (c && c.length >= 3 && candidates.indexOf(c) === -1) candidates.push(c);
            }
            let fixed = null;
            for (const c of candidates) {
              const url = base + c + "/" + encodeURIComponent(c + "-" + file);
              if (await exists(url)) { fixed = url; break; }
            }
            if (fixed) { images[i] = fixed; changed = true; repaired++; }
            else unresolved.push((row.name || sid) + " :: " + img);
          }
          if (changed) {
            sectionsTouched++;
            const doc = await secColl.get(sid);
            await secColl.upsert(sid, Object.assign({}, doc.content, { images }));
            // refresh the parent location's copy (thumbnail url + count)
            try {
              const locDoc = await locColl.get(row.parentid);
              if (locDoc && locDoc.content && Array.isArray(locDoc.content.sections)) {
                const lastHttp = images.filter(u => /^https?:\/\//i.test(u)).pop() || "";
                let touched = false;
                const sections = locDoc.content.sections.map(s => {
                  const sd = s && (s.id || s._id);
                  if (sd === sid) { touched = true; return Object.assign({}, s, { url: lastHttp, count: images.length }); }
                  return s;
                });
                if (touched) await locColl.upsert(row.parentid, Object.assign({}, locDoc.content, { sections }));
              }
            } catch (e) { /* best effort */ }
          }
        }
        // LOCATION COVER PHOTOS (David, Aug 23: "the Location images are not
        // syncing... I don't think they ever did"). The Aug 17 dead-database
        // bug hit every entity type, but this sweep only healed section
        // photos - each Location's own cover url was left holding the
        // phone-local path. Same cure: derive the blob name, verify the blob
        // actually exists, rewrite only verified URLs, and refresh the parent
        // project/building's copy of the thumbnail.
        let locationsTouched = 0; let locationRepaired = 0; const locationUnresolved = [];
        let projName = "";
        try { const pdoc = await cbase.Projects.get(projectId); projName = (pdoc.content && pdoc.content.name) || ""; } catch (e) { /* fine */ }
        const projColl = cbase.Projects, subColl = cbase.SubProjects;
        for (const lr of locRows) {
          const cur = String(lr.url || "");
          if (!cur || /^https?:\/\//i.test(cur)) continue;
          const parts = cur.split("/").filter(Boolean);
          const file = parts[parts.length - 1];
          const pathSeg = parts.length > 1 ? parts[parts.length - 2] : "";
          const candidates = [];
          for (const nm of [pathSeg, lr.name, projName]) {
            const c = sanitize(nm);
            if (c && c.length >= 3 && candidates.indexOf(c) === -1) candidates.push(c);
          }
          let fixed = null;
          for (const c of candidates) {
            const url = base + c + "/" + encodeURIComponent(c + "-" + file);
            if (await exists(url)) { fixed = url; break; }
          }
          if (!fixed) { locationUnresolved.push((lr.name || lr.lid) + " :: " + cur); continue; }
          try {
            const doc = await locColl.get(lr.lid);
            await locColl.upsert(lr.lid, Object.assign({}, doc.content, { url: fixed }));
            locationsTouched++; locationRepaired++;
            // parent's children[] copy carries the thumbnail the lists show
            try {
              const parentColl = (String(lr.parenttype || "").toLowerCase() === "project") ? projColl : subColl;
              const pdoc = await parentColl.get(lr.parentid);
              if (pdoc && pdoc.content && Array.isArray(pdoc.content.children)) {
                let touched = false;
                const children = pdoc.content.children.map((ch) => {
                  const cid = ch && (ch.id || ch._id);
                  if (cid === lr.lid) { touched = true; return Object.assign({}, ch, { url: fixed }); }
                  return ch;
                });
                if (touched) await parentColl.upsert(lr.parentid, Object.assign({}, pdoc.content, { children }));
              }
            } catch (e) { /* parent copy is best effort */ }
          } catch (e) { locationUnresolved.push((lr.name || lr.lid) + " :: save failed"); }
        }
        return res.status(200).json({ sections: sectionsTouched, repaired, unresolved,
          locations: locationsTouched, locationRepaired, locationUnresolved });
      } catch (error) {
        console.log("repairphotos failed:", error);
        return res.status(500).json(new ErrorResponse(500, "Internal server error", error));
      }
    });

/** UMESH TODO  -- REFACTOR this code
 *  Add request Validation
 * */
router.route('/generatereport')
    .post(async function (req, res) {
        try {
            const projectId = req.body.id;
            const sectionImageProperties = req.body.sectionImageProperties;
            const companyName = req.body.companyName;
            const reportType = req.body.reportType;
            const reportFormat = req.body.reportFormat;
            // const requestType = req.body.requestType;
            // const reportId = uuidv4();
            // console.log(`reportID: ${reportId}`);
            const projectName = req.body.projectName;
            const uploader = req.body.user;
            // const docpath = `${projectName}_${reportType}_${reportId}`;

            const now = new Date();
            const timestampTemp = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}-${now.getHours().toString().padStart(2, '0')}-${now.getMinutes().toString().padStart(2, '0')}-${now.getSeconds().toString().padStart(2, '0')}`;
            const docpath = `${projectName}_${reportType}_${timestampTemp}`;
            res.status(200).json({message: 'Generating report'});
           let url; let failMsg = '';
           try {
               // FINAL REPAIRS INSPECTION (Aug 18): its own generator - the
               // originally-BAD locations + the repairs-inspection answers -
               // instead of the Visual/Invasive section pipeline.
               if (reportType === 'FinalRepairs') {
                   url = await FinalRepairsGenerator.generate(projectId, companyName, projectName, uploader, reportFormat);
               } else if (reportType === 'UnsafeConditions') {
                   // NOTICE OF UNSAFE CONDITIONS (David, Aug 29): branded Unsafe
                   // letter + generated findings pages for every section flagged
                   // "Unsafe condition present" in the visual inspection.
                   url = await FinalRepairsGenerator.generateUnsafeReport(projectId, companyName, projectName, uploader, reportFormat);
               } else {
                   url = await generateProjectReport(projectId, sectionImageProperties, companyName, reportType, reportFormat, docpath);
               }
           } catch (genErr) {
               console.error('Report generation FAILED:', genErr);
               failMsg = (genErr && genErr.message) ? String(genErr.message) : String(genErr);
               url = null;
           }
           if (!url) {
               projectReports.addProjectReport({
                   project_id: projectId,
                   name: `${projectName} - ${reportType} report FAILED [${(failMsg || 'no error').slice(0,200)}]`,
                   url: '',
                   uploader,
                   timestamp: (new Date(Date.now())).toISOString()
               }, function (err, result) { if (err) { console.log(err) } });
               return;
           }
           console.log(url);
           const project_id = projectId;
           // Distinct name so the list (and the email picker) can tell the
           // repairs re-inspection apart. Deliberately does NOT contain
           // "final report" - that phrase drives the Final Report matching.
           // Distinct names; deliberately do NOT contain "final report" (that
           // phrase drives the Final Report email-picker matching).
           const name = reportType === 'FinalRepairs' ? `${projectName} - Final Repairs Inspection`
                      : reportType === 'UnsafeConditions' ? `${projectName} - Notice of Unsafe Conditions`
                      : projectName;
            let timestamp = (new Date(Date.now())).toISOString();
            projectReports.addProjectReport({
                project_id,
                name,
                url,
                uploader,
                timestamp
            }, function (err, result) {
                if (err) {
                    console.log(err)
                }
                if (result) {
                    console.log(result)
                }
            });
            console.log(projectId);
            console.log('report uploaded');

            // Auto-build the combined Final Report (tenant final template,
            // auto-filled with project data, with the Visual report annexed).
            if (reportFormat === 'docx' && reportType === 'Visual' && url) {
                try {
                    const tenantCompany = (req.user && req.user.company) ? req.user.company : companyName;
                    const finalUrl = await FinalReportGenerator.generate(projectId, tenantCompany, projectName, uploader, url);
                    projectReports.addProjectReport({
                        project_id,
                        name: `${projectName} - Final Report`,
                        url: finalUrl,
                        uploader,
                        timestamp: (new Date(Date.now())).toISOString()
                    }, function (err, result) {
                        if (err) { console.log(err) }
                        if (result) { console.log('Final Report record added') }
                    });
                    console.log('final report uploaded');
                } catch (finalErr) {
                    console.error('Error generating Final Report:', finalErr);
                    projectReports.addProjectReport({
                        project_id,
                        name: `${projectName} - Final Report FAILED`,
                        url: '',
                        uploader,
                        timestamp: (new Date(Date.now())).toISOString()
                    }, function (err, result) { if (err) { console.log(err) } });
                }
            }
        } catch (err) {
            console.error('Error generating Report:', err);
            //return res.status(500).send('Error generating Report');
        }
    });

router.route('/generate-location-report')
    .post(async function (req, res) {
        try {
            const projectId = req.body.projectId;
            const locationID = req.body.id;
            const sectionImageProperties = req.body.sectionImageProperties;
            const companyName = req.body.companyName;
            const reportType = req.body.reportType;
            const reportFormat = req.body.reportFormat;
            const projectName = req.body.projectName;
            const uploader = req.body.user;

            const now = new Date();
            const timestampTemp = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}-${now.getHours().toString().padStart(2, '0')}-${now.getMinutes().toString().padStart(2, '0')}-${now.getSeconds().toString().padStart(2, '0')}`;
            const docpath = `${projectName}_${reportType}_${timestampTemp}`;
            res.status(200).json({message: 'Generating report'});
            const url = await generateLocationReportDoc(projectId,locationID, sectionImageProperties, companyName, reportType, reportFormat, docpath);
            console.log(url.doc.filePath);
            console.log('report uploaded');
        } catch (err) {
            console.error('Error generating Report:', err);
        }
    });

router.route('/generatereporthtml').post(async function (req, res) {
  try {
    const projectId = req.body.id;
    const sectionImageProperties = req.body.sectionImageProperties;
    const reportType = req.body.reportType;
    const project  = await projects.getProjectById(projectId);
    const htmlContent = await getProjectHtml(project, sectionImageProperties, reportType);
    res.setHeader('Content-Type', 'text/html');
    res.send(htmlContent);
  } catch (err) {
    console.error('Error generating HTML:', err);
    return res.status(500).send('Error generating HTML');
  }
});

router.route('/finalreport')
    .post(async function (req, res){
      try{
        const {companyName} = req.body;

        // Prefer the tenant's most recently generated combined Final Report
        // (final template auto-filled + visual annex) so the button downloads
        // one complete document. Falls back to the raw template if none exists.
        try {
          const tenantCompany = (req.user && req.user.company) ? req.user.company : companyName;
          const latest = await projectReports.getLatestFinalReportForCompany(tenantCompany);
          if (latest && latest.url) {
            const urlArray = latest.url.toString().split('/');
            const buffer = await uploadBlob.getBlobBuffer(urlArray[urlArray.length - 1], urlArray[urlArray.length - 2]);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            res.setHeader('Content-Disposition', `attachment; filename="${(latest.name || 'Final Report').replace(/"/g, '')}.docx"`);
            console.log('Final Report (combined) sent:', latest.name, latest.timestamp);
            return res.send(buffer);
          }
        } catch (combinedErr) {
          console.error('Combined final report lookup failed, falling back to template:', combinedErr.message);
        }

        const cleanName = companyName.replaceAll(/\s/g, "").replace('.ondeckinspectors.com','');
        const absolutePath = path.join(__dirname, '..', `${cleanName}_FinalTemplate.docx`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.sendFile(absolutePath, {}, (err) => {
          if (err) {
            console.error('Error sending file:', err);
            return res.status(500).send('Error sending file');
          } else {
            console.log('Report sent successfully');
          }
        });

      } catch(err){
        console.error('Error generating final report: ', err);
        return res.status(500).send('Error generating final report');
      }
    })

// Replace the ONE corrected Final Report MASTER template used for ALL
// clients (David, Aug 1). There are no per-tenant Final templates anymore -
// that is exactly what caused stale, uncorrected copies to be used. The
// uploaded .docx becomes Deck_FinalTemplate.docx (app folder) AND is
// persisted to blob storage under the same fixed name, so it survives code
// deployments and is always the version report generation references.
// Per-tenant branding (company name, phone, admin header/footer images)
// is applied at generation time, not baked into the template.
router.route('/replacefinalreporttemplate')
    .post(upload.single('file'), async function (req, res){
      try{
        const uploadedFile = req.file;
        if (!uploadedFile) {
          return res.status(400).json({ message: 'No file uploaded.' });
        }

        // Validate BEFORE replacing anything: a corrupt upload must never
        // break Final Report generation for every client.
        try {
          const PizZip = require('pizzip');
          const buf = fs.readFileSync(uploadedFile.path);
          const zip = new PizZip(buf);
          if (!zip.file('word/document.xml')) throw new Error('not a Word document');
        } catch (vErr) {
          try { fs.unlinkSync(uploadedFile.path); } catch (e) { /* ignore */ }
          return res.status(400).json({ message: 'That file is not a valid Word (.docx) document - the master template was NOT changed.' });
        }

        const existingFileName = 'Deck_FinalTemplate.docx';
        const filePath = path.join(__dirname, '..', existingFileName);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        fs.renameSync(uploadedFile.path, filePath);

        // Persist to blob storage: the app folder is replaced on every code
        // deployment, so the blob copy is the durable source of the template.
        try {
          const blobResult = await uploadBlob.uploadFile('projectreports', existingFileName, filePath, {
            metadata: { kind: 'finalreporttemplate-master', uploadedAt: new Date().toISOString() }
          });
          console.log('Final MASTER template persisted to blob:', blobResult);
        } catch (blobErr) {
          console.error('Final template blob persist failed:', blobErr && blobErr.message);
        }
        res.status(200).json({ message: 'Master Final Report template replaced for all clients.' });
      } catch(err){
        console.error('Error replacing final report template: ', err);
        return res.status(500).send('Error replacing final report template');
      }
    })

/* ==================== PROPOSAL (admin-managed template) ==================== */

// Admin site: upload/replace the tenant's Proposal template (.docx).
// Mirrors /replacefinalreporttemplate - blob copy is the durable source.
router.route('/replaceproposaltemplate')
    .post(upload.single('file'), async function (req, res){
      try{
        const uploadedFile = req.file;
        if (!uploadedFile) {
          return res.status(400).json({ message: 'No file uploaded.' });
        }
        const {companyName} = req.body;
        if (!companyName) {
          return res.status(400).json({ message: 'Company name is missing.' });
        }
        const cleanName = companyName.replaceAll(/\s/g, "").replace('.ondeckinspectors.com','').toLowerCase();
        const existingFileName = `${cleanName}_ProposalTemplate.docx`;
        const filePath = path.join(__dirname, '..', existingFileName);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        fs.renameSync(uploadedFile.path, filePath);
        try {
          const blobResult = await uploadBlob.uploadFile('projectreports', existingFileName, filePath, {
            metadata: { kind: 'proposaltemplate', company: cleanName }
          });
          console.log('Proposal template persisted to blob:', blobResult);
        } catch (blobErr) {
          console.error('Proposal template blob persist failed:', blobErr && blobErr.message);
        }
        res.status(200).json({ message: 'File replaced successfully.' });
      } catch(err){
        console.error('Error replacing proposal template: ', err);
        return res.status(500).send('Error replacing proposal template');
      }
    })

/* ============ CLIENT FORMS (admin-managed blank templates) ============
 * Downloadable blank forms the client fills in themselves in Word - the
 * Final Report Upon Completion (macro-enabled .docm with dropdowns that
 * color-change on selection) and the Notice of Unsafe Conditions (.docx with
 * user-input text + photo content controls). ONE master per form for ALL
 * clients (like the Final Report master); the client's own admin Report
 * Header logo + Report Footer are stamped in at download time - the SAME
 * per-tenant branding the Final Report gets - so every client gets the form
 * under their own brand. Content controls, dropdowns and macros are left
 * untouched: only the header/footer parts are rewritten.
 */
const CLIENT_FORMS = {
  finalcompletion: {
    file: 'Deck_FinalCompletionTemplate.docm',
    label: 'Final Report Upon Visual, Owner Supplied Photos',
    ext: 'docm',
    contentType: 'application/vnd.ms-word.document.macroEnabled.12',
  },
  unsafeconditions: {
    file: 'Deck_UnsafeConditionsTemplate.docx',
    label: 'Notice of Unsafe Conditions',
    ext: 'docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  // Master used to GENERATE the integrated Final Report on Final-Inspection
  // projects (one master for ALL clients; each tenant's own logo/footer and
  // company name go in at generation time). Managed in the E3 Multi-Tennant
  // Dashboard; internal - never offered as a fill-online form.
  finalrepairsmaster: {
    file: 'Deck_FinalRepairsMaster.docx',
    label: 'Master Final Upon Repairs, Onsite Visit',
    ext: 'docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    internal: true,
  },
};

// Resolve a form master: blob storage first (durable across code deploys),
// then the app folder copy shipped in the repo.
async function getClientFormMaster(form) {
  try {
    const buf = await uploadBlob.getBlobBuffer(form.file, 'projectreports');
    if (buf && buf.length > 0) return buf;
  } catch (e) { /* blob missing - fall back to the repo copy */ }
  const absolute = path.join(__dirname, '..', form.file);
  if (fs.existsSync(absolute)) return fs.readFileSync(absolute);
  return null;
}

// List the forms available to the logged-in client (only those whose master
// actually resolves) - drives the buttons under the web app's Reports tab.
router.route('/clientforms')
  .get(async function (req, res) {
    try {
      const out = [];
      for (const key of Object.keys(CLIENT_FORMS)) {
        const form = CLIENT_FORMS[key];
        if (form.internal) continue; // generation masters are not fill-online forms
        const buf = await getClientFormMaster(form);
        if (buf) out.push({ id: key, key, label: form.label, ext: form.ext });
      }
      // Both final-report flavours are offered (David, Aug 22): often no
      // on-site visit happens and only the Owner-Supplied-Photos form is
      // used - so the ONSITE (repairs-master) report is its own entry. It
      // reuses the finalcompletion form's values; includeAnnex makes the
      // server generate from the repairs master.
      try {
        const rm = await getClientFormMaster(CLIENT_FORMS.finalrepairsmaster);
        if (rm) out.push({ id: 'finalrepairs', key: 'finalcompletion', label: 'Final Report Upon Repairs, Onsite Visit', ext: 'docx', annex: true });
      } catch (e) { /* repairs master unavailable - entry simply not offered */ }
      return res.status(200).json({ forms: out });
    } catch (err) {
      console.error('Error listing client forms:', err && err.message);
      return res.status(500).json({ message: 'Could not list client forms.' });
    }
  });

// Download one client form, branded with THIS tenant's logo + footer.
router.route('/clientform')
  .get(async function (req, res) {
    try {
      const key = (req.query.key || '').toString();
      const form = CLIENT_FORMS[key];
      if (!form) return res.status(404).json({ message: 'Unknown form.' });
      const master = await getClientFormMaster(form);
      if (!master) return res.status(404).json({ message: 'That form has not been set up yet.' });

      const companyIdentifier = req.user && req.user.company;
      let outBuf = master;
      // Visual-Report presentation for the blank too: 0.25in header/footer
      // clearances + the tenant's admin logo/footer replacing whatever the
      // master carries (David, Aug 14).
      try {
        const PizZip = require('pizzip');
        const zip = new PizZip(master);
        let dxml = zip.file('word/document.xml').asText();
        dxml = dxml.replace(/(<w:pgMar[^>]*?\bw:header=")\d+(")/g, '$1360$2');
        dxml = dxml.replace(/(<w:pgMar[^>]*?\bw:footer=")\d+(")/g, '$1360$2');
        zip.file('word/document.xml', dxml);
        await brandClientFormVerbatim(zip, companyIdentifier);
        outBuf = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
      } catch (brandErr) {
        console.error('Client form branding failed, sending un-branded master:', brandErr && brandErr.message);
      }

      res.setHeader('Content-Type', form.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${form.label}.${form.ext}"`);
      return res.send(outBuf);
    } catch (err) {
      console.error('Error serving client form:', err && err.message);
      return res.status(500).json({ message: 'Could not download that form.' });
    }
  });

// Admin site: per-slot upload status for the Client Forms widget - when each
// master was last uploaded and what the uploaded file was called (David,
// Aug 22). Falls back to the repo copy's ship date when nothing was ever
// uploaded to blob.
router.route('/clientformsstatus')
  .get(async function (req, res) {
    try {
      const out = [];
      for (const key of Object.keys(CLIENT_FORMS)) {
        const form = CLIENT_FORMS[key];
        const entry = { key, label: form.label, ext: form.ext, uploadedAt: null, fileName: null, source: 'none' };
        try {
          const props = await uploadBlob.getBlobProperties(form.file, 'projectreports');
          if (props) {
            const md = props.metadata || {};
            entry.source = 'uploaded';
            entry.uploadedAt = md.uploadedat || md.uploadedAt || (props.lastModified ? new Date(props.lastModified).toISOString() : null);
            const rawName = md.originalname || md.originalName || '';
            if (rawName) { try { entry.fileName = decodeURIComponent(rawName); } catch (e) { entry.fileName = rawName; } }
          }
        } catch (e) { /* fall through to repo copy */ }
        if (entry.source === 'none') {
          const absolute = path.join(__dirname, '..', form.file);
          if (fs.existsSync(absolute)) {
            entry.source = 'built-in';
            try { entry.uploadedAt = fs.statSync(absolute).mtime.toISOString(); } catch (e) { /* leave null */ }
            entry.fileName = form.file;
          }
        }
        out.push(entry);
      }
      return res.status(200).json({ forms: out });
    } catch (err) {
      console.error('Error reading client form status:', err && err.message);
      return res.status(500).json({ message: 'Could not read form status.' });
    }
  });

// Admin site: upload/replace a client form master (one master for all clients,
// like the Final Report master). formKey identifies which form.
router.route('/replaceclientform')
  .post(upload.single('file'), async function (req, res) {
    try {
      const uploadedFile = req.file;
      if (!uploadedFile) return res.status(400).json({ message: 'No file uploaded.' });
      const key = (req.body.formKey || '').toString();
      const form = CLIENT_FORMS[key];
      if (!form) {
        try { fs.unlinkSync(uploadedFile.path); } catch (e) { /* ignore */ }
        return res.status(400).json({ message: 'Unknown form key.' });
      }
      // Validate it is a real Word package before replacing anything.
      try {
        const PizZip = require('pizzip');
        const zip = new PizZip(fs.readFileSync(uploadedFile.path));
        if (!zip.file('word/document.xml')) throw new Error('not a Word document');
      } catch (vErr) {
        try { fs.unlinkSync(uploadedFile.path); } catch (e) { /* ignore */ }
        return res.status(400).json({ message: 'That file is not a valid Word document - the form was NOT changed.' });
      }
      const filePath = path.join(__dirname, '..', form.file);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      fs.renameSync(uploadedFile.path, filePath);
      try {
        const blobResult = await uploadBlob.uploadFile('projectreports', form.file, filePath, {
          metadata: {
            kind: 'clientform', formKey: key, uploadedAt: new Date().toISOString(),
            // Blob metadata must be header-safe ASCII - encode the name and
            // decode it in /clientformsstatus.
            originalname: encodeURIComponent(String(uploadedFile.originalname || '')).slice(0, 512),
          }
        });
        console.log('Client form master persisted to blob:', form.file, blobResult);
      } catch (blobErr) {
        console.error('Client form blob persist failed:', blobErr && blobErr.message);
      }
      return res.status(200).json({ message: form.label + ' replaced for all clients.' });
    } catch (err) {
      console.error('Error replacing client form:', err && err.message);
      return res.status(500).json({ message: 'Error replacing the form.' });
    }
  });

// On-site FILL: field schema parsed from a form's content controls, so the web
// editor always matches the current template (dropdowns, text, photo slots).
router.route('/clientformschema')
  .get(async function (req, res) {
    try {
      const key = (req.query.key || '').toString();
      const form = CLIENT_FORMS[key];
      if (!form) return res.status(404).json({ message: 'Unknown form.' });
      const master = await getClientFormMaster(form);
      if (!master) return res.status(404).json({ message: 'That form has not been set up yet.' });
      const PizZip = require('pizzip');
      const engine = require('../service/clientFormEngine');
      const xml = new PizZip(master).file('word/document.xml').asText();
      const groups = engine.buildSchema(xml);
      return res.status(200).json({ key, label: form.label, ext: form.ext, groups });
    } catch (err) {
      console.error('Error building client form schema:', err && err.message);
      return res.status(500).json({ message: 'Could not read that form.' });
    }
  });

// On-site FILL (layout): HTML that mirrors the real form (tables, shading,
// element rows, column headers) with @@CTRL:<id>@@ tokens where each control
// goes, plus a controls map {id:{type,options,value}}. The web editor swaps
// the tokens for real dropdowns/inputs so it looks and reads like the form.
router.route('/clientformlayout')
  .get(async function (req, res) {
    try {
      const key = (req.query.key || '').toString();
      const form = CLIENT_FORMS[key];
      if (!form) return res.status(404).json({ message: 'Unknown form.' });
      const master = await getClientFormMaster(form);
      if (!master) return res.status(404).json({ message: 'That form has not been set up yet.' });
      const PizZip = require('pizzip');
      const engine = require('../service/clientFormEngine');
      const xml = new PizZip(master).file('word/document.xml').asText();
      const layout = engine.buildLayout(xml);
      // Swap "Deck Inspectors" for this client's company name in the on-screen
      // form (same substitution applied to the Word output).
      let companyName = '';
      try {
        const tenantsDAO = require('../model/tenantsDAO');
        const tenant = await tenantsDAO.getTenantByCompanyIdentifier(req.user && req.user.company);
        companyName = (tenant && tenant.name) || '';
      } catch (e) { /* leave as-is */ }
      const html = engine.substituteCompany(layout.html, companyName);
      // Also swap the name inside dropdown options / values so the editor's
      // "Performed by" option shows the client name.
      if (companyName) {
        for (const ref of Object.keys(layout.controls)) {
          const c = layout.controls[ref];
          if (Array.isArray(c.options)) c.options = c.options.map(o => engine.substituteCompany(o, companyName));
          if (c.value) c.value = engine.substituteCompany(c.value, companyName);
        }
      }
      return res.status(200).json({ key, label: form.label, ext: form.ext, html, controls: layout.controls, rcByRow: layout.rcByRow || {}, company: companyName });
    } catch (err) {
      console.error('Error building client form layout:', err && err.message);
      return res.status(500).json({ message: 'Could not read that form.' });
    }
  });

// On-site FILL: build a completed, branded Word file from the submitted field
// values + photo URLs. The real template is filled in place, so the output is
// pixel-identical to the template (fonts, cell shading, colors) and, for the
// .docm, keeps its macros/dropdowns.
// Build the completed, branded Word buffer from the submitted field values.
// Shared by /clientformfill (Word download) and /clientformpdf (server-side
// PDF). Returns { outBuf, form } or throws {status, message}.
// Split a stored project address into street / city / state / zip. Parsed
// from the END (zip, then state, then the last comma segment as city) so it
// copes with "1 Main St, Anytown, CA 90210" and with line breaks alike.
function splitProjectAddress(raw) {
  let s = String(raw || '').replace(/\r/g, '').replace(/\n+/g, ', ').replace(/\s+/g, ' ').trim();
  let street = s, city = '', state = '', zip = '';
  if (!s) return { street: '', city: '', state: '', zip: '' };
  const zipM = s.match(/(\d{5}(?:-\d{4})?)\s*$/);
  if (zipM) {
    zip = zipM[1];
    s = s.slice(0, zipM.index).replace(/[,\s]+$/, '');
    const stM = s.match(/(?:^|[,\s])([A-Za-z]{2})$/);
    if (stM) {
      state = stM[1].toUpperCase();
      s = s.slice(0, s.length - stM[1].length).replace(/[,\s]+$/, '');
    }
  }
  const segs = s.split(',').map((x) => x.trim()).filter(Boolean);
  if (segs.length >= 2) { city = segs[segs.length - 1]; street = segs.slice(0, -1).join(', '); }
  else { street = s; }
  return { street, city, state, zip };
}

// Content-control id for a given alias in the master ("Property Address" etc).
function controlIdByAlias(xml, alias) {
  const a = xml.indexOf('<w:alias w:val="' + alias + '"/>');
  if (a === -1) return null;
  const m = xml.slice(a, a + 600).match(/<w:id w:val="(-?\d+)"\/>/);
  return m ? m[1] : null;
}

async function buildFilledClientForm(req) {
      const { key, values, photos, origDate } = req.body || {};
      const form = CLIENT_FORMS[key];
      if (!form) throw { status: 404, message: 'Unknown form.' };
      const master = await getClientFormMaster(form);
      if (!master) throw { status: 404, message: 'That form has not been set up yet.' };

      // FINAL INSPECTION AFTER REPAIRS (David, Aug 19-21 2026): a project that
      // went through a Final Inspection generates from the admin-managed
      // "Master Final Inspection Upon Completion of Repairs"
      // (Deck_FinalRepairsMaster.docx - one master for ALL clients, replaced
      // any time in the E3 Multi-Tennant Dashboard). The same web-form values
      // fill it (the control ids match), then the annex loops render one
      // page-set per BAD location. Missing master or no final-inspection
      // footprint -> the plain form generates exactly as before.
      let annex = null;
      let masterBuf = master;
      if (key === 'finalcompletion' && req.body && req.body.projectId && req.body.includeAnnex) {
        try {
          const a = await FinalRepairsGenerator.annexData(String(req.body.projectId));
          if (a.hadFinalInspection && a.data.locations.length) {
            let rm = await getClientFormMaster(CLIENT_FORMS.finalrepairsmaster);
            if (rm) {
              // Defensive: an uploaded master with duplicate control ids would
              // make Word reject every client report - repair it on load.
              try { rm = FinalRepairsGenerator.dedupeControlIds(rm); } catch (e) { /* use as-is */ }
              annex = a; masterBuf = rm;
            }
            else console.error('Final Repairs master missing - plain form generated instead');
          }
        } catch (adErr) { console.error('Final Repairs annex data failed (plain form generated):', adErr && adErr.message); }
      }

      const PizZip = require('pizzip');
      const engine = require('../service/clientFormEngine');
      const zip = new PizZip(masterBuf);
      let xml = zip.file('word/document.xml').asText();

      // PRESENTATION RULE (David, Aug 14, definitive): the report must look
      // like the VISUAL REPORT the system already makes - centred admin logo
      // header, admin badge + Footer Text footer, same 0.25in header/footer
      // clearances - with each SECTION starting at the top of its page. The
      // master supplies the content/tables; the system supplies the Visual
      // presentation. Aug 22 (David, from the Leimert reference report): the
      // repairs report too - identical logo size and header/footer placement
      // to the Visual report, so the clearances apply on BOTH paths.
      xml = xml.replace(/(<w:pgMar[^>]*?\bw:header=")\d+(")/g, '$1360$2');
      xml = xml.replace(/(<w:pgMar[^>]*?\bw:footer=")\d+(")/g, '$1360$2');

      // "Additional Comments" (the tall grey box under the Review of Repairs
      // checklist): when the operator left it blank - or it still holds the
      // generic boilerplate sentence - print the auto-built per-location
      // repairs narrative instead, so the box reads like David's corrected
      // sample rather than a mostly-empty gap (David, Aug 22). An operator's
      // own typed comments always win.
      const fillValues = Object.assign({}, values || {});
      if (annex && annex.data && annex.data.conf && annex.data.conf.narrative) {
        const ai = xml.indexOf('<w:alias w:val="Additional Comments"/>');
        if (ai !== -1) {
          const idm = xml.slice(ai, ai + 500).match(/<w:id w:val="(-?\d+)"\/>/);
          if (idm) {
            const cid = idm[1];
            const cur = fillValues[cid] == null ? '' : String(fillValues[cid]).trim();
            if (!cur || /^All repairs are to be in accordance/i.test(cur)) {
              fillValues[cid] = annex.data.conf.narrative;
            }
          }
        }
      }

      // AUTO-POPULATE THE PROPERTY ADDRESS SERVER-SIDE (David, Aug 22).
      // The address used to be filled only in the browser, so anything that
      // left those boxes blank there - stale saved entries, a machine that had
      // not refreshed - produced a report with an empty Subject Property
      // Address. The project already knows its address, so fill any address
      // control the operator left blank here, where it cannot be lost.
      try {
        if (req.body && req.body.projectId) {
          const pRes = await projects.getProjectById(String(req.body.projectId));
          const proj = (pRes && (pRes.project || (pRes.data && pRes.data.item))) || {};
          const parts = splitProjectAddress(proj.address);
          const map = { 'Property Address': parts.street, 'City': parts.city, 'State': parts.state, 'Zip': parts.zip };
          for (const alias of Object.keys(map)) {
            const val = map[alias];
            if (!val) continue;
            const id = controlIdByAlias(xml, alias);
            if (!id) continue;
            const cur = fillValues[id];
            if (cur == null || String(cur).trim() === '') {
              fillValues[id] = val;
              console.log('clientform: auto-filled "%s" from the project (%s)', alias, val);
            }
          }
        }
      } catch (addrErr) {
        console.error('clientform: project address auto-fill skipped:', addrErr && addrErr.message);
      }

      // Text / dropdown / combo values.
      xml = engine.fillTextControls(xml, fillValues);

      // The auto-narrative must print in the sample's red accent (the fill
      // engine writes plain runs); style only the run we injected.
      xml = xml.replace(/(<w:r>)(\s*<w:t[^>]*>\s*Final Repairs Inspection performed )/,
        '$1<w:rPr><w:rStyle w:val="FinalReport"/><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" w:cstheme="minorHAnsi"/><w:bCs/><w:color w:val="EE0000"/><w:szCs w:val="24"/></w:rPr>$2');

      // "Date of original inspection" (static sample in the master) -> the
      // Visual report's date. Always run so no stale sample date prints.
      xml = engine.replaceOriginalInspectionDate(xml, typeof origDate === 'string' ? origDate : '');

      // Green "good condition" fields turn red where the row's Repairs
      // Completed is NO / IN PROGRESS (David's rule).
      xml = engine.applyConditionalColors(xml, values || {});

      // Photo-Submission / Invasive "Review of Repairs" checklist rows: label +
      // checkbox always BLACK; status value RED when a submission/review value
      // is chosen, BLACK for NA/blank - consistent form-wide (David, Aug 10).
      xml = engine.applyReviewRepairColors(xml);

      // Pagination hygiene for the Visual-style geometry: the master paginates
      // with blank spacer paragraphs tuned to ITS OWN margins, so under the
      // Visual clearances the sections would drift mid-page. applyPageBreaks
      // puts each major section at the top of its page (VISUAL INSPECTION
      // heading red), collapses redundant spacer runs, and keeps the signature
      // block with its page; tightenTallCells halves the oversized blank
      // "Repair documentation" cell (David's Aug 13 morning asks).
      xml = engine.applyPageBreaks(xml);
      xml = engine.tightenTallCells(xml);

      // "Deck Inspectors" -> this client's company name (body text only;
      // header/footer branding is applied separately below).
      try {
        const tenantsDAO = require('../model/tenantsDAO');
        const tenant = await tenantsDAO.getTenantByCompanyIdentifier(req.user && req.user.company);
        if (tenant && tenant.name) xml = engine.substituteCompanyInDoc(xml, tenant.name);
        // body placeholder phone -> tenant phone (Proposal rule; the letter
        // page prints the master's phone otherwise)
        if (tenant && tenant.phone) xml = xml.split('888-224-0489').join(String(tenant.phone).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
      } catch (e) { console.error('Client form company substitution failed:', e && e.message); }

      // Photos: each is a URL already uploaded via /api/image/upload. Fetch the
      // bytes and embed them into the matching picture content control.
      const picsByRef = {};
      if (photos && typeof photos === 'object') {
        const axios = require('axios');
        for (const ref of Object.keys(photos)) {
          const url = photos[ref];
          if (!url) continue;
          try {
            const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
            const extMatch = String(url).split('?')[0].toLowerCase().match(/\.(png|jpe?g)$/);
            const ext = extMatch ? extMatch[1] : 'png';
            picsByRef[ref] = { buf: Buffer.from(resp.data), ext };
          } catch (e) {
            console.error('Client form photo fetch failed for', ref, e && e.message);
          }
        }
      }
      if (Object.keys(picsByRef).length) {
        xml = engine.fillPictureControls(zip, xml, picsByRef, PizZip);
      }
      zip.file('word/document.xml', xml);

      // Brand with this tenant's header logo + footer - VERBATIM-SAFE version.
      // The old inline injection (FinalReportGenerator.injectTenantLogo/Footer)
      // PREPENDED a 0.75in logo paragraph into the header: with this master's
      // 1728-twip header distance the body top dropped by ~1in on EVERY page,
      // each page held a few lines less, the loss accumulated and by page 9 the
      // signature block spilled onto page 10 with a stray gap (David, Aug 13 pm).
      // brandClientFormVerbatim() instead ANCHORS the images as floating
      // (wrapNone) drawings inside the master's existing empty header/footer
      // paragraphs - header/footer heights stay exactly what the empty master
      // renders, so the body area and the master's pagination are untouched.
      try {
        const companyIdentifier = req.user && req.user.company;
        await brandClientFormVerbatim(zip, companyIdentifier);
      } catch (brandErr) {
        console.error('Client form fill branding failed (continuing):', brandErr && brandErr.message);
      }

      let outBuf = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });

      // Render the repairs master's annex loops: per-location findings and
      // photos, PASS/FAIL, editable confirmation checkboxes, the report's own
      // signature block on the confirmation page. Branding above already
      // stamped this tenant's Multi-Tennant header/footer and docx-templates
      // preserves those parts. Any failure regenerates the PLAIN form so the
      // download never breaks or ships raw template commands.
      if (annex) {
        try {
          outBuf = await FinalRepairsGenerator.renderRepairsMaster(outBuf, annex);
          // The repairs master is a plain .docx. Serving those bytes under the
          // form's macro-enabled .docm name/type makes Word refuse the file
          // outright ("unreadable content") - the extension MUST match the
          // package (David, Aug 21, Virginia Gardens).
          return {
            outBuf, form,
            ext: 'docx',
            contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          };
        } catch (renderErr) {
          console.error('Final Repairs master render failed - regenerating plain form:', renderErr && renderErr.message);
          const retryReq = { body: Object.assign({}, req.body, { includeAnnex: false }), user: req.user };
          return buildFilledClientForm(retryReq);
        }
      }

      return { outBuf, form, ext: form.ext, contentType: form.contentType };
}

// Floating-anchor branding for the client blank forms. The images are anchored
// to the page (wrapNone) from within the EXISTING empty header/footer
// paragraphs, so they render on every page WITHOUT adding any inline height:
// body top stays max(w:top, w:header + empty-para height) exactly as the
// uploaded master renders, preserving its pagination verbatim.
async function brandClientFormVerbatim(zip, companyIdentifier) {
  if (!companyIdentifier) return;
  const tenantsDAO = require('../model/tenantsDAO');
  const axios = require('axios');
  const tenant = await tenantsDAO.getTenantByCompanyIdentifier(companyIdentifier);
  if (!tenant) return;
  const EMU = 914400;
  // Per-tenant logo sizing set in the Multi-Tennant admin (David, Aug 22):
  // independent width/height per section, no limits. A blank dimension is
  // automatic (aspect ratio); nothing set = the classic 0.75in / 0.5in.
  const legacy = tenant.reportLogoSizes || {};
  const bs = tenant.brandSizes || {};
  const boxFor = (sec, legacyH, dfltH) => {
    const w = sec && Number(sec.w) > 0 ? Number(sec.w) : null;
    const h = sec && Number(sec.h) > 0 ? Number(sec.h) : null;
    if (w || h) return { w, h };
    const lh = Number(legacyH) > 0 ? Number(legacyH) : dfltH;
    return { w: null, h: lh };
  };
  const headerBox = boxFor(bs.header, legacy.headerIn, 0.75);
  const footerBox = boxFor(bs.footer, legacy.footerIn, 0.5);
  // cx/cy from a box + image dims: both set = exact box; one set = other
  // follows the image's aspect ratio.
  const emuBox = (box, dims) => {
    const ar = Math.max(1, dims.w) / Math.max(1, dims.h);
    let wIn = box.w, hIn = box.h;
    if (wIn && !hIn) hIn = wIn / ar;
    if (hIn && !wIn) wIn = hIn * ar;
    return { cx: Math.max(1, Math.round(wIn * EMU)), cy: Math.max(1, Math.round(hIn * EMU)) };
  };

  // VISUAL-REPORT STYLE BRANDING (David, Aug 14: "The attached [Visual Report]
  // is the correct logo header and footer... This is what must occur on the
  // Final Inspection Upon Completion"). The master supplies the CONTENT; the
  // header/footer presentation is ALWAYS the Visual Report's:
  //   header = the tenant's admin Report Header logo, 0.75in tall, centred -
  //            nothing else (no phone, no baked master art);
  //   footer = the tenant's admin Report Footer image (0.5in, centred) with
  //            the admin Footer Text under it - same as every Visual Report.
  // Every header/footer part is REPLACED outright, so whatever art the master
  // carries can never print. Missing admin assets leave that part empty.
  const replaceParts = (rootTag, partRe, content) => {
    for (const name of Object.keys(zip.files)) {
      const m = name.match(partRe);
      if (!m) continue;
      let x = zip.file(name).asText();
      const rootM = x.match(new RegExp('<' + rootTag + '[^>]*>'));
      const endI = x.lastIndexOf('</' + rootTag + '>');
      if (!rootM || endI === -1) continue;
      x = x.slice(0, rootM.index + rootM[0].length) + content + x.slice(endI);
      zip.file(name, x);
    }
  };
  const fetchImage = async (url) => {
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
    const buf = Buffer.from(resp.data);
    const extMatch = String(url).split('?')[0].toLowerCase().match(/\.(png|jpe?g)$/);
    const ext = extMatch ? (extMatch[1] === 'jpeg' ? 'jpg' : extMatch[1]) : 'png';
    return { buf, ext, dims: FinalReportGenerator.getImageDims(buf, ext) };
  };
  const imgPara = (rid, cx, cy, id, name) =>
    '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>'
    + FinalReportGenerator.inlineImageXml(rid, cx, cy, id, name) + '</w:p>';

  // HEADER: admin logo only, centred (identical geometry to the Visual Report).
  const logoUrl = tenant.icons && tenant.icons.header;
  if (logoUrl) {
    try {
      const img = await fetchImage(logoUrl);
      // Admin-set header box (default 0.75in tall, width by aspect).
      const { cx, cy } = emuBox(headerBox, img.dims);
      zip.file('word/media/tenantlogo.' + img.ext, img.buf);
      FinalReportGenerator.ensureContentType(zip, img.ext);
      const rel = '<Relationship Id="rIdTenantLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/tenantlogo.' + img.ext + '"/>';
      replaceParts('w:hdr', /^word\/(header\d+)\.xml$/, imgPara('rIdTenantLogo', cx, cy, 990001, 'TenantLogo'));
      for (const name of Object.keys(zip.files)) {
        const hm = name.match(/^word\/(header\d+)\.xml$/);
        if (hm) FinalReportGenerator.ensureImageRel(zip, 'word/_rels/' + hm[1] + '.xml.rels', rel, 'rIdTenantLogo');
      }
    } catch (e) { console.error('Client form header logo failed (continuing):', e && e.message); }
  }

  // FOOTER: admin footer image + Footer Text, centred (Visual Report rules).
  const showLogo = tenant.showFooterlogo !== false;
  const footImgUrl = (showLogo && tenant.icons && tenant.icons.footer) || '';
  const ftext = String(tenant.footerText || '').trim()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (footImgUrl || ftext) {
    let content = '';
    let frel = '';
    if (footImgUrl) {
      try {
        const img = await fetchImage(footImgUrl);
        // Admin-set footer box (default 0.5in tall, width by aspect).
        const { cx, cy } = emuBox(footerBox, img.dims);
        zip.file('word/media/tenantfooter.' + img.ext, img.buf);
        FinalReportGenerator.ensureContentType(zip, img.ext);
        frel = '<Relationship Id="rIdTenantFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/tenantfooter.' + img.ext + '"/>';
        content += imgPara('rIdTenantFooter', cx, cy, 990002, 'TenantFooter');
      } catch (e) { console.error('Client form footer image failed (continuing):', e && e.message); }
    }
    if (ftext) {
      content += '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="16"/></w:rPr><w:t xml:space="preserve">' + ftext + '</w:t></w:r></w:p>';
    }
    if (content) {
      replaceParts('w:ftr', /^word\/(footer\d+)\.xml$/, content);
      if (frel) {
        for (const name of Object.keys(zip.files)) {
          const fm = name.match(/^word\/(footer\d+)\.xml$/);
          if (fm) FinalReportGenerator.ensureImageRel(zip, 'word/_rels/' + fm[1] + '.xml.rels', frel, 'rIdTenantFooter');
        }
      }
    }
  }
}

// Convert a Word buffer to PDF using the self-hosted converter (Gotenberg /
// LibreOffice on the VM). This is the ONLY faithful way to match Word - the
// browser preview (html2pdf) reflowed pages and broke the layout.
async function convertDocxToPdf(buf, filename) {
  const base = (process.env.CONVERT_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('CONVERT_URL not configured');
  const token = process.env.CONVERT_TOKEN || '';
  const fd = new FormData();
  fd.append('files', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), filename);
  const headers = token ? { 'X-Convert-Token': token } : {};
  const resp = await fetch(base + '/forms/libreoffice/convert', { method: 'POST', headers, body: fd });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error('converter ' + resp.status + ' ' + t.slice(0, 200));
  }
  return Buffer.from(await resp.arrayBuffer());
}

// On-site FILL: build a completed, branded Word file (download).
router.route('/clientformfill')
  .post(async function (req, res) {
    try {
      const { outBuf, form, ext, contentType } = await buildFilledClientForm(req);
      const fileExt = ext || form.ext;

      // DELIVER AS A URL (David, Aug 22). Building the file inside this POST
      // and handing back bytes forces the browser to save a blob minutes after
      // the click - Chrome classes that as an "automatic download" and demands
      // the site permission, which is why THIS report was the only one that
      // would not download while the Visual report (a plain link to a stored
      // file) always worked. Store the finished file and return its URL so the
      // web app can download it exactly the way the Visual report does.
      if (req.body && req.body.deliver === 'url') {
        const os = require('os');
        const stamp = Date.now();
        const base = String(req.body.fileName || form.label || 'Report')
          .replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim() || 'Report';
        const blobName = base + ' ' + stamp + '.' + fileExt;
        const tmpPath = path.join(os.tmpdir(), 'clientform_' + stamp + '.' + fileExt);
        fs.writeFileSync(tmpPath, outBuf);
        try {
          const result = await uploadBlob.uploadFile('projectreports', blobName, tmpPath, {
            metadata: { kind: 'clientformfill', formKey: String(req.body.key || '') },
          });
          const parsed = JSON.parse(result);
          if (!parsed || !parsed.url) throw new Error('upload returned no url');
          return res.status(200).json({ url: parsed.url, fileName: base + '.' + fileExt });
        } catch (upErr) {
          // Storage hiccup: fall through and send the bytes as before rather
          // than failing the download outright.
          console.error('clientformfill URL delivery failed, sending bytes instead:', upErr && upErr.message);
        } finally {
          try { fs.unlinkSync(tmpPath); } catch (e) { /* temp cleanup only */ }
        }
      }

      res.setHeader('Content-Type', contentType || form.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${form.label} - completed.${fileExt}"`);
      return res.send(outBuf);
    } catch (err) {
      if (err && err.status) return res.status(err.status).json({ message: err.message });
      console.error('Error filling client form:', err && err.message);
      return res.status(500).json({ message: 'Could not build the completed form.' });
    }
  });

// Save PDF: same filled Word file, converted to PDF by the self-hosted Word
// engine so the PDF is IDENTICAL to the Word document (correct header,
// pagination, tables and colours).
router.route('/clientformpdf')
  .post(async function (req, res) {
    try {
      const { outBuf, form } = await buildFilledClientForm(req);
      // LibreOffice (the converter) renders content-control TEXT but drops the
      // run COLOUR inside a <w:sdt>, so the whole colour scheme (green repair
      // rows, red PASS/FAIL, the red VISUAL INSPECTION heading) printed black in
      // the PDF. Flatten the controls to plain runs for the PDF ONLY so the
      // colours render; the Word download above keeps real editable controls.
      const PizZip = require('pizzip');
      const engine = require('../service/clientFormEngine');
      const pdfZip = new PizZip(outBuf);
      let pdfXml = pdfZip.file('word/document.xml').asText();
      pdfXml = engine.flattenContentControls(pdfXml);
      pdfZip.file('word/document.xml', pdfXml);
      const flatBuf = pdfZip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
      // Name it .docx for the converter (LibreOffice reads the bytes either way;
      // macros are irrelevant to rendering).
      const pdf = await convertDocxToPdf(flatBuf, (form.label || 'Final Report') + '.docx');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${form.label} - completed.pdf"`);
      return res.send(pdf);
    } catch (err) {
      if (err && err.status) return res.status(err.status).json({ message: err.message });
      console.error('Error building client form PDF:', err && err.message);
      return res.status(500).json({ message: 'Could not build the PDF.' });
    }
  });

// Field definitions (dropdowns + current defaults) parsed from the tenant's
// CURRENT proposal template, so the web form always matches the document.
router.route('/proposalform')
    .get(async function (req, res){
      try{
        const companyIdentifier = req.user && req.user.company;
        const buf = await ProposalGenerator.getTemplateBuffer(companyIdentifier);
        const fields = ProposalGenerator.parseFields(buf);
        res.status(200).json({ fields });
      } catch(err){
        console.error('Error parsing proposal form:', err);
        return res.status(500).json({ message: 'Could not read the proposal template.' });
      }
    })

// Tenant branding (logo/footer/company name) for the on-line print rendering.
router.route('/proposalbranding')
    .get(async function (req, res){
      try{
        const companyIdentifier = req.user && req.user.company;
        const branding = await ProposalGenerator.getBranding(companyIdentifier);
        res.status(200).json(branding);
      } catch(err){
        console.error('Error reading proposal branding:', err);
        return res.status(500).json({ message: 'Could not read branding.' });
      }
    })

// Fill the template with the submitted form values and stream the .docx.
router.route('/generateproposal')
    .post(async function (req, res){
      try{
        const companyIdentifier = req.user && req.user.company;
        const form = req.body && req.body.form ? req.body.form : req.body;
        const buffer = await ProposalGenerator.generateBuffer(companyIdentifier, form);
        const propName = ((form && form.property) || 'Proposal').replace(/[^\w .,'()-]/g, '').trim() || 'Proposal';
        // format:'pdf' (David, Aug 17): proposals emailed to clients attach as
        // PDF, converted by the self-hosted Word engine so the PDF matches the
        // document. The plain Word download path is unchanged.
        if (req.body && req.body.format === 'pdf') {
          const { convertDocxToPdf } = require('../service/convertDocxToPdf');
          const pdf = await convertDocxToPdf(buffer, propName + ' - Proposal.docx');
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename="${propName} - Proposal.pdf"`);
          return res.send(pdf);
        }
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${propName} - Proposal.docx"`);
        return res.send(buffer);
      } catch(err){
        console.error('Error generating proposal:', err);
        return res.status(500).send('Error generating proposal');
      }
    })

// Saved proposals (drafts + accepted) for the logged-in tenant.
router.route('/proposals')
    .get(async function (req, res){
      try{
        const companyIdentifier = req.user && req.user.company;
        const rows = await proposals.getProposalsByCompany(companyIdentifier);
        res.status(200).json(rows);
      } catch(err){
        console.error('Error listing proposals:', err);
        return res.status(500).json({ message: 'Could not list proposals.' });
      }
    })

// ---------------- QuickBooks Online (David, Aug 14) ----------------
// Per-tenant connection; invoice created from the accepted proposal's price;
// QBO emails the invoice; the app shows a Paid badge from the live balance.
const qboService = require('../service/quickbooksService');
const qboDAO = require('../model/qboDAO');

function parseMoney(v) {
  const m = String(v == null ? '' : v).replace(/,/g, '').match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  return m ? parseFloat(m[1]) : null;
}

// Connection status + a ready-to-confirm invoice picture for one project.
router.route('/qbo/summary')
  .get(async function (req, res) {
    try {
      const cid = req.user && req.user.company;
      const out = { configured: qboService.configured(), connected: false };
      if (!out.configured) return res.status(200).json(out);
      // Validate the connection by actually refreshing the token when needed.
      // If Intuit rejects the refresh (expired/revoked after 100 days of
      // disuse, or access revoked in QBO), tell the app to ask the customer to
      // RECONNECT rather than silently failing (Intuit questionnaire Q4).
      let conn = null;
      try { conn = await qboService.freshConnection(cid); }
      catch (tokenErr) {
        console.error('QBO token refresh failed - asking user to reconnect:', tokenErr && tokenErr.message);
        out.connected = false;
        out.reconnect = true;
        out.message = 'Your QuickBooks connection has expired or was revoked - please reconnect.';
        return res.status(200).json(out);
      }
      if (conn) { out.connected = true; out.qboCompanyName = conn.qboCompanyName || ''; }
      const projectId = (req.query.projectId || '').toString();
      if (projectId) {
        const ref = await qboDAO.getInvoiceRef(projectId);
        if (ref && ref.invoiceId && out.connected) {
          try { out.invoice = await qboService.invoiceStatus(cid, ref.invoiceId); }
          catch (e) { out.invoice = { invoiceId: ref.invoiceId, error: 'Could not reach QuickBooks: ' + e.message }; }
        }
        // defaults from the accepted proposal that became this project
        const prop = await qboDAO.getProposalByProjectId(projectId);
        if (prop && prop.form) {
          const f = prop.form;
          const val = (i) => (f.values && (f.values[i] != null ? f.values[i] : f.values[String(i)])) || '';
          // Inspection date = the date the office sees on the project card.
          let inspDate = '';
          try {
            const pr = await projectService.getProjectById(projectId);
            const item = pr && (pr.project || (pr.data && pr.data.item));
            if (item && item.editedat) inspDate = item.editedat;
          } catch (e) { /* fall back to today */ }
          out.defaults = {
            propertyName: f.property || prop.name || '',   // QBO CUSTOMER = the property
            customerName: f.ownerMgr || '',                // BILL TO line 1 = the owner
            phone: f.contactPhone || f.contact || '',
            email: f.contactEmail || '',
            ship: { line1: f.addressStreet || '', city: f.addressCity || '', stateZip: f.addressStateZip || '' },
            txnDate: inspDate,
            poNumber: 'Contract',
            inspectionAmount: parseMoney(val(10)),        // proposal "Inspection Price"
            reportAmount: parseMoney(val(21)),            // proposal "Report Fee"
          };
        }
      }
      return res.status(200).json(out);
    } catch (err) {
      console.error('QBO summary failed:', err && err.message);
      return res.status(500).json({ message: 'Could not read QuickBooks status.' });
    }
  });

// Start the connect flow: hand the app the Intuit authorize URL.
router.route('/qbo/connecturl')
  .get(async function (req, res) {
    try {
      if (!qboService.configured()) return res.status(400).json({ message: 'QuickBooks keys are not configured on the server yet.' });
      return res.status(200).json({ url: qboService.authorizeUrl(req.user && req.user.company) });
    } catch (err) {
      return res.status(500).json({ message: 'Could not start the QuickBooks connection.' });
    }
  });

// Create the invoice in QBO and have QBO email it to the client.
router.route('/qbo/invoice')
  .post(async function (req, res) {
    try {
      const cid = req.user && req.user.company;
      const b = req.body || {};
      const { projectId, email, customerName, phone, poNumber, txnDate, ship, propertyName } = b;
      if (!projectId) return res.status(400).json({ message: 'projectId is required.' });
      const inspAmt = parseMoney(b.inspectionAmount);
      const repAmt = parseMoney(b.reportAmount);
      if (!inspAmt && !repAmt) return res.status(400).json({ message: 'A valid invoice amount is required.' });
      const existing = await qboDAO.getInvoiceRef(projectId);
      if (existing && existing.invoiceId) return res.status(409).json({ message: 'An invoice already exists for this project (#' + (existing.docNumber || existing.invoiceId) + ').' });
      const when = txnDate || new Date().toISOString();
      const lines = [];
      if (inspAmt > 0) lines.push({ amount: inspAmt, serviceDate: when });
      if (repAmt > 0) lines.push({ amount: repAmt, serviceDate: when });
      const result = await qboService.createAndSendInvoice(cid, {
        propertyName: (propertyName || '').trim(),
        customerName: customerName || 'Client', phone: (phone || '').trim(),
        email: (email || '').trim(), ship: ship || {},
        txnDate: when, poNumber: poNumber || 'Contract', lines,
      });
      await qboDAO.upsertInvoiceRef(projectId, {
        companyIdentifier: cid, invoiceId: result.invoiceId,
        docNumber: result.docNumber, total: result.total, emailed: result.emailed,
      });
      return res.status(200).json(result);
    } catch (err) {
      console.error('QBO invoice failed:', err && err.message);
      return res.status(500).json({ message: 'Could not create the invoice: ' + (err && err.message) });
    }
  });

router.route('/proposals/save')
    .post(async function (req, res){
      try{
        const companyIdentifier = req.user && req.user.company;
        const { id, name, status, form, linkedProjectId } = req.body;
        const result = await proposals.upsertProposal({
          id: id || undefined,
          companyIdentifier,
          name: name || (form && form.property) || 'Untitled proposal',
          status: status || 'draft',
          form: form || {},
          linkedProjectId: linkedProjectId || null,
          createdBy: (req.user && req.user.username) || ''
        });
        res.status(200).json(result);
      } catch(err){
        console.error('Error saving proposal:', err);
        return res.status(500).json({ message: 'Could not save the proposal.' });
      }
    })

router.route('/proposals/delete')
    .post(async function (req, res){
      try{
        const result = await proposals.removeProposal(req.body.id);
        res.status(200).json(result);
      } catch(err){
        console.error('Error deleting proposal:', err);
        return res.status(500).json({ message: 'Could not delete the proposal.' });
      }
    })


module.exports = router;
