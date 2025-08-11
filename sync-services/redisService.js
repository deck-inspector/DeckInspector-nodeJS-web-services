
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
      await redisClient.xAdd(
      REDIS_STREAM_PREFIX + clientId,
      '*',
      { message: typeof message === 'string' ? message : JSON.stringify(message) }
      );
    }
  } catch (error) {
    console.error('Error queuing message for client:', clientId, error);
  }  
}

async function reliableBroadcastToAllClients(message) {
  const msgString = typeof message === 'string' ? message : JSON.stringify(message);
  const allClientIds = await getAllClientIds(); // Get all possible client IDs

  for (const clientId of allClientIds) {
    // Always queue in Redis for offline delivery
    await queueMessage(clientId, msgString);

    // If online, send immediately
    const ws = clients.get(clientId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(msgString);
    }
  }
}

// Helper: Deliver queued messages from Redis Stream to client
async function deliverQueuedMessages(clientId,companyIdentifier, ws) {
  const streamKey = REDIS_STREAM_PREFIX + clientId+ '.' + companyIdentifier;
  // Read all messages from the stream
  let lastId = '0-0';
  while (true) {
    const entries = await redisClient.xRead(
      [{ key: streamKey, id: lastId }],
      { COUNT: 10, BLOCK: 200 }
    );
    if (!entries || entries.length === 0) break;
    for (const entry of entries[0].messages) {
      const msg = entry.message.message;
      ws.send(msg);
      lastId = entry.id;
    }
  }
  // Delete the stream after delivery
  await redisClient.del(streamKey);
}

// Map to track connected clients: clientId -> ws
const clients = new Map();


function addClient(clientId,companyIdentifier, ws) {
    clients.set(`${clientId}.${companyIdentifier}`,ws);
}
function removeClient(clientId,companyIdentifier){
    clients.delete(`${clientId}.${companyIdentifier}`);
}
// Example broadcast function (call this in your handlers as needed)
async function broadcastToOthers(senderId,companyIdentifier, message) {
  for (const [clientId, ws] of clients.entries()) {
    if (clientId !== `${senderId}.${companyIdentifier}` && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    } else if (clientId !== `${senderId}.${companyIdentifier}`) {
      await queueMessage(clientId, message);
    }
  }
}
async function broadcastToAllClients( message) {
  try{
    const msgString = typeof message === 'string' ? message : JSON.stringify(message);
    for (const [clientId, ws] of clients.entries()) {
    if (clientId.includes(message.fullDocument.companyIdentifier) && ws.readyState === WebSocket.OPEN) {
      ws.send(msgString);
    } else if (clientId.includes(message.fullDocument.companyIdentifier)) {
      await queueMessage(clientId, msgString);
    }
  }
  }
  catch (error) {
    console.error('Error broadcasting to all clients:', error);
  }
  finally {
    console.log('Broadcast completed');
  }
}

module.exports={
    redisClient,
    connectRedis,
    broadcastToOthers,
    deliverQueuedMessages,
    addClient,
    removeClient,
    broadcastToAllClients,
    reliableBroadcastToAllClients
}
