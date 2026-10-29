import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatchCache } from '../matchCache.mjs';
import { withHeader, parseTargetHeader } from '../vsearchClient.mjs';

// In-memory backend with the same contract as caches/*.js.
function memoryCache() {
  const store = new Map();
  return {
    store,
    getMany: async (ns, ids) => ids.map(id => (store.has(`${ns}:${id}`) ? structuredClone(store.get(`${ns}:${id}`)) : null)),
    setMany: async (ns, entries) => { for (const [id, v] of entries) store.set(`${ns}:${id}`, structuredClone(v)); },
  };
}

const header = (ref, species) =>
  [ref, 'ACC1', species, '', '', '', '', '', 'SPECIES', '', '', '', '', 'unite', 'ITS',
   'Eukaryota', 'Fungi', '', '', '', '', '', species].join('|');

const hit = (ref, identity, qcovs = 100, species = 'Agaricus_bisporus') => {
  const h = header(ref, species);
  return withHeader({
    ...parseTargetHeader(h), identity, qcovs, alignmentLength: 100, mismatches: 0, gapOpenings: 0,
    qstart: 1, qend: 100, sstart: 1, send: 100, evalue: 1e-50, bitScore: 180,
  }, h);
};

// searchResult builds fresh hits on every call, as vsearch would.
const setup = (searchResult, overrides = {}) => {
  const cache = memoryCache();
  const searched = [];
  const mc = createMatchCache({
    cache, namespace: 'db:v1', topN: 3, timeoutMs: 100, refCacheSize: 100,
    search: async seqs => { searched.push(Object.keys(seqs)); return searchResult(seqs); },
    ...overrides,
  });
  return { mc, cache, searched };
};

test('a cached sequence is answered without searching, with the same matches', async () => {
  const { mc, searched } = setup(() => ({ s1: [hit('R1', 99), hit('R2', 100)] }));
  const first = await mc.query({ s1: 'ACGT' });
  const second = await mc.query({ s1: 'ACGT' });
  assert.equal(searched.length, 1);
  assert.deepEqual(second, first);
  assert.equal(second.s1[0].identity, 100);
  assert.equal(second.s1[0].species, 'Agaricus bisporus');
});

test('a sequence with no hits is cached as empty and not searched again', async () => {
  const { mc, searched } = setup(() => ({}));
  assert.deepEqual(await mc.query({ s1: 'ACGT' }), { s1: [] });
  assert.deepEqual(await mc.query({ s1: 'ACGT' }), { s1: [] });
  assert.equal(searched.length, 1);
});

test('only the top N hits are stored, ranked by identity then qcovs', async () => {
  const { mc, cache } = setup(() => ({
    s1: [hit('R1', 97), hit('R2', 99, 50), hit('R3', 99, 90), hit('R4', 100)],
  }));
  await mc.query({ s1: 'ACGT' });
  const stored = cache.store.get('db:v1:s1');
  assert.deepEqual(stored.map(e => e[0]), ['R4', 'R3', 'R2']);
});

test('reference headers are stored once, separately from sequence entries', async () => {
  const { mc, cache } = setup(seqs => Object.fromEntries(Object.keys(seqs).map(id => [id, [hit('R1', 99)]])));
  await mc.query({ s1: 'A', s2: 'C' });
  assert.equal(typeof cache.store.get('db:v1:ref:R1'), 'string');
  assert.ok(!JSON.stringify(cache.store.get('db:v1:s1')).includes('Agaricus'));
});

test('a cache entry whose reference header is missing is searched again', async () => {
  const { mc, cache, searched } = setup(() => ({ s1: [hit('R1', 99)] }));
  await mc.query({ s1: 'ACGT' });
  cache.store.delete('db:v1:ref:R1');
  // A fresh instance has no in-process copy of the header.
  const fresh = createMatchCache({
    cache, namespace: 'db:v1', topN: 3, timeoutMs: 100, refCacheSize: 100,
    search: async () => { searched.push('again'); return { s1: [hit('R1', 99)] }; },
  });
  const result = await fresh.query({ s1: 'ACGT' });
  assert.equal(searched.at(-1), 'again');
  assert.equal(result.s1[0].identity, 99);
});

test('a failing cache falls through to search instead of failing the query', async () => {
  const broken = { getMany: async () => { throw new Error('down'); }, setMany: async () => { throw new Error('down'); } };
  const { mc, searched } = setup(() => ({ s1: [hit('R1', 99)] }), { cache: broken });
  const result = await mc.query({ s1: 'ACGT' });
  assert.equal(searched.length, 1);
  assert.equal(result.s1[0].identity, 99);
});

test('a hanging cache times out and falls through to search', async () => {
  const hanging = { getMany: () => new Promise(() => {}), setMany: () => new Promise(() => {}) };
  const { mc, searched } = setup(() => ({ s1: [hit('R1', 99)] }), { cache: hanging, timeoutMs: 20 });
  const result = await mc.query({ s1: 'ACGT' });
  assert.equal(searched.length, 1);
  assert.equal(result.s1.length, 1);
});

test('strictWrites surfaces a failed cache write', async () => {
  const readOnly = { getMany: async (ns, ids) => ids.map(() => null), setMany: async () => { throw new Error('write failed'); } };
  const { mc } = setup(() => ({ s1: [hit('R1', 99)] }), { cache: readOnly, strictWrites: true });
  await assert.rejects(mc.query({ s1: 'ACGT' }), /write failed/);
});

test('entries from another namespace (reference DB version) are not read', async () => {
  const { mc, cache, searched } = setup(() => ({ s1: [hit('R1', 99)] }));
  await mc.query({ s1: 'ACGT' });
  const v2 = createMatchCache({
    cache, namespace: 'db:v2', topN: 3, timeoutMs: 100, refCacheSize: 100,
    search: async () => { searched.push('v2'); return {}; },
  });
  await v2.query({ s1: 'ACGT' });
  assert.equal(searched.at(-1), 'v2');
});
