const crypto = require('crypto');
const docxTemplate = require('docx-templates');
const fs = require('fs');
const DocxMerger = require('docx-merger');
const util = require('util');
const objectHash = require('object-hash');
const serialize = require("serialize-javascript");
const axios = require('axios');
const PizZip = require('pizzip');
const {getBlobBuffer} = require("../../database/uploadimage");
const fspromises = require('fs').promises;

class ReportGenerationUtil {
    constructor() {
        this.readFileAsync = util.promisify(fs.readFile);
        this.writeFileAsync = util.promisify(fs.writeFile);
    }

    async saveDocxMerger(docxMerger, outputType) {
        return new Promise((resolve, reject) => {
            docxMerger.save(outputType, (data) => {
                if (data) {
                    resolve(data);
                } else {
                    reject('Error saving DocxMerger data');
                }
            });
        });
    }

    // FIX (Word "unreadable content" error): DocxMerger carries over relationship
    // entries from chunk templates (e.g. header3.xml / footer3.xml) without copying
    // the actual parts into the merged package. Word flags these dangling
    // relationships and shows a recovery prompt on every generated report.
    // This removes any internal relationship whose target part is missing.
    sanitizeDocxBuffer(buffer) {
        try {
            const zip = new PizZip(buffer);
            const relsPath = 'word/_rels/document.xml.rels';
            const relsFile = zip.file(relsPath);
            if (!relsFile) return buffer;
            let rels = relsFile.asText();
            const removed = [];
            rels = rels.replace(/<Relationship\s+[^>]*\/>/g, (tag) => {
                const targetMatch = tag.match(/Target="([^"]+)"/);
                if (!targetMatch) return tag;
                const target = targetMatch[1];
                if (/TargetMode="External"/.test(tag) || /^https?:/i.test(target)) return tag;
                const partPath = target.startsWith('/')
                    ? target.replace(/^\//, '')
                    : 'word/' + target.replace(/^\.\//, '');
                if (!zip.file(partPath)) {
                    removed.push(target);
                    return '';
                }
                return tag;
            });
            if (removed.length === 0) return buffer;
            console.log('sanitizeDocxBuffer: removed dangling relationships ->', removed.join(', '));
            zip.file(relsPath, rels);
            return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
        } catch (error) {
            console.error('sanitizeDocxBuffer failed, returning original buffer', error);
            return buffer;
        }
    }

    // Merge an array of docx buffers (already in memory) and sanitize the result.
    async mergeDocxBuffers(bufferList) {
        const validBuffers = (bufferList || []).filter(Boolean);
        if (validBuffers.length === 0) {
            console.error('mergeDocxBuffers: no valid buffers to merge.');
            return null;
        }
        const docx = new DocxMerger({}, validBuffers);
        let data = await this.saveDocxMerger(docx, 'nodebuffer');
        data = this.sanitizeDocxBuffer(data);
        return data;
    }

    async mergeDocxArray(docxUrls, fileName) {
        try {
            const docFilePath = `${fileName}.docx`;
            const fileList = [];

            for (const url of docxUrls) {
                if(!url) continue;
                try {
                    var urlArray = url.toString().split('/');
                    const docxBuffer = await getBlobBuffer(urlArray[urlArray.length-1],urlArray[urlArray.length-2]);
                    fileList.push(docxBuffer);
                } catch (error) {
                    console.error(`Error fetching the file from URL: ${url}`, error);
                }
            }

            if (fileList.length === 0) {
                console.error('No valid files to merge.');
                return null;
            }

            const docx = new DocxMerger({}, fileList);

            let data = await this.saveDocxMerger(docx, 'nodebuffer');
            data = this.sanitizeDocxBuffer(data);
            await fspromises.writeFile(docFilePath, data);
            console.log('Merged DOCX file saved:', docFilePath);
            return docFilePath;
        } catch (error) {
            console.error(error);
        }
    }
    async createDocReportWithParams(template,data,additionalJsContext)
    {
        const buffer = await docxTemplate.createReport({
                template,
                data: data,
                additionalJsContext: additionalJsContext,
                failFast:false
            },
        );
        return buffer;
    }

    calculateHash = (doc) => {
        const str = serialize(doc);
         // Create a SHA-256 hash of the string
        const hash = crypto.createHash('sha256');
        hash.update(str);

        // Return the hash code as a hex string
        return hash.digest('hex');
    }

     combineHashesInArray(hashArray) {
        const combinedHash = hashArray.join(''); // Concatenate all hash codes
         return crypto.createHash('sha256').update(combinedHash).digest('hex');
    }

}
module.exports = new ReportGenerationUtil();
