/**
 * matchCache.mjs
 *
 * Read-through cache in front of vsearch, keyed by nucleotideSequenceID.
 *
 * Storage is compact so ~24M sequences fit comfortably:
 *   - a sequence entry holds only the top N hits as
 *     [refId, identity, alignmentLength, mismatches, gapOpenings,
 *      qstart, qend, sstart, send, evalue, bitScore, qcovs]
 *   - the 23-field reference header is stored once per reference, under
 *     `${namespace}:ref`, and kept in a bounded in-process map
 *   - a sequence with no hits is stored as [] so it is never searched again
 *
 * Results are deterministic for a given reference DB, so entries never expire;
 * the namespace carries the DB version (see caches/config.js).
 *
 * A cache that errors or answers slowly is treated as a miss for the whole
 * lookup — the request falls through to vsearch rather than failing.
 */

import { parseTargetHeader, withHeader } from './vsearchClient.mjs';

const STAT_FIELDS = [
  'identity', 'alignmentLength', 'mismatches', 'gapOpenings',
  'qstart', 'qend', 'sstart', 'send', 'evalue', 'bitScore', 'qcovs',
];

const byRank = (a, b) => (b.identity - a.identity) || (b.qcovs - a.qcovs);

// The reference id is the first header field.
const refIdOf = header => header.split('|', 1)[0];

export function encodeMatch(match) {
  return [refIdOf(match.header), ...STAT_FIELDS.map(f => match[f])];
}

export function decodeMatch(entry, header) {
  const match = withHeader(parseTargetHeader(header), header);
  STAT_FIELDS.forEach((f, i) => { match[f] = entry[i + 1]; });
  return match;
}

// Insertion-ordered Map used as an LRU: a read re-inserts the key at the end,
// and the oldest key is evicted once the map is full.
function createLru(max) {
  const map = new Map();
  return {
    get(key) {
      const value = map.get(key);
      if (value !== undefined) { map.delete(key); map.set(key, value); }
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      if (map.size > max) map.delete(map.keys().next().value);
    },
  };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`cache timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} opts
 * @param {object} opts.cache       backend with getMany(namespace, ids) / setMany(namespace, entries)
 * @param {Function} opts.search    async (seqs: {id → sequence}) → {id → matches}; ids with no hits absent
 * @param {string} opts.namespace   includes the reference DB version
 * @param {number} opts.topN        hits stored per sequence
 * @param {number} opts.timeoutMs   per cache round-trip
 * @param {number} opts.refCacheSize reference headers kept in memory
 * @param {boolean} [opts.strictWrites] throw when a cache write fails instead of
 *   ignoring it. The service ignores write failures; the backfill must not.
 */
export function createMatchCache({
  cache, search, namespace, topN, timeoutMs, refCacheSize, strictWrites = false,
}) {
  const refNamespace = `${namespace}:ref`;
  const headers = createLru(refCacheSize);
  const stats = { cacheHits: 0, cacheMisses: 0, cacheErrors: 0, searched: 0, noHits: 0 };

  const cacheCall = async (fn) => {
    try {
      return await withTimeout(fn(), timeoutMs);
    } catch (err) {
      stats.cacheErrors++;
      throw err;
    }
  };

  // Returns { id → decoded matches } for every id the cache can fully answer.
  async function lookup(ids) {
    let entries;
    try {
      entries = await cacheCall(() => cache.getMany(namespace, ids));
    } catch {
      return {};
    }

    const missingRefs = new Set();
    for (const entry of entries) {
      for (const hit of entry ?? []) {
        if (headers.get(hit[0]) === undefined) missingRefs.add(hit[0]);
      }
    }
    if (missingRefs.size > 0) {
      const refIds = [...missingRefs];
      try {
        const values = await cacheCall(() => cache.getMany(refNamespace, refIds));
        refIds.forEach((id, i) => { if (typeof values[i] === 'string') headers.set(id, values[i]); });
      } catch {
        return {};
      }
    }

    const found = {};
    ids.forEach((id, i) => {
      const entry = entries[i];
      if (!Array.isArray(entry)) return;
      // A hit whose reference header is gone (evicted, partial write) cannot be
      // rebuilt; treat the whole sequence as a miss so it is searched again.
      const decoded = [];
      for (const hit of entry) {
        const header = headers.get(hit[0]);
        if (header === undefined) return;
        decoded.push(decodeMatch(hit, header));
      }
      found[id] = decoded;
    });
    return found;
  }

  async function store(results) {
    const refEntries = new Map();
    const seqEntries = [];
    for (const [id, matches] of Object.entries(results)) {
      // A reference without an id cannot go in the dictionary; skip the
      // sequence rather than store a result that cannot be decoded.
      if (matches.some(m => !refIdOf(m.header))) continue;
      for (const m of matches) {
        const refId = refIdOf(m.header);
        if (headers.get(refId) === undefined) refEntries.set(refId, m.header);
      }
      seqEntries.push([id, matches.map(encodeMatch)]);
    }
    try {
      // Headers first, so a reader never sees a sequence entry whose
      // references are not stored yet.
      await cacheCall(() => cache.setMany(refNamespace, [...refEntries]));
      for (const [refId, header] of refEntries) headers.set(refId, header);
      await cacheCall(() => cache.setMany(namespace, seqEntries));
    } catch (err) {
      if (strictWrites) throw err;
    }
  }

  /**
   * @param {Object<string,string>} seqs  id → sequence
   * @returns {Promise<Object<string,object[]>>} id → top N matches, best first;
   *   [] for a sequence with no hits
   */
  async function query(seqs) {
    const ids = Object.keys(seqs);
    const result = await lookup(ids);

    const missIds = ids.filter(id => !(id in result));
    stats.cacheHits += ids.length - missIds.length;
    stats.cacheMisses += missIds.length;

    if (missIds.length > 0) {
      const fresh = await search(Object.fromEntries(missIds.map(id => [id, seqs[id]])));
      const toStore = {};
      for (const id of missIds) {
        const matches = (fresh[id] ?? []).sort(byRank).slice(0, topN);
        if (matches.length === 0) stats.noHits++;
        toStore[id] = matches;
        result[id] = matches;
      }
      stats.searched += missIds.length;
      await store(toStore);
    }
    return result;
  }

  return { query, stats };
}
