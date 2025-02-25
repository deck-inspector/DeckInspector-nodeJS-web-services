const ObjectId = require('mongodb').ObjectId;
const mongo = require('../database/mongo');

module.exports = {
    addLocationForm: async (locationForm) => {
        var updatedQuestions=locationForm.questions.map(obj => ({ ...obj, "_id": new ObjectId() }));
        locationForm.questions=updatedQuestions;
        return await mongo.LocationsForms.insertOne(locationForm);
    },
    getAllLocationForms: async (companyIdentifier) => {
        return await mongo.LocationsForms.find({companyIdentifier:companyIdentifier}).sort({"_id": -1}).toArray();
    },
    getLocationFormById: async (id) => {
        return await mongo.LocationsForms.findOne({ _id:  ObjectId(id) });
    },
    editLocationForm: async (id, newData) => {
        var updatedQuestions=newData.questions.map(obj => ({ ...obj, "_id": new ObjectId(obj._id) }))
        return await mongo.LocationsForms.updateOne({ _id:  ObjectId(id) },
         { $set: { questions: updatedQuestions } }, { upsert: false });
    },
    deleteLocationForm: async (id) => {
        return await mongo.LocationsForms.deleteOne({ _id:  ObjectId(id) });
    },
    addQuestionsToLocationForm: async (locationFormId, questions) => {
        var updatedQuestions=questions.map(obj => ({ ...obj, "_id": new ObjectId() }))
        return await mongo.LocationsForms.updateOne({ _id:  ObjectId(locationFormId) }, {
            $push: { questions: {$each: updatedQuestions},
                // questions: {
                //     // "_id": new ObjectId(),
                //     ...questions
                // }
            }
        });
    },
    addQuestionToLocationForm: async (locationFormId, question) => {
        //var updatedQuestion={...questions, "_id": new ObjectId() };
        //question._id = ObjectId(question._id);
        return await mongo.LocationsForms.updateOne({ _id:  ObjectId(locationFormId) }, {
            $push: { 
                questions: {
                    
                    ...question
                }
            }
        });
    },
    removeQuestionFromLocationForm : async (locationFormId, questionId) => {
        return await mongo.LocationsForms.updateOne({ _id:  ObjectId(locationFormId) }, { $pull: { questions: { "_id":  ObjectId(questionId) } } });
    },
    
    addUpdateQuestionInLocationForm : async  (locationFormId, questionId, question)=>{
         question._id= ObjectId(questionId);
        return await mongo.LocationsForms.findOneAndUpdate({_id:ObjectId(locationFormId),"questions._id":ObjectId(questionId)},
        {
            $set:{
                //"_id":ObjectId(questionId),
                "questions.$":question
            }
        },{upsert:true}
        );
    }
}
