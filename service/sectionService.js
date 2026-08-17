"use strict";
const LocationDAO = require("../model/locationDAO");
const SectionDAO = require("../model/sectionDAO");
const InvasiveSectionService = require("../service/invasiveSectionService");
const ConclusiveSectionService = require("../service/conclusiveSectionService");
const InvasiveUtil = require("../service/invasiveUtil");
const ProjectDAO = require("../model/projectDAO");
const updateParentHelper = require("../service/updateParentHelper");
const RatingMapping  = require("../model/ratingMapping.js");
const { orderSectionsByIds, sortSectionsBySequence, childId } = require("../model/sectionOrder");


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
      // Screen order must match report order. The query has no ORDER BY, so
      // sort by the sequenceNo written by reorderSections. Lists that have
      // never been reordered carry no sequenceNo and come back untouched.
      return {
        success: true,
        sections: sortSectionsBySequence(result),
      };
    }
    // A parent (e.g. a location) with NO sections is a normal, valid state -
    // not an error. Returning code 401 here made the /getSectionsByParentId
    // endpoint respond HTTP 401, which the web app interprets as an expired
    // session and logs the user out (seen on single-level projects whose
    // location has no sections). Return an empty list instead.
    return {
      success: true,
      sections: [],
    };
  } catch (error) {
    return handleError(error);
  }
};

/**
 * Reorder the sections under one parent.
 *
 * Writes BOTH places order lives, so the unit screen and the generated report
 * agree: the parent document's sections array (report order) and the
 * sequenceNo on each section document (screen order).
 *
 * The parent-child relationship is taken from the sections themselves, never
 * from the client: only sections that actually belong to parentId are touched,
 * and the parent kind (location vs single-level project) is read off the
 * section's own parenttype. Empty parent is a valid state - returns an empty
 * list, never a 401 (that would log the user out).
 */
const reorderSections = async (parentId, orderedIds) => {
  try {
    if (!parentId) {
      return { code: 400, success: false, reason: "parentid is required" };
    }

    const rows = await SectionDAO.getSectionByParentId(parentId);
    if (!rows || rows.length === 0) {
      return { success: true, sections: [] };
    }

    // Only ids that really live under this parent survive.
    const owned = new Set(rows.map((row) => childId(row)).filter(Boolean));
    const requested = (Array.isArray(orderedIds) ? orderedIds : [])
      .map(String)
      .filter((id) => owned.has(id));

    if (requested.length === 0) {
      return { code: 400, success: false, reason: "No sections of this parent were named in the requested order" };
    }

    const ordered = orderSectionsByIds(rows, requested);
    // NB: named finalIds, not orderedIds - that is this function's parameter.
    const finalIds = ordered.map((section) => childId(section)).filter(Boolean);

    // Screen order first, then report order. Both are single N1QL statements,
    // so a failure surfaces to the caller instead of leaving the screen and the
    // report disagreeing — the earlier version swallowed sequenceNo errors and
    // a KV timeout produced exactly that split (Aug 17, seen in production).
    await SectionDAO.setSequenceNos(finalIds);

    const parentType = String(rows[0].parenttype || "location").toLowerCase();
    if (parentType === "project") {
      await ProjectDAO.reorderSingleLevelProjectChildren(parentId, finalIds);
    } else {
      await LocationDAO.reorderLocationChildren(parentId, finalIds);
    }

    return {
      success: true,
      sections: ordered.map((section) => childId(section)),
    };
  } catch (error) {
    return handleError(error);
  }
};

/**
 * Move a section to a different parent, keeping the parent-child relationship
 * correct on BOTH sides and keeping the section itself intact.
 *
 * The old /moveSection route deleted the section from its old parent and
 * re-added it as a NEW document. That had three problems:
 *   - deleteSectionPermanently also deletes the section's invasive and
 *     conclusive child records, so a "move" silently destroyed them;
 *   - the section got a new id, orphaning anything that referenced the old one;
 *   - it never updated parenttype, so moving between a unit and a single-level
 *     project left the section pointing at the wrong kind of parent and the
 *     report generator could not find it.
 *
 * This version edits the section in place (same id, same photos, same invasive
 * and conclusive children), then detaches the metadata entry from the old
 * parent and attaches it to the new one. The destination kind is verified
 * against the database rather than trusted from the client.
 */
