# sequence-classifier-ws

A Node.js web service that classifies DNA sequences taxonomically by querying a [vsearch](https://github.com/torognes/vsearch) search server against a curated reference database.

Given one or more DNA sequences from a GBIF occurrence record, the service returns a ranked list of reference database matches and a compiled taxonomic classification — the best supported identification given all sequences in the occurrence.

## Requirements

- Node.js >= 18
- A vsearch server running in batch search mode (see below)
- A cache backend: [Dragonfly](https://www.dragonflydb.io/) (default) or Apache HBase

```bash
npm install
```

## Starting vsearch

This service requires the GBIF fork of vsearch on the `batch-requests` branch, which adds HTTP server mode:

```bash
git clone --branch batch-requests https://github.com/gbif/vsearch.git
cd vsearch && ./autogen.sh && ./configure && make && sudo make install
```

Start the server against a pre-built reference UDB:

```bash
vsearch --threads 8 --usearch_global_server \
  --db /path/to/gbif_dna_taxonomy_annotation.udb \
  --id 0.9 --query_cov 0.5 --n_mismatch \
  --maxaccepts 1000 --maxrejects 1000 --maxhits 100 \
  --port 8000 --temp_file_path ~/temp-vsearch
```

## Starting the service

```bash
npm start
# Listening on http://localhost:3000
```

Configuration via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Listening port |
| `VSEARCH_URL` | `http://0.0.0.0:8000/search/batch` | vsearch server URL |
| `CACHE` | `dragonfly` | Cache backend: `dragonfly`, `hbase`, or `none` (no cache) |

## Endpoints

### `POST /search/batch`

**Body**: FASTA (`text/plain`)  
**Response**: `{ [queryId]: topMatches[] }` — up to 5 ranked matches per sequence

Query params:
- `outfmt=blast6out|alnout` (default `blast6out`)

### `POST /occurrence/classify`

**Body**: a single GBIF occurrence object (JSON)  
**Response**: `DnaClassification` object, or `204` if no sequences matched

### `POST /occurrence/classify/batch`

**Body**: `occurrence[]` (JSON array)  
**Response**: `{ gbifID, classification }[]` — one entry per input occurrence

Sequences are deduplicated across all occurrences before querying vsearch, so a sequence shared by many occurrences incurs only one vsearch lookup. Results are cached so repeated batches return quickly without hitting vsearch again.

## Ranking and classification logic

**`pickBestMatch.mjs`** ranks vsearch hits for a single sequence and returns the top 5. Current rule: sort by `identity` descending, then query coverage (`qcovs`) descending as a tiebreaker.

**`assignTaxonomyToOccurrence.mjs`** compiles a single classification from all sequences in an occurrence. Current rule: when sequences disagree, the one with the highest identity match wins. More sophisticated reconciliation rules will be added here — for example, using multi-marker agreement to resolve ties (if two sequences point to different species but a second gene independently confirms one of them, that species is preferred).

## Caching

Match results are cached by `nucleotideSequenceID` so repeated lookups for the same sequence skip vsearch entirely. The cache backend is swappable via the `CACHE` environment variable:

```bash
CACHE=dragonfly npm start   # default — requires Dragonfly on localhost:6379
CACHE=hbase npm start       # Apache HBase via Thrift
CACHE=none npm start        # no cache — every query goes straight to vsearch
```

To run Dragonfly locally with Docker:

```bash
docker run -p 6379:6379 --ulimit memlock=-1 docker.dragonflydb.io/dragonflydb/dragonfly
```

Connection details and the cache namespace are configured in `caches/config.js`.

## Testing

The ranking and classification logic has a unit test suite that runs entirely offline — no vsearch server, no reference database, no real sequences needed. Tests use minimal synthetic match objects to verify each ranking rule in isolation.

```bash
npm test
```

```
✔ higher identity ranks first
✔ higher qcovs wins when identity is tied
✔ multiple sequences: sequence with highest identity wins
...
ℹ tests 15  pass 15  fail 0
```

Tests live in `test/`. Each `test()` block covers exactly one rule. When adding a new ranking rule, write the test first — it serves as a precise specification of what the rule should do before any code is written.
