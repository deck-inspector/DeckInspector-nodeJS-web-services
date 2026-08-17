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

    // ONE corrected master template for ALL clients (David, Aug 1): every
    // tenant's Final Report is generated from the corrected/confirmed
    // Deck_FinalTemplate.docx. Per-tenant customization happens at generation
    // time only: the client's company name + phone are substituted into the
    // text, and the client's admin-panel header/footer images are stamped in.
    // Stale per-tenant template files (e.g. westcoastdeckinspections_
    // FinalTemplate.docx - an OLD uncorrected copy with pre-checked boxes,
    // pre-filled dropdowns and broken pagination) are deliberately IGNORED.
    resolveTemplatePath(companyName) {
        return path.join(__dirname, '..', '..', 'Deck_FinalTemplate.docx');
    }

    async getTemplateBuffer(companyName) {
        // Blob first: the admin's "Corrected Final Report" upload (webapp ->
        // /replacefinalreporttemplate) is persisted to blob under this fixed
        // name and survives code deployments. The repo copy is the fallback.
        try {
            const buf = await getBlobBuffer('Deck_FinalTemplate.docx', 'projectreports');
            if (buf && buf.length > 0) {
                console.log('FinalReport: using admin-uploaded master template (blob) for', companyName || '(unknown tenant)');
                return buf;
            }
        } catch (e) { /* no admin upload yet - use the repo copy */ }
        console.log('FinalReport: using repo master template (Deck_FinalTemplate.docx) for', companyName || '(unknown tenant)');
        return fs.readFileSync(path.join(__dirname, '..', '..', 'Deck_FinalTemplate.docx'));
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
        let anyFail = false;
        for (const locId of locationIds) {
            if (!locId) continue;
            try {
                const sectionData = await sections.getSectionMetaDataForLocationId(locId);
                const items = (sectionData.data && sectionData.data.item) ? sectionData.data.item : [];
                if (items.length > 0) {
                    unitsWithEEE += 1;
                    totalEEE += items.length;
                }
                // PASS/FAIL rule (David, Jul 23): all green -> PASS; any
                // 0-1 year life expectancy (EEE/LBC/AWE), failed condition
                // assessment, or bad visual review -> FAIL.
                for (const sec of items) {
                    const life = [sec.eee, sec.lbc, sec.awe].map(v => String(v == null ? '' : v)).join(' ');
                    const assess = String(sec.conditionalassessment || '').toLowerCase();
                    const review = String(sec.visualreview || '').toLowerCase();
                    if (assess.indexOf('fail') !== -1 || review === 'bad' || /0\s*[-\u2013]\s*1/.test(life)) {
                        anyFail = true;
                    }
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
            const m = restPart.replace(/\s+/g, ' ').match(/^(.*?),?\s*([A-Z]{2})[.,]?\s*(\d{5})(?:-\d{4})?\s*$/);
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
            eeeInspected: String(totalEEE),
            passFail: anyFail ? 'FAIL' : 'PASS'
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

    // Shared: build an inline image run.
    inlineImageXml(rid, cx, cy, id, name) {
        return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
            + '<wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:effectExtent l="0" t="0" r="0" b="0"/>'
            + '<wp:docPr id="' + id + '" name="' + name + '"/>'
            + '<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>'
            + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
            + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
            + '<pic:nvPicPr><pic:cNvPr id="' + id + '" name="' + name + '"/><pic:cNvPicPr/></pic:nvPicPr>'
            + '<pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
            + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>'
            + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
            + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
    }

    ensureContentType(zip, ext) {
        const ctPath = '[Content_Types].xml';
        let ct = zip.file(ctPath).asText();
        if (ct.indexOf('Extension="' + ext + '"') === -1) {
            const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
            ct = ct.replace('</Types>', '<Default Extension="' + ext + '" ContentType="' + mime + '"/></Types>');
            zip.file(ctPath, ct);
        }
    }

    ensureImageRel(zip, relPath, rel, rid) {
        const f = zip.file(relPath);
        if (f) {
            let rels = f.asText();
            if (rels.indexOf(rid) === -1) rels = rels.replace('</Relationships>', rel + '</Relationships>');
            zip.file(relPath, rels);
        } else {
            zip.file(relPath, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + String.fromCharCode(10) + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rel + '</Relationships>');
        }
    }

    // Stamp the tenant's 'Report Header' image into EVERY
    // header of the template. Templates ship with empty headers; each client's
    // branding comes from the Multi-Tenant admin at generation time. Any
    // template-baked header content is replaced so there is exactly one logo.
    async injectTenantLogo(zip, companyIdentifier) {
        try {
            if (!companyIdentifier) return;
            const tenant = await tenantsDAO.getTenantByCompanyIdentifier(companyIdentifier);
            const logoUrl = tenant && tenant.icons && tenant.icons.header;
            if (!logoUrl) { console.log('FinalReport: no Report Header image set in admin, header left as-is'); return; }
            const resp = await axios.get(logoUrl, { responseType: 'arraybuffer', timeout: 60000 });
            const buf = Buffer.from(resp.data);
            const extMatch = logoUrl.split('?')[0].toLowerCase().match(/\.(png|jpe?g)$/);
            const ext = extMatch ? (extMatch[1] === 'jpeg' ? 'jpg' : extMatch[1]) : 'png';
            const dims = this.getImageDims(buf, ext);
            const EMU = 914400;
            // Logo only, 0.75in tall, zero paragraph spacing: 360 (header
            // offset) + 1080 twips stays inside the template's 1572-twip top
            // margin, so the body position - and the template's pagination -
            // is identical to the uploaded master. No website line here: the
            // site appears once on the page, from the admin Footer Text.
            const cy = Math.round(0.75 * EMU);
            const cx = Math.max(1, Math.round(cy * dims.w / Math.max(1, dims.h)));
            zip.file('word/media/tenantlogo.' + ext, buf);
            this.ensureContentType(zip, ext);
            const content = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>' + this.inlineImageXml('rIdTenantLogo', cx, cy, 990001, 'TenantLogo') + '</w:p>';
            const rel = '<Relationship Id="rIdTenantLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/tenantlogo.' + ext + '"/>';
            let stamped = 0;
            for (const name of Object.keys(zip.files)) {
                const hm = name.match(/^word\/(header\d+)\.xml$/);
                if (!hm) continue;
                let header = zip.file(name).asText();
                const rootM = header.match(/<w:hdr[^>]*>/);
                const endI = header.lastIndexOf('</w:hdr>');
                if (!rootM || endI === -1) continue;
                header = header.slice(0, rootM.index + rootM[0].length) + content + header.slice(endI);
                zip.file(name, header);
                this.ensureImageRel(zip, 'word/_rels/' + hm[1] + '.xml.rels', rel, 'rIdTenantLogo');
                stamped++;
            }
            console.log('FinalReport: Report Header image stamped in ' + stamped + ' header(s) (' + ext + ', ' + dims.w + 'x' + dims.h + ') for', companyIdentifier);
        } catch (e) {
            console.error('FinalReport: tenant logo injection failed (report continues without it):', e.message);
        }
    }

    // Per-tenant FOOTER: every footer becomes the admin's 'Report Footer'
    // image + footer text. If none are set in the admin, the
    // template's own footer is left untouched. showFooterlogo=false hides
    // the image but keeps the text lines.
    async injectTenantFooter(zip, companyIdentifier) {
        try {
            if (!companyIdentifier) return;
            const tenant = await tenantsDAO.getTenantByCompanyIdentifier(companyIdentifier);
            if (!tenant) return;
            const showLogo = tenant.showFooterlogo !== false;
            const footImgUrl = (showLogo && tenant.icons && tenant.icons.footer) || '';
            const ftext = this.xmlEscape(((tenant.footerText || '') + '').trim());
            if (!footImgUrl && !ftext) { console.log('FinalReport: no footer branding set in admin, footer left as-is'); return; }
            let imgPara = '';
            let frel = '';
            if (footImgUrl) {
                const resp = await axios.get(footImgUrl, { responseType: 'arraybuffer', timeout: 60000 });
                const buf = Buffer.from(resp.data);
                const extMatch = footImgUrl.split('?')[0].toLowerCase().match(/\.(png|jpe?g)$/);
                const ext = extMatch ? (extMatch[1] === 'jpeg' ? 'jpg' : extMatch[1]) : 'png';
                const dims = this.getImageDims(buf, ext);
                const EMU = 914400;
                const cy = Math.round(0.5 * EMU);
                const cx = Math.max(1, Math.round(cy * dims.w / Math.max(1, dims.h)));
                zip.file('word/media/tenantfooter.' + ext, buf);
                this.ensureContentType(zip, ext);
                frel = '<Relationship Id="rIdTenantFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/tenantfooter.' + ext + '"/>';
                imgPara = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>' + this.inlineImageXml('rIdTenantFooter', cx, cy, 990002, 'TenantFooter') + '</w:p>';
            }
            // Image + Footer Text only (the site lives in Footer Text if the
            // client wants it shown). Compact spacing keeps 360 + 720 + one
            // 8pt line inside the template's 1440-twip bottom margin.
            const content = imgPara
                + (ftext ? '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="16"/></w:rPr><w:t xml:space="preserve">' + ftext + '</w:t></w:r></w:p>' : '');
            let stamped = 0;
            for (const name of Object.keys(zip.files)) {
                const fm = name.match(/^word\/(footer\d+)\.xml$/);
                if (!fm) continue;
                let footer = zip.file(name).asText();
                const rootM = footer.match(/<w:ftr[^>]*>/);
                const endI = footer.lastIndexOf('</w:ftr>');
                if (!rootM || endI === -1) continue;
                footer = footer.slice(0, rootM.index + rootM[0].length) + content + footer.slice(endI);
                zip.file(name, footer);
                if (frel) this.ensureImageRel(zip, 'word/_rels/' + fm[1] + '.xml.rels', frel, 'rIdTenantFooter');
                stamped++;
            }
            console.log('FinalReport: tenant footer stamped in ' + stamped + ' footer(s) for', companyIdentifier);
        } catch (e) {
            console.error('FinalReport: footer injection failed (report continues):', e.message);
        }
    }

    async fillTemplate(templatePath, data, companyIdentifier) {
        const content = Buffer.isBuffer(templatePath) ? templatePath : fs.readFileSync(templatePath);
        const zip = new PizZip(content);
        let doc = zip.file('word/document.xml').asText();

        // RENDER-TIME FIX (David, Aug 1): the master template's page-1
        // paragraph "...there are: (EEE= Exterior Elevated Elements)" can
        // carry legacy runs of dozens of literal SPACES that push the EEE
        // note to the right of the line - and a longer client name makes the
        // wrap worse. Admins upload masters through the admin site, so fix
        // it HERE at generation time: blank any space-only text runs (>2
        // spaces) inside that one paragraph. The uploaded template itself is
        // never modified, and every future master renders correctly.
        try {
            const ei = doc.indexOf('EEE= Exterior');
            if (ei !== -1) {
                const ps = Math.max(doc.lastIndexOf('<w:p>', ei), doc.lastIndexOf('<w:p ', ei));
                const pe = doc.indexOf('</w:p>', ei);
                if (ps !== -1 && pe !== -1 && pe > ps) {
                    const para = doc.slice(ps, pe);
                    const cleaned = para.replace(/(<w:t[^>]*>)([^<]*)(<\/w:t>)/g, function (m, open, txt, close) {
                        return (txt.trim() === '' && txt.length > 2) ? (open + close) : m;
                    });
                    if (cleaned !== para) {
                        doc = doc.slice(0, ps) + cleaned + doc.slice(pe);
                        console.log('FinalReport: EEE note space-gap normalized at render time');
                    }
                }
            }
        } catch (e) { console.log('FinalReport: EEE normalization skipped:', e && e.message); }

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

        // Count cells (# Units with EEE / Total # EEE Count / Total # EEE
        // Inspected) are intentionally NOT auto-filled: per the corrected
        // master template, red 0 / NA cells are edited by the end user.

        // PASS/FAIL auto-set from inspection results (David, Jul 23):
        // PASS in green when everything is green; FAIL in red when any element
        // shows a 0-1 year life expectancy or a failed assessment. The dropdown
        // remains in place so the user can override the value in Word.
        try {
            if (data.passFail) {
                // PASS must render BOLD GREEN, FAIL must render BOLD RED
                // (David, Aug 1) - regardless of how the uploaded master's
                // dropdown run is formatted. The old code only swapped an
                // existing <w:color> value (a run with no color element got
                // no color at all) and never applied bold. Now the first text
                // run inside the PASS/FAIL dropdown is REWRITTEN: its fonts
                // and size are kept, any old color/bold stripped, and
                // <w:b/> + the verdict color forced in.
                const pfColor = data.passFail === 'PASS' ? '00B050' : 'EE0000';
                const comboIdx = doc.indexOf('w:displayText="PASS"');
                if (comboIdx !== -1) {
                    const sdtStart = doc.lastIndexOf('<w:sdt>', comboIdx);
                    const sdtEnd = doc.indexOf('</w:sdt>', comboIdx);
                    if (sdtStart !== -1 && sdtEnd !== -1) {
                        let pfSdt = doc.slice(sdtStart, sdtEnd);
                        // 1) set the displayed text
                        pfSdt = pfSdt.replace(/(<w:sdtContent>[\s\S]*?<w:t[^>]*>)[^<]*(<\/w:t>)/, '$1' + data.passFail + '$2');
                        // 2) force bold + verdict color on the first run in the content
                        pfSdt = pfSdt.replace(/(<w:sdtContent>[\s\S]*?)<w:r\b([^>]*)>([\s\S]*?)<\/w:r>/, function (m, pre, rAttrs, rBody) {
                            const rPrMatch = rBody.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/);
                            let inner = rPrMatch ? rPrMatch[1] : '';
                            // keep fonts/size, drop any existing color/bold
                            inner = inner
                                .replace(/<w:color[^>]*\/>/g, '')
                                .replace(/<w:b\/>|<w:b [^>]*\/>/g, '')
                                .replace(/<w:bCs[^>]*\/>/g, '');
                            let fonts = '';
                            inner = inner.replace(/<w:rFonts[^>]*\/>/, function (f) { fonts = f; return ''; });
                            const newRPr = '<w:rPr>' + fonts + '<w:b/><w:bCs/><w:color w:val="' + pfColor + '"/>' + inner + '</w:rPr>';
                            const body = rPrMatch ? rBody.replace(rPrMatch[0], newRPr) : (newRPr + rBody);
                            return pre + '<w:r' + rAttrs + '>' + body + '</w:r>';
                        });
                        // 3) also set the CONTROL's default formatting (sdtPr rPr)
                        // to the verdict color: when someone re-picks a value in
                        // Word, Word applies the control's default formatting -
                        // previously the template's red, so a re-picked PASS
                        // showed red. Now re-picking returns to the generated
                        // verdict's color. (True conditional coloring per choice
                        // is impossible in a macro-free .docx.)
                        pfSdt = pfSdt.replace(/(<w:sdtPr>)([\s\S]*?)(<\/w:sdtPr>)/, function (m, open, inner, close) {
                            const cleaned = inner.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, function (rpr) {
                                let body = rpr.slice('<w:rPr>'.length, -('</w:rPr>'.length))
                                    .replace(/<w:color[^>]*\/>/g, '')
                                    .replace(/<w:b\/>|<w:b [^>]*\/>/g, '')
                                    .replace(/<w:bCs[^>]*\/>/g, '');
                                let fonts = '';
                                body = body.replace(/<w:rFonts[^>]*\/>/, function (f) { fonts = f; return ''; });
                                return '<w:rPr>' + fonts + '<w:b/><w:bCs/><w:color w:val="' + pfColor + '"/>' + body + '</w:rPr>';
                            });
                            if (cleaned.indexOf('<w:rPr>') === -1) {
                                return open + '<w:rPr><w:b/><w:bCs/><w:color w:val="' + pfColor + '"/></w:rPr>' + cleaned + close;
                            }
                            return open + cleaned + close;
                        });
                        doc = doc.slice(0, sdtStart) + pfSdt + doc.slice(sdtEnd);
                        console.log('FinalReport: PASS/FAIL set to', data.passFail, '(bold ' + (data.passFail === 'PASS' ? 'green' : 'red') + ', control default matched)');
                    } else {
                        console.log('FinalReport: PASS/FAIL dropdown boundaries not found - value not set');
                    }
                } else {
                    console.log('FinalReport: PASS/FAIL dropdown not found in template - value not set');
                }
            }
        } catch (e) { console.log('FinalReport: PASS/FAIL auto-set failed:', e.message); }

        // Wherever the template says "Deck Inspectors" (any variant), print the
        // CLIENT company name from the Admin panel; same for the phone number.
        // Placeholder token first so a tenant name containing 'Deck Inspectors'
        // cannot be re-matched and corrupted.
        try {
            const tenantRec = companyIdentifier ? await tenantsDAO.getTenantByCompanyIdentifier(companyIdentifier) : null;
            if (tenantRec && tenantRec.name) {
                const cname = this.xmlEscape(tenantRec.name);
                doc = doc.split('Deck Inspectors, Inc.').join('%%CNAME%%');
                doc = doc.split('Deck Inspectors Inc').join('%%CNAME%%');
                doc = doc.split('Deck Inspectors').join('%%CNAME%%');
                if (/\.$/.test(cname)) { doc = doc.replace(/%%CNAME%%\s*\./g, '%%CNAME%%'); }
                doc = doc.replace(/(<w:t(?: [^>]*)?>)\s*,?\s*Inc\s*\.?\s*(<\/w:t>)/g, '$1$2');
                doc = doc.split('%%CNAME%%').join(cname);
                console.log('FinalReport: company name substituted ->', tenantRec.name);
            }
            // Phone + website: ALWAYS replace Deck Inspectors' defaults with
            // the CLIENT's values from the admin panel (David, Aug 1: "do not
            // allow deck inspectors phone number or url to populate this
            // drop down"). If the client has none on file, the default is
            // REMOVED - another company's contact info must never print on a
            // client's report. (The E3 Association line is a different string
            // and is left alone.)
            {
                const isDeckTenant = ((companyIdentifier || '') + '').toLowerCase().indexOf('deck inspectors') === 0;
                if (!isDeckTenant) {
                    const tphone = (tenantRec && tenantRec.phone ? String(tenantRec.phone).trim() : '');
                    doc = doc.split('888-224-0489').join(this.xmlEscape(tphone));
                    console.log('FinalReport: phone ' + (tphone ? 'substituted' : 'removed (none on file)'));
                    let tsite = (tenantRec && tenantRec.website ? String(tenantRec.website).trim() : '');
                    if (!tsite && tenantRec && tenantRec.footerText && /^[\w.-]+\.[A-Za-z]{2,}$/.test(String(tenantRec.footerText).trim())) {
                        tsite = String(tenantRec.footerText).trim();
                    }
                    doc = doc.split('www.deckinspectors.com').join(this.xmlEscape(tsite));
                    console.log('FinalReport: website ' + (tsite ? ('substituted -> ' + tsite) : 'removed (none on file)'));
                }
            }
        } catch (e) { console.log('FinalReport: company substitution failed', e.message); }

        // 0.25\" clearance at the top and bottom of every page (David, Jul 21):
        // header and footer start 360 twips (0.25 inch) from the paper edge.
        // NOTE: no forced page break on the report title - the corrected
        // master template handles its own pagination (a forced break here
        // produced a blank page 2).
        doc = doc.replace(/(<w:pgMar[^>]*?w:header=")\d+(")/g, '$1360$2');
        doc = doc.replace(/(<w:pgMar[^>]*?w:footer=")\d+(")/g, '$1360$2');

        zip.file('word/document.xml', doc);
        await this.injectTenantLogo(zip, companyIdentifier);
        await this.injectTenantFooter(zip, companyIdentifier);
        return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    }

    // Insert a page break before the first paragraph whose text contains all needles.
    addPageBreakToParagraph(xml, needles) {
        const re = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
        let m;
        while ((m = re.exec(xml))) {
            const p = m[0];
            const texts = (p.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).join('');
            let all = true;
            for (const n of needles) { if (texts.indexOf(n) === -1) { all = false; break; } }
            if (!all) continue;
            if (p.indexOf('<w:pageBreakBefore/>') !== -1) return xml;
            let np;
            if (p.indexOf('<w:pPr>') !== -1) {
                const ps = p.match(/<w:pPr><w:pStyle[^>]*\/>/);
                np = ps ? p.replace(ps[0], ps[0] + '<w:pageBreakBefore/>') : p.replace('<w:pPr>', '<w:pPr><w:pageBreakBefore/>');
            } else {
                np = p.replace(/(<w:p\b[^>]*>)/, '$1<w:pPr><w:pageBreakBefore/></w:pPr>');
            }
            console.log('FinalReport: page break pinned before paragraph [' + needles.join('+') + ']');
            return xml.slice(0, m.index) + np + xml.slice(m.index + p.length);
        }
        console.log('FinalReport: paragraph not found for page break ->', needles.join('+'));
        return xml;
    }

    // The appended Visual must start at the top of its own page (David-approved layout).
    addVisualPageBreak(visualBuffer) {
        try {
            const zip = new PizZip(visualBuffer);
            let x = zip.file('word/document.xml').asText();
            const nx = this.addPageBreakToParagraph(x, ['Visual', 'Inspection Report']);
            if (nx === x) return visualBuffer;
            zip.file('word/document.xml', nx);
            return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
        } catch (e) { console.error('FinalReport: visual page-break failed', e.message); return visualBuffer; }
    }

    // visualReportUrl: blob URL of the just-generated Visual report
    async generate(projectId, companyName, projectName, uploader, visualReportUrl) {
        const templateBuffer = await this.getTemplateBuffer(companyName);

        const data = await this.collectProjectData(projectId);
        console.log('FinalReport: data', JSON.stringify(data));

        const filledBuffer = await this.fillTemplate(templateBuffer, data, companyName);

        // fetch the visual report we just uploaded
        const urlArray = visualReportUrl.toString().split('/');
        const visualBuffer = await getBlobBuffer(urlArray[urlArray.length - 1], urlArray[urlArray.length - 2]);

        // Preferred: docxcompose merge (verified Word-clean). Fallback: Node merger + repairs.
        // NOTE: merge_docx.py now inserts a page break before EVERY appended
        // annex, so the Visual always starts on its own page. The old
        // addVisualPageBreak() pin is no longer applied - combining both
        // produced an extra blank page between the Final and the Visual.
        const sanitizedVisual = ReportGenerationUtil.sanitizeDocxBuffer(visualBuffer);
        let mergedBuffer = this.combineWithDocxCompose(filledBuffer, sanitizedVisual, projectId);
        if (!mergedBuffer) {
            mergedBuffer = await this.combineAndRepair(filledBuffer, this.addVisualPageBreak(sanitizedVisual));
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
