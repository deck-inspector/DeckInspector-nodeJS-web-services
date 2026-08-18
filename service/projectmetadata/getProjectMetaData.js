const project = require("../../model/project.js");
const subProject = require("../../model/subproject.js");
const location = require("../../model/location.js");

const getProjectHierarchyMetadata = async function(username)
{
    try{
        var response = {}
        var projects = [];

        const allProjects = await project.getProjectByAssignedToUserId(username);
        
        if(allProjects.data && allProjects.data.projects)
        {
            for(const proj of allProjects.data.projects)
            {
                // ✅ FIX: Handle both Couchbase (id) and legacy (_id) formats
                const projectId = proj.id || proj._id;
                
                if (!projectId || projectId === 'undefined') {
                    console.warn("⚠️ Skipping project with undefined ID:", proj);
                    continue;
                }
                
                console.log("Processing project ID:", projectId);
                const projectResponse = await getProjectData(projectId);
                projects.push(projectResponse);
            }
        }

        response = {
            "data" :{
                "item": projects,
                "message": "Projects found.",
                "code":201
            }     
        }
        return response;
    }catch(error){
        console.log("Error in getProjectHierarchyMetadata:", error);
        return {
            "error": { code: 500, message: error.message || "Internal server error" }
        }
    }

   
}

async function getSingleProjectMetadata(projectId)
{
    try{
        var response = {}
        var projects = [];

        const projectResponse = await getProjectData(projectId);
        projects.push(projectResponse);
        response = {
            "data" :{
                "item": projects,
                "message": "Projects found.",
                "code":201
            }     
        }
        return response;
    }catch(error){
        console.log(error);
        return {
            "error": { code: 500, message: error.message || "Internal server error" }
        }
    }
}


async function getProjectData(projectId) {
    const projectResponse = {};
    console.log("Fetching data for project ID:", projectId);
    const projectData = await project.getProjectById(projectId);
    console.log("Project Data:", projectData);
    
    // ✅ Handle new Couchbase response format
    let projectInfo = null;
    
    if (projectData.success && projectData.project) {
        // New format: { success: true, project: {...} }
        projectInfo = projectData.project;
    } else if (projectData.data && projectData.data.item) {
        // Legacy format: { data: { item: {...} } }
        projectInfo = projectData.data.item;
    } else {
        console.error("Invalid project data structure:", projectData);
        throw new Error("Invalid project response format");
    }
    
    // ✅ Safely extract properties with fallbacks
    projectResponse.id = projectInfo._id || projectInfo.id || projectId;
    projectResponse.name = projectInfo.name || "";
    projectResponse.isInvasive = projectInfo.isInvasive ? projectInfo.isInvasive : false;
    projectResponse.projectType = projectInfo.projecttype || projectInfo.projectType || "";
    projectResponse.subProjects = await getSubProjectsData(projectId);
    projectResponse.locations = await getProjectWiseLocationsMetaData(projectId);
    
    return projectResponse;
}


// Worst-of condition rollup for a location, from the section metadata the
// location doc already carries (visualreview / furtherinvasivereviewrequired,
// maintained by updateParentHelper). BAD if ANY section's visual review is Bad
// OR further invasive review is required (David, Aug 18); else FAIR if any
// Fair; else GOOD if any rated Good; '' when nothing is rated yet.
function locConditionRollup(loc) {
    const secs = Array.isArray(loc && loc.sections) ? loc.sections : [];
    let fair = false, good = false;
    for (const s of secs) {
        if (!s) continue;
        const v = String(s.visualreview || '').toLowerCase();
        const inv = s.furtherinvasivereviewrequired;
        const invYes = inv === true || /^(yes|true)$/i.test(String(inv || ''));
        if (v.startsWith('bad') || invYes) return 'Bad';
        if (v.startsWith('fair')) fair = true;
        else if (v.startsWith('good')) good = true;
    }
    return fair ? 'Fair' : (good ? 'Good' : '');
}

async function getProjectWiseLocationsMetaData(projectId) {
    const locationData = await location.getLocationByParentId(projectId);
    const locations = [];
    if(locationData.data && locationData.data.item)
    {
        for (const loc of locationData.data.item) {
            locations.push({ locationId: loc.id || loc._id, locationName: loc.name, locationType: loc.type ,isInvasive:loc.isInvasive?loc.isInvasive:false, sequenceNo: loc.sequenceNo, url: loc.url || '', rating: locConditionRollup(loc)});
        }
    }
    locations.sort(function(loc1,loc2){
        return (loc1.sequenceNo-loc2.sequenceNo)
    });
    return locations;
}


async function getSubProjectsData(projectId) {
    const subProjectsData = await subProject.getSubProjectsByParentId(projectId);
    console.log("SubProjects Data:", subProjectsData);
    const subProjects = [];
    if (subProjectsData.data && subProjectsData.data.item) {
        for (const subProject of subProjectsData.data.item) {
            const subProjectData = {};
            // Always use 'id' in the response
            subProjectData.id = subProject.id || subProject._id;
            subProjectData.name = subProject.name;
            subProjectData.isInvasive = subProject.isInvasive ? subProject.isInvasive : false;
            subProjectData.sequenceNo = subProject.sequenceNo;
            const subProjectLocations = [];
            // Use id for location parent
            const subProjectKey = subProject.id || subProject._id;
            const subProjectChildren = await location.getLocationByParentId(subProjectKey);

            if (subProjectChildren.data && subProjectChildren.data.item) {
                for (const loc of subProjectChildren.data.item) {
                    const locId = loc.id || loc._id;
                    const locName = loc.name;
                    const locType = loc.type;
                    const sequenceNo = loc.sequenceNo;
                    const isInvasive = loc.isInvasive ? loc.isInvasive : false;
                    subProjectLocations.push({
                        locationId: locId,
                        sequenceNo: sequenceNo,
                        locationName: locName,
                        locationType: locType,
                        isInvasive: isInvasive,
                        url: loc.url || '',
                        rating: locConditionRollup(loc)
                    });
                }
            }
            subProjectData.subProjectLocations = subProjectLocations.sort(function (subProj1, subProj2) {
                return (subProj1.sequenceNo - subProj2.sequenceNo)
            });
            subProjects.push(subProjectData);
        }
    }
    subProjects.sort(function (subProj1, subProj2) {
        return (subProj1.sequenceNo - subProj2.sequenceNo)
    });
    return subProjects;
}




module.exports = {getProjectHierarchyMetadata, getSingleProjectMetadata,getProjectData};

