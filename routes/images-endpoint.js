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
// PHOTO ROTATION (David, Aug 23: "create a rotation process to select the
// photo and rotate to the desired viewing angle"). Rotates the ACTUAL stored
// image - not a screen-only trick - so the web app, the mobile app, and every
// generated report all see the corrected orientation. The rotated copy is
// written under a NEW blob name (browsers cache aggressively by URL; reusing
// the name would keep showing the old orientation), and the caller swaps the
// new URL into its photo list and saves as usual.
router.route('/rotate')
    .post(async function (req, res) {
        try {
            const { url, degrees } = req.body || {};
            const deg = parseInt(degrees, 10);
            if ([90, 180, 270].indexOf(deg) === -1) {
                return res.status(400).json(new ErrorResponse(400, 'degrees must be 90, 180 or 270', ''));
            }
            let u;
            try { u = new URL(String(url || '')); } catch (e) { u = null; }
            if (!u || !/\.blob\.core\.windows\.net$/.test(u.hostname)) {
                return res.status(400).json(new ErrorResponse(400, 'url must be an Azure blob photo URL', ''));
            }
            const axios = require('axios');
            const resp = await axios.get(u.href, { responseType: 'arraybuffer', timeout: 30000 });
            const buf = Buffer.from(resp.data);

            const Jimp = require('jimp');
            const img = await new Promise((ok, bad) => Jimp.read(buf, (e, i) => (e ? bad(e) : ok(i))));
            // NOTE: this jimp version's own rotate() is broken (pads the image
            // square instead of swapping width/height) - VERIFIED by test, so
            // the pixels are remapped directly instead. 90 = clockwise.
            const w = img.bitmap.width, h = img.bitmap.height, src = img.bitmap.data;
            const W = (deg === 180) ? w : h, H = (deg === 180) ? h : w;
            const dst = await new Promise((ok, bad) => new Jimp(W, H, 0xFFFFFFFF, (e, i) => (e ? bad(e) : ok(i))));
            const dd = dst.bitmap.data;
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const si = (y * w + x) * 4;
                    let dx, dy;
                    if (deg === 90) { dx = h - 1 - y; dy = x; }
                    else if (deg === 180) { dx = w - 1 - x; dy = h - 1 - y; }
                    else { dx = y; dy = w - 1 - x; }
                    const di = (dy * W + dx) * 4;
                    dd[di] = src[si]; dd[di + 1] = src[si + 1]; dd[di + 2] = src[si + 2]; dd[di + 3] = src[si + 3];
                }
            }
            const out = await new Promise((ok, bad) => dst.getBuffer(Jimp.MIME_JPEG, (e, b) => (e ? bad(e) : ok(b))));

            const parts = u.pathname.split('/').filter(Boolean);
            const container = parts.shift();
            const blobName = decodeURIComponent(parts.join('/'));
            const newName = blobName.replace(/\.[a-zA-Z0-9]+$/, '') + '-r' + Date.now() + '.jpg';

            const os = require('os'), path = require('path'), fs = require('fs');
            const tmp = path.join(os.tmpdir(), 'rotate-' + Date.now() + '-' + Math.floor(Math.random() * 1e5) + '.jpg');
            fs.writeFileSync(tmp, out);
            try {
                const result = await uploadBlob.uploadFile(container, newName, tmp, {
                    metadata: { rotatedFrom: blobName, degrees: String(deg) },
                    tags: { kind: 'rotated' },
                });
                const parsed = JSON.parse(result);
                if (!parsed || !parsed.url) throw new Error('upload returned no url');
                return res.status(200).json({ url: parsed.url });
            } finally { try { fs.unlinkSync(tmp); } catch (e) { /* temp cleanup only */ } }
        } catch (err) {
            console.log('image rotate failed:', err && err.message);
            return res.status(500).json(new ErrorResponse(500, 'Could not rotate this photo (HEIC-format phone photos cannot be rotated server-side).', String(err && err.message || err)));
        }
    });

module.exports = router;