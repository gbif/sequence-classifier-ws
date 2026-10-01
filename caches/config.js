const fs = require('fs');

// Returns the contents of ${name}_FILE if set, otherwise ${name}.
function fromEnv(name, fallback) {
  const filePath = process.env[`${name}_FILE`];
  if (filePath) {
    return fs.readFileSync(filePath, 'utf8').trim();
  }
  if (process.env[name] !== undefined) {
    return process.env[name];
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`Missing required config: ${name} (or ${name}_FILE)`);
}

const CACHE = {
  dataBaseName: fromEnv('DB_NAME','vsearch_testing'),
};

const HBASE = {
  hosts: JSON.parse(fromEnv('HBASE_URL',['127.0.0.1'])),
  port: Number(fromEnv('HBASE_PORT','9090')),
  tableName: fromEnv('HBASE_TABLE','blast_cache'),
};

const DRAGONFLY = {
  host: fromEnv('DRAGONFLY_URL','127.0.0.1'),
  port: Number(fromEnv('DRAGONFLY_PORT','6379')),
};

module.exports = { CACHE, HBASE, DRAGONFLY };
