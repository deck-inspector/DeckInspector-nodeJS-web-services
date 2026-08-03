const projectReportType = require("../../../model/projectReportType");
const invasiveSections = require("../../../model/invasiveSections");
const ProjectReportType = require("../../../model/projectReportType");
const conclusiveSections = require("../../../model/conclusiveSections");
const fs = require("fs");
const path = require("path");
const jo = require("jpeg-autorotate");
const ReportGenerationUtil = require("../ReportGenerationUtil");

class SectionWordGenerator {
    async createSectionDoc(sectionId, sectionData, reportType, subprojectName, location, companyName) {
            console.log("sectionId received:", sectionId);
        // A section referenced by a location can be orphaned (deleted, or its id
        // no longer resolves). getSectionById then returns { error } with no
        // .data.item, and reading it used to crash the WHOLE report with
        // "Cannot read properties of undefined (reading 'item')". Skip the
        // missing section (same as an excluded section) so the rest of the
        // report still generates.
        if (!sectionData || !sectionData.data || !sectionData.data.item) {
            console.error("Section data missing, skipping section:", sectionId);
            return;
        }
        if (!location || !location.data || !location.data.item) {
            console.error("Location data missing for section, skipping section:", sectionId);
            return;
        }
        if (this.isSectionIncluded(reportType, sectionData)) {
            const locationType = this.getLocationType(location);
            const template = this.getTemplate(companyName, subprojectName);
            const baseSectionDocValues = this.getBaseSectionDocValues(sectionData, reportType, subprojectName, locationType, location);
            let sectionDocValues;
            if (reportType === projectReportType.INVASIVEONLY || reportType === projectReportType.INVASIVEVISUAL) {
                // The section already passed isSectionIncluded (further invasive review
                // required). Do NOT additionally require location.isInvasive === true:
                // when an inspector marks the SECTION invasive but the location flag was
                // never set, the section silently vanished from Invasive reports
                // (Aug 3, "can't print the invasive report"). Log the inconsistency
                // instead of dropping the section.
                {
                    if (location.data.item.isInvasive !== true) {
                        console.error(`Invasive report: location "${location.data.item.name}" is not flagged isInvasive but section requires invasive review - including it anyway.`);
                    }
                    if (sectionData) {
                        let sectionDocValuesWhenUnitAvailable = this.getSectionDocValuesWhenUnitAvailable(sectionData);
                        const invasiveSectionData = await invasiveSections.getInvasiveSectionByParentId(sectionId);
                        if (invasiveSectionData.data && invasiveSectionData.data.item) {
                            let invasiveData = this.getInvasiveData(invasiveSectionData);
                            if (reportType === ProjectReportType.INVASIVEONLY) {
                                const conclusiveSectionData = await conclusiveSections.getConclusiveSectionByParentId(sectionId);
                                const conclusiveData = conclusiveSectionData.data && conclusiveSectionData.data.item
                                    ? this.getConclusiveData(conclusiveSectionData)
                                    : {
                                        invasiverepairsinspectedandcompleted: false,
                                    };
                                sectionDocValues = {
                                    ...baseSectionDocValues,
                                    ...invasiveData,
                                    ...conclusiveData
                                }
                                return await this.getWord(sectionData.data.item.id, template, sectionDocValues);
                            }
                            else {
                                sectionDocValues = {
                                    ...baseSectionDocValues,
                                    ...sectionDocValuesWhenUnitAvailable,
                                    ...invasiveData,
                                    furtherInvasiveRequired: false,
                                    invasiverepairsinspectedandcompleted: false
                                }
                                return await this.getWord(sectionData.data.item.id, template, sectionDocValues);
                            }
                        }
                        else {
                            sectionDocValues = {
                                ...baseSectionDocValues,
                                ...sectionDocValuesWhenUnitAvailable,
                                furtherInvasiveRequired: false,
                                invasiverepairsinspectedandcompleted: false,
                                invasiveImages: [],
                                invasiveDesc: 'Invasive inspection not done'
                            }
                            return await this.getWord(sectionData.data.item.id, template, sectionDocValues);
                        }
                    }
                }
            }
            else if (reportType === projectReportType.VISUALREPORT) {
                if (sectionData.data.item.unitUnavailable) {
                    sectionDocValues = {
                        ...baseSectionDocValues,
                    };
                    return await this.getWord(sectionData.data.item.id, template, sectionDocValues);
                }
                const sectionDocValuesWhenUnitAvailable = this.getSectionDocValuesWhenUnitAvailable(sectionData);
                sectionDocValues =  {
                    ...baseSectionDocValues,
                    ...sectionDocValuesWhenUnitAvailable,
                };
                return await this.getWord(sectionData.data.item.id, template, sectionDocValues);
            }
            // return await this.getWord(sectionData.data.item._id, template, sectionDocValues);
        }
    }
    getBaseSectionDocValues(sectionData, reportType, subprojectName, locationType, location) {
        return {
            isUnitUnavailable: sectionData.data.item.unitUnavailable ? 'true' : 'false',
            reportType: reportType,
            buildingName: subprojectName,
            parentType: locationType,
            parentName: location.data.item.name,
            name: sectionData.data.item.name,
        };
    }
    getSectionDocValuesWhenUnitAvailable(sectionData) {
        return {
            exteriorelements: sectionData.data.item.exteriorelements?.toString().replaceAll(',', ', '),
            waterproofing: sectionData.data.item.waterproofingelements?.toString().replaceAll(',', ', '),
            visualreview: sectionData.data.item.visualreview,
            signsofleak: this.isYes(sectionData.data.item.visualsignofleak !== undefined ? sectionData.data.item.visualsignofleak : sectionData.data.item.visualsignsofleak) ? 'Yes' : 'No',
            furtherinvasive: this.isYes(sectionData.data.item.furtherinvasivereviewrequired) ? 'Yes' : 'No',
            conditionalassesment: sectionData.data.item.conditionalassessment === 'Futureinspection' ? 'Future Inspection' : sectionData.data.item.conditionalassessment,
            additionalconsiderations: sectionData.data.item.additionalconsiderations,
            eee: sectionData.data.item.eee,
            lbc: sectionData.data.item.lbc,
            awe: sectionData.data.item.awe,
            images: sectionData.data.item.images,
        };
    }
    getInvasiveData(invasiveSectionData) {
        return {
            furtherInvasiveRequired: invasiveSectionData.data.item.postinvasiverepairsrequired ? 'true' : 'false',
            invasiveDesc: invasiveSectionData.data.item.invasiveDescription,
            invasiveImages: invasiveSectionData.data.item.invasiveimages
        }
    }
    getConclusiveData(conclusiveSectionData) {

        return {
            conclusiveImages: conclusiveSectionData.data.item.conclusiveimages,
            propowneragreed: conclusiveSectionData.data.item.propowneragreed ? 'true' : 'false',
            additionalconsiderations: conclusiveSectionData.data.item.conclusiveconsiderations,
            conclusiveeee: conclusiveSectionData.data.item.eeeconclusive,
            conclusivelbc: conclusiveSectionData.data.item.lbcconclusive,
            conclusiveawe: conclusiveSectionData.data.item.aweconclusive,
            invasiverepairsinspectedandcompleted: conclusiveSectionData.data.item.invasiverepairsinspectedandcompleted ? 'true' : 'false'
        }
    }
    getTemplate(companyName, subprojectName) {
        if (companyName === 'Wicr') {
            if (subprojectName === '') {
                return fs.readFileSync('Wicr2AllData.docx');
            } else {
                return fs.readFileSync('WicrAllData.docx');
            }
        } else {
            if (subprojectName === '') {
                return fs.readFileSync('Deck2AllData.docx');
            } else {
                return fs.readFileSync('DeckAllData.docx');
            }
        }
    }
    getLocationType(location) {
        let locationType = '';
        if (location.data.item.type === 'buildinglocation') {
            locationType = "Building Common"
        }
        if (location.data.item.type === 'apartment') {
            locationType = "Apartment"
        }
        if (location.data.item.type === 'projectlocation') {
            locationType = "Project Common"
        }
        return locationType;
    }


