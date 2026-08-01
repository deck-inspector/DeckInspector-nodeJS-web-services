const {getSubProjectById} = require("../../../model/subproject");
const {SubprojectDoc, Doc} = require("../Models/ProjectDocs");
const ReportGenerationUtil = require("../ReportGenerationUtil");
const LocationType = require("../../../model/locationType");
const LocationGenerator = require("./LocationGenerator");
const ProjectReportUploader = require("../projectReportUploader");
const fs = require("fs");

class SubprojectGenerator{
    async createSubProject(subProjectId,reportType) {
        console.log("Subproject Generation Started", subProjectId);
        const subProjectData = await getSubProjectById(subProjectId);
        const subProjectDoc = new SubprojectDoc();
        // An orphaned/missing subproject id makes getSubProjectById return
        // { error } with no .data.item. Skip it (empty doc) instead of crashing
        // the whole report with "reading 'item'".
        if (!subProjectData || !subProjectData.data || !subProjectData.data.item) {
            console.error("Subproject data missing, skipping subproject:", subProjectId);
            return subProjectDoc;
        }
        const subprojectName = subProjectData.data.item.name;
        const subProjectMetadataHashCode = ReportGenerationUtil.calculateHash(subProjectData);
        let subprojectLocationsHashCode = [];
        let locationPath = [];
        subprojectLocationsHashCode.push(subProjectMetadataHashCode);
        const {subProjectApartments, subProjectLocations } = this.reordersubProjectLocations(subProjectData.data.item.children);
        try {
            // Children may carry their id as `id` OR `_id` depending on which
            // app version wrote them (mobile vs web). Reading only one of the
            // two passed `undefined` to createLocation, every location was
            // skipped, and the report came out as the COVER PAGE ONLY
            // (seen live: "Location creation started: undefined" x2 ->
            // "No valid files to merge." on WestCoast 3944-46 Georgia).
            for (let key in subProjectApartments) {
                const aptId = subProjectApartments[key] && (subProjectApartments[key].id || subProjectApartments[key]._id);
                if (!aptId) { console.error("Subproject apartment child has no id, skipping:", subProjectApartments[key] && subProjectApartments[key].name); continue; }
                let locationDoc = await LocationGenerator.createLocation(aptId,reportType,subprojectName);
                if (locationDoc) {
                    if (locationDoc.doc !== null && locationDoc.doc !== undefined) {
                        subProjectDoc.buildingApartmentMap.set(String(aptId), locationDoc);
                        subprojectLocationsHashCode.push(locationDoc.doc.hashCode);
                        locationPath.push(locationDoc.doc.filePath);
                    }
                }

            }

            for (let key in subProjectLocations) {
                const locId = subProjectLocations[key] && (subProjectLocations[key].id || subProjectLocations[key]._id);
                if (!locId) { console.error("Subproject location child has no id, skipping:", subProjectLocations[key] && subProjectLocations[key].name); continue; }
                let locationDoc = await LocationGenerator.createLocation(locId,reportType,subprojectName);
                if (locationDoc) {
                    if (locationDoc.doc !== null && locationDoc.doc !== undefined) {
                        subProjectDoc.buildingLocationMap.set(String(locId), locationDoc);
                        subprojectLocationsHashCode.push(locationDoc.doc.hashCode);
                        locationPath.push(locationDoc.doc.filePath);
                    }
                }
            }

            let subProjectHashCode = ReportGenerationUtil.combineHashesInArray(subprojectLocationsHashCode);
            const filePath = await ReportGenerationUtil.mergeDocxArray(locationPath, subProjectId);
            let fileS3url = null
            if(filePath!= null) {
                fileS3url = await ProjectReportUploader.uploadToBlobStorage(filePath, subProjectId, reportType);
                await fs.promises.unlink(filePath);
            }
            subProjectDoc.doc = new Doc(subProjectHashCode, fileS3url);
        } catch (e) {
            console.error(e);
            console.error("Subproject Generation Failed", subProjectId);
            // Skip the bad subproject instead of failing the WHOLE report.
            return subProjectDoc;
        }
        console.log("Subproject Generation Completed", subProjectId);
        return subProjectDoc;

    }

