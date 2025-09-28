// projectDAO.js

const ObjectId = require('mongodb').ObjectId;
const mongo = require('../database/mongo');

module.exports = {
    addProject: async (project) => {
        return await mongo.Projects.insertOne(project);
    },
    getAllProjects: async () => {
        return await mongo.Projects.find({}).sort({"_id": -1}).toArray();
    },
    getProjectById: async (id) => {
        return await mongo.Projects.findOne({ _id: new ObjectId(id) }, {files: 0});
    },
    assignProjectToUser: async (id, username) => {
        return await mongo.Projects.updateOne({ _id: new ObjectId(id) }, { $addToSet: { assignedto: username }});
    },
    unassignUserFromProject: async (id, username) => {
        return await mongo.Projects.updateOne({ _id: new ObjectId(id) }, { $pull: { assignedto: username }});
    },

   getProjectsByNameCreatedOnIsCompletedAndDeleted: async function({name = null,createdon = null,iscomplete = false,isdeleted = false} = {}) {
    // Initialize an empty query object
        const query = {};

        // Populate the query object based on function arguments
        if (name !== null) { query.name = name; }
        if (createdon !== null) { query.createdon = createdon; }
        query.iscomplete = iscomplete;
        query.isdeleted = isdeleted;

        // Execute the query and return the result
        return await mongo.Projects.find(query)
            .sort({ editedat: -1 })
            .limit(25)
            .toArray();
 
    },

    editProject: async (projectId, newData) => {
        return await mongo.Projects.updateOne({ _id: new ObjectId(projectId) }, { $set: newData },{upsert:false});
    },
    editAddProject: async (projectId, newData) => {
        return await mongo.Projects.updateOne({ _id: new ObjectId(projectId) }, { $set: newData },{upsert:true});
    },

    updateProjectVisibilityStatus: async (id, isVisible) => {
        return await mongo.Projects.updateOne({ _id: new ObjectId(id) }, { $set: { isdeleted: isVisible } });
    },
    updateImageUrl: async (id, imageUrl) => {
        return await mongo.Projects.updateOne({ _id: new ObjectId(id) }, { $set: { url: imageUrl } });
    },  
    updateProjectStatus: async (id, isComplete) => {
        return await mongo.Projects.updateOne({ _id: new ObjectId(id) }, { $set: { iscomplete: isComplete } });
    },

    deleteProjectPermanently: async (id) => {
        return await mongo.Projects.deleteOne({ _id: new ObjectId(id) });
    },

    getAllFilesOfProject: async (id) => {
        return await mongo.Projects.findOne({ _id: new ObjectId(id) }, { files: 1 });
    },

    getProjectByAssignedToUserId: async (userId) => {
        return await mongo.Projects.find({ assignedto: { $in: [userId] } }).toArray();
    },

    addProjectChild: async (projectId, childId, childData) => {
        return await mongo.Projects.updateOne({ _id: new ObjectId(projectId) }, {
            $push: {
                children: {
                    "_id": new ObjectId(childId),
                    ...childData
                }
            }
        });
    },

    removeProjectChild: async (projectId, childId) => {
        //console.log(projectId,childId);
        return await mongo.Projects.updateOne({ _id: new ObjectId(projectId) }, {
            $pull: {
                children: {
                    "_id": new ObjectId(childId)
                }
            }
        });
    },
    
    addChildInSingleLevelProject: async (projectId, childId,childData) => {
        return await mongo.Projects.updateOne({ _id: new ObjectId(projectId) }, {
            $push: {
                sections: {
                    "_id": new ObjectId(childId),
                    ...childData
                }
            }
        });
    },

   removeChildFromSingleLevelProject: async (projectId, childId) => {
        return await mongo.Projects.updateOne({ _id: new ObjectId(projectId) }, {
            $pull: {
                sections: {
                    "_id": new ObjectId(childId)
                }
            }
        });
   },
   addUpdateChildInSingleLevelProject: async (projectId, childId,childData) => {
    const projId = new ObjectId(projectId);
    const secId = ObjectId(childId);
    const found = await mongo.Projects.findOne({ _id: projId, 'sections._id': secId });
    if (found) {
        return await mongo.Projects.updateOne({ _id: projId, 'sections._id': secId }, {
            $set: { 'sections.$': childData }
        }, { upsert: false });
    } else {
        // mark new child with _d prop and push
        const toPush = { _id: secId, ...childData};
        return await mongo.Projects.updateOne({ _id: projId }, {
            $push: { sections: toPush }
        });
    }
},
   addUpdateProjectChild : async  (projectId, childId, childData)=>{
    var found = await mongo.Projects.findOne({_id:ObjectId(projectId),"children._id":ObjectId(childId)});
    if(found){
        try {
            var result =  await mongo.Projects.findOneAndUpdate({_id:ObjectId(projectId),"children._id":ObjectId(childId)},
        {
            $set:{
                "children.$":childData
            }
        },{upsert:true}
        );
        return result;
        }
    catch (error) {
        
    }
}else{
    return await mongo.Projects.updateOne({ _id: new ObjectId(projectId) }, {
        $push: {
            children: {
                "_id": new ObjectId(childId),
                ...childData
            }
        }
    });
}
    
}    
};
