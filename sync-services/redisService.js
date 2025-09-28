const redis = require('redis');
const { promisify } = require('util');
const WebSocket = require('ws');
const mongo = require('../database/mongo');
require('dotenv').config();

// Enable verbose Redis stream debug logging when DEBUG=1 or DEBUG=true
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

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
// Deep merge utility: merges b into a and returns a new object.
// - Plain objects are merged recursively.
// - Arrays of plain objects that contain an `_id` property are merged by `_id`.
// - Other arrays are replaced by the value from b (new wins).
function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && v.constructor === Object;
}

function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone);
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
    return out;
  }
  return v;
}

function deepMerge(a, b) {
  if (b === undefined) return deepClone(a);
  if (a === undefined || a === null) return deepClone(b);
  if (isPlainObject(a) && isPlainObject(b)) {
    const out = {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (k in a && k in b) out[k] = deepMerge(a[k], b[k]);
      else if (k in b) out[k] = deepClone(b[k]);
      else out[k] = deepClone(a[k]);
    }
    return out;
  }
  // both arrays -> try smart merge for arrays of objects with _id
  if (Array.isArray(a) && Array.isArray(b)) {
    // check if elements are objects with _id
    const aHasIds = a.every(x => isPlainObject(x) && (x._id !== undefined));
    const bHasIds = b.every(x => isPlainObject(x) && (x._id !== undefined));
    if (aHasIds && bHasIds) {
      const map = new Map();
      for (const item of a) map.set(String(item._id), deepClone(item));
      for (const item of b) {
        const id = String(item._id);
        if (map.has(id)) map.set(id, deepMerge(map.get(id), item));
        else map.set(id, deepClone(item));
      }
      // Preserve ordering from b, then any remaining from a that weren't in b
      const out = [];
      const seen = new Set();
      for (const item of b) { out.push(map.get(String(item._id))); seen.add(String(item._id)); }
      for (const item of a) {
        const id = String(item._id);
        if (!seen.has(id)) out.push(map.get(id));
      }
      return out;
    }
    // fallback: new array replaces old
    return deepClone(b);
  }
  // default: prefer b (new value)
  return deepClone(b);
}
// Merge two arrays into an ordered union. If elements are plain objects with _id,
// merge by _id (preserve order from b then remaining from a). Otherwise dedupe by primitive value.
function mergeArraysUnion(a, b) {
  if (!Array.isArray(a)) return deepClone(b || []);
  if (!Array.isArray(b)) return deepClone(a || []);
  const aObjs = a.every(x => isPlainObject(x) && x._id !== undefined);
  const bObjs = b.every(x => isPlainObject(x) && x._id !== undefined);
  if (aObjs && bObjs) {
    const map = new Map();
    for (const item of a) map.set(String(item._id), deepClone(item));
    for (const item of b) {
      const id = String(item._id);
      if (map.has(id)) map.set(id, deepMerge(map.get(id), item));
      else map.set(id, deepClone(item));
    }
    const out = [];
    const seen = new Set();
    for (const item of b) { out.push(map.get(String(item._id))); seen.add(String(item._id)); }
    for (const item of a) { const id = String(item._id); if (!seen.has(id)) out.push(map.get(id)); }
    return out;
  }
  // primitives: ordered union (b then remaining from a)
  const out = [];
  const seen = new Set();
  for (const v of b) { const key = String(v); if (!seen.has(key)) { out.push(v); seen.add(key); } }
  for (const v of a) { const key = String(v); if (!seen.has(key)) { out.push(v); seen.add(key); } }
  return out;
}
// Known image-array field name variants used across different socket handlers
const IMAGE_FIELD_CANDIDATES = [
  'images',
  'invasiveimages',
  'conclusiveimages',
  'visualimages',
  // camelCase variants just in case
  'invasiveImages',
  'conclusiveImages'
];

// Detect which image field key to use for merging: prefer existingMsg then incomingMsg, fallback to 'images'
function detectImageFieldKey(existingMsg, incomingMsg) {
  for (const k of IMAGE_FIELD_CANDIDATES) if (existingMsg && existingMsg[k]) return k;
  for (const k of IMAGE_FIELD_CANDIDATES) if (incomingMsg && incomingMsg[k]) return k;
  return 'images';
}
async function getAllClientIds() {
  const users = await mongo.Users.find({}).toArray();
  return users.map(u => `${u.username}.${u.companyIdentifier}`);
}
const REDIS_STREAM_PREFIX = 'ws_offline_';

