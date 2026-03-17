const SingleProjectReportGeneration = require("../../reportstrategy/singleProjectReportGeneration");
const ReportGenerationUtil = require("../ReportGenerationUtil");
const {Doc} = require("../Models/ProjectDocs");
const ProjectReportUploader = require("../projectReportUploader");
const fs = require("fs");
const ReportDocGeneration = require("../ReportDocGeneration.js");

class ProjectHeaderDocGenerator{

    async createProjectHeaderDoc(projectId,project,companyName, reportType) {
        // Extract project from response wrapper if needed
        const actualProject = project.project || project;
        
        const projectHeaderHashCode = ReportGenerationUtil.calculateHash(actualProject);
        const projectHeaderDoc = await this.getProjectHeaderDoc(projectId, actualProject, companyName, null, reportType);

        let fileS3url = null;
        if (projectHeaderDoc != null) {
            fileS3url = await ProjectReportUploader.uploadToBlobStorage(projectHeaderDoc, projectId + "header", reportType);
            await fs.promises.unlink(projectHeaderDoc);
        }
        return new Doc(projectHeaderHashCode, fileS3url);
    }

    async updateProjectHeaderDoc(projectId,project,companyName, reportType,projectHeaderDoc) {
        // Extract project from response wrapper if needed
        const actualProject = project.project || project;
        
        const newProjectHeaderHashCode = ReportGenerationUtil.calculateHash(actualProject);
        if (newProjectHeaderHashCode !== projectHeaderDoc.hashCode) {
            console.log("Project header doc is changed");
            const generatedProjectHeaderDoc = await this.getProjectHeaderDoc(projectId, actualProject, companyName, null, reportType);
            let fileS3url = null;
            if (generatedProjectHeaderDoc != null) {
                fileS3url = await ProjectReportUploader.uploadToBlobStorage(generatedProjectHeaderDoc, projectId + "-Header", reportType);
                await fs.promises.unlink(generatedProjectHeaderDoc);
            }
            return new Doc(newProjectHeaderHashCode, fileS3url);
        }
        return null;
    }



    async getProjectHeaderDoc(projectId, project, sectionImageProperties, companyName, reportType) {

    // Extract project from response wrapper if needed
    const actualProject = project.project || project;
    
    const projectType = actualProject.projecttype || actualProject.projectType || actualProject.type;
    
    if (!projectType) {
        throw new Error(`Project type is undefined. Project object: ${JSON.stringify(actualProject)}`);
    }

    if (projectType === "singlelevel") {
        console.log("Generating single level project header doc");
        return await SingleProjectReportGeneration.generateReportDoc(
            actualProject,
            companyName,
            sectionImageProperties,
            reportType
        );
    }

    else if (projectType === "multilevel") {
        console.log("Generating multi level project header doc");
        return await ReportDocGeneration.generateReportDoc(
            projectId,
            actualProject,
            companyName,
            sectionImageProperties,
            reportType
        );
    }
}

}
module.exports = new ProjectHeaderDocGenerator();