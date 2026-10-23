const ProjectGenerator = require("./DocGenerator/ProjectGenerator");
const LocationGenerator = require("./DocGenerator/LocationGenerator");
const ProjectReportHashCodeService = require("../projectReportHashCodeService");
const serialize = require("serialize-javascript");

class GenerateReport {
    constructor() {
        this.projects = new Map();
    }

    async generateReport(projectId,reportType) {
        // check if project exist in DB/List
        const existingDoc = await ProjectReportHashCodeService.getProjctReportHashCodeByIdAndReportType(projectId,reportType);
        if  ( existingDoc == null ) {
            console.log("Project not found");
            return await ProjectGenerator.createProject(projectId,reportType);
        } else {
            return await ProjectGenerator.updateProject(projectId,existingDoc,reportType);
        }
    }

    // PARTIAL report: only the given buildings / project-level locations
    // (child ids). Always built fresh and never cached, so the whole-project
    // report and its cache stay exactly as they were (Sep 22 2026).
    async generatePartialReport(projectId, reportType, onlyIds) {
        return await ProjectGenerator.createProject(projectId, reportType, { only: onlyIds, noCache: true });
    }

    // Unit report (Oct 23 2026): always fresh, returns the uploaded Word url.
    async generateLocationReport(projectId,locationId,reportType) {
        return await ProjectGenerator.createLocationReport(projectId, locationId, reportType);
    }
}

module.exports = new GenerateReport();