// Helper: Add message to Redis Stream for a client (simple xAdd)
// now accepts optional resumeToken and collectionName so the stream entry
// carries the resumeToken until the client acks it.
async function queueMessage(clientId, message, senderClientId, resumeToken = null, collectionName = null) {
  try {
    let companyIdentifier = message && message.companyIdentifier;
    // If companyIdentifier not present on the message, try to derive it.
    if (!companyIdentifier) {
      // Primary: try to extract from senderClientId (usual case: "user.companyIdentifier")
      try {
        if (senderClientId && typeof senderClientId === 'string') {
          const firstDotIdx = senderClientId.indexOf('.');
          if (firstDotIdx !== -1) {
            companyIdentifier = senderClientId.substring(firstDotIdx + 1);
          } else if (senderClientId) {
            // senderClientId may be a special token like 'archive' or similar; don't trust it as company id
            companyIdentifier = null;
          }
        }
      } catch (e) {
        companyIdentifier = null;
      }
    }

    // If we still don't have companyIdentifier (e.g., replay with senderClientId='archive'),
    // try deriving it from the clientId which in our code is expected to be "username.companyIdentifier".
    if (!companyIdentifier && clientId && typeof clientId === 'string' && clientId.indexOf('.') !== -1) {
      const parts = clientId.split('.');
      // everything after the first dot is treated as companyIdentifier
      companyIdentifier = parts.slice(1).join('.');
      if (DEBUG) console.debug('[DEBUG][redisService] derived companyIdentifier from clientId fallback', { clientId, companyIdentifier });
    }

    if (!companyIdentifier || !String(clientId).includes(companyIdentifier)) {
      // Client doesn't belong to this company identifier or message missing companyIdentifier
      if (DEBUG) console.debug('[DEBUG][redisService] queueMessage skipping due to companyIdentifier mismatch', { clientId, senderClientId, companyIdentifier });
      return null;
    }

    const streamKey = REDIS_STREAM_PREFIX + clientId;
    const dedupeMapKey = `ws_dedupe:${streamKey}`;
    const payload = { message: typeof message === 'string' ? message : JSON.stringify(message) };
    // Attach collectionName if available
    const collName = collectionName || (message && message.collectionName) || null;
    if (collName) payload.collectionName = collName;
    // Store resumeToken as JSON so we can persist it only on ack
    if (resumeToken) {
      try {
        payload.resumeToken = typeof resumeToken === 'string' ? resumeToken : JSON.stringify(resumeToken);
      } catch (e) {
        payload.resumeToken = String(resumeToken);
      }
    }
    // Try to de-duplicate messages by messageId to avoid stream growth.
    let messageObj = null;
    try {
      messageObj = typeof message === 'string' ? JSON.parse(message) : message;
    } catch (_) { messageObj = null; }

    const messageId = messageObj && (messageObj.messageId || messageObj._id || (messageObj.fullDocument && messageObj.fullDocument._id)) ? String(messageObj.messageId || messageObj._id || messageObj.fullDocument._id) : null;
    const collFromMsg = collectionName || (messageObj && (messageObj.collectionName || (messageObj.fullDocument && messageObj.fullDocument.collectionName))) || null;
    const actionFromMsg = messageObj && (messageObj.action || null);

    // Use composite field so we only dedupe same messageId+collection+action
  const dedupeField = messageId && collFromMsg && actionFromMsg ? `${messageId}|${collFromMsg}|${actionFromMsg}` : null;
  const dedupeKeylessField = messageId && collFromMsg ? `${messageId}|${collFromMsg}` : null;

    let existingEntryId = null;
    if (messageId && dedupeField) {
      try {
        existingEntryId = await redisClient.hGet(dedupeMapKey, dedupeField);

        if (existingEntryId) {
          if (DEBUG) console.debug('[DEBUG][redisService] dedupe hit ->', { streamKey, dedupeField, existingEntryId });
          // Read existing entry payload
          try {
            const res = await redisClient.xRange(streamKey, existingEntryId, existingEntryId, { COUNT: 1 });
            if (res && res.length > 0) {
              const fields = res[0].messages || res[0][1];
              // Normalize fields depending on node-redis shape
              let existingPayloadRaw = null;
              if (Array.isArray(fields)) {
                // fields is array [field, value, field, value]
                for (let i = 0; i < fields.length; i += 2) {
                  if (fields[i] === 'message') existingPayloadRaw = fields[i+1];
                }
              } else if (fields && typeof fields === 'object') {
                existingPayloadRaw = fields.message || null;
              }
              if (existingPayloadRaw) {
                let existingMsgObj = null;
                try { existingMsgObj = JSON.parse(existingPayloadRaw); } catch (_) { existingMsgObj = null; }
                // Merge deeply so nested objects and arrays are handled correctly
                let mergedMsg = deepMerge(existingMsgObj || {}, messageObj || {});
                // If either existing or incoming message contains any known image-array field,
                // union-merge those arrays into a single chosen key to avoid duplicates.
                const hasImageFieldExisting = IMAGE_FIELD_CANDIDATES.some(k => existingMsgObj && existingMsgObj[k]);
                const hasImageFieldIncoming = IMAGE_FIELD_CANDIDATES.some(k => messageObj && messageObj[k]);
                if (hasImageFieldExisting || hasImageFieldIncoming) {
                  const targetKey = detectImageFieldKey(existingMsgObj, messageObj);
                  const existingImages = (existingMsgObj && (existingMsgObj[targetKey] || existingMsgObj.images)) || [];
                  const newImages = (messageObj && (messageObj[targetKey] || messageObj.images)) || [];
                  const mergedImages = mergeArraysUnion(existingImages, newImages);
                  mergedMsg[targetKey] = mergedImages;
                  for (const k of IMAGE_FIELD_CANDIDATES) if (k !== targetKey && mergedMsg[k]) delete mergedMsg[k];
                }
                payload.message = JSON.stringify(mergedMsg);
              }
            }
          } catch (err) {
            if (DEBUG) console.debug('[DEBUG][redisService] failed reading existing entry for dedupe', err);
          }

          // Add new entry and update map, then delete the old entry
          if (DEBUG) console.debug('[DEBUG][redisService] xAdd (replace) ->', { streamKey, payload });
          const entryId = await redisClient.xAdd(streamKey, '*', payload);
          if (DEBUG) console.debug('[DEBUG][redisService] xAdd returned entryId ->', { streamKey, entryId });
          try {
            // update action-specific dedupe field
            if (dedupeField) await redisClient.hSet(dedupeMapKey, dedupeField, entryId);
            // if this message is an update/addImages, also set a keyless mapping so future addImages can merge
            if (dedupeKeylessField && (actionFromMsg === 'update' || actionFromMsg === 'addImages')) {
              await redisClient.hSet(dedupeMapKey, dedupeKeylessField, entryId);
            }
            // Set TTL on dedupe map to avoid unbounded growth (7 days)
            try { await redisClient.expire(dedupeMapKey, 60 * 60 * 24 * 7); } catch (e) { /* best-effort */ }
          } catch (e) {
            if (DEBUG) console.debug('[DEBUG][redisService] failed updating dedupe map', e);
          }
          try {
            await redisClient.xDel(streamKey, existingEntryId);
          } catch (e) {
            if (DEBUG) console.debug('[DEBUG][redisService] failed deleting old stream entry during dedupe', e);
          }
          return entryId;
        }
      } catch (err) {
        if (DEBUG) console.debug('[DEBUG][redisService] dedupe check error', err);
      }
    }

    // No action-specific normalization required here — change stream messages
    // use operationType (insert/update/replace/delete) and include changed fields
    // in `fullDocument` or `updateDescription`. The merge logic above will detect
    // image-array fields and union-merge them when appropriate.

    if (DEBUG) console.debug('[DEBUG][redisService] xAdd ->', { streamKey, payload });
    const entryId = await redisClient.xAdd(streamKey, '*', payload);
    if (DEBUG) console.debug('[DEBUG][redisService] xAdd returned entryId ->', { streamKey, entryId });
    // record in dedupe map when composite dedupeField present
    if (messageId && dedupeField) {
      try {
        await redisClient.hSet(dedupeMapKey, dedupeField, entryId);
        // also set keyless mapping for update/addImages so addImages can merge later
        if (dedupeKeylessField && (actionFromMsg === 'update' || actionFromMsg === 'addImages')) {
          await redisClient.hSet(dedupeMapKey, dedupeKeylessField, entryId);
        }
        // Set TTL on dedupe map to avoid unbounded growth (7 days)
        try { await redisClient.expire(dedupeMapKey, 60 * 60 * 24 * 7); } catch (e) { /* best-effort */ }
      } catch (e) { if (DEBUG) console.debug('[DEBUG][redisService] failed setting dedupe map after xAdd', e); }
    }
    return entryId;
  } catch (error) {
    console.error('Error queuing message for client:', clientId, error);
    return null;
  }
}


