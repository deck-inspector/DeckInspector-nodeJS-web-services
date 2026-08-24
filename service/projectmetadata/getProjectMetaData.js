// SCHEDULING ORDER (David, Aug 15, approved on the web app; applied to the
// MOBILE-facing endpoints Aug 23: "the project order by date is jumbled up in
// the app but on the website it works great"): upcoming inspections first -
// furthest out down to today - then past ones most-recent first, undated at
// the bottom. Dates partition against midnight LOS ANGELES time, same as the
// web app on David's screen.
function schedulingOrder(list) {
  if (!Array.isArray(list)) return list;
  const laNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  laNow.setHours(0, 0, 0, 0);
  const today = laNow.getTime();
  const when = (p) => { const v = new Date(p && p.editedat).getTime(); return isNaN(v) ? -Infinity : v; };
  return list.slice().sort((a, b) => {
    const wa = when(a), wb = when(b);
    const ua = wa >= today, ub = wb >= today;
    if (ua !== ub) return ua ? -1 : 1;
    return wb - wa;
  });
}

async function pmapMeta(items, fn, limit = 6) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
  return out;
}

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
            // Scheduling order first (matches the web app), then the heavy
            // per-project builds run in parallel batches instead of one at a
            // time - the mobile launch was waiting through every project in
            // sequence (same pattern fixed for the web on Aug 23).
            const srcList = schedulingOrder(allProjects.data.projects)
                .filter((proj) => {
                    const projectId = proj.id || proj._id;
                    if (!projectId || projectId === 'undefined') {
                        console.warn("⚠️ Skipping project with undefined ID:", proj);
                        return false;
                    }
                    return true;
                });
            const built = await pmapMeta(srcList, (proj) => getProjectData(proj.id || proj._id).catch(() => null), 6);
            for (const b of built) { if (b) projects.push(b); }
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
    const subProjects = [];
    if (subProjectsData.data && subProjectsData.data.item) {
        // SPEED (David, Aug 23): a large project has many buildings, and each
        // building's locations were fetched ONE AT A TIME - the project page
        // waited through every round-trip in sequence. All buildings are now
        // fetched IN PARALLEL, so the wait is one round-trip, not N.
        const subs = subProjectsData.data.item;
        const childrenList = await Promise.all(
            subs.map((sp) => location.getLocationByParentId(sp.id || sp._id).catch(() => null))
        );
        for (let si = 0; si < subs.length; si++) {
            const subProject = subs[si];
            const subProjectData = {};
            // Always use 'id' in the response
            subProjectData.id = subProject.id || subProject._id;
            subProjectData.name = subProject.name;
            subProjectData.isInvasive = subProject.isInvasive ? subProject.isInvasive : false;
            subProjectData.sequenceNo = subProject.sequenceNo;
            const subProjectLocations = [];
            const subProjectChildren = childrenList[si] || {};

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

