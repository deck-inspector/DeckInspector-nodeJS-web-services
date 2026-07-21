const projects = require("../../../model/project");
const {ProjectDocs, Doc} = require("../Models/ProjectDocs");
const ReportGenerationUtil = require("../ReportGenerationUtil");
const ProjectChildType = require("../../../model/projectChildType");
const LocationGenerator = require("./LocationGenerator");
const SubProjectGenerator = require("./SubProjectGenerator");
const ProjectReportHashCodeService = require("../../projectReportHashCodeService");
const serialize = require('serialize-javascript');
const ProjectReportUploader = require("../projectReportUploader");
const ProjectHeaderDocGenerator = require("./ProjectHeaderDocGenerator");
const fs = require("fs");
class ProjectGenerator{
    async createProject(projectId,reportType) {
        console.log("Project Generation started", projectId);
        let projectResponse = await projects.getProjectById(projectId);
        
        // Extract project from wrapped response if needed
        const project = projectResponse.project || projectResponse;
        console.log("Project fetched, children:", project.children);
        
        const projectDoc = new ProjectDocs();
        projectDoc.projectId = projectId;
        const projectHashcodeArray = [];
        const docPath = [];

        // Create Project Header Doc
        projectDoc.projectHeaderDoc = await ProjectHeaderDocGenerator.createProjectHeaderDoc(projectId, project, "DeckInspectors", reportType);
        projectHashcodeArray.push(projectDoc.projectHeaderDoc.hashCode);
        docPath.push(projectDoc.projectHeaderDoc.filePath);

        const {subProjects, locations } = this.reOrderAndGroupProjects(project.children);
        console.log("After reOrderAndGroupProjects - subProjects count:", subProjects.length, "locations count:", locations.length);
        for(const mySubProject of subProjects) {
            const subProjectDoc = await SubProjectGenerator.createSubProject(mySubProject.id,reportType);
            if (subProjectDoc.doc !== null && subProjectDoc.doc !== undefined) {
                projectDoc.subprojectMap.set(mySubProject.id.toString(), subProjectDoc);
                projectHashcodeArray.push(subProjectDoc.doc.hashCode);
                docPath.push(subProjectDoc.doc.filePath);
            }
        }

        for (const location of locations) {
            const locationDoc = await LocationGenerator.createLocation(location.id,reportType);
            if (locationDoc) {
                if (locationDoc.doc !== null && locationDoc.doc !== undefined) {
                    projectDoc.locationMap.set(location.id.toString(), locationDoc);
                    projectHashcodeArray.push(locationDoc.doc.hashCode);
                    docPath.push(locationDoc.doc.filePath)
                }
            }
        }
        projectHashcodeArray.push(ReportGenerationUtil.calculateHash(project));
        const projectHashCode = ReportGenerationUtil.combineHashesInArray(projectHashcodeArray);
        await this.saveFileToS3(docPath, projectId, reportType, projectDoc, projectHashCode);
        const projectDocToSave = this.getProjectReportHascodeDocToSave(projectDoc, projectId,reportType);
        await ProjectReportHashCodeService.addProjectReportHashCode(projectDocToSave);
        return projectDoc.doc.filePath;
    }