async function reliableBroadcastToAllClients(message, senderClientId, resumeToken = null) {
  const msgString = typeof message === 'string' ? message : JSON.stringify(message);
  // Archive the message for fresh-device replays (fire-and-forget)
  archiveMessage(message).catch(err => {
    if (DEBUG) console.error('[DEBUG][redisService] archiveMessage failed', err);
  });
  let allClientIds = await getAllClientIds();
  // defensive: ensure senderClientId is string
  if (senderClientId == null) senderClientId = '';
  // Batch size for processing clients in chunks
  const BATCH_SIZE = 100;
  for (let i = 0; i < allClientIds.length; i += BATCH_SIZE) {
    const batch = allClientIds.slice(i, i + BATCH_SIZE);

    // Queue messages in Redis in parallel for the batch. Each promise resolves to
    // an object { clientId, entryId } so we can map results to clients deterministically
    // regardless of resolution order.
    const queuePromises = batch.map(clientId => {
      if (clientId === senderClientId) {
        // skip queuing for sender: keep shape consistent
        return Promise.resolve({ clientId, entryId: null });
      }
  // include resumeToken and collectionName in the stream entry so it can be
  // persisted only when the client acks the entry
  return queueMessage(clientId, message, senderClientId, resumeToken, message && message.collectionName)
        .then(entryId => ({ clientId, entryId }))
        .catch(err => {
          console.error('Error queuing message for client (caught in batch):', clientId, err);
          return { clientId, entryId: null };
        });
    });
    const settled = await Promise.allSettled(queuePromises);

    // Build a map clientId -> entryId from settled results (use clientId embedded in value)
    const clientEntryMap = new Map();
    for (let s = 0; s < settled.length; s++) {
      const res = settled[s];
      let cid = null;
      let entryId = null;
      if (res && res.status === 'fulfilled' && res.value) {
        cid = String(res.value.clientId).trim();
        entryId = res.value.entryId || null;
      } else if (res && res.status === 'rejected' && res.reason && res.reason.clientId) {
        // defensive: if a rejection carried clientId info
        cid = String(res.reason.clientId).trim();
        entryId = null;
      } else {
        // Fallback: use batch index to determine client id
        cid = String(batch[s]).trim();
        entryId = null;
      }
      clientEntryMap.set(cid, entryId);
    }

    // Send to online clients in parallel for the batch
    await Promise.allSettled(
      batch.map((clientId) => {
        if (clientId === senderClientId) return Promise.resolve();
        const ws = clients.get(clientId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          let msgObj;
          try {
            msgObj = typeof message === 'string' ? JSON.parse(message) : { ...message };
          } catch {
            msgObj = message;
          }
          // Lookup entryId from the map by clientId (safer than index-based)
          const entryId = clientEntryMap.get(String(clientId).trim());
          if (entryId) {
            msgObj.redisEntryId = entryId;
          }
          try {
            ws.send(JSON.stringify(msgObj));
            // NOTE: resume tokens are persisted only when the client ACKs the Redis
            // stream entry. See persistResumeTokenFromStreamEntry which is called by
            // the ack handler in the WebSocket entrypoint.
          } catch (err) {
            console.error('Failed sending immediate broadcast to client', clientId, err);
          }
        }
        return Promise.resolve();
      })
    );
  }
}

