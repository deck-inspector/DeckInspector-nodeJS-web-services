
const redis = require('redis');
const { promisify } = require('util');

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
const REDIS_STREAM_PREFIX = 'ws_offline_';

// Helper: Add message to Redis Stream for a client
async function queueMessage(clientId, message) {
  await redisClient.xAdd(
    REDIS_STREAM_PREFIX + clientId,
    '*',
    { message: typeof message === 'string' ? message : JSON.stringify(message) }
  );
}

// Helper: Deliver queued messages from Redis Stream to client
async function deliverQueuedMessages(clientId, ws) {
  const streamKey = REDIS_STREAM_PREFIX + clientId;
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


function addClient(clientId, ws) {
    clients.set(clientId,ws);
}
function removeClient(clientId){
    clients.delete(clientId);
}
// Example broadcast function (call this in your handlers as needed)
async function broadcastToOthers(senderId, message) {
  for (const [clientId, ws] of clients.entries()) {
    if (clientId !== senderId && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    } else if (clientId !== senderId) {
      await queueMessage(clientId, message);
    }
  }
}

module.exports={
    redisClient,
    connectRedis,
    broadcastToOthers,
    deliverQueuedMessages,
    addClient,
    removeClient
}
