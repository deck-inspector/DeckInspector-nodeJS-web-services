const locations = require("../../../model/location");
const {LocationDoc, Doc} = require("../Models/ProjectDocs");
const ReportGenerationUtil = require("../ReportGenerationUtil");
const SectionGenerator = require("./SectionGenerator");
const ProjectReportUploader = require("../projectReportUploader");
const fs = require("fs");

class LocationGenerator {
    async createLocation(locationId, reportType, subprojectName = '') {
        console.log("Location creation started:", locationId);
        const location = await locations.getLocationById(locationId);
        let locationDoc = new LocationDoc();
        // An orphaned/missing location id makes getLocationById return { error }
        // with no .data.item. Skip it (empty doc) instead of crashing the report.
        if (!location || !location.data || !location.data.item) {
            console.error("Location data missing, skipping location:", locationId);
            return locationDoc;
        }
        let locationSections = location.data.item.sections;
        if (locationSections) {
            let locationMetaDataHashCode = ReportGenerationUtil.calculateHash(location);
            let locationSectionHashCodes = [];
            let sectionPath = [];
            try {
                for (const section of locationSections) {
                    const sectionDoc = await SectionGenerator.createSection(section.id, location, subprojectName, reportType);
                    if (sectionDoc != null) {
                        locationDoc.sectionMap.set(section.id.toString(), sectionDoc);
                        locationSectionHashCodes.push(sectionDoc.hashCode);
                        sectionPath.push(sectionDoc.filePath);
                    }
                }

                locationSectionHashCodes.push(locationMetaDataHashCode);
                const locationHashCode = ReportGenerationUtil.combineHashesInArray(locationSectionHashCodes);
                const filePath = await ReportGenerationUtil.mergeDocxArray(sectionPath, locationId);
                let fileS3url = null;
                if (filePath != null) {
                    fileS3url = await ProjectReportUploader.uploadToBlobStorage(filePath, locationId, reportType);
                    await fs.promises.unlink(filePath);
                }
                locationDoc.doc = new Doc(locationHashCode, fileS3url);
            } catch (e) {
                console.error(e);
                console.error("Location creation failed:", locationId)
                // Skip the bad location instead of failing the WHOLE report.
                return locationDoc;
            }
        }
        console.log("Location creation completed:", locationId);
        return locationDoc;
    }

    async updateLocation(locationId, locationDoc, reportType, subprojectName = '') {
        const location = await locations.getLocationById(locationId);
        // An orphaned/missing location id makes getLocationById return { error }
        // with no .data.item. Treat as "no update" instead of crashing.
        if (!location || !location.data || !location.data.item) {
            console.error("Location data missing on update, skipping location:", locationId);
            return null;
        }
        let locationSections = location.data.item.sections;
        let originalHashCode = locationDoc.doc.hashCode;
        let sectionMap = locationDoc.sectionMap;
        let newSectionMap = new Map();

        if (locationSections) {
            try {
                let locationMetaDataHashCode = ReportGenerationUtil.calculateHash(location);
                let locationSectionHashCodes = [];
                let sectionPath = [];
                for (const section of locationSections) {
                    if (sectionMap.has(section._id.toString())) {
                        const sectionDoc = await SectionGenerator.updateSection(section._id, sectionMap.get(section._id.toString()).hashCode, location, subprojectName, reportType);
                        if (sectionDoc !== null) {
                            // Section Doc is updated
                            sectionMap.set(section._id.toString(), sectionDoc);
                        }
                    } else {
                        const sectionDoc = await SectionGenerator.createSection(section._id, location, subprojectName, reportType);
                        sectionMap.set(section._id.toString(), sectionDoc);
                    }
                    let newSectionDoc = sectionMap.get(section._id.toString());
                    if (newSectionDoc != null) {
                        newSectionMap.set(section._id.toString(), newSectionDoc);
                        locationSectionHashCodes.push(newSectionDoc.hashCode);
                        sectionPath.push(newSectionDoc.filePath);
                    }
                }
                locationDoc.sectionMap = newSectionMap;
                locationSectionHashCodes.push(locationMetaDataHashCode);
                const locationHashCode = ReportGenerationUtil.combineHashesInArray(locationSectionHashCodes);
                if (locationHashCode !== originalHashCode) {
                    console.log('Location Doc is changed', locationId);
                    const filePath = await ReportGenerationUtil.mergeDocxArray(sectionPath, locationId);
                    let fileS3url = null;
                    if (filePath != null) {
                        fileS3url = await ProjectReportUploader.uploadToBlobStorage(filePath, locationId, reportType);
                        await fs.promises.unlink(filePath);
                    }
                    console.log('Location update completed', locationId);
                    return new Doc(locationHashCode, fileS3url);
                }
            } catch (e) {
                console.error(e);
                console.error("Failed for location :", locationId);
                return null;
            }

        }
        return null;  // No update needed.  Location doc is unchanged.
    }
}

module.exports = new LocationGenerator();