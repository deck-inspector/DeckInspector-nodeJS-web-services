"use strict";
const InvasiveSectionDAO = require("../model/invasiveSectionDAO");

const addInvasiveSection = async (invasiveSection) => {
  try {
    const result = await InvasiveSectionDAO.addInvasiveSection(invasiveSection);
    if (result.insertedId) {
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

const getInvasiveSectionById = async (invasiveSectionId) => {
  try {
    const result = await InvasiveSectionDAO.getInvasiveSectionById(
      invasiveSectionId
    );
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
      reason: "No Invasive Section found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

const editInvasiveSection = async (invasiveSectionId, invasiveSection) => {
  try {
    const result = await InvasiveSectionDAO.editInvasiveSection(
      invasiveSectionId,
      invasiveSection
    );
    if (result.ok === 1) {
      return {
        success: true,
        id: invasiveSectionId,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Invasive Section found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

const deleteInvasiveSectionPermanently = async (invasiveSectionId) => {
  try {
    const result = await InvasiveSectionDAO.deleteInvasiveSection(
      invasiveSectionId
    );
    if (result.deletedCount === 1) {
      return {
        success: true,
        id: invasiveSectionId,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Invasive Section found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

const getInvasiveSectionByParentId = async (parentId) => {
  try {
    const result = await InvasiveSectionDAO.getInvasiveSectionByParentId(
      parentId
    );
    if (result.length > 0) {
      for(let invasiveSection of result){
        transformData(invasiveSection);
      }
      return {
        success: true,
        sections: result,
      };
    }
    // A visual section with NO invasive record is a normal, valid state - not
    // an error. Returning code 401 here made the route respond HTTP 401, which
    // the web app treats as an expired session and logs the user out the
    // moment the Edit Inspection modal loads. Return an empty list instead
    // (same rule as sectionService.getSectionsByParentId).
    return {
      success: true,
      sections: [],
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

const transformData = (invasiveSection) => {  
  invasiveSection.postinvasiverepairsrequired = capitalizeWords(convertBooleanToString(invasiveSection.postinvasiverepairsrequired));
}

var convertBooleanToString = function (word) {
  if (typeof word !== 'boolean') {
      return; // this will return undefined by default
  }
  return word ? "Yes" : "No";
};



var capitalizeWords = function (word) {
  if (word) {
    var finalWord = word[0].toUpperCase() + word.slice(1);
    return finalWord;
  }
  return word;
};

module.exports = {
  addInvasiveSection,
  getInvasiveSectionById,
  getInvasiveSectionByParentId,
  deleteInvasiveSectionPermanently,
  editInvasiveSection,
};
