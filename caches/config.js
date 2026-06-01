const CACHE = {
  dataBaseName: 'vsearch_testing',
};

const HBASE = {
  hosts: ['c8n3.gbif.org', 'c8n7.gbif.org', 'c8n2.gbif.org'],
  port: 31995,
  tableName: 'blast_cache',
};

const DRAGONFLY = {
  host: '127.0.0.1',
  port: 6379,
};

module.exports = { CACHE, HBASE, DRAGONFLY };
