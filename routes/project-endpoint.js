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
const ProposalGenerator = require("../service/ReportGeneration/ProposalGenerator.js");
const proposals = require("../model/proposals");

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
    label: 'Final Report Upon Completion',
    ext: 'docm',
    contentType: 'application/vnd.ms-word.document.macroEnabled.12',
  },
  unsafeconditions: {
    file: 'Deck_UnsafeConditionsTemplate.docx',
    label: 'Notice of Unsafe Conditions',
    ext: 'docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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
        const buf = await getClientFormMaster(form);
        if (buf) out.push({ key, label: form.label, ext: form.ext });
      }
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
      // Stamp the tenant's admin Report Header logo + Report Footer - the SAME
      // functions the Final Report uses. They only rewrite header/footer XML,
      // so dropdowns, content controls and (for the .docm) macros survive. Any
      // failure falls back to the un-branded master rather than blocking.
      try {
        const PizZip = require('pizzip');
        const zip = new PizZip(master);
        await FinalReportGenerator.injectTenantLogo(zip, companyIdentifier);
        await FinalReportGenerator.injectTenantFooter(zip, companyIdentifier);
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
          metadata: { kind: 'clientform', formKey: key, uploadedAt: new Date().toISOString() }
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
router.route('/clientformfill')
  .post(async function (req, res) {
    try {
      const { key, values, photos, origDate } = req.body || {};
      const form = CLIENT_FORMS[key];
      if (!form) return res.status(404).json({ message: 'Unknown form.' });
      const master = await getClientFormMaster(form);
      if (!master) return res.status(404).json({ message: 'That form has not been set up yet.' });

      const PizZip = require('pizzip');
      const engine = require('../service/clientFormEngine');
      const zip = new PizZip(master);
      let xml = zip.file('word/document.xml').asText();

      // Header sits ~1.2in down in the master (w:header="1728") which pushes the
      // branded logo too far down; match the Visual/Final report header by
      // moving it near the top. Body top margin (w:top) is left untouched so
      // pagination stays identical - pages won't run into each other.
      xml = xml.replace(/(<w:pgMar\b[^>]*?\bw:header=")\d+(")/g, '$118$2');

      // Text / dropdown / combo values.
      xml = engine.fillTextControls(xml, values || {});

      // "Date of original inspection" (static sample in the master) -> the
      // Visual report's date. Always run so no stale sample date prints.
      xml = engine.replaceOriginalInspectionDate(xml, typeof origDate === 'string' ? origDate : '');

      // Green "good condition" fields turn red where the row's Repairs
      // Completed is NO / IN PROGRESS (David's rule).
      xml = engine.applyConditionalColors(xml, values || {});

      // "Deck Inspectors" -> this client's company name (body text only;
      // header/footer branding is applied separately below).
      try {
        const tenantsDAO = require('../model/tenantsDAO');
        const tenant = await tenantsDAO.getTenantByCompanyIdentifier(req.user && req.user.company);
        if (tenant && tenant.name) xml = engine.substituteCompanyInDoc(xml, tenant.name);
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

      // Brand with this tenant's header logo + footer (same as the download).
      try {
        const companyIdentifier = req.user && req.user.company;
        await FinalReportGenerator.injectTenantLogo(zip, companyIdentifier);
        await FinalReportGenerator.injectTenantFooter(zip, companyIdentifier);
      } catch (brandErr) {
        console.error('Client form fill branding failed (continuing):', brandErr && brandErr.message);
      }

      const outBuf = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.setHeader('Content-Type', form.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${form.label} - completed.${form.ext}"`);
      return res.send(outBuf);
    } catch (err) {
      console.error('Error filling client form:', err && err.message);
      return res.status(500).json({ message: 'Could not build the completed form.' });
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
