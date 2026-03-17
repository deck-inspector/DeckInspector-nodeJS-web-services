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
        const subprojectName = subProjectData.data.item.name;
        const subProjectDoc = new SubprojectDoc();
        const subProjectMetadataHashCode = ReportGenerationUtil.calculateHash(subProjectData);
        let subprojectLocationsHashCode = [];
        let locationPath = [];
        subprojectLocationsHashCode.push(subProjectMetadataHashCode);
        const {subProjectApartments, subProjectLocations } = this.reordersubProjectLocations(subProjectData.data.item.children);
        try {
            for (let key in subProjectApartments) {
                let locationDoc = await LocationGenerator.createLocation(subProjectApartments[key].id,reportType,subprojectName);
                if (locationDoc) {
                    if (locationDoc.doc !== null && locationDoc.doc !== undefined) {
                        subProjectDoc.buildingApartmentMap.set(subProjectApartments[key].id.toString(), locationDoc);
                        subprojectLocationsHashCode.push(locationDoc.doc.hashCode);
                        locationPath.push(locationDoc.doc.filePath);
                    }
                }

            }

            for (let key in subProjectLocations) {
                let locationDoc = await LocationGenerator.createLocation(subProjectLocations[key]._id,reportType,subprojectName);
                if (locationDoc) {
                    if (locationDoc.doc !== null && locationDoc.doc !== undefined) {
                        subProjectDoc.buildingLocationMap.set(subProjectLocations[key]._id.toString(), locationDoc);
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
            throw e;
        }
        console.log("Subproject Generation Completed", subProjectId);
        return subProjectDoc;

    }

    async updateSubProject(subProjectId, subprojectDoc,reportType) {
        console.log("Update Subproject Generation Started", subProjectId);
        const subProjectData = await getSubProjectById(subProjectId);
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
            for (let key in subProjectApartments) {
                if (subprojectDoc.buildingApartmentMap.get(subProjectApartments[key]._id.toString())) {
                    let locationDoc = await LocationGenerator.updateLocation(subProjectApartments[key]._id,
                        subprojectDoc.buildingApartmentMap.get(subProjectApartments[key]._id.toString()),
                        reportType,
                        subprojectName);
                    if (locationDoc !== null) {
                        subprojectDoc.buildingApartmentMap.get(subProjectApartments[key]._id.toString()).doc = locationDoc;
                    }
                } else {
                    console.log("New subproject apartment is added")
                    let locationDoc = await LocationGenerator.createLocation(subProjectApartments[key]._id, reportType, subprojectName);
                    subprojectDoc.buildingApartmentMap.set(subProjectApartments[key]._id.toString(), locationDoc);
                }

                let newLocationDoc = subprojectDoc.buildingApartmentMap.get(subProjectApartments[key]._id.toString());
                if (newLocationDoc.doc !== null && newLocationDoc.doc !== undefined) {
                    buildingApartmentMap.set(subProjectApartments[key]._id.toString(), newLocationDoc);
                    subprojectLocationsHashCode.push(newLocationDoc.doc.hashCode);
                    locationPath.push(newLocationDoc.doc.filePath)
                }
            }
            for (let key in subProjectLocations) {
                if (subprojectDoc.buildingLocationMap.has(subProjectLocations[key]._id.toString())) {
                    let locationDoc = await LocationGenerator.updateLocation(subProjectLocations[key]._id,
                        subprojectDoc.buildingLocationMap.get(subProjectLocations[key]._id.toString()),
                        reportType,
                        subprojectName);
                    if (locationDoc !== null) {
                        subprojectDoc.buildingLocationMap.get(subProjectLocations[key]._id.toString()).doc = locationDoc;
                    }
                } else {
                    console.log("New subproject location is added");
                    let locationDoc = await LocationGenerator.createLocation(subProjectLocations[key]._id, reportType, subprojectName);
                    subprojectDoc.buildingLocationMap.set(subProjectLocations[key]._id.toString(), locationDoc);
                }
                let newLocationDoc = subprojectDoc.buildingLocationMap.get(subProjectLocations[key]._id.toString());
                if (newLocationDoc.doc !== null && newLocationDoc.doc !== undefined) {
                    buildingLocationMap.set(subProjectLocations[key]._id.toString(), newLocationDoc);
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
            throw e;
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