    async updateProject(projectId,existingProjectDoc,reportType) {
        let projectResponse = await projects.getProjectById(projectId);
        // Extract project from wrapped response if needed
        const project = projectResponse.project || projectResponse;
        
        // Handle both string and object formats
        let projectDoc;
        if (typeof existingProjectDoc === 'string') {
            projectDoc = JSON.parse(existingProjectDoc);
        } else {
            projectDoc = existingProjectDoc;
        }
        
        // Ensure subprojectMap and locationMap are Maps
        if (!projectDoc.subprojectMap) {
            projectDoc.subprojectMap = new Map();
        } else if (!(projectDoc.subprojectMap instanceof Map)) {
            projectDoc.subprojectMap = new Map(Object.entries(projectDoc.subprojectMap));
        }
        
        if (!projectDoc.locationMap) {
            projectDoc.locationMap = new Map();
        } else if (!(projectDoc.locationMap instanceof Map)) {
            projectDoc.locationMap = new Map(Object.entries(projectDoc.locationMap));
        }
        
        const projectHashcodeArray = [];
        const docPath = [];
        const {subProjects, locations } = this.reOrderAndGroupProjects(project.children);
        let locationMap = new Map();
        let subprojectMap = new Map();

        //Project Header Doc
        if(projectDoc.projectHeaderDoc)
        {
            const projectHeaderDoc = await ProjectHeaderDocGenerator.updateProjectHeaderDoc(projectId, project, "DeckInspectors", reportType,projectDoc.projectHeaderDoc);
            if (projectHeaderDoc !== null) {
                projectDoc.projectHeaderDoc = projectHeaderDoc;
            }
        }
        else {
            projectDoc.projectHeaderDoc = await ProjectHeaderDocGenerator.createProjectHeaderDoc(projectId, project, "DeckInspectors", reportType);
        }
        projectHashcodeArray.push(projectDoc.projectHeaderDoc.hashCode);
        docPath.push(projectDoc.projectHeaderDoc.filePath)

        //SubProjects
        for(const mySubProject of subProjects) {
            if (projectDoc.subprojectMap.has(mySubProject.id.toString())) {
                const subProjectDoc = await SubProjectGenerator.updateSubProject(mySubProject.id, projectDoc.subprojectMap.get(mySubProject.id.toString()),reportType);
                if (subProjectDoc !== null) {
                    projectDoc.subprojectMap.get(mySubProject.id.toString()).doc= subProjectDoc;
                }
            } else {
                console.log("New subproject is added");
                const subProjectDoc = await SubProjectGenerator.createSubProject(mySubProject.id,reportType);
                projectDoc.subprojectMap.set(mySubProject.id.toString(), subProjectDoc);
            }

            let newSubprojectDoc = projectDoc.subprojectMap.get(mySubProject.id.toString());
            if (newSubprojectDoc.doc !== null && newSubprojectDoc.doc !== undefined) {
                subprojectMap.set(mySubProject.id.toString(), newSubprojectDoc);
                projectHashcodeArray.push(newSubprojectDoc.doc.hashCode);
                docPath.push(newSubprojectDoc.doc.filePath)
            }
        }

        // Project Locations
        for (const location of locations) {
            if (projectDoc.locationMap.has(location.id.toString())) {
                const locationDoc = await LocationGenerator.updateLocation(location._id || location.id,
                    projectDoc.locationMap.get(location.id.toString()),reportType);
                if (locationDoc !== null) {
                    projectDoc.locationMap.get(location.id.toString()).doc= locationDoc;
                }
            } else {
                console.log("New location is added");
                const locationDoc = await LocationGenerator.createLocation(location._id || location.id,reportType);
                projectDoc.locationMap.set(location.id.toString(), locationDoc);
            }
            let newLocationDoc = projectDoc.locationMap.get(location.id.toString());
            if (newLocationDoc.doc !== null && newLocationDoc.doc !== undefined) {
                locationMap.set(location.id.toString(), newLocationDoc);
                projectHashcodeArray.push(newLocationDoc.doc.hashCode);
                docPath.push(newLocationDoc.doc.filePath)
            }

        }
        projectDoc.subprojectMap = subprojectMap;
        projectDoc.locationMap = locationMap;

        projectHashcodeArray.push(ReportGenerationUtil.calculateHash(project));
        const projectHashCode = ReportGenerationUtil.combineHashesInArray(projectHashcodeArray);
        // RESTORED FAST-PATH: return the already-built report when the project
        // is unchanged and a cached file exists. Only re-merge when the data
        // changed or there is no cache yet; if a re-merge yields no file, fall
        // back to the last good report instead of writing a FAILED record.
        const cachedFilePath = (projectDoc.doc && projectDoc.doc.filePath) || null;
        if (projectHashCode !== projectDoc.data.hashCode || !cachedFilePath) {
            console.log('Re-merging project report (data changed or no cached file).');
            await this.saveFileToS3(docPath, projectId, reportType, projectDoc, projectHashCode);
            if (projectDoc.doc && projectDoc.doc.filePath) {
                await ProjectReportHashCodeService.deleteProjectReportHashCodeByIdAndReportType(projectId,reportType);
                const projectDocToSave = this.getProjectReportHascodeDocToSave(projectDoc, projectId,reportType);
                await ProjectReportHashCodeService.addProjectReportHashCode(projectDocToSave);
            } else if (cachedFilePath) {
                console.error('Re-merge produced no file; serving cached report for project ' + projectId);
                return cachedFilePath;
            }
        }
        return (projectDoc.doc && projectDoc.doc.filePath) || cachedFilePath
    }

    async saveFileToS3(docPath, projectId, reportType, projectDoc, projectHashCode) {
        const filePath = await ReportGenerationUtil.mergeDocxArray(docPath, projectId);
        let fileS3url = null;
        if (filePath != null) {
            fileS3url = await ProjectReportUploader.uploadToBlobStorage(filePath, projectId, reportType);
            await fs.promises.unlink(filePath);
        }
        projectDoc.doc = new Doc(projectHashCode, fileS3url);
    }

    reOrderAndGroupProjects (projects){
        const subProjects = [];
        const locations = [];
        
        // Handle both array and object formats, and null/undefined
        const projectsArray = Array.isArray(projects) ? projects : (projects ? Object.values(projects) : []);
        
        console.log("projectsArray:", projectsArray);
        
        for(const project of projectsArray)
        {            
            if(project && project.type === ProjectChildType.SUBPROJECT)
            {
                console.log("Adding subproject:", project.name);
                subProjects.push(project);
            }
            else if(project && project.type === ProjectChildType.PROJECTLOCATION)
            {
                console.log("Adding location:", project.name);
                locations.push(project);
            }
            else {
                console.log("Child type not recognized - type:", project.type);
            }
        }
        
        console.log("Final result - subProjects count:", subProjects.length, "locations count:", locations.length);
        
        subProjects.sort(function(subProj1,subProj2){
            return (parseInt(subProj1.sequenceNo || subProj1.sequenceNumber || 0) - parseInt(subProj2.sequenceNo || subProj2.sequenceNumber || 0));
        });
        locations.sort(function(loc1,loc2){
            return (parseInt(loc1.sequenceNo || loc1.sequenceNumber || 0) - parseInt(loc2.sequenceNo || loc2.sequenceNumber || 0));
        });
        return {subProjects,locations};
    }
    getProjectReportHascodeDocToSave(projectDoc, projectId,reportType) {
        // Convert Maps to plain objects for serialization
        const projectDocForSave = {
            ...projectDoc,
            locationMap: projectDoc.locationMap instanceof Map ? Object.fromEntries(projectDoc.locationMap) : projectDoc.locationMap,
            subprojectMap: projectDoc.subprojectMap instanceof Map ? Object.fromEntries(projectDoc.subprojectMap) : projectDoc.subprojectMap
        };
        
        const serialized = serialize(projectDocForSave);
        const now = new Date();
        const indianTime = now.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
        return {
            projectId: projectId,
            data: serialized,
            reportType: reportType,
            createdAt: indianTime,
        };
    }
}

module.exports = new ProjectGenerator();
