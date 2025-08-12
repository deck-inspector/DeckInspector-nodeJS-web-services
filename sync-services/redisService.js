
const redis = require('redis');
const { promisify } = require('util');
const WebSocket = require('ws');
const mongo = require('../database/mongo');
require('dotenv').config();

const redisHost = process.env.REDIS_HOST; 
const redisPassword = process.env.REDIS_KEY;
const redisClient = redis.createClient({
    url: `rediss://${redisHost}:6380`,
    password: redisPassword,
    socket: {
        tls: true,
        rejectUnauthorized: false 
    }
    });
async function connectRedis() {
  try {
    redisClient.on('error', (err) => console.error('Redis Client Error:', err));
    await redisClient.connect();
    console.log('✅ Connected to Redis');
  } catch (error) {
    console.error('❌ Redis connection failed:', error);
  }
}
async function getAllClientIds() {
  const users = await mongo.Users.find({}).toArray();
  return users.map(u => `${u.username}.${u.companyIdentifier}`);
}
const REDIS_STREAM_PREFIX = 'ws_offline_';

// Helper: Add message to Redis Stream for a client
async function queueMessage(clientId, message) {
  const companyIdentifier = message.companyIdentifier;
  try {
    if (clientId.includes(companyIdentifier)) {
      // xAdd returns the entry ID
      const entryId = await redisClient.xAdd(
        REDIS_STREAM_PREFIX + clientId,
        '*',
        { message: typeof message === 'string' ? message : JSON.stringify(message) }
      );
      return entryId;
    }
  } catch (error) {
    console.error('Error queuing message for client:', clientId, error);
  }
  return null;
}

async function reliableBroadcastToAllClients(message) {
  const msgString = typeof message === 'string' ? message : JSON.stringify(message);
  const allClientIds = await getAllClientIds(); // Get all possible client IDs

  for (const clientId of allClientIds) {
    // Always queue in Redis for offline delivery, get entryId
    const entryId = await queueMessage(clientId, message);

    // If online, send immediately with entryId for ack
    const ws = clients.get(clientId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      let msgObj;
      try {
        msgObj = typeof message === 'string' ? JSON.parse(message) : { ...message };
      } catch {
        msgObj = message;
      }
      msgObj.redisEntryId = entryId;
      ws.send(JSON.stringify(msgObj));
    }
  }
}

// Helper: Deliver queued messages from Redis Stream to client
async function deliverQueuedMessages(clientId,companyIdentifier, ws) {
  const streamKey = REDIS_STREAM_PREFIX + clientId + '.' + companyIdentifier;
  let lastId = '0-0';
  while (true) {
    const entries = await redisClient.xRead(
      [{ key: streamKey, id: lastId }],
      { COUNT: 10, BLOCK: 200 }
    );
    if (!entries || entries.length === 0) break;
    for (const entry of entries[0].messages) {
      let msgObj;
      try {
        msgObj = JSON.parse(entry.message.message);
      } catch {
        msgObj = entry.message.message;
      }
      msgObj.redisEntryId = entry.id;
      ws.send(JSON.stringify(msgObj));
      lastId = entry.id;
    }
  }
  // Do not delete the stream here; delete entries after ack
}

// Helper: Delete a specific entry from Redis stream after ack
async function deleteQueuedMessage(clientId, redisEntryId) {
  const streamKey = REDIS_STREAM_PREFIX + clientId;
  try {
    await redisClient.xDel(streamKey, redisEntryId);
    // Check if stream is empty, then delete the stream for cleanup
    const streamLen = await redisClient.xLen(streamKey);
    if (streamLen === 0) {
      await redisClient.del(streamKey);
      console.log(`Cleaned up empty Redis stream: ${streamKey}`);
    }
  } catch (error) {
    console.error('Error deleting message from Redis stream:', streamKey, redisEntryId, error);
  }
}

// Map to track connected clients: clientId -> ws
const clients = new Map();


function addClient(clientId,companyIdentifier, ws) {
    clients.set(`${clientId}.${companyIdentifier}`,ws);
}
function removeClient(clientId,companyIdentifier){
    clients.delete(`${clientId}.${companyIdentifier}`);
}
// async function broadcastToAllClients( message) {
//   try{
//     const msgString = typeof message === 'string' ? message : JSON.stringify(message);
//     for (const [clientId, ws] of clients.entries()) {
//     if (clientId.includes(message.fullDocument.companyIdentifier) && ws.readyState === WebSocket.OPEN) {
//       ws.send(msgString);
//     } else if (clientId.includes(message.fullDocument.companyIdentifier)) {
//       await queueMessage(clientId, msgString);
//     }
//   }
//   }
//   catch (error) {
//     console.error('Error broadcasting to all clients:', error);
//   }
//   finally {
//     console.log('Broadcast completed');
//   }
// }

module.exports={
    redisClient,
    connectRedis,
    deliverQueuedMessages,
    addClient,
    removeClient,
    deleteQueuedMessage,
    reliableBroadcastToAllClients
}
