
const mongo = require('../database/mongo');
const redisManager = require('./redisService');

// Helper to start change stream for a collection
function watchCollection(collection, collectionName) {
  try {
    const changeStream = collection.watch([], { fullDocument: 'updateLookup' });
    changeStream.on('change', async (change) => {
      // Prepare message for queue
      console.log(`Change detected in ${collectionName}`);
    const broadcastData = {
        collectionName,
        action: change.operationType, // 'insert', 'update', 'replace', 'delete'
        messageId: change.documentKey && change.documentKey._id ? String(change.documentKey._id) : null,
        fullDocument: change.fullDocument || null,
        companyIdentifier: change.fullDocument ? change.fullDocument.companyIdentifier : null,
        updateDescription: change.updateDescription || null,
        servermessage: 'sync_with_server',
        timestamp: Date.now()
    };
      // Add to Redis queue for offline clients
      await redisManager.reliableBroadcastToAllClients(broadcastData);
    });
    changeStream.on('error', (err) => {
      console.error(`ChangeStream error for ${collectionName}:`, err);
    });
  } catch (err) {
    console.error(`Failed to watch collection ${collectionName}:`, err);
  }
}

// Start watching all relevant collections
function startAllCollectionStreams() {
  // Wait for mongo.Connect() to finish and collections to be available
  setTimeout(() => {
    if (mongo.Projects) watchCollection(mongo.Projects, 'project');
    if (mongo.SubProjects) watchCollection(mongo.SubProjects, 'subProject');
    if (mongo.Locations) watchCollection(mongo.Locations, 'location');
    if (mongo.Sections) watchCollection(mongo.Sections, 'visualSection');
    if (mongo.InvasiveSections) watchCollection(mongo.InvasiveSections, 'invasiveSection');
    if (mongo.DynamicSections) watchCollection(mongo.DynamicSections, 'dynamicSection');
    if (mongo.ConclusiveSections) watchCollection(mongo.ConclusiveSections, 'conclusiveSection');
    // Add more collections as needed
    console.log('Started change streams for all collections.');
  }, 2000); // Delay to ensure mongo.Connect() is done
}

module.exports = {
  startAllCollectionStreams
};
