const ProjectDAO = require("../model/projectDAO");
const subProjectDAO = require("../model/subProjectDAO");
const LocationDAO = require("../model/locationDAO");
const ObjectId = require('mongodb').ObjectId;

const toSafeObjectId = (value) => {
  if (ObjectId.isValid(value)) {
    return new ObjectId(value);
  }
  return value;
};

const addLocationMetadataInParent = async (locationId, location) => {
  const locationDataInParent = {
    name: location.name,
    type: location.type,
    url: location.url,
    description: location.description,
    isInvasive: location.isInvasive ? location.isInvasive : false,
    sequenceNo: location.sequenceNo !== undefined ? location.sequenceNo : null,
  };

  if (location.parenttype == "subproject") {
    await subProjectDAO.addSubProjectChild(
      location.parentid,
      locationId,
      locationDataInParent
    );
    console.log(
      `Added Location with id ${locationId} in subProject id ${location.parentid} successfully`
    );
  } else if (location.parenttype == "project") {
    await ProjectDAO.addProjectChild(
      location.parentid,
      locationId,
      locationDataInParent
    );
    console.log(
      `Added Location with id ${locationId} in Project id ${location.parentid} successfully`
    );
  }
};

const removeLocationFromParent = async (locationId, location) => {
  if (location.parenttype == "subproject") {
    const result = await subProjectDAO.removeSubProjectChild(
      location.parentid,
      locationId
    );
    if (result.modifiedCount === 1) {
      console.log(
        `Removed Location with id ${locationId} in subProject id ${location.parentid} successfully`
      );
    }
  } else if (location.parenttype == "project") {
    const result = await ProjectDAO.removeProjectChild(
      location.parentid,
      locationId
    );
    if (result.modifiedCount === 1) {
      console.log(
        `Removed Location with id ${locationId} in Project id ${location.parentid} successfully`
      );
    }
  }
};
const addUpdateLocationMetadataInParent = async (locationId,location)=>{
  const locationDataInParent = {
    id: toSafeObjectId(locationId),
    name: location.name,
    type: location.type,
    url: location.url,
    description: location.description,
    isInvasive: location.isInvasive ? location.isInvasive : false,
    sequenceNo: location.sequenceNo !== undefined ? location.sequenceNo : null,
  };

  if (location.parenttype == "subproject") {
    await subProjectDAO.addUpdateSubProjectChild(
      location.parentid,
      locationId,
      locationDataInParent
    );
    console.log(
      `Added/edited Location metadata with id ${locationId} in subProject id ${location.parentid} successfully`
    );
  } else if (location.parenttype == "project") {
    await ProjectDAO.addUpdateProjectChild(
      location.parentid,
      locationId,
      locationDataInParent
    );
    console.log(
      `Added/edited Location metadata with id ${locationId} in Project id ${location.parentid} successfully`
    );
  }
};
const addSectionMetadataInParent = async (sectionId, section) => {
  const sectionDataInParent = {
    name: section.name,
    conditionalassessment: section.conditionalassessment,
    visualreview: section.visualreview,
    coverUrl: section.images ? section.images[0] : "",
    furtherinvasivereviewrequired: section.furtherinvasivereviewrequired,
    isInvasive: section.furtherinvasivereviewrequired,
    visualsignsofleak: section.visualsignsofleak,
    isuploading: false,
    count: section.images ? section.images.length : 0,
    sequenceNo: section.sequenceNo !== undefined ? section.sequenceNo : null,
  };

  if (section.parenttype == "project") {
    await ProjectDAO.addChildInSingleLevelProject(
      section.parentid,
      sectionId,
      sectionDataInParent
    );
    console.log(
      `Added section with id ${sectionId} in Project id ${section.parentid} for Single Level Project successfully`
    );
  } else {
    await LocationDAO.addLocationChild(
      section.parentid,
      sectionId,
      sectionDataInParent
    );
    console.log(
      `Added section with id ${sectionId} in location id ${section.parentid} successfully`
    );
  }
};

const removeSectionMetadataFromParent = async (sectionId, section) => {
  if (section.parenttype == "project") {
    await ProjectDAO.removeChildFromSingleLevelProject(
      section.parentid,
      sectionId
    );
    console.log(
      `Removed section with id ${sectionId} from Project id ${section.parentid} for Single Level Project successfully`
    );
  } else {
    await LocationDAO.removeLocationChild(section.parentid, sectionId);
    console.log(
      `Removed section with id ${sectionId} from location id ${section.parentid} successfully`
    );
  }
};
const addUpdateSectionMetadataInParent = async (sectionId,section)=>{
  try {
    const sectionDataInParent = {
      _id: toSafeObjectId(sectionId),
      name: section.name,
      conditionalassessment: section.conditionalassessment,
      visualreview: section.visualreview,
      coverUrl: section.images ? section.images[0] : "",
      furtherinvasivereviewrequired: section.furtherinvasivereviewrequired,
      isInvasive: section.furtherinvasivereviewrequired,
      visualsignsofleak: section.visualsignsofleak,
      isuploading: false,
      count: section.images.length,
      sequenceNo: section.sequenceNo !== undefined ? section.sequenceNo : null,
      editedAt: Date.now().toString()
    };
  
    if (section.parenttype == "project") {
      await ProjectDAO.addUpdateChildInSingleLevelProject (
        section.parentid,
        sectionId,
        sectionDataInParent
      );
      console.log(
        `Added/edited section with id ${sectionId} in Project id ${section.parentid} for Single Level Project successfully`
      );
    } else {
      await LocationDAO.addUpdateLocationChild(
        section.parentid,
        sectionId,
        sectionDataInParent
      );
      console.log(
        `Added/edited section with id ${sectionId} in location id ${section.parentid} successfully`
      );
    }
  } catch (error) {
    console.log(error);
  }
  
};

