"use strict";
var express = require('express');
var router = express.Router();
var uploadBlob = require('../database/uploadimage')
const bcrypt = require('bcrypt');
var jwt = require('jsonwebtoken');
const ErrorResponse = require('../model/error');
var multer = require('multer');
var upload = multer({ dest: 'uploads/' });
const bodyParser = require('body-parser');
var image = require('../model/image');
var tenantService = require('../service/tenantService');
const { newPipeline } = require('@azure/storage-blob');

require("dotenv").config();

//#region upload image

//uploadOptions: {
//   metadata: { reviewer: 'john', reviewDate: '2022-04-01' }, 
//   tags: {project: 'xyz', owner: 'accounts-payable'}
// }
router.use(bodyParser.urlencoded({ extended: true }));
router.route('/upload')
    .post(upload.single("picture"), async function (req, res) {
        var errResponse;
        try {
            var editedat = (new Date(Date.now())).toISOString();
            const { containerName, uploader, entityName,id,
                  lasteditedby, 
                 type, parentType} = req.body;
            var companyIdentifier = req.user.company;
            // companyIdentifier = companyIdentifier.replaceAll(".","-");
            // companyIdentifier = companyIdentifier.replaceAll(" ","");
            var fileSizeInBytes = parseInt(req.headers['content-length']) ;
            const filetoUpload = req.file;
            
            //replace all except alphanumeric

            var newcontainerName= containerName.replace(/[^a-zA-Z0-9 ]/g, '');
            newcontainerName = newcontainerName.toLowerCase();
            newcontainerName = newcontainerName.replaceAll(" ","");
            companyIdentifier = companyIdentifier.replace(/[^a-zA-Z0-9 ]/g, '');
            // var newentityName= entityName.replace(/[^a-zA-Z0-9 ]/g, '');
            // newentityName = newentityName.toLowerCase();
            //container would be now the companyidentifier

            const uploadOptions = {
                metadata: {
                    'uploader': uploader,
                },
                tags: {
                    'project': newcontainerName,
                    'owner': companyIdentifier
                }
            };
            
            if (newcontainerName.length < 3) {
                newcontainerName = `${newcontainerName}-${uploader}`;
              }
            if (!(newcontainerName && filetoUpload)) {
                errResponse = new ErrorResponse(400, "containerName, blobName, filePath is required", "");
                res.status(400).json(errResponse);
                return;
            }
            var result = await uploadBlob.uploadFile(newcontainerName, `${newcontainerName}-${filetoUpload.originalname}`, filetoUpload.path, uploadOptions);
            var response = JSON.parse(result);
            if (response.error) {
                errResponse = new ErrorResponse(500, 'Internal server error', result.error);
                console.log(response);
                res.status(500).json(errResponse);
                return;
            }
            if (response.message) {
                res.status(201).json(response);
                //Update images Url
                image.updateImageURL(id,
                    response.url, lasteditedby, editedat, 
                    type, parentType);
                //TODO update the used space against the company
                tenantService.updateStorageStats(companyIdentifier,1,fileSizeInBytes);
                // increment the image count  as well
                
            }
            else
                res.status(409).json(response);
            return;

        } catch (err) {
            console.log(err);
            errResponse = new ErrorResponse(500, "Internal server error", err);
            res.status(500).json(errResponse);
        }
    });

    router.route('/uploadlogos')
    .post(upload.single("picture"), async function (req, res) {
        var errResponse;
        try {
            var editedat = (new Date(Date.now())).toISOString();
            const { containerName, uploader, entityName,id,
                  lasteditedby, 
                 type, parentType} = req.body;
            //var companyIdentifier = req.user.company;
            //companyIdentifier = companyIdentifier.replaceAll(".","-");
            //var fileSizeInBytes = req.headers['content-length'] ;
            const filetoUpload = req.file;
            
            //replace all except alphanumeric

            var newcontainerName= containerName.replace(/[^a-zA-Z0-9 ]/g, '');
            newcontainerName = newcontainerName.toLowerCase();
            // var newentityName= entityName.replace(/[^a-zA-Z0-9 ]/g, '');
            // newentityName = newentityName.toLowerCase();
            //container would be now the companyidentifier

            const uploadOptions = {
                metadata: {
                    'uploader': uploader,
                },
                tags: {
                    'project': newcontainerName,
                    
                }
            };
            
            if (newcontainerName.length < 3) {
                newcontainerName = `${newcontainerName}-${uploader}`;
              }
            if (!(newcontainerName && filetoUpload)) {
                errResponse = new ErrorResponse(400, "containerName, blobName, filePath is required", "");
                res.status(400).json(errResponse);
                return;
            }
            var result = await uploadBlob.uploadFile(newcontainerName, `${filetoUpload.originalname}`, filetoUpload.path, uploadOptions);
            var response = JSON.parse(result);
            if (response.error) {
                errResponse = new ErrorResponse(500, 'Internal server error', result.error);
                console.log(response);
                res.status(500).json(errResponse);
                return;
            }
            if (response.message) {
                res.status(201).json(response);                
                
            }
            else
                res.status(409).json(response);
            return;

        } catch (err) {
            console.log(err);
            errResponse = new ErrorResponse(500, "Internal server error", err);
            res.status(500).json(errResponse);
        }
    });
module.exports = router;