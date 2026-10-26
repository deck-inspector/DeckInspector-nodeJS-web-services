const { generatePdfFile } = require("./generatePdfFile");
const {  generateDocFile } = require("./generateDocFile");
const ReportGeneration = require("./reportstrategy/reportGeneration.js")
const SingleProjectReportGeneration = require("./reportstrategy/singleProjectReportGeneration.js")
const GenerateReport = require("./ReportGeneration/GenerateReport.js")
const projects = require("../model/project");
require("docx-merger");
require("./ReportGeneration/ReportGenerationUtil");


const generateProjectReport = async function generate(projectId,sectionImageProperties,companyName,reportType,
                                                      reportFormat, fileName, onlyIds)
{
    const project  = await projects.getProjectById(projectId);
    // PARTIAL report (Sep 22 2026): onlyIds = selected building / location ids.
    // Word only - the PDF path renders from HTML and is unchanged.
    if (Array.isArray(onlyIds) && onlyIds.length && reportFormat !== 'pdf') {
        const partialUrl = await GenerateReport.generatePartialReport(projectId, reportType, onlyIds);
        if (!partialUrl) { throw new Error('generatePartialReport returned no url (merge or upload produced no file)'); }
        return partialUrl;
    }
    if (reportFormat==='pdf') {
        // Oct 26 2026 (David): the HTML -> headless-browser PDF distorted and
        // skewed the report. When Microsoft 365 conversion is configured, build
        // the Word report and let Microsoft's Word engine render the PDF, so it
        // matches the Word report exactly. The HTML path stays as the fallback.
        const { graphConfigured } = require('./convertDocxToPdf');
        if (graphConfigured()) {
            try {
                const wordUrl = await GenerateReport.generateReport(projectId, reportType);
                if (!wordUrl) throw new Error('generateReport returned no url');
                return await wordUrlToPdfUrl(wordUrl, String(projectId), reportType, 'project-report.docx');
            } catch (e) {
                console.error('Project PDF via Word failed - using the HTML PDF instead:', e && e.message);
            }
        }
        const projectHtml =  await getProjectHtml(project, sectionImageProperties, reportType);
        return await generatePdfFile(fileName,projectHtml,companyName);
    } else {
        const generatedUrl = await GenerateReport.generateReport(projectId,reportType);
        if (!generatedUrl) { throw new Error('generateReport returned no url (merge or upload produced no file)'); }
        return generatedUrl;
    }
}

// Download a generated Word report, convert it to PDF and store the PDF next
// to it in blob storage; returns the PDF's url.
async function wordUrlToPdfUrl(wordUrl, tagId, reportType, nameForConverter) {
    const axios = require('axios');
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const uploadBlob = require('../database/uploadimage');
    const { convertDocxToPdf } = require('./convertDocxToPdf');
    const resp = await axios.get(wordUrl, { responseType: 'arraybuffer', timeout: 120000 });
    const pdf = await convertDocxToPdf(Buffer.from(resp.data), nameForConverter);
    const fileName = `${tagId}_${reportType}_${new Date().toISOString().slice(0,19).replace(/[T:]/g, '-')}.pdf`;
    const tmp = path.join(os.tmpdir(), fileName);
    fs.writeFileSync(tmp, Buffer.from(pdf));
    try {
        const result = await uploadBlob.uploadFile('projectreports', fileName, tmp, { metadata: { uploader: 'system' }, tags: { id: String(tagId), reportType: String(reportType) } });
        const url = JSON.parse(result).url;
        if (!url) throw new Error('PDF upload returned no url');
        return url;
    } finally { try { fs.unlinkSync(tmp); } catch (e) { /* temp cleanup */ } }
}

const generateLocationReportDoc = async function generate(projectId,locationId,sectionImageProperties,companyName,reportType,
                                                          reportFormat, fileName)
{
    // Errors now reach the route so it can record a FAILED entry in Reports
    // instead of the button spinning forever (Oct 23 2026).
    const wordUrl = await GenerateReport.generateLocationReport(projectId,locationId,reportType);
    if (!wordUrl) throw new Error('unit report produced no file');
    if (reportFormat !== 'pdf') return wordUrl;
    try {
        const axios = require('axios');
        const os = require('os');
        const path = require('path');
        const fs = require('fs');
        const uploadBlob = require('../database/uploadimage');
        const { convertDocxToPdf } = require('./convertDocxToPdf');
        const resp = await axios.get(wordUrl, { responseType: 'arraybuffer', timeout: 120000 });
        const pdf = await convertDocxToPdf(Buffer.from(resp.data), 'unit-report.docx');
        const fileName = `${locationId}_${reportType}_${new Date().toISOString().slice(0,19).replace(/[T:]/g, '-')}.pdf`;
        const tmp = path.join(os.tmpdir(), fileName);
        fs.writeFileSync(tmp, Buffer.from(pdf));
        try {
            const result = await uploadBlob.uploadFile('projectreports', fileName, tmp, { metadata: { uploader: 'system' }, tags: { id: String(locationId), reportType: String(reportType) } });
            const url = JSON.parse(result).url;
            if (url) return url;
        } finally { try { fs.unlinkSync(tmp); } catch (e) { /* temp cleanup */ } }
    } catch (e) {
        console.error('Unit report: PDF conversion failed, delivering Word instead:', e && e.message);
    }
    return wordUrl;
}

async function getProjectDoc(projectId,project, sectionImageProperties,companyName, reportType) {
    if (project.data.item.projecttype === "singlelevel") {
        return await SingleProjectReportGeneration.generateReportDoc(project,companyName, sectionImageProperties, reportType);
    }
    else if (project.data.item.projecttype  === "multilevel") {
        return await ReportDocGeneration.generateReportDoc(projectId,project,companyName, sectionImageProperties, reportType);
    }
}

async function getProjectHtml(project, sectionImageProperties, reportType) {
    if (project.data.item.projecttype === "singlelevel") {
        return await SingleProjectReportGeneration.generateReportHtml(project, sectionImageProperties, reportType);
    }
    else if (project.data.item.projecttype  === "multilevel") {
        return await ReportGeneration.generateReportHtml(project, sectionImageProperties, reportType);
    }
}

module.exports = { generateProjectReport,getProjectHtml,generateLocationReportDoc};
