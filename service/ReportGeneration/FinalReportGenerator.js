const path = require('path');
const fs = require('fs');
const os = require('os');
const PizZip = require('pizzip');
const DocxMerger = require('docx-merger');
const { spawnSync } = require('child_process');
const projects = require("../../model/project");
const location = require("../../model/location");
const subProject = require("../../model/subproject");
const sections = require("../../model/sections");
const ReportGenerationUtil = require("./ReportGenerationUtil");
const uploadBlob = require("../../database/uploadimage");
const { getBlobBuffer } = require("../../database/uploadimage");
const tenantsDAO = require("../../model/tenantsDAO");
const axios = require("axios");

// Builds the combined "Final Report": the tenant's Final template auto-filled
// with project data, followed by the freshly generated Visual report as annex.
class FinalReportGenerator {

    resolveTemplatePath(companyName) {
        const cleanName = (companyName || '').replaceAll(/\s/g, "").replace('.ondeckinspectors.com', '');
        const candidates = [
            `${cleanName}_FinalTemplate.docx`,
            `${cleanName}_finalTemplate.docx`,
            'Deck_FinalTemplate.docx'
        ];
        for (const candidate of candidates) {
            const absolute = path.join(__dirname, '..', '..', candidate);
            if (candidate.length > '_FinalTemplate.docx'.length && fs.existsSync(absolute)) {
                return absolute;
            }
        }
        // final fallback: default Deck template
        return path.join(__dirname, '..', '..', 'Deck_FinalTemplate.docx');
    }

    formatDate(value) {
        if (!value) return '';
        try {
            const d = new Date(value);
            if (isNaN(d.getTime())) return String(value);
            return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
        } catch (e) {
            return String(value);
        }
    }

    async collectProjectData(projectId) {
        const projectResponse = await projects.getProjectById(projectId);
        const project = projectResponse.project || (projectResponse.data && projectResponse.data.item) || {};

        // Gather every unit (location) directly under the project and under each subproject
        const locationIds = [];
        try {
            const directLocations = await location.getLocationByParentId(projectId);
            if (directLocations.data && directLocations.data.item) {
                for (const loc of directLocations.data.item) {
                    locationIds.push(loc.id || loc._id);
                }
            }
        } catch (e) { console.log('FinalReport: direct locations lookup failed', e.message); }

        try {
            const subProjectsData = await subProject.getSubProjectsByParentId(projectId);
            if (subProjectsData.data && subProjectsData.data.item) {
                for (const sp of subProjectsData.data.item) {
                    const spId = sp.id || sp._id;
                    try {
                        const spLocations = await location.getLocationByParentId(spId);
                        if (spLocations.data && spLocations.data.item) {
                            for (const loc of spLocations.data.item) {
                                locationIds.push(loc.id || loc._id);
                            }
                        }
                    } catch (e) { console.log('FinalReport: subproject locations lookup failed', e.message); }
                }
            }
        } catch (e) { console.log('FinalReport: subprojects lookup failed', e.message); }

        let unitsWithEEE = 0;
        let totalEEE = 0;
        for (const locId of locationIds) {
            if (!locId) continue;
            try {
                const sectionData = await sections.getSectionMetaDataForLocationId(locId);
                const count = (sectionData.data && sectionData.data.item) ? sectionData.data.item.length : 0;
                if (count > 0) {
                    unitsWithEEE += 1;
                    totalEEE += count;
                }
            } catch (e) { console.log('FinalReport: section count failed for', locId, e.message); }
        }

        // Split the address into street / city / state / zip. Handles both
        // "street, city, ST 12345" and the mobile-app style with a line
        // break between street and city ("street\ncity, ST 12345").
        const rawAddress = (project.address || '').trim();
        const flatAddress = rawAddress.replace(/\s+/g, ' ').trim();
        let addressStreet = flatAddress;
        let addressCity = '';
        let addressState = '';
        let addressZip = '';
        let streetPart = '';
        let restPart = '';
        if (/\r|\n/.test(rawAddress)) {
            const nlLines = rawAddress.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
            streetPart = nlLines[0] || '';
            restPart = nlLines.slice(1).join(', ');
        } else {
            const cIdx = flatAddress.indexOf(',');
            if (cIdx !== -1) {
                streetPart = flatAddress.slice(0, cIdx).trim();
                restPart = flatAddress.slice(cIdx + 1).trim();
            }
        }
        if (restPart) {
            const m = restPart.replace(/\s+/g, ' ').match(/^(.*?),?\s*([A-Z]{2})\.?\s*(\d{5})(?:-\d{4})?\s*$/);
            if (m) {
                addressStreet = streetPart;
                addressCity = m[1].replace(/,\s*$/, '').trim();
                addressState = m[2];
                addressZip = m[3];
            } else {
                addressStreet = streetPart;
                addressCity = restPart;
            }
        }

        return {
            projectName: project.name || '',
            projectAddress: flatAddress,
            addressStreet: addressStreet,
            addressCity: addressCity,
            addressState: addressState,
            addressZip: addressZip,
            projectDescription: project.description || '',
            inspectionDate: this.formatDate(project.createdat || project.createdAt),
            unitsWithEEE: String(unitsWithEEE),
            totalEEE: String(totalEEE),
            eeeInspected: String(totalEEE)
        };
    }

