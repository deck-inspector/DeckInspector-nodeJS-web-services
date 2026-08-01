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
                    // Section refs may carry `id` OR `_id` (mobile vs web writers).
                    const secId = section && (section.id || section._id);
                    if (!secId) { console.error("Location section ref has no id, skipping:", section && section.name); continue; }
                    const sectionDoc = await SectionGenerator.createSection(secId, location, subprojectName, reportType);
                    if (sectionDoc != null) {
                        locationDoc.sectionMap.set(String(secId), sectionDoc);
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
                    // Section refs may carry `id` OR `_id` (mobile vs web writers).
                    const secId = section && (section.id || section._id);
                    if (!secId) { console.error("Location section ref has no id, skipping:", section && section.name); continue; }
                    const secKey = String(secId);
                    if (sectionMap.has(secKey)) {
                        const sectionDoc = await SectionGenerator.updateSection(secId, sectionMap.get(secKey).hashCode, location, subprojectName, reportType);
                        if (sectionDoc !== null) {
                            // Section Doc is updated
                            sectionMap.set(secKey, sectionDoc);
                        }
                    } else {
                        const sectionDoc = await SectionGenerator.createSection(secId, location, subprojectName, reportType);
                        sectionMap.set(secKey, sectionDoc);
                    }
                    let newSectionDoc = sectionMap.get(secKey);
                    if (newSectionDoc != null) {
                        newSectionMap.set(secKey, newSectionDoc);
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