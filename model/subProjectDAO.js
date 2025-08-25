"use strict";
var ObjectId = require('mongodb').ObjectId;
var mongo = require('../database/mongo');

module.exports = {
    insertSubProject: async (subproject) => {
        return await mongo.SubProjects.insertOne(subproject);
    },
    findSubProjectById: async (id) => {
        return await mongo.SubProjects.findOne({ _id: new ObjectId(id) });
    },
    editSubProject: async (id, newData) => {
        return await mongo.SubProjects.updateOne({ _id: new ObjectId(id) },{ $set: newData },{upsert:false});
    },
    deleteSubProject: async (id) => {
        return await mongo.SubProjects.deleteOne({ _id: new ObjectId(id) });
    },
    findSubProjectsByParentId: async (parentId) => {
        return await mongo.SubProjects.find({ parentid: new ObjectId(parentId) }).toArray();
    },
    updateImageUrl: async (id, imageUrl) => {
        return await mongo.SubProjects.updateOne({ _id: new ObjectId(id) }, { $set: { url: imageUrl } });
    },
    addSubProjectChild: async (subProjectId, childId,childData) => {
        return await mongo.SubProjects.updateOne(
            { 
                _id: new ObjectId(subProjectId) 
            },
            {
                $push: {
                    children: {
                        "_id": new ObjectId(childId),
                        ...childData
                    }
                }
            }
        );
    },

    removeSubProjectChild: async (subProjectId, childId) => {
        return await mongo.SubProjects.updateOne(
            { 
                _id: new ObjectId(subProjectId) 
            },
            { 
                $pull: {
                    children: {
                        "_id": new ObjectId(childId)
                    }
                } 
            }
        );
    },

    assignSubprojectToUser: async (subProjectId, username) => {
        //add the user to projet assigned to set as well.
        
        return await mongo.SubProjects.updateOne(
            { 
                _id: new ObjectId(subProjectId) 
            }, 
            { 
                $addToSet: { assignedto: username }
            }
        );
    },

    unassignSubprojectFromUser: async (subProjectId, username) => {
        return await mongo.SubProjects.updateOne(
            { 
                _id: new ObjectId(subProjectId) 
            }, 
            { 
                $pull: { assignedto: username }
            }
        );
    },

    addUpdateSubProjectChild : async  (subprojectId, childId, childData)=>{
        return await mongo.SubProjects.findOneAndUpdate({_id:ObjectId(subprojectId),"children._id":ObjectId(childId)},
        {
            $set:{
                "children.$":childData
            }
        },{upsert:true}
        );
    }
};
