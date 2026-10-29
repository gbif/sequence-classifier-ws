const { createClient } = require('redis');
const config = require('./config').DRAGONFLY;

const where = `dragonfly ${config.host}:${config.port}`;

// disableOfflineQueue makes commands fail at once while disconnected. The
// default queues them until the connection comes back, which turns a cache
// outage into requests that hang for as long as the outage lasts.
const client = createClient({
  socket: {
    host: config.host,
    port: config.port,
    connectTimeout: 5000,
    reconnectStrategy: retries => Math.min(100 * 2 ** retries, 30_000),
  },
  disableOfflineQueue: true,
});

// The client emits 'error' on every failed reconnect attempt, so log state
// transitions rather than every event.
let available = null;
client.on('ready', () => {
  if (available !== true) console.log(`Cache connected (${where})`);
  available = true;
});
client.on('error', err => {
  if (available !== false) console.error(`Cache unavailable (${where}): ${err.message}`);
  available = false;
});
// Resolves once the first connection is up (reconnectStrategy keeps retrying
// until then). Commands sent before that fail, so callers wait on this first.
const ready = client.connect().then(() => undefined, () => { /* reported by the 'error' listener */ });

const key = (namespace, id) => `${namespace}:${id}`;

// Resolves to one value per id, null where the key is absent or unreadable.
const getMany = async (namespace, ids) => {
  if (ids.length === 0) return [];
  const values = await client.mGet(ids.map(id => key(namespace, id)));
  return values.map(v => {
    if (v === null) return null;
    try { return JSON.parse(v); } catch { return null; }
  });
};

// entries: [id, value][]
const setMany = async (namespace, entries) => {
  if (entries.length === 0) return;
  await client.mSet(entries.map(([id, value]) => [key(namespace, id), JSON.stringify(value)]));
};

const disconnect = () => client.quit();

module.exports = { getMany, setMany, disconnect, ready };
