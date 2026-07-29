const sections = require("../../../model/sections");
const ReportGenerationUtil = require("../ReportGenerationUtil");
const {Doc} = require("../Models/ProjectDocs");
const SectionWordGenerator = require("../WordGenerator/SectionWordGenerator");
const fs = require("fs");

const ProjectReportUploader = require("../../ReportGeneration/projectReportUploader");

class SectionGenerator{
    async createSection(sectionId,location,subprojectName,reportType) {
        // Fetch sectionData from DB
        const sectionData = await sections.getSectionById(sectionId);
        // Calculate Hashcode
        const hashCode = ReportGenerationUtil.calculateHash(sectionData);
        // Create a Document
        return await this.createSectionDoc(sectionId, sectionData, reportType, subprojectName, location, hashCode);
    }

    async updateSection(sectionId, originalHashCode,location,subprojectName,reportType) {
        // Fetch sectionData from DB
        const sectionData = await sections.getSectionById(sectionId);
        // Calculate Hashcode
        const hashCode = ReportGenerationUtil.calculateHash(sectionData);
        if (hashCode !== originalHashCode) {
            // Create a Document
            console.log("Section Hashcode changed for SectionID :"+sectionId);
            return await this.createSectionDoc(sectionId, sectionData, reportType, subprojectName, location, hashCode);
        }
        return null;

    }

    async createSectionDoc(sectionId, sectionData, reportType, subprojectName, location, hashCode) {
        try {
            console.log("Creation of Section Doc started :", sectionId);
            const filePath = await SectionWordGenerator.createSectionDoc(sectionId, sectionData, reportType, subprojectName, location, 'DeckInspectors');
            let fileS3url = null;
            if (filePath != null) {
                fileS3url = await ProjectReportUploader.uploadToBlobStorage(filePath, sectionId, reportType);
                await fs.promises.unlink(filePath);
            }
            console.log("Section doc completed :", sectionId);
            return new Doc(hashCode, fileS3url);
        } catch (e) {
            console.error(e);
            console.error("Failed for section :", sectionId);
            // Skip the bad section instead of failing the WHOLE report. A single
            // section with an unexpected/undefined field (e.g. a '.toString()' on
            // missing data) previously crashed the entire report generation.
            return null;
        }
    }
}

module.exports = new SectionGenerator();