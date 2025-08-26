const ObjectId = require('mongodb').ObjectId;
const mongo = require('../database/mongo');

module.exports = {
    addConclusiveSection: async (conclusiveSection) => {
        return await mongo.ConclusiveSections.insertOne(conclusiveSection);
    },
    getAllConclusiveSections: async () => {
        return await mongo.ConclusiveSections.find({}).limit(50).sort({"_id": -1}).toArray();
    },
    getConclusiveSectionById: async (id) => {     
        return await mongo.ConclusiveSections.findOne({ _id: new ObjectId(id) });
    },
    editConclusiveSection: async (id, newData) => {
        return await mongo.ConclusiveSections.updateOne({ _id: new ObjectId(id) }, { $set: newData },{upsert:false});
    },
    deleteConclusiveSection: async (id) => {
        return await mongo.ConclusiveSections.deleteOne({ _id: new ObjectId(id) });
    },
    getConclusiveSectionByParentId: async (parentId) => {
        return await mongo.ConclusiveSections.find({ parentid: new ObjectId(parentId) }).toArray();
    },
    addImagesInConclusiveSection : async (conclusiveSectionId, urls) => {
        return await mongo.ConclusiveSections.updateOne({ _id: new ObjectId(conclusiveSectionId) }, { $set: { conclusiveimages: urls } });
    },
}