// Persist a copy of the message to MessageArchive for replay on fresh devices.
// Keep archive compact: store only necessary fields.
async function archiveMessage(message) {
  try {
    if (!mongo.MessageArchive) return;
    const doc = typeof message === 'string' ? JSON.parse(message) : { ...message };
    // Try to extract companyIdentifier robustly from known locations
    let companyIdentifier = doc.companyIdentifier || null;
    if (!companyIdentifier && doc.fullDocument && doc.fullDocument.companyIdentifier) companyIdentifier = doc.fullDocument.companyIdentifier;
    if (!companyIdentifier && doc.message && typeof doc.message === 'object' && doc.message.companyIdentifier) companyIdentifier = doc.message.companyIdentifier;
    const archiveDoc = {
      collectionName: doc.collectionName || null,
      action: doc.action || null,
      messageId: doc.messageId || null,
      fullDocument: doc.fullDocument || null,
      companyIdentifier: companyIdentifier || null,
      updateDescription: doc.updateDescription || null,
      servermessage: doc.servermessage || 'sync_with_server',
      timestamp: doc.timestamp || Date.now()
    };
    await mongo.MessageArchive.insertOne(archiveDoc);
  } catch (err) {
    console.error('Failed to write to MessageArchive', err);
  }
}

// Replay archived messages for a client. Query archive by companyIdentifier and
// stream results ordered by timestamp. Deliver to ws and wait for ack semantics
// handled by existing ack flow.
async function replayFromArchive(clientId, companyIdentifier, ws, opts = {}) {
  const compId = `${clientId}.${companyIdentifier}`;
  try {
    if (!mongo.MessageArchive) return;
    // Simple heuristic: replay last N messages for the company
    const N = opts.limit || 500;
    const cursor = mongo.MessageArchive.find({ companyIdentifier }).sort({ timestamp: 1 }).limit(N);
    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      const payload = {
        collectionName: doc.collectionName,
        action: doc.action,
        messageId: doc.messageId,
        fullDocument: doc.fullDocument,
        companyIdentifier: doc.companyIdentifier,
        updateDescription: doc.updateDescription,
        servermessage: doc.servermessage,
        timestamp: doc.timestamp
      };
      try {
        // Queue into redis stream for the client so ack semantics and resume token
        // persistence apply. Use senderClientId 'archive' for these entries.
        const entryId = await queueMessage(`${clientId}.${companyIdentifier}`, payload, 'archive', null, payload.collectionName);
        if (entryId && ws && ws.readyState === WebSocket.OPEN) {
          const msgToSend = { ...payload, redisEntryId: entryId };
          ws.send(JSON.stringify(msgToSend));
        }
      } catch (err) {
        console.error('Failed to queue/send archived message to client', compId, err);
        if (!ws || ws.readyState !== WebSocket.OPEN) break;
      }
    }
  } catch (err) {
    console.error('Error replaying archive for', compId, err);
  }
}

