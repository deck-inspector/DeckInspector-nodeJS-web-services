const ObjectId = require('mongodb').ObjectId;
const mongo = require('../database/mongo');

module.exports = {
    addLocation: async (location) => {
        return await mongo.Locations.insertOne(location);
    },
    getAllLocations: async () => {
        return await mongo.Locations.find({}).limit(50).sort({"_id": -1}).toArray();
    },
    getLocationById: async (id) => {
        return await mongo.Locations.findOne({ _id: new ObjectId(id) });
    },
    editLocation: async (id, newData) => {
        return await mongo.Locations.updateOne({ _id: new ObjectId(id) }, { $set: newData },{upsert:false});
    },
    deleteLocation: async (id) => {
        return await mongo.Locations.deleteOne({ _id: new ObjectId(id) });
    },
    addLocationChild: async (locationId, childId, childData) => {
        return await mongo.Locations.updateOne({ _id: new ObjectId(locationId) }, {
            $push: {
                sections: {
                    "_id": new ObjectId(childId),
                    ...childData
                }
            }
        });
    },
    removeLocationChild : async (locationId, childId) => {
        return await mongo.Locations.updateOne({ _id: new ObjectId(locationId) }, { $pull: { sections: { "_id": new ObjectId(childId) } } });
    },
    getLocationByParentId: async (parentId) => {
        return await mongo.Locations.find({ parentid: new ObjectId(parentId) }).toArray();
    },
    addUpdateLocationChild : async  (locationId, childId, childData)=>{
        //make the same changes here as well.
        var found = await mongo.Locations.findOne({_id:ObjectId(locationId),"sections._id":ObjectId(childId)});
        if(found){
            try {
                var result =  await mongo.Locations.findOneAndUpdate({_id:ObjectId(locationId),"sections._id":ObjectId(childId)},
                {
                    $set:{
                        "sections.$":childData
                    }
                },{upsert:false}
                );
                return result;
            } catch (error) {}
        }else{
            return await mongo.Locations.updateOne({ _id: new ObjectId(locationId) }, {
                $push: {
                    sections: {
                        "_id": new ObjectId(childId),
                        ...childData
                    }
                }
            });
        }

    },

    updateSectionImageCount:async  (locationId, childId, childData)=>{
        return await mongo.Locations.findOneAndUpdate({_id:ObjectId(locationId),"sections._id":ObjectId(childId)},
        {
            $set:{
                "count":childData.count,
                "coverUrl":childData.coverUrl
            }
        },{upsert:true}
        );
    }
}
