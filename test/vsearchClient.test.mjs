import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVsearchClient } from '../vsearchClient.mjs';

// One blast6out row for a query, against a minimal 23-field header.
const row = (id, identity = 99) =>
  `${id}\tREF${id}|ACC|Some species${'|'.repeat(20)}\t${identity}\t100\t1\t0\t1\t100\t1\t100\t1e-50\t180`;

const seqs = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, 'ACGT'.repeat(25)]));

const idsIn = body => body.split('\n').filter(l => l.startsWith('>')).map(l => l.slice(1));

const ok = text => ({ ok: true, status: 200, text: async () => text });

const client = (fetch, overrides = {}) => createVsearchClient({
  url: 'http://vsearch/search/batch', timeoutMs: 1000,
  batchSize: 10, concurrency: 2, retries: 2, fetch, ...overrides,
});

test('splits a large search into batchSize chunks and merges the results', async () => {
  const bodies = [];
  const fetch = async (url, { body }) => { bodies.push(body); return ok(idsIn(body).map(id => row(id)).join('\n')); };
  const result = await client(fetch).search(seqs(25));
  assert.deepEqual(bodies.map(b => idsIn(b).length), [10, 10, 5]);
  assert.equal(Object.keys(result).length, 25);
});

test('never has more than `concurrency` requests in flight', async () => {
  let inFlight = 0, peak = 0;
  const fetch = async (url, { body }) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    return ok(idsIn(body).map(id => row(id)).join('\n'));
  };
  await client(fetch, { batchSize: 1, concurrency: 3 }).search(seqs(12));
  assert.equal(peak, 3);
});

test('retries a chunk that fails with a 5xx, then succeeds', async () => {
  let calls = 0;
  const fetch = async (url, { body }) => {
    if (++calls === 1) return { ok: false, status: 503, text: async () => 'busy' };
    return ok(idsIn(body).map(id => row(id)).join('\n'));
  };
  const result = await client(fetch).search(seqs(1));
  assert.equal(calls, 2);
  assert.ok(result.s0);
});

test('does not retry a 4xx', async () => {
  let calls = 0;
  const fetch = async () => { calls++; return { ok: false, status: 400, text: async () => 'bad' }; };
  await assert.rejects(client(fetch).search(seqs(1)), /vsearch error 400/);
  assert.equal(calls, 1);
});

test('gives up after the configured retries', async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    throw new TypeError('fetch failed');
  };
  await assert.rejects(client(fetch, { retries: 1 }).search(seqs(1)), /fetch failed/);
  assert.equal(calls, 2);
});

test('does not retry a timeout, and preserves the error name', async () => {
  // vsearch keeps working on a request the client abandoned, so a retry
  // would only add load to a server that is already behind.
  let calls = 0;
  const fetch = async () => {
    calls++;
    throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  };
  await assert.rejects(client(fetch).search(seqs(1)), { name: 'TimeoutError' });
  assert.equal(calls, 1);
});
