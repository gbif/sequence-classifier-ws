import express from 'express';
import { createRequire } from 'module';
import { pickBestMatch } from './pickBestMatch.mjs';
import { assignTaxonomyToOccurrence, extractSequences } from './assignTaxonomyToOccurrence.mjs';
import { createVsearchClient, parseFasta } from './vsearchClient.mjs';
import { createMatchCache } from './matchCache.mjs';

const _require = createRequire(import.meta.url);
const cache = _require('./caches/index.js');
const CACHE_CONFIG = _require('./caches/config.js').CACHE;

// Mirrors the selection in caches/index.js, which is what actually loads the
// module. Kept here so startup and health logging can name the active backend.
const CACHE_BACKEND = process.env.CACHE || 'dragonfly';

const int = (name, fallback) => {
  const n = parseInt(process.env[name]);
  return Number.isNaN(n) ? fallback : n;
};

const VSEARCH_URL = process.env.VSEARCH_URL || 'http://127.0.0.1:8000/search/batch';
const VSEARCH_TIMEOUT_MS = int('VSEARCH_TIMEOUT_MS', 120_000);
const PORT = process.env.PORT || 3000;
const SHUTDOWN_TIMEOUT_MS = int('SHUTDOWN_TIMEOUT_MS', 150_000);

// One queue per process caps the vsearch requests this pod has in flight,
// across every endpoint.
const vsearch = createVsearchClient({
  url:         VSEARCH_URL,
  timeoutMs:   VSEARCH_TIMEOUT_MS,
  batchSize:   int('VSEARCH_BATCH_SIZE', 25),
  concurrency: int('VSEARCH_CONCURRENCY', 4),
  retries:     int('VSEARCH_RETRIES', 2),
  logQueue:    process.env.VSEARCH_QUEUE_LOG === 'true',
});

const matchCache = createMatchCache({
  cache,
  search:       seqs => vsearch.search(seqs),
  namespace:    CACHE_CONFIG.namespace,
  topN:         int('CACHE_TOP_N', 10),
  timeoutMs:    int('CACHE_TIMEOUT_MS', 1000),
  refCacheSize: int('REF_CACHE_SIZE', 500_000),
});

const vsearchQueryWithCache = fasta => matchCache.query(parseFasta(fasta));

const upstreamError = (res, err, message) => {
  console.error(`${message}:`, err.message);
  if (err.name === 'TimeoutError') {
    return res.status(504).json({ error: 'vsearch server timed out' });
  }
  return res.status(502).json({ error: message, details: err.message });
};

// ── Express server ───────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '10mb' }));                    // for /occurrence/classify
app.use(express.text({ type: 'text/*', limit: '50mb' }));   // for /search/batch

app.post('/search/batch', async (req, res) => {
  const outfmt = req.query.outfmt || 'blast6out';
  if (!['blast6out', 'alnout'].includes(outfmt)) {
    return res.status(400).json({ error: `Unknown outfmt: ${outfmt}` });
  }

  const body = req.body;
  if (!body) return res.status(400).json({ error: 'No FASTA body provided' });

  const sequences = parseFasta(body);

  let parsed;
  try {
    parsed = await vsearch.search(sequences, outfmt);
  } catch (err) {
    return upstreamError(res, err, 'Could not reach vsearch server');
  }

  const result = Object.fromEntries(
    Object.entries(parsed).map(([queryId, matches]) => [queryId, pickBestMatch(queryId, matches)])
  );
  res.json(result);
});

// ── GET /health ───────────────────────────────────────────────────────────────

// Liveness: the process is up and serving. Deliberately checks nothing
// downstream, so a vsearch or cache outage never gets pods restarted.
app.get('/livez', (req, res) => res.json({ status: 'ok' }));

// Readiness. vsearch is required; the cache is optional (lookups fall through
// to vsearch), so a cache outage reports "degraded" but stays 200 — otherwise
// one cache outage would take every replica out of the load balancer at once.
//
// Probes are typically scraped every few seconds, so log on transition rather
// than on every poll: one line when a dependency starts failing, one when it
// recovers. Null until the first probe, so the first result is always logged.
let lastHealthStatus = null;

app.get('/health', async (req, res) => {
  const vsearchHealthUrl = new URL('/health', VSEARCH_URL).href;

  const [vsearchState, cacheState] = await Promise.all([
    fetch(vsearchHealthUrl, { signal: AbortSignal.timeout(3000) })
      .then(r => (r.ok ? { ok: true } : { ok: false, reason: `HTTP ${r.status}` }))
      .catch(err => ({ ok: false, reason: err.message })),

    Promise.race([
      cache.getMany(CACHE_CONFIG.namespace, ['__health_check__']),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 3000).unref()),
    ])
      .then(() => ({ ok: true }))
      .catch(err => ({ ok: false, reason: err instanceof Error ? err.message : String(err) })),
  ]);

  const status = !vsearchState.ok ? 'unavailable' : cacheState.ok ? 'ok' : 'degraded';

  if (status !== lastHealthStatus) {
    if (status === 'ok') {
      console.log(`Health ok — vsearch ${vsearchHealthUrl}, cache ${CACHE_BACKEND}`);
    } else {
      const failed = [];
      if (!vsearchState.ok) failed.push(`vsearch ${vsearchHealthUrl}: ${vsearchState.reason}`);
      if (!cacheState.ok)   failed.push(`cache ${CACHE_BACKEND}: ${cacheState.reason}`);
      console.error(`Health ${status} — ${failed.join('; ')}`);
    }
    lastHealthStatus = status;
  }

  res.status(vsearchState.ok ? 200 : 503).json({
    status,
    vsearch: vsearchState.ok ? 'ok' : 'error',
    cache: cacheState.ok ? 'ok' : 'error',
  });
});

