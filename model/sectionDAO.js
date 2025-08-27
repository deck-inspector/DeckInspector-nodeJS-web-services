const ObjectId = require('mongodb').ObjectId;
const mongo = require('../database/mongo');

module.exports = {
    addSection: async (section) => {
        return await mongo.Sections.insertOne(section);
    },
    getAllSections: async () => {
        return await mongo.Sections.find({}).limit(50).sort({"_id": -1}).toArray();
    },
    getSectionById: async (id) => {
        return await mongo.Sections.findOne({ _id: new ObjectId(id) });
    },
    editSection: async (id, newData) => {
        return await mongo.Sections.updateOne({ _id: new ObjectId(id) }, { $set: newData },{upsert:false});
    },
    deleteSection: async (id) => {
        return await mongo.Sections.deleteOne({ _id: new ObjectId(id) });
    },
    getSectionByParentId: async (parentId) => {
        return await mongo.Sections.find({ parentid: new ObjectId(parentId) }).toArray();
    },
    addImageInSection : async (sectionId, url) => {
        await mongo.Sections.updateOne({ _id: new ObjectId(sectionId) }, { $push: { images: url } });
    },
    addMultipleImagesInSection : async (sectionId, urls) => {
        return await mongo.Sections.updateOne({ _id: new ObjectId(sectionId) }, { $set: { images: urls } });
    },
    removeImageInSection :  async (sectionId, url) => {
        await mongo.Sections.updateOne({ _id: new ObjectId(sectionId) }, { $pull: { images: url } });
    }
}


