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
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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

    // Merge N docx buffers via docxcompose (python, vendored in pyvendor/).
    // This is the only merge method verified to open cleanly in Word
    // (no 'unreadable content' recovery prompt). Returns a buffer or null.
    mergeViaPython(bufferList, tag) {
        try {
            if (!bufferList || bufferList.length === 0) return null;
            if (bufferList.length === 1) return bufferList[0];
            const appRoot = path.join(__dirname, '..', '..');
            const script = path.join(appRoot, 'scripts', 'merge_docx.py');
            const pyvendor = path.join(appRoot, 'pyvendor');
            if (!fs.existsSync(script) || !fs.existsSync(pyvendor)) {
                console.log('mergeViaPython: python merge assets missing, using Node fallback');
                return null;
            }
            const tmpFiles = [];
            for (let k = 0; k < bufferList.length; k++) {
                const p = path.join(os.tmpdir(), `${tag}_m${k}.docx`);
                fs.writeFileSync(p, bufferList[k]);
                tmpFiles.push(p);
            }
            const outPath = path.join(os.tmpdir(), `${tag}_mout.docx`);
            const r = spawnSync('python3', [script, ...tmpFiles, outPath], {
                env: Object.assign({}, process.env, { PYTHONPATH: pyvendor }),
                timeout: 180000
            });
            let out = null;
            if (r.status === 0 && fs.existsSync(outPath)) {
                out = fs.readFileSync(outPath);
            } else {
                console.error('mergeViaPython failed', r.status, (r.stderr || '').toString().slice(0, 400));
            }
            for (const f of [...tmpFiles, outPath]) { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } }
            return out;
        } catch (e) {
            console.error('mergeViaPython error', e);
            return null;
        }
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

            // docxcompose first - Word-clean output; DocxMerger below is fallback.
            const pyMerged = this.mergeViaPython(fileList, fileName);
            if (pyMerged) {
                await fspromises.writeFile(docFilePath, pyMerged);
                console.log('Merged DOCX file saved (docxcompose):', docFilePath);
                return docFilePath;
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