// ── POST /occurrence/classify ─────────────────────────────────────────────────
//
// Accept a single GBIF occurrence object (JSON), extract its nucleotide
// sequences, run vsearch for each, and return a DnaClassification that the
// GBIF pipeline can feed to the taxon-matching service.
//
// Request body: a GBIF occurrence object (Content-Type: application/json).
//
// Response (200):
//   { scientificName, taxonRank, [kingdom, phylum, class, order, family, genus, species], remarks }
//
// Response (204): occurrence had no sequences or no matches were found.
//
// Response (400): malformed request body.
//
app.post('/occurrence/classify', async (req, res) => {
  const occurrence = req.body;
  if (!occurrence || typeof occurrence !== 'object') {
    return res.status(400).json({ error: 'Request body must be a JSON occurrence object' });
  }

  let classification;
  try {
    classification = await assignTaxonomyToOccurrence(occurrence, vsearchQueryWithCache);
  } catch (err) {
    return upstreamError(res, err, 'Classification failed');
  }

  if (classification === null) {
    return res.status(204).end();
  }

  res.json(classification);
});

// ── POST /occurrence/classify/batch ──────────────────────────────────────────
//
// Accept an array of GBIF occurrence objects, classify all of them in a single
// vsearch round-trip by deduplicating sequences across occurrences before
// querying, then fanning results back to each occurrence.
//
// Request body: occurrence[] (Content-Type: application/json).
//
// Response (200): array of result objects, one per input occurrence, in order:
//   { gbifID, classification }
//   classification is null if the occurrence had no sequences or no matches.
//
// Response (400): malformed request body.
//
app.post('/occurrence/classify/batch', async (req, res) => {
  const occurrences = req.body;
  if (!Array.isArray(occurrences)) {
    return res.status(400).json({ error: 'Request body must be an array of occurrence objects' });
  }

  // Collect unique sequences across all occurrences, using the same filter
  // assignTaxonomyToOccurrence applies.
  const seqMap = {}; // nucleotideSequenceID → sequence string
  for (const occ of occurrences) {
    for (const { nucleotideSequenceID, sequence } of extractSequences(occ)) {
      seqMap[nucleotideSequenceID] ??= sequence;
    }
  }

  // One cache lookup and one chunked vsearch search covering all unique sequences.
  let matchesMap = {};
  if (Object.keys(seqMap).length > 0) {
    try {
      matchesMap = await matchCache.query(seqMap);
    } catch (err) {
      return upstreamError(res, err, 'Could not reach vsearch server');
    }
  }

  // For each occurrence, inject a lookup-based searchSequences so
  // assignTaxonomyToOccurrence resolves from the cached matchesMap.
  const results = await Promise.all(
    occurrences.map(async (occurrence) => {
      async function searchSequences(fasta) {
        const ids = Object.keys(parseFasta(fasta));
        return Object.fromEntries(ids.map(id => [id, matchesMap[id] ?? []]));
      }
      try {
        const classification = await assignTaxonomyToOccurrence(occurrence, searchSequences);
        return { gbifID: occurrence.gbifID ?? null, classification };
      } catch (err) {
        return { gbifID: occurrence.gbifID ?? null, classification: null, error: err.message };
      }
    })
  );
  res.json(results);
});

// ── malformed-body errors ─────────────────────────────────────────────────────
// body-parser rejects a bad body before any route runs, and Express' default
// handler answers with an HTML error page and logs a full stack trace. Clients of
// this API parse JSON, so answer in JSON and log one line. Registered after the
// routes so it also catches anything they throw.
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    console.error(`Malformed JSON body on ${req.method} ${req.path}: ${err.message}`);
    return res.status(400).json({ error: 'Malformed JSON in request body' });
  }
  if (err?.type === 'entity.too.large') {
    console.error(`Body too large on ${req.method} ${req.path}: limit ${err.limit} bytes`);
    return res.status(413).json({ error: 'Request body too large', limit: err.limit });
  }
  return next(err);
});

// Give the cache a moment to connect so the first requests after startup can
// use it. Not required: if it is still down, lookups just fall through.
const cacheReady = await Promise.race([
  cache.ready.then(() => true),
  new Promise(resolve => setTimeout(resolve, 5000, false)),
]);
if (!cacheReady) console.warn(`Cache ${CACHE_BACKEND} not connected after 5 s; starting anyway`);

const server = app.listen(PORT, () => {
  console.log(`vsearch proxy listening on http://localhost:${PORT}`);
  console.log(`Forwarding to ${VSEARCH_URL}`);
  console.log(`Cache backend: ${CACHE_BACKEND}, namespace ${CACHE_CONFIG.namespace}`);
  if (CACHE_CONFIG.referenceVersion === 'unversioned' && CACHE_BACKEND !== 'none') {
    console.warn('REFERENCE_DB_VERSION is not set; cached results will not be invalidated when the reference DB changes');
  }
});

const shutdown = (signal) => {
  console.log(`${signal} received, shutting down gracefully`);
  server.close(async () => {
    try { await cache.disconnect?.(); } catch {}
    process.exit(0);
  });
  // Force exit if in-flight requests don't finish in time. Must exceed the
  // longest request (vsearch timeout × attempts) and stay below the pod's
  // terminationGracePeriodSeconds.
  setTimeout(() => {
    console.error('Shutdown timeout exceeded, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
