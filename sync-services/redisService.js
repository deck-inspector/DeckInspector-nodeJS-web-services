const redis = require('redis');
const { promisify } = require('util');
const WebSocket = require('ws');
const mongo = require('../database/mongo');
//require('dotenv').config();

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


async function reliableBroadcastToAllClients(message, senderClientId) {
  const msgString = typeof message === 'string' ? message : JSON.stringify(message);
  let allClientIds = await getAllClientIds();
  // defensive: ensure senderClientId is string
  if (senderClientId == null) senderClientId = '';
  allClientIds = allClientIds.filter(id => id !== senderClientId);

  // Batch size for processing clients in chunks
  const BATCH_SIZE = 100;
  for (let i = 0; i < allClientIds.length; i += BATCH_SIZE) {
    const batch = allClientIds.slice(i, i + BATCH_SIZE);

    // Queue messages in Redis in parallel for the batch. Skip sender defensively.
    const queuePromises = batch.map(clientId => {
      if (clientId === senderClientId) {
        // skip queuing for sender
        return Promise.resolve(null);
      }
      return queueMessage(clientId, message);
    });
    const entryIds = await Promise.allSettled(queuePromises);

    // Send to online clients in parallel for the batch
    await Promise.allSettled(
      batch.map((clientId, idx) => {
        if (clientId === senderClientId) return Promise.resolve();
        const ws = clients.get(clientId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          let msgObj;
          try {
            msgObj = typeof message === 'string' ? JSON.parse(message) : { ...message };
          } catch {
            msgObj = message;
          }
          // Use entryId if queueMessage succeeded
          if (entryIds[idx] && entryIds[idx].status === 'fulfilled') {
            msgObj.redisEntryId = entryIds[idx].value;
          }
          try {
            ws.send(JSON.stringify(msgObj));
          } catch (err) {
            console.error('Failed sending immediate broadcast to client', clientId, err);
          }
        }
      })
    );
  }
}

// Helper: Deliver queued messages from Redis Stream to client
async function deliverQueuedMessages(clientId,companyIdentifier, ws) {
  const compId = `${clientId}.${companyIdentifier}`;
  const streamKey = REDIS_STREAM_PREFIX + compId;
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
      try {
        ws.send(JSON.stringify(msgObj));
      } catch (sendErr) {
        // If sending fails, log and continue; do not delete entry so it can be retried later
        console.error('Failed to send queued message to client, will retry later:', compId, entry.id, sendErr);
        continue;
      }
      // Do not delete the entry here — wait for client ack which will call deleteQueuedMessage
      lastId = entry.id;
    }
  }
  // Entries persist until client acknowledges them with an ack containing redisEntryId
}

// Helper: Delete a specific entry from Redis stream after ack
// Queue for pending delete requests
const deleteQueue = [];
let isProcessingDeleteQueue = false;

// Enqueue delete requests instead of processing immediately
async function deleteQueuedMessage(clientId, redisEntryId) {
  deleteQueue.push({ clientId, redisEntryId });
  processDeleteQueue();
}

// Process the delete queue sequentially
async function processDeleteQueue() {
  if (isProcessingDeleteQueue) return;
  isProcessingDeleteQueue = true;
  while (deleteQueue.length > 0) {
    const { clientId, redisEntryId } = deleteQueue.shift();
    const streamKey = REDIS_STREAM_PREFIX + clientId;
    try {
      await redisClient.xDel(streamKey, redisEntryId);
      const streamLen = await redisClient.xLen(streamKey);
      if (streamLen === 0) {
        await redisClient.del(streamKey);
        console.log(`Cleaned up empty Redis stream: ${streamKey}`);
      }
    } catch (error) {
      console.error('Error deleting message from Redis stream:', streamKey, redisEntryId, error);
    }
  }
  isProcessingDeleteQueue = false;
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

// Mark a pending origin for a document (used to identify sender for delete operations)
async function markPendingOrigin(collectionName, docId, origin, ttlSeconds = 60) {
  try {
    const key = `pending_origin:${collectionName}:${docId}`;
    await redisClient.set(key, origin, { EX: ttlSeconds });
  } catch (err) {
    console.error('Error marking pending origin in Redis:', collectionName, docId, err);
  }
}

// Get and clear pending origin for a document
async function getAndClearPendingOrigin(collectionName, docId) {
  const key = `pending_origin:${collectionName}:${docId}`;
  try {
    const val = await redisClient.get(key);
    if (val) {
      await redisClient.del(key);
    }
    return val;
  } catch (err) {
    console.error('Error reading/clearing pending origin in Redis:', collectionName, docId, err);
    return null;
  }
}

module.exports={
    redisClient,
    connectRedis,
    deliverQueuedMessages,
    addClient,
    removeClient,
    deleteQueuedMessage,
    reliableBroadcastToAllClients,
    markPendingOrigin,
    getAndClearPendingOrigin
}