    saveDocxMerger(m, type) {
        return new Promise((res, rej) => m.save(type, d => d ? res(d) : rej(new Error('merge save failed'))));
    }

    getNumberingMaps(numberingXml) {
        const nums = {};
        const abstracts = {};
        for (const m of numberingXml.matchAll(/<w:num w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
            const a = (m[2].match(/<w:abstractNumId w:val="(\d+)"\/>/) || [])[1];
            nums[m[1]] = a;
        }
        for (const m of numberingXml.matchAll(/<w:abstractNum w:abstractNumId="(\d+)"[^>]*>[\s\S]*?<\/w:abstractNum>/g)) {
            abstracts[m[1]] = m[0];
        }
        return { nums, abstracts };
    }

    // Re-add numbering definitions that docx-merger drops when merging two
    // unrelated documents (undefined numIds are one cause of Word's
    // "unreadable content" prompt).
    repairNumbering(zip, sourceBuffers) {
        const numPath = 'word/numbering.xml';
        const numFile = zip.file(numPath);
        if (!numFile) return;
        let numbering = numFile.asText();
        const doc = zip.file('word/document.xml').asText();
        const used = new Set([...doc.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map(m => m[1]));
        const merged = this.getNumberingMaps(numbering);
        const missing = [...used].filter(id => !(id in merged.nums));
        if (!missing.length) return;
        console.log('FinalReport repair: missing numIds ->', missing.join(', '));
        let maxAbstract = Math.max(0, ...Object.keys(merged.abstracts).map(Number));
        const additionsAbstract = [];
        const additionsNum = [];
        for (const numId of missing) {
            for (const buf of sourceBuffers) {
                try {
                    const srcZip = new PizZip(buf);
                    const srcNumFile = srcZip.file(numPath);
                    if (!srcNumFile) continue;
                    const src = this.getNumberingMaps(srcNumFile.asText());
                    if (!(numId in src.nums)) continue;
                    const abstractXml = src.abstracts[src.nums[numId]];
                    if (!abstractXml) continue;
                    maxAbstract += 1;
                    additionsAbstract.push(abstractXml.replace(/<w:abstractNum w:abstractNumId="\d+"/, `<w:abstractNum w:abstractNumId="${maxAbstract}"`));
                    additionsNum.push(`<w:num w:numId="${numId}"><w:abstractNumId w:val="${maxAbstract}"/></w:num>`);
                    break;
                } catch (e) { /* try next source */ }
            }
        }
        if (!additionsAbstract.length) return;
        const firstNumIdx = numbering.search(/<w:num w:numId="/);
        if (firstNumIdx !== -1) {
            numbering = numbering.slice(0, firstNumIdx) + additionsAbstract.join('') + numbering.slice(firstNumIdx);
        } else {
            numbering = numbering.replace('</w:numbering>', additionsAbstract.join('') + '</w:numbering>');
        }
        numbering = numbering.replace('</w:numbering>', additionsNum.join('') + '</w:numbering>');
        zip.file(numPath, numbering);
        console.log('FinalReport repair: added', additionsAbstract.length, 'numbering definitions');
    }

    fixDuplicateDocPrIds(zip) {
        const docPath = 'word/document.xml';
        let doc = zip.file(docPath).asText();
        const seen = new Set();
        let nextId = 100000;
        let fixes = 0;
        doc = doc.replace(/<wp:docPr id="(\d+)"/g, (m, id) => {
            if (seen.has(id)) { fixes += 1; nextId += 1; return `<wp:docPr id="${nextId}"`; }
            seen.add(id);
            return m;
        });
        if (fixes) {
            console.log('FinalReport repair: renumbered', fixes, 'duplicate docPr ids');
            zip.file(docPath, doc);
        }
    }

    // Merge via docxcompose (python, vendored into pyvendor/ by the CI build).
    // This is the method verified to open cleanly in Word. Returns null on failure
    // so the caller can fall back to the Node merger.
    combineWithDocxCompose(finalBuffer, visualBuffer, projectId) {
        try {
            const appRoot = path.join(__dirname, '..', '..');
            const script = path.join(appRoot, 'scripts', 'merge_docx.py');
            const pyvendor = path.join(appRoot, 'pyvendor');
            if (!fs.existsSync(script) || !fs.existsSync(pyvendor)) {
                console.log('FinalReport: python merge assets missing, will use Node fallback');
                return null;
            }
            const tmpHost = path.join(os.tmpdir(), `${projectId}_final_host.docx`);
            const tmpAnnex = path.join(os.tmpdir(), `${projectId}_final_annex.docx`);
            const tmpOut = path.join(os.tmpdir(), `${projectId}_final_out.docx`);
            fs.writeFileSync(tmpHost, finalBuffer);
            fs.writeFileSync(tmpAnnex, visualBuffer);
            const r = spawnSync('python3', [script, tmpHost, tmpAnnex, tmpOut], {
                env: Object.assign({}, process.env, { PYTHONPATH: pyvendor }),
                timeout: 120000
            });
            let out = null;
            if (r.status === 0 && fs.existsSync(tmpOut)) {
                out = fs.readFileSync(tmpOut);
            } else {
                console.error('FinalReport: python merge failed', r.status, (r.stderr || '').toString().slice(0, 500));
            }
            for (const f of [tmpHost, tmpAnnex, tmpOut]) { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } }
            return out;
        } catch (e) {
            console.error('FinalReport: python merge error', e);
            return null;
        }
    }

    // Merge filled final + visual with docx-merger, then repair every defect
    // class it creates (dangling rels, dropped numbering, duplicate docPr ids).
    async combineAndRepair(finalBuffer, visualBuffer) {
        const merger = new DocxMerger({}, [finalBuffer, visualBuffer]);
        const mergedBuf = await this.saveDocxMerger(merger, 'nodebuffer');
        let repaired = ReportGenerationUtil.sanitizeDocxBuffer(mergedBuf);
        const zip = new PizZip(repaired);
        this.repairNumbering(zip, [finalBuffer, visualBuffer]);
        this.fixDuplicateDocPrIds(zip);
        return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    }

    xmlEscape(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Find the sdtContent range of the content control whose alias matches.
    findSdtContentRange(doc, aliasName) {
        const escaped = aliasName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = doc.match(new RegExp(`<w:alias w:val="${escaped}"[^>]*/>`));
        if (!m) return null;
        const aIdx = doc.indexOf(m[0]);
        const start = doc.indexOf('<w:sdtContent>', aIdx);
        if (start === -1) return null;
        let depth = 0;
        let i = start;
        while (i < doc.length) {
            const nextOpen = doc.indexOf('<w:sdtContent>', i + 1);
            const nextClose = doc.indexOf('</w:sdtContent>', i + 1);
            if (nextClose === -1) return null;
            if (nextOpen !== -1 && nextOpen < nextClose) {
                depth += 1;
                i = nextOpen;
            } else {
                if (depth === 0) {
                    return { contentStart: start + '<w:sdtContent>'.length, contentEnd: nextClose };
                }
                depth -= 1;
                i = nextClose;
            }
        }
        return null;
    }

    // Swap only the text inside the first w:t of a chunk, preserving all
    // run/paragraph structure and attributes (verified Word-safe approach).
    swapFirstTextRun(chunk, value) {
        const v = this.xmlEscape(value);
        return chunk.replace(/(<w:t(?: [^>]*)?>)([\s\S]*?)(<\/w:t>)/, (m, open, inner, close) => {
            if (!/xml:space/.test(open)) open = open.replace('<w:t', '<w:t xml:space="preserve"');
            return open + v + close;
        });
    }

    // Fill the template's named content controls (Property Address, City, Date, ...)
    // and labeled count cells by minimal in-place text swap — the uploaded template
    // is used exactly as-is; only field text changes, nothing structural.
    getImageDims(buf, ext) {
        try {
            if (ext === 'png') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
            let i = 2;
            while (i < buf.length - 9) {
                if (buf[i] !== 0xFF) { i++; continue; }
                const marker = buf[i + 1];
                if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
                    return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
                }
                i += 2 + buf.readUInt16BE(i + 2);
            }
        } catch (e) { /* fall through */ }
        return { w: 900, h: 260 };
    }

    // Stamp the tenant's logo (Multi-Tenant admin -> tenant.icons.logoUrl) into
    // the template's blank header at generation time. The shared template ships
    // with an empty header; each client's logo is applied here 'at print'.
    async injectTenantLogo(zip, companyIdentifier) {
        try {
            if (!companyIdentifier) return;
            const tenant = await tenantsDAO.getTenantByCompanyIdentifier(companyIdentifier);
            const logoUrl = tenant && tenant.icons && tenant.icons.logoUrl;
            if (!logoUrl) { console.log('FinalReport: no tenant logo set, header left as-is'); return; }
            const resp = await axios.get(logoUrl, { responseType: 'arraybuffer', timeout: 60000 });
            const buf = Buffer.from(resp.data);
            const extMatch = logoUrl.split('?')[0].toLowerCase().match(/\.(png|jpe?g)$/);
            const ext = extMatch ? (extMatch[1] === 'jpeg' ? 'jpg' : extMatch[1]) : 'png';
            const headerFile = zip.file('word/header1.xml');
            const relsFile = zip.file('word/_rels/header1.xml.rels');
            if (!headerFile || !relsFile) { console.log('FinalReport: template has no header1 to stamp'); return; }
            let header = headerFile.asText();
            if (header.indexOf('rIdTenantLogo') !== -1) return; // already stamped
            const dims = this.getImageDims(buf, ext);
            const EMU = 914400;
            const cy = Math.round(0.85 * EMU);
            const cx = Math.max(1, Math.round(cy * dims.w / Math.max(1, dims.h)));
            const mediaPath = 'word/media/tenantlogo.' + ext;
            zip.file(mediaPath, buf);
            let rels = relsFile.asText();
            rels = rels.replace('</Relationships>', '<Relationship Id="rIdTenantLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/tenantlogo.' + ext + '"/></Relationships>');
            zip.file('word/_rels/header1.xml.rels', rels);
            const ctPath = '[Content_Types].xml';
            let ct = zip.file(ctPath).asText();
            if (ct.indexOf('Extension="' + ext + '"') === -1) {
                const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
                ct = ct.replace('</Types>', '<Default Extension="' + ext + '" ContentType="' + mime + '"/></Types>');
                zip.file(ctPath, ct);
            }
            const drawing = '<w:p><w:pPr><w:pStyle w:val="Header"/><w:jc w:val="center"/></w:pPr>'
                + '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
                + '<wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:effectExtent l="0" t="0" r="0" b="0"/>'
                + '<wp:docPr id="990001" name="TenantLogo"/>'
                + '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>'
                + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
                + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
                + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
                + '<pic:nvPicPr><pic:cNvPr id="990001" name="TenantLogo"/><pic:cNvPicPr/></pic:nvPicPr>'
                + '<pic:blipFill><a:blip r:embed="rIdTenantLogo"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
                + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>'
                + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
                + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
            const rootMatch = header.match(/<w:hdr[^>]*>/);
            if (!rootMatch) { console.log('FinalReport: header root not found'); return; }
            const insertAt = header.indexOf(rootMatch[0]) + rootMatch[0].length;
            header = header.slice(0, insertAt) + drawing + header.slice(insertAt);
            zip.file('word/header1.xml', header);
            console.log('FinalReport: tenant logo stamped (' + ext + ', ' + dims.w + 'x' + dims.h + ') for', companyIdentifier);
        } catch (e) {
            console.error('FinalReport: tenant logo injection failed (report continues without it):', e.message);
        }
    }

    // Per-tenant FOOTER from the Multi-Tenant admin (David, Jul 21 2026):
    // footer text comes from tenant.footerText; the footer seal/logo obeys
    // the admin's showFooterlogo toggle. Fields left unset in the admin keep
    // the template's footer unchanged.
    async injectTenantFooter(zip, companyIdentifier) {
        try {
            if (!companyIdentifier) return;
            const tenant = await tenantsDAO.getTenantByCompanyIdentifier(companyIdentifier);
            if (!tenant) return;
            const footerFile = zip.file('word/footer1.xml');
            if (!footerFile) { console.log('FinalReport: no footer1 in template'); return; }
            let footer = footerFile.asText();
            let changed = false;
            if (tenant.showFooterlogo === false) {
                const before = footer.length;
                footer = footer.replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, '');
                if (footer.length !== before) { changed = true; console.log('FinalReport: footer logo removed (admin toggle off)'); }
            }
            const ft = (tenant.footerText || '').toString().trim();
            if (ft) {
                let first = true;
                footer = footer.replace(/(<w:t(?: [^>]*)?>)([\s\S]*?)(<\/w:t>)/g, (m, open, inner, close) => {
                    if (first) {
                        first = false;
                        if (!/xml:space/.test(open)) open = open.replace('<w:t', '<w:t xml:space="preserve"');
                        return open + this.xmlEscape(ft) + close;
                    }
                    return open + close;
                });
                changed = true;
                console.log('FinalReport: footer text set from admin for', companyIdentifier);
            }
            if (changed) zip.file('word/footer1.xml', footer);
        } catch (e) {
            console.error('FinalReport: footer injection failed (report continues):', e.message);
        }
    }

    async fillTemplate(templatePath, data, companyIdentifier) {
        const content = fs.readFileSync(templatePath);
        const zip = new PizZip(content);
        let doc = zip.file('word/document.xml').asText();

        const aliasValues = {
            'Property Address': data.addressStreet || data.projectAddress || '',
            'City': data.addressCity || '',
            'State': data.addressState || '',
            'Zip': data.addressZip || '',
            'Date': data.inspectionDate || ''
        };
        for (const alias of Object.keys(aliasValues)) {
            const value = aliasValues[alias];
            if (!value) continue;
            const range = this.findSdtContentRange(doc, alias);
            if (!range) { console.log('FinalReport: content control not found ->', alias); continue; }
            const chunk = doc.slice(range.contentStart, range.contentEnd);
            const newChunk = this.swapFirstTextRun(chunk, value);
            doc = doc.slice(0, range.contentStart) + newChunk + doc.slice(range.contentEnd);
            // remove the placeholder flag (same thing Word does when a user types in the field)
            const plcIdx = doc.lastIndexOf('<w:showingPlcHdr/>', range.contentStart);
            if (plcIdx !== -1 && range.contentStart - plcIdx < 700) {
                doc = doc.slice(0, plcIdx) + doc.slice(plcIdx + '<w:showingPlcHdr/>'.length);
            }
        }

        const labelValues = {
            '# Units with EEE:': data.unitsWithEEE,
            'Total # EEE Count:': data.totalEEE,
            'Total # EEE Inspected': data.eeeInspected
        };
        for (const label of Object.keys(labelValues)) {
            const value = labelValues[label];
            if (value === undefined || value === null || value === '') continue;
            const lIdx = doc.indexOf(this.xmlEscape(label));
            if (lIdx === -1) { console.log('FinalReport: count label not found ->', label); continue; }
            const tcClose = doc.indexOf('</w:tc>', lIdx);
            if (tcClose === -1) continue;
            let cellStart = doc.indexOf('<w:tc>', tcClose);
            const cellStartAttr = doc.indexOf('<w:tc ', tcClose);
            if (cellStart === -1 || (cellStartAttr !== -1 && cellStartAttr < cellStart)) cellStart = cellStartAttr;
            if (cellStart === -1) continue;
            const cellEnd = doc.indexOf('</w:tc>', cellStart);
            if (cellEnd === -1) continue;
            const cell = doc.slice(cellStart, cellEnd);
            doc = doc.slice(0, cellStart) + this.swapFirstTextRun(cell, value) + doc.slice(cellEnd);
        }

        zip.file('word/document.xml', doc);
        await this.injectTenantLogo(zip, companyIdentifier);
        await this.injectTenantFooter(zip, companyIdentifier);
        return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    }

    // visualReportUrl: blob URL of the just-generated Visual report
    async generate(projectId, companyName, projectName, uploader, visualReportUrl) {
        const templatePath = this.resolveTemplatePath(companyName);
        console.log('FinalReport: using template', templatePath);

        const data = await this.collectProjectData(projectId);
        console.log('FinalReport: data', JSON.stringify(data));

        const filledBuffer = await this.fillTemplate(templatePath, data, companyName);

        // fetch the visual report we just uploaded
        const urlArray = visualReportUrl.toString().split('/');
        const visualBuffer = await getBlobBuffer(urlArray[urlArray.length - 1], urlArray[urlArray.length - 2]);

        // Preferred: docxcompose merge (verified Word-clean). Fallback: Node merger + repairs.
        const sanitizedVisual = ReportGenerationUtil.sanitizeDocxBuffer(visualBuffer);
        let mergedBuffer = this.combineWithDocxCompose(filledBuffer, sanitizedVisual, projectId);
        if (!mergedBuffer) {
            mergedBuffer = await this.combineAndRepair(filledBuffer, sanitizedVisual);
        }
        if (!mergedBuffer) {
            throw new Error('FinalReport: merge produced no output');
        }

        const tmpFile = path.join(os.tmpdir(), `${projectId}_FinalReport.docx`);
        fs.writeFileSync(tmpFile, mergedBuffer);

        const containerName = 'projectreports';
        const fileName = `${projectId}_FinalReport_${new Date().toISOString().slice(0,19).replace(/[T:]/g, "-")}.docx`;
        const uploadOptions = {
            metadata: { 'uploader': uploader || 'system' },
            tags: { 'id': String(projectId), 'reportType': 'FinalReport' }
        };
        const result = await uploadBlob.uploadFile(containerName, fileName, tmpFile, uploadOptions);
        try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ }

        const parsed = JSON.parse(result);
        if (!parsed || !parsed.url) {
            throw new Error('FinalReport: upload failed -> ' + result);
        }
        return parsed.url;
    }
}

module.exports = new FinalReportGenerator();
