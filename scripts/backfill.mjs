#!/usr/bin/env node
/**
 * backfill.mjs — fill the cache for a list of distinct sequences.
 *
 * Classifying billions of occurrences only needs one vsearch search per
 * distinct sequence. This script runs those searches up front, so at indexing
 * time the service answers almost everything from the cache and only calls
 * vsearch for sequences that are genuinely new.
 *
 *   node scripts/backfill.mjs sequences.tsv[.gz] [options]
 *
 * Input: one sequence per line, `nucleotideSequenceID<TAB>sequence`.
 *
 * Options:
 *   --chunk N       sequences per cache lookup / write round (default 1000)
 *   --parallel N    chunks in flight (default 4); vsearch load is capped
 *                   separately by VSEARCH_CONCURRENCY
 *   --limit N       stop after N input lines (benchmarking)
 *   --total N       expected line count, for the ETA
 *   --checkpoint P  progress file (default <input>.checkpoint)
 *   --failures P    sequences whose chunk failed, same TSV format
 *                   (default <input>.failed.tsv); rerun the script on it
 *
 * Resuming: the checkpoint records how many input lines are fully done, so a
 * rerun after a crash or Ctrl-C continues from there. Sequences already in the
 * cache are skipped anyway, so overlap after a resume costs only cache reads.
 *
 * Benchmark vsearch alone (nothing cached, nothing written):
 *   CACHE=none node scripts/backfill.mjs sample.tsv --limit 10000
 *
 * Uses the same environment variables as the service (VSEARCH_URL, CACHE,
 * DB_NAME, REFERENCE_DB_VERSION, VSEARCH_BATCH_SIZE, VSEARCH_CONCURRENCY, ...).
 */

import { createReadStream, existsSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { createVsearchClient } from '../vsearchClient.mjs';
import { createMatchCache } from '../matchCache.mjs';
import { extractSequences } from '../assignTaxonomyToOccurrence.mjs';

const _require = createRequire(import.meta.url);
const cache = _require('../caches/index.js');
const CACHE_CONFIG = _require('../caches/config.js').CACHE;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    chunk:      { type: 'string', default: '1000' },
    parallel:   { type: 'string', default: '4' },
    limit:      { type: 'string' },
    total:      { type: 'string' },
    checkpoint: { type: 'string' },
    failures:   { type: 'string' },
  },
});

const input = positionals[0];
if (!input) {
  console.error('usage: node scripts/backfill.mjs sequences.tsv[.gz] [--chunk N] [--parallel N] [--limit N] [--total N]');
  process.exit(2);
}

const CHUNK = parseInt(opts.chunk);
const PARALLEL = parseInt(opts.parallel);
const LIMIT = opts.limit ? parseInt(opts.limit) : Infinity;
const TOTAL = opts.total ? parseInt(opts.total) : null;
const CHECKPOINT = opts.checkpoint ?? `${input}.checkpoint`;
const FAILURES = opts.failures ?? `${input}.failed.tsv`;

const int = (name, fallback) => {
  const n = parseInt(process.env[name]);
  return Number.isNaN(n) ? fallback : n;
};

const vsearch = createVsearchClient({
  url:         process.env.VSEARCH_URL || 'http://127.0.0.1:8000/search/batch',
  timeoutMs:   int('VSEARCH_TIMEOUT_MS', 120_000),
  batchSize:   int('VSEARCH_BATCH_SIZE', 25),
  concurrency: int('VSEARCH_CONCURRENCY', 4),
  retries:     int('VSEARCH_RETRIES', 2),
});

const matchCache = createMatchCache({
  cache,
  search:       seqs => vsearch.search(seqs),
  namespace:    CACHE_CONFIG.namespace,
  topN:         int('CACHE_TOP_N', 10),
  timeoutMs:    int('CACHE_TIMEOUT_MS', 5000),
  refCacheSize: int('REF_CACHE_SIZE', 2_000_000),
  // A lost write here is lost work; fail the chunk so it lands in --failures.
  strictWrites: true,
});

// ── checkpoint ────────────────────────────────────────────────────────────────

const startLine = existsSync(CHECKPOINT)
  ? JSON.parse(readFileSync(CHECKPOINT, 'utf8')).linesDone
  : 0;

// Chunks finish out of order; the checkpoint only advances past a line once
// every chunk before it has finished too.
let linesDone = startLine;
const finished = new Map(); // chunk start line → chunk end line

function markFinished(start, end) {
  finished.set(start, end);
  while (finished.has(linesDone)) {
    const next = finished.get(linesDone);
    finished.delete(linesDone);
    linesDone = next;
  }
  writeFileSync(`${CHECKPOINT}.tmp`, JSON.stringify({ linesDone, updated: new Date().toISOString() }));
  renameSync(`${CHECKPOINT}.tmp`, CHECKPOINT);
}

