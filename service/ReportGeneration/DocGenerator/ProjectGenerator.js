const projects = require("../../../model/project");
const {ProjectDocs, Doc} = require("../Models/ProjectDocs");
const ReportGenerationUtil = require("../ReportGenerationUtil");
const ProjectChildType = require("../../../model/projectChildType");
const LocationGenerator = require("./LocationGenerator");
const SubProjectGenerator = require("./SubProjectGenerator");
const SectionGenerator = require("./SectionGenerator");
const ProjectReportHashCodeService = require("../../projectReportHashCodeService");
const serialize = require('serialize-javascript');
const ProjectReportUploader = require("../projectReportUploader");
const ProjectHeaderDocGenerator = require("./ProjectHeaderDocGenerator");
const FinalReportGenerator = require("../FinalReportGenerator");
const PizZip = require("pizzip");
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

        // Create Project Header Doc. A header failure must not kill the whole
        // report - generate the body without the cover page rather than failing.
        try {
            projectDoc.projectHeaderDoc = await ProjectHeaderDocGenerator.createProjectHeaderDoc(projectId, project, "DeckInspectors", reportType);
        } catch (e) {
            console.error("Project header generation failed, continuing without cover page:", e && e.message);
        }
        if (projectDoc.projectHeaderDoc) {
            projectHashcodeArray.push(projectDoc.projectHeaderDoc.hashCode);
            docPath.push(projectDoc.projectHeaderDoc.filePath);
        }

        const {subProjects, locations } = this.reOrderAndGroupProjects(project.children);
        console.log("After reOrderAndGroupProjects - subProjects count:", subProjects.length, "locations count:", locations.length);
        for(const mySubProject of subProjects) {
            // Per-child guard: one bad subproject must not abort the whole report.
            try {
                const subId = (mySubProject && (mySubProject.id || mySubProject._id));
                const subProjectDoc = await SubProjectGenerator.createSubProject(subId,reportType);
                if (subProjectDoc && subProjectDoc.doc !== null && subProjectDoc.doc !== undefined) {
                    projectDoc.subprojectMap.set(String(subId), subProjectDoc);
                    projectHashcodeArray.push(subProjectDoc.doc.hashCode);
                    docPath.push(subProjectDoc.doc.filePath);
                }
            } catch (e) {
                console.error("Skipping subproject after error:", mySubProject && (mySubProject.id || mySubProject._id), e && e.message);
            }
        }

        for (const location of locations) {
            // Per-child guard: one bad location must not abort the whole report.
            try {
                const locId = (location && (location.id || location._id));
                const locationDoc = await LocationGenerator.createLocation(locId,reportType);
                if (locationDoc) {
                    if (locationDoc.doc !== null && locationDoc.doc !== undefined) {
                        projectDoc.locationMap.set(String(locId), locationDoc);
                        projectHashcodeArray.push(locationDoc.doc.hashCode);
                        docPath.push(locationDoc.doc.filePath)
                    }
                }
            } catch (e) {
                console.error("Skipping location after error:", location && (location.id || location._id), e && e.message);
            }
        }

        // Single-level projects keep their sections DIRECTLY on the project (no
        // subproject/location tree), so the loops above find nothing for them.
        // Render those project-level sections here, treating the project itself
        // as the parent "location", so single-level projects generate the same
        // way multi-level ones do - no data conversion required.
        const projType = (project.projecttype || project.projectType || '').toString().toLowerCase();
        const projectSections = Array.isArray(project.sections) ? project.sections : [];
        if ((projType === 'singlelevel' || (subProjects.length === 0 && locations.length === 0)) && projectSections.length > 0) {
            console.log("Generating single-level body from", projectSections.length, "project-level section(s)");
            const syntheticLocation = { data: { item: {
                name: project.name || '',
                type: 'projectlocation',
                isInvasive: project.isInvasive === true,
            } } };
            for (const sec of projectSections) {
                try {
                    const secId = sec && (sec._id || sec.id);
                    if (!secId) continue;
                    const sectionDoc = await SectionGenerator.createSection(secId, syntheticLocation, '', reportType);
                    if (sectionDoc && sectionDoc.filePath) {
                        projectHashcodeArray.push(sectionDoc.hashCode);
                        docPath.push(sectionDoc.filePath);
                    }
                } catch (e) {
                    console.error("Skipping single-level section after error:", sec && (sec._id || sec.id), e && e.message);
                }
            }
        }

        projectHashcodeArray.push(ReportGenerationUtil.calculateHash(project));
        const projectHashCode = ReportGenerationUtil.combineHashesInArray(projectHashcodeArray);
        await this.saveFileToS3(docPath, projectId, reportType, projectDoc, projectHashCode, project && project.companyIdentifier);
        const projectDocToSave = this.getProjectReportHascodeDocToSave(projectDoc, projectId,reportType);
        await ProjectReportHashCodeService.addProjectReportHashCode(projectDocToSave);
        return projectDoc.doc.filePath;
    }

    async updateProject(projectId,existingProjectDoc,reportType) {
        let projectResponse = await projects.getProjectById(projectId);
        // Extract project from wrapped response if needed
        const project = projectResponse.project || projectResponse;

        // Single-level projects don't fit the cached subproject/location update
        // model (their sections live on the project). Rebuild from scratch via
        // createProject so single-level reports regenerate correctly.
        const projTypeU = (project.projecttype || project.projectType || '').toString().toLowerCase();
        if (projTypeU === 'singlelevel') {
            try { await ProjectReportHashCodeService.deleteProjectReportHashCodeByIdAndReportType(projectId, reportType); } catch (e) { console.error('single-level: could not clear cached hashcode:', e && e.message); }
            return await this.createProject(projectId, reportType);
        }

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
        // Always re-merge (docxcompose): merge-pipeline fixes must reach
        // existing projects; chunk generation above stays hash-cached. The
        // cachedFilePath fallback below still protects against merge failure.
        if (true) {
            console.log('Re-merging project report (data changed or no cached file).');
            await this.saveFileToS3(docPath, projectId, reportType, projectDoc, projectHashCode, project && project.companyIdentifier);
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

    async saveFileToS3(docPath, projectId, reportType, projectDoc, projectHashCode, companyIdentifier) {
        const filePath = await ReportGenerationUtil.mergeDocxArray(docPath, projectId);
        let fileS3url = null;
        if (filePath != null) {
            // Stamp the tenant's admin "Report Header" logo into the Visual
            // report's page headers - the SAME branding the Final report gets
            // (FinalReportGenerator.injectTenantLogo) - so the company logo now
            // appears on the Visual report too, not only the Final report.
            try {
                if (companyIdentifier) {
                    const buf = await fs.promises.readFile(filePath);
                    const zip = new PizZip(buf);
                    await FinalReportGenerator.injectTenantLogo(zip, companyIdentifier);
                    // Also stamp the tenant's admin "Report Footer" image (the
                    // round logo) + footer text into every page footer - the
                    // SAME branding the Final report gets - so the Visual
                    // report footer matches the Final report footer.
                    await FinalReportGenerator.injectTenantFooter(zip, companyIdentifier);
                    await fs.promises.writeFile(filePath, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
                    console.log('Visual report: tenant header logo + footer stamped for', companyIdentifier);
                }
            } catch (e) {
                console.error('Visual report tenant logo injection failed (report continues without it):', e && e.message);
            }
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
