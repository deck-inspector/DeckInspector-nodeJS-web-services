const ObjectId = require('mongodb').ObjectId;
const mongo = require('../database/mongo');

module.exports = {
    addInvasiveSection: async (invasiveSection) => {
        return await mongo.InvasiveSections.insertOne(invasiveSection);
    },
    getAllInvasiveSections: async () => {
        return await mongo.InvasiveSections.find({}).limit(50).sort({"_id": -1}).toArray();
    },
    getInvasiveSectionById: async (id) => {
        return await mongo.InvasiveSections.findOne({ _id: new ObjectId(id) });
    },
    editInvasiveSection: async (id, newData) => {
        return await mongo.InvasiveSections.updateOne({ _id: new ObjectId(id) }, { $set: newData },{upsert:false});
    },
    deleteInvasiveSection: async (id) => {
        return await mongo.InvasiveSections.deleteOne({ _id: new ObjectId(id) });
    },
    getInvasiveSectionByParentId: async (parentId) => {
        return await mongo.InvasiveSections.find({ parentid: new ObjectId(parentId) }).toArray();
    },
    addImagesInInvasiveSection : async (invasiveSectionId, urls) => {
        return await mongo.InvasiveSections.updateOne({ _id: new ObjectId(invasiveSectionId) }, { $set: { invasiveimages: urls } });
    },
}