    async updateSubProject(subProjectId, subprojectDoc,reportType) {
        console.log("Update Subproject Generation Started", subProjectId);
        const subProjectData = await getSubProjectById(subProjectId);
        // An orphaned/missing subproject id makes getSubProjectById return
        // { error } with no .data.item. Treat as "no update" instead of crashing.
        if (!subProjectData || !subProjectData.data || !subProjectData.data.item) {
            console.error("Subproject data missing on update, skipping subproject:", subProjectId);
            return null;
        }
        const subprojectName = subProjectData.data.item.name;
        const subProjectMetadataHashCode = ReportGenerationUtil.calculateHash(subProjectData);
        const originalHashCode = subprojectDoc.doc.hashCode;
        const subprojectLocationsHashCode = [];
        subprojectLocationsHashCode.push(subProjectMetadataHashCode);
        let locationPath = [];
        const {subProjectApartments, subProjectLocations } = this.reordersubProjectLocations(subProjectData.data.item.children);
        let buildingLocationMap = new Map();
        let buildingApartmentMap = new Map();
        try {
            // Children may carry `id` OR `_id` (mobile vs web writers) - read both.
            for (let key in subProjectApartments) {
                const aptId = subProjectApartments[key] && (subProjectApartments[key].id || subProjectApartments[key]._id);
                if (!aptId) { console.error("Subproject apartment child has no id, skipping:", subProjectApartments[key] && subProjectApartments[key].name); continue; }
                const aptKey = String(aptId);
                if (subprojectDoc.buildingApartmentMap.get(aptKey)) {
                    let locationDoc = await LocationGenerator.updateLocation(aptId,
                        subprojectDoc.buildingApartmentMap.get(aptKey),
                        reportType,
                        subprojectName);
                    if (locationDoc !== null) {
                        subprojectDoc.buildingApartmentMap.get(aptKey).doc = locationDoc;
                    }
                } else {
                    console.log("New subproject apartment is added")
                    let locationDoc = await LocationGenerator.createLocation(aptId, reportType, subprojectName);
                    subprojectDoc.buildingApartmentMap.set(aptKey, locationDoc);
                }

                let newLocationDoc = subprojectDoc.buildingApartmentMap.get(aptKey);
                if (newLocationDoc && newLocationDoc.doc !== null && newLocationDoc.doc !== undefined) {
                    buildingApartmentMap.set(aptKey, newLocationDoc);
                    subprojectLocationsHashCode.push(newLocationDoc.doc.hashCode);
                    locationPath.push(newLocationDoc.doc.filePath)
                }
            }
            for (let key in subProjectLocations) {
                const locId = subProjectLocations[key] && (subProjectLocations[key].id || subProjectLocations[key]._id);
                if (!locId) { console.error("Subproject location child has no id, skipping:", subProjectLocations[key] && subProjectLocations[key].name); continue; }
                const locKey = String(locId);
                if (subprojectDoc.buildingLocationMap.has(locKey)) {
                    let locationDoc = await LocationGenerator.updateLocation(locId,
                        subprojectDoc.buildingLocationMap.get(locKey),
                        reportType,
                        subprojectName);
                    if (locationDoc !== null) {
                        subprojectDoc.buildingLocationMap.get(locKey).doc = locationDoc;
                    }
                } else {
                    console.log("New subproject location is added");
                    let locationDoc = await LocationGenerator.createLocation(locId, reportType, subprojectName);
                    subprojectDoc.buildingLocationMap.set(locKey, locationDoc);
                }
                let newLocationDoc = subprojectDoc.buildingLocationMap.get(locKey);
                if (newLocationDoc && newLocationDoc.doc !== null && newLocationDoc.doc !== undefined) {
                    buildingLocationMap.set(locKey, newLocationDoc);
                    subprojectLocationsHashCode.push(newLocationDoc.doc.hashCode);
                    locationPath.push(newLocationDoc.doc.filePath);
                }
            }
            subprojectDoc.buildingLocationMap = buildingLocationMap;
            subprojectDoc.buildingApartmentMap = buildingApartmentMap;

            const subProjectHashCode = ReportGenerationUtil.combineHashesInArray(subprojectLocationsHashCode);
            if (subProjectHashCode !== originalHashCode) {
                console.log('SubProject Doc is changed', subProjectId);
                const filePath = await ReportGenerationUtil.mergeDocxArray(locationPath, subProjectId);
                let fileS3url = null
                if (filePath != null) {
                    fileS3url = await ProjectReportUploader.uploadToBlobStorage(filePath, subProjectId, reportType);
                    await fs.promises.unlink(filePath);
                }
                subprojectDoc.doc = new Doc(subProjectHashCode, fileS3url);
                console.log("SubProject Doc is updated",  subProjectId);
                return subprojectDoc;
            }
        } catch (e) {
            console.error(e);
            console.error("Subproject Generation Failed", subProjectId);
            // Skip the bad subproject instead of failing the WHOLE report.
            return null;
        }
        return null;  // No update needed.  SubProject doc is unchanged.
    }

    reordersubProjectLocations (locations){
        const subProjectApartments = [];
        const subProjectLocations = [];
        for(let key in locations)
        {
            if(locations[key].type === LocationType.APARTMENT)
            {
                subProjectApartments.push(locations[key]);
            }
            else if(locations[key].type === LocationType.BUILDINGLOCATION){
                subProjectLocations.push(locations[key]);
            }
        }
        subProjectApartments.sort(function(apt1,apt2){
            return (apt1.sequenceNumber-apt2.sequenceNumber);
        });
        subProjectLocations.sort(function(loc1,loc2){
            return (loc1.sequenceNumber-loc2.sequenceNumber)});
        return {subProjectApartments,subProjectLocations};
    }
}

module.exports = new SubprojectGenerator();