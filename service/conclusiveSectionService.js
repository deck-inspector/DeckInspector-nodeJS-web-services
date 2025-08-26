"use strict";
const ConclusiveSectionDAO = require('../model/conclusiveSectionDAO');
const RatingMapping  = require("../model/ratingMapping.js");

const addConclusiveSection = async (conclusiveSection) => {
    try {
        const result = await ConclusiveSectionDAO.addConclusiveSection(conclusiveSection);
        if (result.insertedId) {
            return {
                success: true,
                id: result.insertedId,
            };
        }
        return {
            code:500,
            success: false,
            reason: 'Insertion failed'
        };
    } catch (error) {
        return handleError(error);
    }
};

const getConclusiveSectionById = async (conclusiveSectionId) => {
    try {
        const result = await ConclusiveSectionDAO.getConclusiveSectionById(conclusiveSectionId);
        if (result) {
            transformData(result);
            return {
                success: true,
                section: result,
            };
        }
        return {
            code:401,
            success: false,
            reason: 'No Conclusive Section found with the given ID'
        };
    } catch (error) {
        return handleError(error);
    }
};

const editConclusiveSection = async (conclusiveSectionId, conclusiveSection) => {
    try {
        const result = await ConclusiveSectionDAO.editConclusiveSection(conclusiveSectionId, conclusiveSection);
        if (result.modifiedCount === 1) {
            return {
                success: true,
                id: conclusiveSectionId,
            };
        }
        return {
            code:401,
            success: false,
            reason: 'No Conclusive Section found with the given ID'
        };
    } catch (error) {
        return handleError(error);
    }
};


const deleteConclusiveSectionPermanently = async (conclusiveSectionId) => {
    try {
        const result = await ConclusiveSectionDAO.deleteConclusiveSection(conclusiveSectionId);
        if (result.deletedCount === 1) {
            return {
                success: true,
                id: conclusiveSectionId,
            };
        }
        return {
            code:401,
            success: false,
            reason: 'No Conclusibve Section found with the given ID'
        };
    } catch (error) {
        return handleError(error);
    }
};

const getConclusiveSectionByParentId = async (parentId)=>{
    try{
        const result = await ConclusiveSectionDAO.getConclusiveSectionByParentId(parentId);
        if (result.length > 0) {
            for(let conclusiveSection of result){
                transformData(conclusiveSection);
            }
            return {
                success: true,
                sections: result,
            };
        }
        return {
            code:401,
            success: false,
            reason: 'No Conclusive Section found with the given parent ID'
        };
    }
    catch(error){
        return handleError(error);
    }
}

const handleError = (error) => {
    console.error('An error occurred:', error);
    return {
        code:500,
        success: false,
        reason: `An error occurred: ${error.message}`
    };
};

  var transformData = function(conclusiveSection) {
    conclusiveSection.propowneragreed = capitalizeWords(convertBooleanToString(conclusiveSection.propowneragreed));
    conclusiveSection.invasiverepairsinspectedandcompleted = capitalizeWords(convertBooleanToString(conclusiveSection.invasiverepairsinspectedandcompleted));
    conclusiveSection.eeeconclusive = RatingMapping[conclusiveSection.eeeconclusive];
    conclusiveSection.lbcconclusive = RatingMapping[conclusiveSection.lbcconclusive];
    conclusiveSection.aweconclusive = RatingMapping[conclusiveSection.aweconclusive];
  };

  var convertBooleanToString = function (word) {
    if (typeof word !== 'boolean') {
        return; // this will return undefined by default
    }
    return word ? "Yes" : "No";
  };
  
  const addImagesInConclusiveSection = async (conclusiveSectionId, urls) => {
    try {
      const result = await ConclusiveSectionDAO.addImagesInConclusiveSection(
        conclusiveSectionId,
        urls
      );
      if (result.modifiedCount === 1) {
        return {
          success: true,
          id: conclusiveSectionId,
        };
      }
      return {
        code: 401,
        success: false,
        reason: "No conclusive Section found with the given ID",
      };
    } catch (error) {
      return handleError(error);
    }
  };
  
  var capitalizeWords = function (word) {
    if (word) {
      var finalWord = word[0].toUpperCase() + word.slice(1);
      return finalWord;
    }
    return word;
  };


module.exports = {
    getConclusiveSectionById,
    addConclusiveSection,
    addImagesInConclusiveSection,
    editConclusiveSection,
    getConclusiveSectionByParentId,
    deleteConclusiveSectionPermanently
};
