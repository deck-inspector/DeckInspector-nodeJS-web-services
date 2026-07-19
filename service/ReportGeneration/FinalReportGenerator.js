const path = require('path');
const fs = require('fs');
const os = require('os');
const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const projects = require("../../model/project");
const location = require("../../model/location");
const subProject = require("../../model/subproject");
const sections = require("../../model/sections");
const ReportGenerationUtil = require("./ReportGenerationUtil");
const uploadBlob = require("../../database/uploadimage");
const { getBlobBuffer } = require("../../database/uploadimage");

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

        return {
            projectName: project.name || '',
            projectAddress: project.address || '',
            projectDescription: project.description || '',
            inspectionDate: this.formatDate(project.createdat || project.createdAt),
            unitsWithEEE: String(unitsWithEEE),
            totalEEE: String(totalEEE),
            eeeInspected: String(totalEEE)
        };
    }

    combineWithAltChunk(hostBuffer, annexBuffer) {
        const zip = new PizZip(hostBuffer);

        // embed the annex docx as a part
        zip.file('word/annex_visual.docx', annexBuffer);

        // declare its content type
        const ctPath = '[Content_Types].xml';
        let ct = zip.file(ctPath).asText();
        if (ct.indexOf('/word/annex_visual.docx') === -1) {
            ct = ct.replace('</Types>',
                '<Override PartName="/word/annex_visual.docx" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document"/></Types>');
            zip.file(ctPath, ct);
        }

        // add the afChunk relationship
        const relsPath = 'word/_rels/document.xml.rels';
        let rels = zip.file(relsPath).asText();
        const relId = 'rIdVisualAnnex1';
        if (rels.indexOf(relId) === -1) {
            rels = rels.replace('</Relationships>',
                `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="annex_visual.docx"/></Relationships>`);
            zip.file(relsPath, rels);
        }

        // insert page break + altChunk right before the body's closing sectPr
        const docPath = 'word/document.xml';
        let doc = zip.file(docPath).asText();
        const insertion = `<w:p><w:r><w:br w:type="page"/></w:r></w:p><w:altChunk r:id="${relId}"/>`;
        const sectIdx = doc.lastIndexOf('<w:sectPr');
        if (sectIdx !== -1) {
            doc = doc.slice(0, sectIdx) + insertion + doc.slice(sectIdx);
        } else {
            doc = doc.replace('</w:body>', insertion + '</w:body>');
        }
        zip.file(docPath, doc);

        return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    }

    fillTemplate(templatePath, data) {
        const content = fs.readFileSync(templatePath);
        const zip = new PizZip(content);
        const doc = new Docxtemplater(zip, {
            paragraphLoop: true,
            linebreaks: true,
            nullGetter: () => ''
        });
        doc.render(data);
        return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
    }

    // visualReportUrl: blob URL of the just-generated Visual report
    async generate(projectId, companyName, projectName, uploader, visualReportUrl) {
        const templatePath = this.resolveTemplatePath(companyName);
        console.log('FinalReport: using template', templatePath);

        const data = await this.collectProjectData(projectId);
        console.log('FinalReport: data', JSON.stringify(data));

        const filledBuffer = this.fillTemplate(templatePath, data);

        // fetch the visual report we just uploaded
        const urlArray = visualReportUrl.toString().split('/');
        const visualBuffer = await getBlobBuffer(urlArray[urlArray.length - 1], urlArray[urlArray.length - 2]);

        // Combine using Word's native altChunk embedding: unlike docx-merger,
        // Word performs the merge itself on open, so both documents keep their
        // styles, numbering and images intact (no "unreadable content" errors).
        const sanitizedVisual = ReportGenerationUtil.sanitizeDocxBuffer(visualBuffer);
        const mergedBuffer = this.combineWithAltChunk(filledBuffer, sanitizedVisual);
        if (!mergedBuffer) {
            throw new Error('FinalReport: merge produced no output');
        }

        const tmpFile = path.join(os.tmpdir(), `${projectId}_FinalReport.docx`);
        fs.writeFileSync(tmpFile, mergedBuffer);

        const containerName = 'projectreports';
        const fileName = `${projectId}_FinalReport.docx`;
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
