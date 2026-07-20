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
        console.log(req.user);
        result.projects = result.projects.filter(project => project.companyIdentifier === companyIdentifier);
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
               url = await generateProjectReport(projectId, sectionImageProperties, companyName, reportType, reportFormat, docpath);
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
           const name = projectName;
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

router.route('/replacefinalreporttemplate')
    .post(upload.single('file'), async function (req, res){
      try{
        
        const uploadedFile = req.file;
        //var companyIdentifier = req.user.company;
        if (!uploadedFile) {
          return res.status(400).json({ message: 'No file uploaded.' });
        }

        const {companyName} = req.body;

        if (!companyName) {
          return res.status(400).json({ message: 'Company name is missing.' });
        }
        const cleanName = companyName.replaceAll(/\s/g, "").replace('.ondeckinspectors.com','');
        const existingFileName = `${cleanName}_FinalTemplate.docx`;
        const filePath = path.join(__dirname, '..', existingFileName);

        // Check if the file to be replaced exists
        if (fs.existsSync(filePath)) {
          // Delete the existing file
          fs.unlinkSync(filePath);
        }

        //Rename the uploaded file
        fs.renameSync(uploadedFile.path, filePath);
        res.status(200).json({ message: 'File replaced successfully.' });
      } catch(err){
        console.error('Error replacing final report template: ', err);
        return res.status(500).send('Error replacing final report template');
      }
    })


module.exports = router;
