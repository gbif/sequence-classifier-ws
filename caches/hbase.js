const config = require('./config').HBASE;
const thrift = require('thrift'),
  HBase = require('./gen-nodejs/HBase.js'),
  HBaseTypes = require('./gen-nodejs/Hbase_types.js');

// Each namespace is its own column in the 'ref' family, so results for
// different reference DB versions can sit side by side in one row.
const column = namespace => `ref:${namespace}`;

const where = `hbase ${config.host}:${config.port}/${config.tableName}`;
const MIN_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 30_000;

let connection = null;
let client = null;          // set only while connected, so calls fail fast during an outage
let reconnectDelay = MIN_RECONNECT_MS;
let reconnectTimer = null;
let shuttingDown = false;
let available = null;       // log transitions, not every failed attempt
let markReady;
// Resolves once the table is confirmed for the first time. Calls made before
// that fail, so callers wait on this first.
const ready = new Promise(resolve => { markReady = resolve; });

const markUnavailable = reason => {
  if (available !== false) console.error(`Cache unavailable (${where}): ${reason}`);
  available = false;
};

const scheduleReconnect = () => {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
};

function connect() {
  reconnectTimer = null;
  const conn = thrift.createConnection(config.host, config.port, {
    transport: thrift.TBufferedTransport,
    protocol: thrift.TBinaryProtocol,
    connect_timeout: 5000,
  });
  const pending = thrift.createClient(HBase, conn);
  connection = conn;

  conn.on('connect', () => {
    reconnectDelay = MIN_RECONNECT_MS;
    pending.getTableNames((err, tables) => {
      if (err) return markUnavailable(`getTableNames failed: ${err.message || err}`);
      if (!tables.some(t => t.toString() === config.tableName)) {
        return markUnavailable(`table ${config.tableName} not found`);
      }
      client = pending;
      markReady();
      if (available !== true) console.log(`Cache connected (${where})`);
      available = true;
    });
  });
  // Without a listener, thrift re-emits socket errors as an unhandled 'error'
  // event, which Node turns into an uncaught exception that kills the process.
  conn.on('error', err => markUnavailable(err.message));
  conn.on('close', () => {
    if (connection === conn) client = null;
    markUnavailable('connection closed');
    scheduleReconnect();
  });
}

const call = (method, ...args) => new Promise((resolve, reject) => {
  if (!client) return reject(new Error('HBase not connected'));
  client[method](...args, (err, data) => (err ? reject(err) : resolve(data)));
});

// Resolves to one value per id, null where the cell is absent or unreadable.
const getMany = async (namespace, ids) => {
  if (ids.length === 0) return [];
  const col = column(namespace);
  const rows = await call('getRowsWithColumns', config.tableName, ids, [col], null);
  const byRow = new Map(rows.map(r => [r.row.toString(), r.columns?.[col]?.value]));
  return ids.map(id => {
    const value = byRow.get(id);
    if (value === undefined || value === null) return null;
    try { return JSON.parse(value.toString()); } catch { return null; }
  });
};

// entries: [id, value][]
const setMany = async (namespace, entries) => {
  if (entries.length === 0) return;
  const col = column(namespace);
  const batches = entries.map(([id, value]) => new HBaseTypes.BatchMutation({
    row: id,
    mutations: [new HBaseTypes.Mutation({ column: col, value: JSON.stringify(value) })],
  }));
  await call('mutateRows', config.tableName, batches, null);
};

const disconnect = () => {
  shuttingDown = true;
  clearTimeout(reconnectTimer);
  connection?.end();
};

connect();
module.exports = { getMany, setMany, disconnect, ready };