// ── progress ──────────────────────────────────────────────────────────────────

const counts = { sequences: 0, invalid: 0, failed: 0 };
const startedAt = Date.now();

function report() {
  const secs = (Date.now() - startedAt) / 1000;
  const rate = counts.sequences / secs;
  const s = matchCache.stats;
  const searchRate = s.searched / secs;
  let line = `${counts.sequences} done (${rate.toFixed(1)}/s) | cache hits ${s.cacheHits}` +
    ` | searched ${s.searched} (${searchRate.toFixed(1)}/s), no hits ${s.noHits}` +
    ` | invalid ${counts.invalid} | failed ${counts.failed} | cache errors ${s.cacheErrors}`;
  if (TOTAL && rate > 0) {
    const remaining = TOTAL - startLine - counts.sequences - counts.invalid;
    line += ` | ETA ${(remaining / rate / 3600).toFixed(1)} h`;
  }
  console.log(line);
}

const progressTimer = setInterval(report, 10_000);

// ── main loop ─────────────────────────────────────────────────────────────────

let stopping = false;
process.on('SIGINT', () => {
  if (stopping) process.exit(1);
  stopping = true;
  console.log('Stopping after in-flight chunks finish (Ctrl-C again to abort)…');
});

async function runChunk(start, end, rows) {
  const seqs = Object.fromEntries(rows);
  try {
    await matchCache.query(seqs);
    counts.sequences += rows.length;
  } catch (err) {
    counts.failed += rows.length;
    console.error(`Chunk at line ${start} failed (${rows.length} sequences): ${err.message}`);
    appendFileSync(FAILURES, rows.map(([id, seq]) => `${id}\t${seq}\n`).join(''));
  }
  markFinished(start, end);
}

// Without a cache every lookup misses and every write fails, so there is
// nothing to backfill into; stop rather than fail every chunk.
const cacheReady = await Promise.race([
  cache.ready.then(() => true),
  new Promise(resolve => setTimeout(resolve, 30_000, false)),
]);
if (!cacheReady) {
  console.error(`Cache ${process.env.CACHE || 'dragonfly'} not connected after 30 s; aborting`);
  process.exit(1);
}

// Splits a byte stream into lines. Used instead of readline, whose async
// iterator throws ERR_USE_AFTER_CLOSE (Node 24) when the loop body awaits long
// enough for the input to end before the next read — exactly what the
// backpressure wait below does.
async function* readLines(stream) {
  let rest = '';
  for await (const chunk of stream) {
    const parts = (rest + chunk).split('\n');
    rest = parts.pop();
    for (const line of parts) yield line.endsWith('\r') ? line.slice(0, -1) : line;
  }
  if (rest) yield rest;
}

const stream = createReadStream(input);
const lines = readLines((input.endsWith('.gz') ? stream.pipe(createGunzip()) : stream).setEncoding('utf8'));

if (startLine > 0) console.log(`Resuming from line ${startLine} (${CHECKPOINT})`);
console.log(`Cache ${process.env.CACHE || 'dragonfly'}, namespace ${CACHE_CONFIG.namespace}`);

const inFlight = new Set();
let lineNo = 0;
let chunkStart = startLine;
let rows = [];

const submit = async (end) => {
  const p = runChunk(chunkStart, end, rows);
  inFlight.add(p);
  p.finally(() => inFlight.delete(p));
  chunkStart = end;
  rows = [];
  if (inFlight.size >= PARALLEL) await Promise.race(inFlight);
};

for await (const line of lines) {
  lineNo++;
  if (lineNo <= startLine) continue;
  if (lineNo > startLine + LIMIT || stopping) { lineNo--; break; }

  const tab = line.indexOf('\t');
  const nucleotideSequenceID = line.slice(0, tab).trim();
  const sequence = line.slice(tab + 1).trim();
  // Same validity rules the service applies.
  if (tab === -1 || extractSequences({ nucleotideSequence: [{ nucleotideSequenceID, sequence }] }).length === 0) {
    counts.invalid++;
  } else {
    rows.push([nucleotideSequenceID, sequence]);
  }
  if (rows.length >= CHUNK) await submit(lineNo);
}
// Lines past the last full chunk (including invalid ones) still need to be
// marked done, even when no valid rows remain.
if (rows.length > 0 || chunkStart < lineNo) await submit(lineNo);
await Promise.all(inFlight);

clearInterval(progressTimer);
report();
console.log(`Checkpoint at line ${linesDone}.` +
  (counts.failed ? ` ${counts.failed} sequences failed; rerun on ${FAILURES}.` : ''));
try { await cache.disconnect?.(); } catch {}
process.exit(counts.failed ? 1 : 0);
