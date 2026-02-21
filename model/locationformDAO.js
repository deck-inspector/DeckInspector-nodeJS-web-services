const { v4: uuidv4 } = require("uuid");
const couchbase = require("../database/couchbase");

// Helper function to get LocationsForms collection
async function getLocationFormsCollection() {
  return couchbase.LocationsForms;
}

// Helper function to execute N1QL queries
async function executeQuery(statement, parameters = []) {
  try {
    const cluster = couchbase.cluster;
    if (!cluster) {
      throw new Error("Cluster connection not initialized.");
    }
    const result = await cluster.query(statement, { parameters });
    return result.rows;
  } catch (error) {
    console.error("Query execution error:", error);
    throw error;
  }
}

module.exports = {
    addLocationForm: async (locationForm) => {
        try {
            const locationFormId = `locationform_${uuidv4()}`;
            const collection = await getLocationFormsCollection();
            const updatedQuestions = locationForm.questions.map(obj => ({ 
                ...obj, 
                "_id": `question_${uuidv4()}` 
            }));
            const locationFormDoc = {
                ...locationForm,
                questions: updatedQuestions,
                docType: "LocationForm",
                createdAt: new Date().toISOString(),
            };
            await collection.insert(locationFormId, locationFormDoc);
            return { insertedId: locationFormId, ok: 1 };
        } catch (error) {
            console.error("Error adding location form:", error);
            throw error;
        }
    },

    getAllLocationForms: async (companyIdentifier) => {
        try {
            const query = `SELECT META(lf).id as id, lf.* FROM \`${process.env.DB_BUCKET_NAME}\`.\`${process.env.DB_SCOPE_NAME || "inventory"}\`.LocationForm lf WHERE lf.companyIdentifier = $1 ORDER BY META(lf).id DESC`;
            const results = await executeQuery(query, [companyIdentifier]);
            return results.map(row => ({
                id: row.id,
                ...row
            }));
        } catch (error) {
            console.error("Error getting all location forms:", error);
            throw error;
        }
    },

    getLocationFormById: async (id) => {
        try {
            const collection = await getLocationFormsCollection();
            const doc = await collection.get(id);
            return doc.content;
        } catch (error) {
            if (error.code === 13) {
                return null;
            }
            console.error("Error getting location form by id:", error);
            throw error;
        }
    },

    editLocationForm: async (id, newData) => {
        try {
            const collection = await getLocationFormsCollection();
            const doc = await collection.get(id);
            const updatedQuestions = newData.questions.map(obj => ({ 
                ...obj, 
                "_id": obj._id || `question_${uuidv4()}` 
            }));
            const updatedDoc = { ...doc.content, questions: updatedQuestions };
            await collection.upsert(id, updatedDoc);
            return { ok: 1 };
        } catch (error) {
            console.error("Error editing location form:", error);
            throw error;
        }
    },

    deleteLocationForm: async (id) => {
        try {
            const collection = await getLocationFormsCollection();
            await collection.remove(id);
            return { ok: 1 };
        } catch (error) {
            console.error("Error deleting location form:", error);
            throw error;
        }
    },

    addQuestionsToLocationForm: async (locationFormId, questions) => {
        try {
            const collection = await getLocationFormsCollection();
            const doc = await collection.get(locationFormId);
            const updatedQuestions = questions.map(obj => ({ 
                ...obj, 
                "_id": `question_${uuidv4()}` 
            }));
            const existingQuestions = doc.content.questions || [];
            const allQuestions = [...existingQuestions, ...updatedQuestions];
            
            await collection.upsert(locationFormId, { ...doc.content, questions: allQuestions });
            return { ok: 1 };
        } catch (error) {
            console.error("Error adding questions to location form:", error);
            throw error;
        }
    },

    addQuestionToLocationForm: async (locationFormId, question) => {
        try {
            const collection = await getLocationFormsCollection();
            const doc = await collection.get(locationFormId);
            const questions = doc.content.questions || [];
            
            questions.push({
                ...question,
                "_id": question._id || `question_${uuidv4()}`
            });
            
            await collection.upsert(locationFormId, { ...doc.content, questions });
            return { ok: 1 };
        } catch (error) {
            console.error("Error adding question to location form:", error);
            throw error;
        }
    },

    removeQuestionFromLocationForm: async (locationFormId, questionId) => {
        try {
            const collection = await getLocationFormsCollection();
            const doc = await collection.get(locationFormId);
            const questions = doc.content.questions || [];
            
            const filteredQuestions = questions.filter(q => q._id !== questionId);
            
            await collection.upsert(locationFormId, { ...doc.content, questions: filteredQuestions });
            return { ok: 1 };
        } catch (error) {
            console.error("Error removing question from location form:", error);
            throw error;
        }
    },
    
    addUpdateQuestionInLocationForm: async (locationFormId, questionId, question) => {
        try {
            const collection = await getLocationFormsCollection();
            const doc = await collection.get(locationFormId);
            const questions = doc.content.questions || [];
            
            const index = questions.findIndex(q => q._id === questionId);
            if (index !== -1) {
                questions[index] = { ...questions[index], ...question, "_id": questionId };
            } else {
                questions.push({ ...question, "_id": questionId });
            }
            
            await collection.upsert(locationFormId, { ...doc.content, questions });
            return { ok: 1 };
        } catch (error) {
            console.error("Error updating question in location form:", error);
            throw error;
        }
    }
}
