"use strict";
const { MongoClient } = require('mongodb');

//const uri = "mongodb+srv://deckDbAdmin:deckadmin91@cluster0.60uuo.mongodb.net/?retryWrites=true&w=majority";

const uri = "mongodb+srv://webappuser:EFQGiY42QWSvt8mB@deckinspectorcluster.g1uf6.mongodb.net/?retryWrites=true&w=majority";
const dbName = "deckSync";//"DeckInspectors";
function getDBConnectionString(){
    return uri;
}
var Connect = async function () {   

    const client = new MongoClient(uri);
    try {
        // Connect to the MongoDB cluster
        await client.connect();
       
        module.exports.Projects = client.db(dbName).collection('Project');
        module.exports.SubProjects = client.db(dbName).collection('SubProject');
        module.exports.Locations = client.db(dbName).collection('Location');
        module.exports.Sections = client.db(dbName).collection('VisualSection');
        module.exports.DynamicSections = client.db(dbName).collection('DynamicVisualSection');
        module.exports.Users = client.db(dbName).collection('Users');
        module.exports.ProjectDocuments = client.db(dbName).collection('ProjectDocuments');
        module.exports.ResumeTokens = client.db(dbName).collection('ResumeTokens');

        module.exports.ProjectReports = client.db(dbName).collection('ProjectReports');
        module.exports.InvasiveSections = client.db(dbName).collection('InvasiveSection');
        module.exports.ConclusiveSections = client.db(dbName).collection('ConclusiveSection');
        module.exports.ProjectReportHashCode = client.db(dbName).collection('ProjectReportHashCode');
        module.exports.Tenants = client.db(dbName).collection('Tenants');
        module.exports.SuperUsers = client.db(dbName).collection('SuperUsers');
        module.exports.ArchivedProjects = client.db(dbName).collection('ArchivedProjects');
        module.exports.DynamicVisualSection = client.db(dbName).collection('DynamicVisualSection');  
        module.exports.LocationsForms =  client.db(dbName).collection('LocationForm');

        console.log('Connected to MongoDB');
    } catch (e) {
        console.error(e);
    }     
    
};

module.exports = {
    Connect,
    GetConnectionString: getDBConnectionString
};
