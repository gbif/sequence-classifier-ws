# CLAUDE.md

Node.js web service that accepts DNA sequences, queries a vsearch search server, and returns taxonomic classifications. Part of the GBIF sequence taxonomy annotation pipeline.

## Starting the service

Requires vsearch running in server mode (built from the GBIF fork, `batch-requests` branch):

```bash
vsearch --threads 8 --usearch_global_server \
  --db /path/to/gbif_dna_taxonomy_annotation.udb \
  --id 0.9 --query_cov 0.5 --n_mismatch \
  --maxaccepts 1000 --maxrejects 1000 --maxhits 100 \
  --port 8000 --temp_file_path ~/temp-vsearch
```

Then start this service:

```bash
npm install
npm start
# Listens on http://localhost:3000 by default
```

Environment variables:
- `PORT` — listening port (default 3000)
- `VSEARCH_URL` — vsearch server URL (default `http://127.0.0.1:8000/search/batch`)
- `CACHE` — cache backend: `dragonfly` (default), `hbase`, or `none` (no cache)
- `REFERENCE_DB_VERSION` — part of every cache key; bump when the `.udb` or vsearch flags change
- `VSEARCH_BATCH_SIZE` / `VSEARCH_CONCURRENCY` / `VSEARCH_RETRIES` — chunking, per-process in-flight cap, retries
- Full list in README.md

## Endpoints

| Endpoint | Body | Response |
|---|---|---|
| `POST /search/batch` | FASTA (text/plain) | `{ [queryId]: topMatches[] }` — up to 5 ranked matches per sequence |
| `POST /occurrence/classify` | Single occurrence (JSON) | `DnaClassification` or 204 |
| `POST /occurrence/classify/batch` | `occurrence[]` (JSON) | `{ gbifID, classification }[]` |

Query params for `/search/batch`: `outfmt=blast6out|alnout` (default `blast6out`).

`/occurrence/classify/batch` deduplicates sequences across all occurrences, does one batched cache lookup, and sends only the misses to vsearch, then fans results back to each `assignTaxonomyToOccurrence` call.

All vsearch traffic goes through `vsearchClient.mjs`: requests are split into `VSEARCH_BATCH_SIZE` chunks, run through one per-process `p-queue` (`VSEARCH_CONCURRENCY`), and retried on network errors and 5xx. Timeouts are not retried: each vsearch replica serves one request at a time and keeps working on abandoned requests, so a retry only adds load. Spreading load over several vsearch instances is done in Kubernetes, behind `VSEARCH_URL`.

`GET /livez` is liveness (process only). `GET /health` is readiness: 503 only when vsearch is down; a cache outage is 200 `degraded`.

## Match object fields

vsearch blast6out results are parsed into match objects with these fields:

| Field | Notes |
|---|---|
| `identity` | % identity (blast6out col 3) |
| `qcovs` | alignmentLength / queryLength × 100 (computed) |
| `alignmentLength`, `mismatches`, `gapOpenings`, `qstart`, `qend`, `sstart`, `send`, `evalue`, `bitScore` | blast6out cols 4–12 |
| 23 FASTA header fields | parsed from blast6out col 2 (pipe-separated) |

The 23 FASTA header fields (in pipe order): `id`, `accessionNumber`, `scientificName`, `decimalLatitude`, `decimalLongitude`, `typeStatus`, `catalogueNumber`, `identifiedBy`, `taxonRank`, `country`, `locality`, `basisOfRecord`, `higherClassification`, `dataset`, `targetGene`, `domain`, `kingdom`, `phylum`, `class`, `order`, `family`, `genus`, `species`.

## pickBestMatch

`pickBestMatch.mjs` receives all vsearch hits for a single sequence and returns a ranked array of up to 5 matches, best first.

**Current ranking rule**: sort by `identity` descending, then `qcovs` descending as tiebreaker.

Signature: `pickBestMatch(queryId, matches, context, topN = 5) → object[]`

`context` carries occurrence-level fields (`decimalLatitude`, `decimalLongitude`, `gbifID`) for future context-sensitive ranking (e.g. geographic plausibility).

## assignTaxonomyToOccurrence

`assignTaxonomyToOccurrence(occurrence, searchSequences)` takes an occurrence and an injected async `searchSequences` function. It extracts valid sequences, queries vsearch, calls `pickBestMatch` per sequence, and compiles a single `DnaClassification`.

**Current reconciliation rule**: when an occurrence has multiple sequences, the sequence whose top match has the highest identity wins.

Further reconciliation rules will be added here — for example, using multi-marker agreement to break ties (if ITS2 returns two equally-plausible species but rbcL independently supports one of them, the multi-marker-supported species wins).

## Cache abstraction

All cache calls route through `caches/index.js` — the single swap point. To change backend, edit that one file or set the `CACHE` env var at startup.

Backend contract: `getMany(namespace, ids) → (value|null)[]`, `setMany(namespace, [id, value][])`, `disconnect()`, and `ready` (a promise resolved on first connection).

Available backends:
- `caches/dragonfly.js` — Redis-compatible, uses `redis` npm package, default host `127.0.0.1:6379`. Offline queue disabled so an outage fails fast.
- `caches/hbase.js` — Apache HBase via Thrift. Namespace is the column qualifier (`ref:<namespace>`); reconnects with backoff.
- `caches/none.js` — no-op: every lookup misses (straight to vsearch), writes discarded, no connections opened

Connection config: `caches/config.js`.
- `CACHE.namespace` — `DB_NAME:REFERENCE_DB_VERSION`, used for every key
- `DRAGONFLY` — host/port for Dragonfly
- `HBASE` — hosts, port, tableName for HBase

`matchCache.mjs` sits on top of the backend. Per `nucleotideSequenceID` it stores the top `CACHE_TOP_N` (default 10) hits as compact arrays `[refId, ...stats]`; reference headers are stored once each under `<namespace>:ref` and kept in an in-process LRU. Sequences with no hits are stored as `[]`. Entries never expire — the namespace carries the reference DB version.

Cache failures are non-fatal: an error or a round-trip slower than `CACHE_TIMEOUT_MS` counts as a miss and the query goes to vsearch.

`scripts/backfill.mjs` fills the cache from a TSV of distinct sequences, with checkpointing and a failures file; with `CACHE=none --limit N` it benchmarks vsearch throughput.

## Unit tests

Tests run without vsearch or any live server — synthetic match objects only.

```bash
npm test
```

Tests live in `test/`. Each `test()` block covers exactly one ranking rule. **Add a test for every new ranking rule before implementing it.**

Also under test: `vsearchClient` (chunking, concurrency cap, retry rules) and `matchCache` (hits skip search, negative caching, top-N storage, header dictionary, cache failure/timeout fallthrough, namespace isolation).

Current rules under test:
- `pickBestMatch`: identity desc, qcovs desc tiebreaker; topN limit
- `assignTaxonomyToOccurrence`: null on empty/invalid sequences; highest-identity sequence wins across multiple sequences; invalid sequences and unusable IDs excluded before querying
