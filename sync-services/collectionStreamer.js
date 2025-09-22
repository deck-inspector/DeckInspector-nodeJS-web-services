const mongo = require('../database/mongo');
const redisManager = require('./redisService');
const ObjectId = require('mongodb').ObjectId;
// Helper to start change stream for a collection
function watchCollection(collection, collectionName, resumeToken) {
  try {
    // If a resume token is provided, pass it to the change stream so MongoDB
    // will start from that point (replay changes happened after the token).
    const watchOptions = { fullDocument: 'updateLookup' };
    if (resumeToken) watchOptions.resumeAfter = resumeToken;
    const changeStream = collection.watch([], watchOptions);
    changeStream.on('change', async (change) => {
      // Prepare message for queue
      console.log(`collectionstreamer: Change detected in ${collectionName}`);
      const messageId = change.documentKey && change.documentKey._id ? String(change.documentKey._id) : null;
      const broadcastData = {
        collectionName,
        action: change.operationType, // 'insert', 'update', 'replace', 'delete'
        messageId,
        fullDocument: change.fullDocument || null,
        companyIdentifier: change.fullDocument ? change.fullDocument.companyIdentifier : null,
        updateDescription: change.updateDescription || null,
        servermessage: 'sync_with_server',
        timestamp: Date.now()
      };

      // Determine origin (sender) to exclude from broadcast
      let originClientId = null;
      try {
        if (change.operationType === 'delete') {
          // //fetch the document before deletion from db collection based on collectionName
          // switch (collectionName) {
          //   case 'visualSection':
          //     correctCollection = mongo.Sections;
          //     break;
          //   case 'project':
          //     correctCollection = mongo.Projects;
          //     break;
          //   case 'subProject':
          //     correctCollection = mongo.SubProjects;
          //     break;
          //   case 'location':
          //     correctCollection = mongo.Locations;
          //     break;
          //   case 'invasiveSection':
          //     correctCollection = mongo.InvasiveSections;
          //     break;
          //   case 'dynamicSection':
          //     correctCollection = mongo.DynamicSections;
          //     break;
          //   case 'conclusiveSection':
          //     correctCollection = mongo.ConclusiveSections;
          //     break;
          //   default:
          //     break;
          // }
          // const document = await correctCollection.findOne({ _id: ObjectId(messageId) });
          // broadcastData.companyIdentifier = document ? document.companyIdentifier : null;
          // // For deletes fullDocument is null; use pending origin stored at delete time
          originClientId = await redisManager.getAndClearPendingOrigin(collectionName, messageId);
        } else if (change.fullDocument && change.fullDocument.__lastOpClient) {
          originClientId = change.fullDocument.__lastOpClient;
        }
      } catch (err) {
        console.error('Error resolving origin for change event:', err);
      }
  console.log(`collectionstreamer: Broadcasting change in ${collectionName}, excluding origin: ${originClientId}`);
  // Add to Redis queue for offline clients and broadcast to others, excluding origin
  // Pass the change stream resume token so it can be persisted per-client (durable resume)
  await redisManager.reliableBroadcastToAllClients(broadcastData, originClientId, change._id);

    });
    changeStream.on('error', (err) => {
      console.error(`ChangeStream error for ${collectionName}:`, err);
    });
  } catch (err) {
    console.error(`Failed to watch collection ${collectionName}:`, err);
  }
}

// Start watching all relevant collections.
// If a `resumeTokens` object is provided it should be a map of collectionName -> resumeToken
// Example: { project: <resumeTokenObj>, visualSection: <token> }
function startAllCollectionStreams(resumeTokens = {}) {
  // Wait for mongo.Connect() to finish and collections to be available
  setTimeout(async () => {
    try {
      // Load most recently-updated resume tokens per collection from MongoDB ResumeTokens
      const resumeTokensFromMongo = {};
      if (mongo.ResumeTokens) {
        const docs = await mongo.ResumeTokens.find({}).toArray();
        for (const d of docs) {
          const updatedAt = d.updatedAt || new Date(0);
          const toks = d.tokens || {};
          for (const [coll, token] of Object.entries(toks)) {
            if (!resumeTokensFromMongo[coll] || (resumeTokensFromMongo[coll].updatedAt || new Date(0)) < updatedAt) {
              resumeTokensFromMongo[coll] = { token, updatedAt };
            }
          }
        }
      }

      // Helper to extract token value for a collection name
      const tokenFor = (collName) => (resumeTokensFromMongo[collName] ? resumeTokensFromMongo[collName].token : undefined);

      if (mongo.Projects) watchCollection(mongo.Projects, 'project', tokenFor('project'));
      if (mongo.SubProjects) watchCollection(mongo.SubProjects, 'subProject', tokenFor('subProject'));
      if (mongo.Locations) watchCollection(mongo.Locations, 'location', tokenFor('location'));
      if (mongo.Sections) watchCollection(mongo.Sections, 'visualSection', tokenFor('visualSection'));
      if (mongo.InvasiveSections) watchCollection(mongo.InvasiveSections, 'invasiveSection', tokenFor('invasiveSection'));
      if (mongo.DynamicSections) watchCollection(mongo.DynamicSections, 'dynamicSection', tokenFor('dynamicSection'));
      if (mongo.ConclusiveSections) watchCollection(mongo.ConclusiveSections, 'conclusiveSection', tokenFor('conclusiveSection'));
      // Add more collections as needed
      console.log('Started change streams for all collections (resumed from Mongo tokens where available).');
    } catch (err) {
      console.error('Failed to start collection streams with resume tokens from Mongo:', err);
      // Fallback: start without tokens
      if (mongo.Projects) watchCollection(mongo.Projects, 'project');
      if (mongo.SubProjects) watchCollection(mongo.SubProjects, 'subProject');
      if (mongo.Locations) watchCollection(mongo.Locations, 'location');
      if (mongo.Sections) watchCollection(mongo.Sections, 'visualSection');
      if (mongo.InvasiveSections) watchCollection(mongo.InvasiveSections, 'invasiveSection');
      if (mongo.DynamicSections) watchCollection(mongo.DynamicSections, 'dynamicSection');
      if (mongo.ConclusiveSections) watchCollection(mongo.ConclusiveSections, 'conclusiveSection');
    }
  }, 2000); // Delay to ensure mongo.Connect() is done
}

module.exports = {
  startAllCollectionStreams
};
