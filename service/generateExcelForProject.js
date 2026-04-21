const ExcelJS = require('exceljs');
const path = require('path');
const SectionService = require('../service/sectionService');
const LocationService = require('../service/locationService');
const SubProjectService = require('../service/subProjectService');
const ProjectService = require('../service/projectService');
const LocationType = require('../model/locationType');

function resolveId(entity) {
    return entity.id || entity._id;
}

async function generateExcelForProject(projectId) {
    const { project: projectData } = await ProjectService.getProjectById(projectId);
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Sheet 1');

    worksheet.getCell('A1').value = projectData.name;
    const { headerMapping, headerRow } = await createHeaderRow(worksheet);
    styleHeaderRow(headerRow);

    if (projectData.projecttype === "singlelevel") {
        await addSectionsForSingleLevelProject(projectId, worksheet, headerMapping);
    } else {
        await addCommonLocations(projectId, worksheet, headerMapping);
        await addBuildingLocations(projectId, worksheet, headerMapping);
        await addBuildingApartments(projectId, worksheet, headerMapping);
    }
    const cleanedFileName = projectData.name.replace(/[^\w\s]/g, '');
    const excelFileName = path.join(__dirname, `${cleanedFileName}.xlsx`);
    await workbook.xlsx.writeFile(excelFileName);
    return excelFileName;
}

async function addDataToWorksheet(data, worksheet, headerMapping) {
    const rowData = Object.keys(headerMapping).map(key => data[key] || '');
    const flattenedRowData = rowData.map(item => Array.isArray(item) ? item.join(', ') : item);
    try {
        await worksheet.addRow(flattenedRowData);
    } catch (err) {
        console.error(err);
    }
}

async function addSectionsForSingleLevelProject(projectId, worksheet, headerMapping) {
    const { sections } = await SectionService.getSectionsByParentId(projectId);
    for (const section of sections || []) {
        const sectionData = {
            cLocName: section.name,
            ...await generateSectionDataNew(section)
        };
        await addDataToWorksheet(sectionData, worksheet, headerMapping);
    }
}

async function addDataByLocationType(projectId, worksheet, headerMapping, locationType, mapping) {
    const { subprojects } = await SubProjectService.getSubProjectByParentId(projectId);
    for (const subProject of subprojects || []) {
        const buildingData = { [mapping.buildingKey]: subProject.name };
        const { locations } = await LocationService.getLocationsByParentId(resolveId(subProject));
        const filteredLocations = (locations || []).filter(location => location.type === locationType);

        for (const location of filteredLocations) {
            const locationData = { [mapping.locationKey]: location.name };
            const { sections } = await SectionService.getSectionsByParentId(resolveId(location));
            for (const section of sections || []) {
                const sectionData = {
                    [mapping.sectionNameKey]: section.name,
                    ...await generateSectionDataNew(section)
                };
                const finalData = { ...buildingData, ...locationData, ...sectionData };
                await addDataToWorksheet(finalData, worksheet, headerMapping);
            }
        }
    }
}

async function addCommonLocations(projectId, worksheet, headerMapping) {
    const { locations } = await LocationService.getLocationsByParentId(projectId);
    for (const location of locations || []) {
        const commonLocationData = { 'cLoc': location.name };
        const { sections } = await SectionService.getSectionsByParentId(resolveId(location));
        for (const section of sections || []) {
            const sectionData = {
                'cLocName': section.name,
                ...await generateSectionDataNew(section)
            };
            const finalData = { ...commonLocationData, ...sectionData };
            await addDataToWorksheet(finalData, worksheet, headerMapping);
        }
    }
}

async function addBuildingLocations(projectId, worksheet, headerMapping) {
    const mapping = {
        buildingKey: 'bld',
        locationKey: 'bldLoc',
        sectionNameKey: 'bldLocName'
    };
    await addDataByLocationType(projectId, worksheet, headerMapping, LocationType.BUILDINGLOCATION, mapping);
}

async function addBuildingApartments(projectId, worksheet, headerMapping) {
    const mapping = {
        buildingKey: 'bld',
        locationKey: 'bldApt',
        sectionNameKey: 'bldAptName'
    };
    await addDataByLocationType(projectId, worksheet, headerMapping, LocationType.APARTMENT, mapping);
}

async function generateSectionDataNew(sectionData) {
    return {
        'unitUnavailable': sectionData.unitUnavailable ? 'Yes' : 'No',
        'extElem': sectionData.exteriorelements,
        'wpElem': sectionData.waterproofingelements,
        'visRev': sectionData.visualreview,
        'visLeaks': sectionData.visualsignsofleak,
        'furtherInvRev': sectionData.furtherinvasivereviewrequired,
        'condAssess': sectionData.conditionalassessment,
        'addConcerns': sectionData.additionalconsiderations,
        'lifeEEE': sectionData.eee,
        'lifeLBC': sectionData.lbc,
        'lifeAWE': sectionData.awe
    }
}

async function createHeaderRow(worksheet) {
    const headerMapping = {
        'cLoc': 'Common Location',
        'cLocName': 'Common Location Name',
        'bld': 'Building',
        'bldLoc': 'Building Location',
        'bldLocName': 'Building Location Name',
        'bldApt': 'Building Apartment',
        'bldAptName': 'Building Apartment Name',
        'unitUnavailable': 'Is Unit Unavailable',
        'extElem': 'Exterior Elements',
        'wpElem': 'Water Proofing Elements',
        'visRev': 'Visual Review',
        'visLeaks': 'Any Visual Signs of leaks',
        'furtherInvRev': 'Further Invasive Review Required',
        'condAssess': 'Condition Assessment',
        'addConcerns': 'Additional Considerations or Concerns',
        'lifeEEE': 'Life Expectancy (EEE)',
        'lifeLBC': 'Life Expectancy (LBC)',
        'lifeAWE': 'Life Expectancy (AWE)'
    };

    const headers = Object.values(headerMapping);
    const headerRow = await worksheet.addRow(headers);
    return { headerMapping, headerRow };
}

function styleHeaderRow(headerRow) {
    headerRow.eachCell((cell) => {
        cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF90EE90' }
        };
        cell.font = {
            color: { argb: 'FF000000' },
            bold: true
        };
        cell.border = {
            top: { style: 'thin', color: { argb: 'FF000000' } },
            left: { style: 'thin', color: { argb: 'FF000000' } },
            bottom: { style: 'thin', color: { argb: 'FF000000' } },
            right: { style: 'thin', color: { argb: 'FF000000' } }
        };
    });
}

module.exports = { generateExcelForProject };