const addDynamicSectionMetadataInParent = async (sectionId, section) => {
  const sectionDataInParent = {
    name: section.name,
    coverUrl: section.images ? section.images[0] : "",
    furtherinvasivereviewrequired: section.furtherinvasivereviewrequired,
    visualsignsofleak: false,
    isInvasive: section.furtherinvasivereviewrequired,
    isuploading: false,
    count: section.images ? section.images.length : 0,
    sequenceNo: section.sequenceNo !== undefined ? section.sequenceNo : null,
  };

  if (section.parenttype == "project") {
    await ProjectDAO.addChildInSingleLevelProject(
      section.parentid,
      sectionId,
      sectionDataInParent
    );
    console.log(
      `Added section with id ${sectionId} in Project id ${section.parentid} for Single Level Project successfully`
    );
  } else {
    await LocationDAO.addLocationChild(
      section.parentid,
      sectionId,
      sectionDataInParent
    );
    console.log(
      `Added section with id ${sectionId} in location id ${section.parentid} successfully`
    );
  }
};

const removeDynamicSectionMetadataFromParent = async (sectionId, section) => {
  if (section.parenttype == "project") {
    await ProjectDAO.removeChildFromSingleLevelProject(
      section.parentid,
      sectionId
    );
    console.log(
      `Removed section with id ${sectionId} from Project id ${section.parentid} for Single Level Project successfully`
    );
  } else {
    await LocationDAO.removeLocationChild(section.parentid, sectionId);
    console.log(
      `Removed section with id ${sectionId} from location id ${section.parentid} successfully`
    );
  }
};
const addUpdateDynamicSectionMetadataInParent = async (sectionId,section)=>{
  const sectionDataInParent = {
    _id: toSafeObjectId(sectionId),
    name: section.name,
    coverUrl: section.images ? section.images[0] : "",
    furtherinvasivereviewrequired: section.furtherinvasivereviewrequired,
    visualsignsofleak: false,
    isInvasive: section.furtherinvasivereviewrequired,
    isuploading: false,
    count: section.images.length,
    sequenceNo: section.sequenceNo !== undefined ? section.sequenceNo : null,
  };

  if (section.parenttype == "project") {
    await ProjectDAO.addUpdateChildInSingleLevelProject (
      section.parentid,
      sectionId,
      sectionDataInParent
    );
    console.log(
      `Added section with id ${sectionId} in Project id ${section.parentid} for Single Level Project successfully`
    );
  } else {
    await LocationDAO.addUpdateLocationChild(
      section.parentid,
      sectionId,
      sectionDataInParent
    );
    console.log(
      `Added section with id ${sectionId} in location id ${section.parentid} successfully`
    );
  }
};

const addSubprojectMetaDataInProject = async (subProjectId, subProject) => {
  const subProjectDataInParent = {
    name: subProject.name,
    type: "subproject",
    url: subProject.url,
    description: subProject.description,
    isInvasive: subProject.isInvasive,
    sequenceNo: subProject.sequenceNo !== undefined ? subProject.sequenceNo : null,
  };
  await ProjectDAO.addProjectChild(
    subProject.parentid,
    subProjectId,
    subProjectDataInParent
  );
  console.log(
    `Added subproject with id ${subProjectId} in project id ${subProject.parentid} successfully`
  );
};

const addUpdateSubprojectMetaDataInProject = async (subProjectId, subProject) => {
  const subProjectDataInParent = {
    name: subProject.name,
    type: "subproject",
    url: subProject.url,
    description: subProject.description,
    isInvasive: subProject.isInvasive,
    sequenceNo: subProject.sequenceNo !== undefined ? subProject.sequenceNo : null,
  };
  await ProjectDAO.addUpdateProjectChild(
    subProject.parentid,
    subProjectId,
    subProjectDataInParent
  );
  console.log(
    `Added subproject with id ${subProjectId} in project id ${subProject.parentid} successfully`
  );
};

const removeSubprojectMetaDataInProject = async (subProjectId, subProject) => {
  await ProjectDAO.removeProjectChild(subProject.parentid, subProjectId);
  console.log(
    `Removed subproject with id ${subProjectId} in project successfully`
  );
};

const addUpdateSubProjectMetadataInProject = async (subProjectId, subProject) => {
  const subProjectDataInParent = {
    _id: toSafeObjectId(subProject._id),
    name: subProject.name,
    type: "subproject",
    url: subProject.url,
    description: subProject.description,
    isInvasive: subProject.isInvasive,
    sequenceNo: subProject.sequenceNo !== undefined ? subProject.sequenceNo : null,
  };

  await ProjectDAO.addUpdateProjectChild(subProject.parentid,subProjectId ,subProjectDataInParent);
  console.log(
    `updated subproject meta data with id ${subProjectId} in project successfully`
  );
}

module.exports = {
  addLocationMetadataInParent,
  removeLocationFromParent,
  addSectionMetadataInParent,
  removeSectionMetadataFromParent,
  addDynamicSectionMetadataInParent,
  removeDynamicSectionMetadataFromParent,
  addSubprojectMetaDataInProject,
  removeSubprojectMetaDataInProject,
  addUpdateLocationMetadataInParent,
  addUpdateDynamicSectionMetadataInParent,
  addUpdateSubProjectMetadataInProject,
  addUpdateSectionMetadataInParent
};