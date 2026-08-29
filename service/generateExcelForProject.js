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
        await addMultiLevelRows(projectId, worksheet, headerMapping);
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

/**
 * Build the whole multi-level sheet.
 *
 * SPEED (David, Aug 29 2026: "the Excel sheet is not downloading" - it did, after
 * ~5 minutes). The old shape was one database round trip per building and per unit,
 * run one after another, AND the building pass ran TWICE (once for building
 * locations, once for apartments). On a project the size of Northridge (37
 * buildings, ~185 units) that is well over 300 sequential queries.
 *
 * Now: buildings once, every building's locations IN PARALLEL, and every unit's
 * sections in ONE bulk query (getSectionsByParentIds, 200 parents per call) - about
 * three round trips in total. The rows, their order and their contents are
 * unchanged: common locations first, then building locations, then apartments.
 */
async function addMultiLevelRows(projectId, worksheet, headerMapping) {
    const [projectLocationsRes, subProjectsRes] = await Promise.all([
        LocationService.getLocationsByParentId(projectId).catch(() => ({})),
        SubProjectService.getSubProjectByParentId(projectId).catch(() => ({})),
    ]);

    const commonLocations = projectLocationsRes.locations || [];
    const subProjects = subProjectsRes.subprojects || [];

    // every building's children, fetched together instead of one at a time
    const childrenPerBuilding = await Promise.all(
        subProjects.map((sp) =>
            LocationService.getLocationsByParentId(resolveId(sp)).catch(() => ({}))
        )
    );

    // one bulk query for the sections of every location on the sheet
    const locationIds = [];
    for (const loc of commonLocations) locationIds.push(String(resolveId(loc)));
    for (const res of childrenPerBuilding) {
        for (const loc of res.locations || []) locationIds.push(String(resolveId(loc)));
    }
    const sectionsByParent = await fetchSectionsByParents(locationIds);
    const sectionsOf = (loc) => sectionsByParent[String(resolveId(loc))] || [];

    // 1. the project's own common locations
    for (const location of commonLocations) {
        const commonLocationData = { cLoc: location.name };
        for (const section of sectionsOf(location)) {
            const finalData = {
                ...commonLocationData,
                cLocName: section.name,
                ...await generateSectionDataNew(section)
            };
            await addDataToWorksheet(finalData, worksheet, headerMapping);
        }
    }

    // 2. building locations, then 3. apartments - same order as before
    const passes = [
        { type: LocationType.BUILDINGLOCATION, locationKey: 'bldLoc', sectionNameKey: 'bldLocName' },
        { type: LocationType.APARTMENT, locationKey: 'bldApt', sectionNameKey: 'bldAptName' },
    ];
    for (const pass of passes) {
        for (let i = 0; i < subProjects.length; i++) {
            const subProject = subProjects[i];
            const buildingData = { bld: subProject.name };
            const locations = (childrenPerBuilding[i].locations || [])
                .filter((location) => location.type === pass.type);
            for (const location of locations) {
                for (const section of sectionsOf(location)) {
                    const finalData = {
                        ...buildingData,
                        [pass.locationKey]: location.name,
                        [pass.sectionNameKey]: section.name,
                        ...await generateSectionDataNew(section)
                    };
                    await addDataToWorksheet(finalData, worksheet, headerMapping);
                }
            }
        }
    }
}

/**
 * Sections for many parents, in chunks. Falls back to one-at-a-time only if the
 * bulk call is unavailable, so an older deployment still produces a sheet.
 */
async function fetchSectionsByParents(parentIds) {
    const ids = [...new Set((parentIds || []).filter(Boolean))];
    const byParent = {};
    if (!ids.length) return byParent;
    if (typeof SectionService.getSectionsByParentIds === 'function') {
        for (let i = 0; i < ids.length; i += 200) {
            const chunk = ids.slice(i, i + 200);
            const res = await SectionService.getSectionsByParentIds(chunk);
            Object.assign(byParent, (res && res.byParent) || {});
        }
        return byParent;
    }
    for (const id of ids) {
        const res = await SectionService.getSectionsByParentId(id);
        byParent[id] = (res && res.sections) || [];
    }
    return byParent;
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