// Persist resume tokens in MongoDB (per-client per-collection) to survive Redis flushes
async function saveResumeToken(clientId, collectionName, resumeToken) {
  if (!clientId || !collectionName || !resumeToken) return;
  try {
    if (!mongo.ResumeTokens) {
      console.warn('Mongo ResumeTokens collection not available');
      return;
    }
    const filter = { clientId };
    const update = { $set: { [`tokens.${collectionName}`]: resumeToken, updatedAt: new Date() } };
    await mongo.ResumeTokens.updateOne(filter, update, { upsert: true });
  } catch (err) {
    console.error('Error saving resume token to MongoDB for', clientId, collectionName, err);
  }
}

async function getResumeToken(clientId, collectionName) {
  if (!clientId || !collectionName) return null;
  try {
    if (!mongo.ResumeTokens) return null;
    const doc = await mongo.ResumeTokens.findOne({ clientId }, { projection: { [`tokens.${collectionName}`]: 1 } });
    return doc && doc.tokens ? doc.tokens[collectionName] : null;
  } catch (err) {
    console.error('Error reading resume token from MongoDB for', clientId, collectionName, err);
    return null;
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
      console.log(`Deleting message ${redisEntryId} from Redis stream for client ${clientId}`);
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

// Read a specific stream entry and persist any resumeToken it carries to MongoDB
async function persistResumeTokenFromStreamEntry(clientId, entryId) {
  if (!clientId || !entryId) return null;
  const streamKey = REDIS_STREAM_PREFIX + clientId;
  try {
    // Read the single entry using XRANGE for the exact id
    const res = await redisClient.xRange(streamKey, entryId, entryId, { COUNT: 1 });
    if (!res || res.length === 0) {
      if (DEBUG) console.debug('[DEBUG][redisService] persistResumeTokenFromStreamEntry: no entry found', { streamKey, entryId });
      return null;
    }
    const entry = res[0];
    let obj = {};

    // Handle node-redis return formats. It may return either:
    // 1) [ id, [field, val, field, val...] ]
    // 2) { id: '...', message: { field: val, ... } }
    if (Array.isArray(entry)) {
      const id = entry[0];
      const fields = entry[1];
      if (Array.isArray(fields)) {
        for (let i = 0; i < fields.length; i += 2) {
          obj[fields[i]] = fields[i + 1];
        }
      } else if (typeof fields === 'object' && fields !== null) {
        obj = { ...fields };
      }
    } else if (entry && typeof entry === 'object') {
      // new-style object
      if (entry.message && typeof entry.message === 'object') {
        obj = { ...entry.message };
      } else {
        // fallback: try to merge any enumerable fields
        obj = { ...entry };
      }
    }

    if (DEBUG) console.debug('[DEBUG][redisService] persistResumeTokenFromStreamEntry parsed fields', { streamKey, entryId, obj });

    if (obj && obj.resumeToken && obj.collectionName) {
      let token = obj.resumeToken;
      try { token = JSON.parse(obj.resumeToken); } catch (_) { /* keep as string */ }
      await saveResumeToken(clientId, obj.collectionName, token);
      if (DEBUG) console.debug('[DEBUG][redisService] saved resume token for', { clientId, collectionName: obj.collectionName });
      return { clientId, collectionName: obj.collectionName, resumeToken: token };
    } else {
      if (DEBUG) console.debug('[DEBUG][redisService] persistResumeTokenFromStreamEntry: entry missing resumeToken or collectionName', { streamKey, entryId, obj });
    }
  } catch (err) {
    console.error('Error reading stream entry for resume token persistence', streamKey, entryId, err);
  }
  return null;
}

// Map to track connected clients: clientId -> ws
const clients = new Map();


function addClient(clientId,companyIdentifier, ws) {
    clients.set(`${clientId}.${companyIdentifier}`,ws);
}
function removeClient(clientId,companyIdentifier){
    clients.delete(`${clientId}.${companyIdentifier}`);
}

function isClientConnected(clientId) {
  try {
    return clients.has(String(clientId));
  } catch (err) {
    return false;
  }
}

//add  a local map to track pending origins
const pendingOrigins = new Map();

// Mark a pending origin for a document (used to identify sender for delete operations)
// markPendingOrigin: store an object { origin, companyIdentifier } keyed by collection and docId
// Backwards-compatible: callers can still pass (collectionName, docId, origin, ttlSeconds)
async function markPendingOrigin(collectionName, docId, originOrCompany, maybeCompanyOrTtl, ttlSeconds = 60) {
  try {
    let origin = null;
    let companyIdentifier = null;
    // Support both (collection, docId, origin, ttl) and (collection, docId, origin, companyIdentifier, ttl)
    if (arguments.length >= 4 && typeof maybeCompanyOrTtl === 'string') {
      origin = originOrCompany;
      companyIdentifier = maybeCompanyOrTtl;
    } else {
      origin = originOrCompany;
    }
    const key = `pending_origin:${collectionName}:${docId}`;
    pendingOrigins.set(key, { origin, companyIdentifier });
    return true;
  } catch (err) {
    console.error('Error marking pending origin in Redis:', collectionName, docId, err);
    return false;
  }
}

// Get and clear pending origin for a document
async function getAndClearPendingOrigin(collectionName, docId) {
  const key = `pending_origin:${collectionName}:${docId}`;
  const entry = pendingOrigins.get(key);
  pendingOrigins.delete(key);
  // return object { origin, companyIdentifier } for callers
  return entry || null;
}

// Debug helper: list all pending_origin keys and values (optimized)
async function listPendingOrigins() {
  try {
    console.log('Scanning pending_origin keys (optimized)...');
    if (!redisClient || !redisClient.isOpen) {
      console.warn('Redis client not open when listing pending origins, attempting to connect...');
      try { await redisClient.connect(); } catch (e) { console.error('Failed to connect Redis in listPendingOrigins', e); return; }
    }

    const iter = redisClient.scanIterator({ MATCH: 'pending_origin:*', COUNT: 1000 });
    const BATCH_SIZE = 500;
    let batch = [];
    let total = 0;

    const flushBatch = async (keys) => {
      if (!keys.length) return;
      // Use mGet to fetch many keys at once
      try {
        const results = await redisClient.mGet(keys);
        for (let i = 0; i < keys.length; i++) {
          console.log(keys[i], '->', results ? results[i] : null);
        }
      } catch (err) {
        console.error('Failed to mGet pending origin keys batch:', err);
      }
    };

    for await (const key of iter) {
      batch.push(key);
      total++;
      if (batch.length >= BATCH_SIZE) {
        await flushBatch(batch);
        batch = [];
      }
    }
    if (batch.length) await flushBatch(batch);
    console.log(`Done scanning pending_origin keys in Redis. Total keys: ${total}`);
  } catch (err) {
    console.error('Error listing pending origins:', err);
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
  persistResumeTokenFromStreamEntry,
  replayFromArchive,
  archiveMessage,
    markPendingOrigin,
    getAndClearPendingOrigin,
    listPendingOrigins
    ,isClientConnected
}