const moveSectionToParent = async (sectionId, newParentId) => {
  try {
    if (!sectionId || !newParentId) {
      return { code: 400, success: false, reason: "sectionId and newParentId are required" };
    }

    // Couchbase KV get THROWS DocumentNotFoundError rather than returning
    // null, so every lookup here is wrapped: a missing document is a 404, not
    // a 500, and a missing Location must fall through to the Project check
    // (otherwise moving a section onto a single-level project would error).
    const missing = (error) =>
      error && (error.name === "DocumentNotFoundError" || error.code === 13);

    let section = null;
    try {
      section = await SectionDAO.getSectionById(sectionId);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (!section) {
      return { code: 404, success: false, reason: "Section not found" };
    }

    const oldParentId = section.parentid;
    const oldParentType = String(section.parenttype || "location").toLowerCase();

    if (String(oldParentId) === String(newParentId)) {
      return { success: true, sections: [sectionId], message: "Section is already under that parent" };
    }

    // Verify the destination exists and learn what kind of parent it is.
    let newParentType = null;
    let destinationLocation = null;
    try {
      destinationLocation = await LocationDAO.getLocationById(newParentId);
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (destinationLocation) {
      newParentType = "location";
    } else {
      let destinationProject = null;
      try {
        destinationProject = await ProjectDAO.getProjectById(newParentId);
      } catch (error) {
        if (!missing(error)) throw error;
      }
      if (destinationProject) newParentType = "project";
    }
    if (!newParentType) {
      return { code: 404, success: false, reason: "Destination parent not found" };
    }

    // 1. Point the section at its new parent - both halves of the relationship.
    await SectionDAO.editSection(sectionId, {
      parentid: newParentId,
      parenttype: newParentType,
    });

    // 2. Detach the metadata entry from the old parent.
    await updateParentHelper.removeSectionMetadataFromParent(sectionId, {
      parentid: oldParentId,
      parenttype: oldParentType,
    });

    // 3. Attach it under the new parent (appended at the end of its list).
    const movedSection = await SectionDAO.getSectionById(sectionId);
    await updateParentHelper.addSectionMetadataInParent(sectionId, movedSection);

    // 4. Re-evaluate invasive flags: the new hierarchy may need marking, and
    //    the old one may no longer have any invasive children.
    try {
      if (movedSection.furtherinvasivereviewrequired) {
        await InvasiveUtil.markSectionInvasive(sectionId);
      }
      if (oldParentType === "project") {
        await InvasiveUtil.markProjectNonInvasive(oldParentId);
      } else {
        await InvasiveUtil.markLocationNonInvasive(oldParentId);
      }
    } catch (error) {
      // Invasive re-marking is cosmetic on the cards - never fail a move for it.
      console.error("Could not re-evaluate invasive flags after move:", error);
    }

    return {
      success: true,
      sectionId: sectionId,
      parentid: newParentId,
      parenttype: newParentType,
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
  section.conditionalassessment = section.conditionalassessment != null ? capitalizeWords(section.conditionalassessment.toString()) : '';
  // Web-edited sections store display labels ("0-1 Years"), not the mobile
  // codes RatingMapping knows - pass unknown values through unchanged so
  // they show in the web modal and print on reports.
  section.eee = RatingMapping[section.eee] || section.eee;
  section.lbc = RatingMapping[section.lbc] || section.lbc;
  section.awe = RatingMapping[section.awe] || section.awe;

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
  reorderSections,
  moveSectionToParent,
  editSetion,
  addImageInSection,
  removeImageFromSection
};