    // The data stores yes-ish values inconsistently across mobile versions and the
    // web editor: true (boolean), "True", "true", "Yes", "yes". Comparing === 'True'
    // silently excluded real invasive sections (315 N. Swall unit 201, value "Yes")
    // and made Invasive reports come out empty (Aug 3). Accept every yes form.
    isYes(v) {
        return v === true || /^(true|yes)$/i.test(String(v || '').trim());
    }
    isSectionIncluded(reportType, section) {
        if (reportType === projectReportType.INVASIVEONLY || reportType === projectReportType.INVASIVEVISUAL) {
            return this.isYes(section.data.item.furtherinvasivereviewrequired);
        } else if (reportType === projectReportType.VISUALREPORT) {
            return true;
        }
    }
    async getWord(sectionId, template, sectionDocValues) {
        try {
            let data = {
                section: sectionDocValues
            }
            let additionalJsContext = {

                getChunks: async (imageArray, chunk_size = 4) => {
                    let index = 0;
                    const tempArray = [];
                    if (imageArray === undefined) {
                        return tempArray;
                    }
                    const arrayLength = imageArray.length;
                    for (index = 0; index < arrayLength; index += chunk_size) {
                        let myChunk = imageArray.slice(index, index + chunk_size);

                        tempArray.push(myChunk);
                    }
                    return tempArray;
                },
                tile: async (imageUrl) => {
                    // An image slot can be undefined (partial chunk of 4). It can
                    // also be a NON-STRING (null / object / number) when the
                    // inspection's image data is malformed - e.g. duplicated or
                    // partially-synced image entries from the mobile app.
                    // path.extname()/startsWith() THROW on a non-string, and with
                    // failFast:false that single error made docx-templates fail the
                    // WHOLE section, so the section vanished from the report (report
                    // came out as cover page only). Skip any bad/non-string/non-http
                    // entry instead - a missing image must never drop the section.
                    if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.startsWith('http')) {
                        return;
                    }
                    try {
                        const resp = await fetch(imageUrl);
                        if (resp.ok) {
                            const imagebuffer = resp.arrayBuffer
                                ? await resp.arrayBuffer()
                                : await resp.buffer();
                            //fix image rotation
                            try {
                                const {buffer} = await jo.rotate(Buffer.from(imagebuffer), {quality: 50});
                                return {height: 6.2, width: 4.85, data: buffer, extension: '.jpg'};
                            } catch (error) {
                                return {height: 6.2, width: 4.85, data: imagebuffer, extension: '.jpg'};
                            }
                        }
                    } catch (error) {
                        console.log('tile: skipping image that failed to load:', error && error.message);
                    }
                    return;
                },
            }
            const buffer = await ReportGenerationUtil.createDocReportWithParams(template, data, additionalJsContext);
            const filename = sectionId + '.docx';
            fs.writeFileSync(filename, buffer);
            return filename;
        } catch (error) {
            console.log(error);
            return "";
        }

    }


}

module.exports = new SectionWordGenerator();