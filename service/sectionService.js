"use strict";
const LocationDAO = require("../model/locationDAO");
const SectionDAO = require("../model/sectionDAO");
const InvasiveSectionService = require("../service/invasiveSectionService");
const ConclusiveSectionService = require("../service/conclusiveSectionService");
const InvasiveUtil = require("../service/invasiveUtil");
const ProjectDAO = require("../model/projectDAO");
const updateParentHelper = require("../service/updateParentHelper");
const RatingMapping  = require("../model/ratingMapping.js");


const addSection = async (section) => {
  try {
    const result = await SectionDAO.addSection(section);
    if (result && result.insertedId) {
      await updateParentHelper.addSectionMetadataInParent(result.insertedId, section);
      //if section is invasive ,it will mark entire parent hierarchy as invasive
      await InvasiveUtil.markSectionInvasive(result.insertedId);
      return {
        success: true,
        id: result.insertedId,
      };
    }
    return {
      code: 500,
      success: false,
      reason: "Insertion failed",
    };
  } catch (error) {
    return handleError(error);
  }
};

var getSectionById = async function (sectionId) {
  try {
    const result = await SectionDAO.getSectionById(sectionId);
    if (result) {
      transformData(result);
      return {
        success: true,
        section: result,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Section found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

var deleteSectionPermanently = async function (sectionId) {
  try {
    //Delete Invasive Sections
    const invasiveSectionResult =
      await InvasiveSectionService.getInvasiveSectionByParentId(sectionId);
    if (invasiveSectionResult.sections) {
      for (let invasiveSection of invasiveSectionResult.sections) {
        await InvasiveSectionService.deleteInvasiveSectionPermanently(
          invasiveSection._id
        );
      }
    }

    //Delete Conclusive Sections
    const conclusiveSectionResult =
      await ConclusiveSectionService.deleteConclusiveSectionPermanently(
        sectionId
      );
    if (conclusiveSectionResult.sections) {
      for (let conclusiveSection of conclusiveSectionResult.sections) {
        await ConclusiveSectionService.deleteConclusiveSectionPermanently(
          conclusiveSection._id
        );
      }
    }

    const section = await SectionDAO.getSectionById(sectionId);
    const result = await SectionDAO.deleteSection(sectionId);

    //Mark parent as non-invasive if its all child are non invasive
    if(section.parenttype == "project")
    {
      await InvasiveUtil.markProjectNonInvasive(section.parentid);
    }
    else{
      await InvasiveUtil.markLocationNonInvasive(section.parentid);
    }
    //Update Parent for the section
    await updateParentHelper.removeSectionMetadataFromParent(sectionId, section);

    // Couchbase returns { ok: 1 } for delete
    if (result && result.ok === 1) {
      return {
        success: true,
        id: sectionId,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Section found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

var getSectionsByParentId = async function (parentId) {
  try {
    const result = await SectionDAO.getSectionByParentId(parentId);
    if (result && result.length > 0) {
      for (let section of result) {
        transformData(section);
      }
      return {
        success: true,
        sections: result,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Location found with the given parent ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

const editSetion = async (sectionId, section) => {
  try {
    const result = await SectionDAO.editSection(sectionId, section);
    // Couchbase returns { ok: 1 } for edit
    if (result && result.ok === 1) {
      const sectionFromDB = await SectionDAO.getSectionById(sectionId);
      await updateParentHelper.addUpdateSectionMetadataInParent(
        sectionId,
        sectionFromDB
      );
      //if section is invasive ,it will mark entire parent hierarchy as invasive
      if (sectionFromDB.furtherinvasivereviewrequired) {
        await InvasiveUtil.markSectionInvasive(sectionId);
      } else {
        if (sectionFromDB.parenttype == "project") {
          await InvasiveUtil.markProjectNonInvasive(section.parentid);
        }
        else {
          await InvasiveUtil.markLocationNonInvasive(section.parentid);
        }
      }
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Section found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

const addImageInSection = async (sectionId, imageUrl) => {
  try {
    const result = await SectionDAO.addImageInSection(sectionId, imageUrl);
    if (result && result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Section found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};


const removeImageFromSection = async (sectionId, imageUrl) => {
  try {
    const result = await SectionDAO.removeImageInSection(sectionId, imageUrl);
    if (result && result.ok === 1) {
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Section found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

const handleError = (error) => {
  console.error("An error occurred:", error);
  return {
    code: 500,
    success: false,
    reason: `An error occurred: ${error.message}`,
  };
};


var transformData = function(section) {
  section.visualreview = capitalizeWords(section.visualreview);
  section.visualsignsofleak = capitalizeWords(convertBooleanToString(section.visualsignsofleak));
  section.furtherinvasivereviewrequired = capitalizeWords(convertBooleanToString((section.furtherinvasivereviewrequired)));
  section.conditionalassessment = capitalizeWords(section.conditionalassessment.toString());
  section.eee = RatingMapping[section.eee];
  section.lbc = RatingMapping[section.lbc];
  section.awe = RatingMapping[section.awe];

};

var capitalizeWords = function (word) {
  if (word) {
    var finalWord = word[0].toUpperCase() + word.slice(1);
    return finalWord;
  }
  return word;
};

var convertBooleanToString = function (word) {
  if (typeof word !== 'boolean') {
      return; // this will return undefined by default
  }
  return word ? "Yes" : "No";
};


module.exports = {
  addSection,
  getSectionById,
  deleteSectionPermanently,
  getSectionsByParentId,
  editSetion,
  addImageInSection,
  removeImageFromSection
};