"use strict";

const LocationFormDAO = require("../model/locationformDAO");

const addLocationForm = async (locationForm) => {
  try {
    const result = await LocationFormDAO.addLocationForm(locationForm);
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
var getAllLocationForms = async function(companyIdentifier){
    try {
        const result = await LocationFormDAO.getAllLocationForms(companyIdentifier);
        if (result) {
          return {
            success: true,
            forms: result,
          };
        }
        return {
          code: 401,
          success: false,
          reason: "No forms found",
        };
      } catch (error) {
        return handleError(error);
      }
}
var getLocationFormById = async function (locationFormId) {
  try {
    const result = await LocationFormDAO.getLocationFormById(locationFormId);
    if (result) {
      return {
        success: true,
        location: result,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No Locationform found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

var deleteLocationFormPermanently = async function (locationFormId) {
  try {
    const location = await LocationFormDAO.getLocationFormById(locationFormId);
    if (location) {
      
      const result = await LocationFormDAO.deleteLocationForm(locationFormId);
      if (result.deletedCount === 1) {
        return {
          success: true,
        };
      }
    }
    return {
      code: 401,
      success: false,
      reason: "No Locationform found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

const editLocationForm = async (locationFormId, locationForm) => {
  try {
    const result = await LocationFormDAO.editLocationForm(locationFormId, locationForm);
    if (result.ok === 1) {
      
      return {
        success: true,
      };
    }
    return {
      code: 401,
      success: false,
      reason: "No locationform found with the given ID",
    };
  } catch (error) {
    return handleError(error);
  }
};

const addQuestionsInLoctionForm = async (locationFormId, questions)=>{
    try {
        const result = await LocationFormDAO.addQuestionsToLocationForm(locationFormId,questions);
        if (result.ok === 1) {
          
          return {
            success: true,
          };
        }
        return {
          code: 401,
          success: false,
          reason: "Failed to add question to the form.",
        };
      } catch (error) {
        return handleError(error);
      }
}
const addQuestionInLoctionForm = async (locationFormId, question)=>{
  try {
      const result = await LocationFormDAO.addQuestionToLocationForm(locationFormId,question);
      if (result.ok === 1) {
        
        return {
          success: true,
          
        };
      }
      return {
        code: 401,
        success: false,
        reason: "Failed to add question to the form.",
      };
    } catch (error) {
      return handleError(error);
    }
}

const removeQuestionFromLoctionForm = async (locationFormId, questionId)=>{
    try {
        const result = await LocationFormDAO.removeQuestionFromLocationForm(locationFormId,questionId);
        if (result.ok === 1) {
          
          return {
            success: true,
          };
        }
        return {
          code: 401,
          success: false,
          reason: "Failed to remove question from the form.",
        };
      } catch (error) {
        return handleError(error);
      }
}

const addUpdateQuestionInLocationForm = async(locationFormId,questionId,question)=>{
    try {
        const result = await LocationFormDAO.addUpdateQuestionInLocationForm(locationFormId,questionId,question);
        if (result.ok === 1) {
          
          return {
            success: true,
          };
        }
        return {
          code: 401,
          success: false,
          reason: "Failed to add/update question from the form.",
        };
      } catch (error) {
        return handleError(error);
      }
}

const handleError = (error) => {
  console.error("An error occurred:", error);
  return {
    code: 500,
    success: false,
    reason: `An error occurred: ${error.message}`,
  };
};

module.exports = {
    addLocationForm,
    getLocationFormById,
  deleteLocationFormPermanently,
  addUpdateQuestionInLocationForm,
  removeQuestionFromLoctionForm,
  addQuestionsInLoctionForm,
  editLocationForm,
  getAllLocationForms,
  addQuestionInLoctionForm
};