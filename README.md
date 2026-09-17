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
| `VSEARCH_URL` | `http://127.0.0.1:8000/search/batch` | vsearch server URL |
| `VSEARCH_TIMEOUT_MS` | `30000` | How long to wait for vsearch before giving up |
| `CACHE` | `dragonfly` | Cache backend: `dragonfly`, `hbase`, or `none` (no cache) |

`npm start` reads a `.env` file in the project root if one is present — copy
`.env.example` to `.env` and edit. Real environment variables take precedence over
anything in `.env`, so a value exported in your shell or injected by an orchestrator
wins. Running without a `.env` is fine; the file is optional.

`CACHE` is read once at startup and cannot be changed while the server runs. Connection
details for the `dragonfly` and `hbase` backends live in `caches/config.js`.

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

### `GET /health`

Readiness probe. Checks the upstream vsearch server (3 s timeout) and the cache backend
in parallel.

**Response**: `200` when both are reachable, `503` when either is not.

```json
{ "status": "ok", "vsearch": "ok", "cache": "ok" }
```

A failing component is reported individually, so a `503` body tells you which one is
down:

```json
{ "status": "degraded", "vsearch": "ok", "cache": "error" }
```

## Examples

The sequences and occurrences below are real records from `test-data/`, so these
commands run as-is against a local server.


### Classify one occurrence

```bash
jq '.[0]' test-data/multi_seq_occurrences.json \
  | curl -s -X POST http://localhost:3000/occurrence/classify \
      -H 'Content-Type: application/json' --data-binary @-
```

Returns a `DnaClassification`, or `204 No Content` if the occurrence had no sequences
or nothing matched. `remarks` records which sequences matched, at what identity and
coverage, and which one the classification came from:

```json
{
  "scientificName": "Cortinarius cesarioanus A. R. Nilsen & Orlovich, 2021",
  "taxonRank": "species",
  "kingdom": "Fungi",
  "phylum": "Basidiomycota",
  "class": "Agaricomycetes",
  "order": "Agaricales",
  "family": "Cortinariaceae",
  "genus": "Cortinarius",
  "species": "Cortinarius cesarioanus",
  "remarks": "2 sequence(s) matched; selected highest identity (100%) from refseq its (ITS region, seqID=dee481ca728cf22a3c2c4c4dfbb8e83b); all matches: [a82cd5f9ca4f26b427c37342c5e4b7de: dataset=unite its gene=its region identity=98.1 qcovs=68.6; dee481ca728cf22a3c2c4c4dfbb8e83b: dataset=refseq its gene=ITS region identity=100 qcovs=100]"
}
```

### Classify a batch of occurrences

```bash
jq '.[0:5]' test-data/multi_seq_occurrences.json \
  | curl -s -X POST http://localhost:3000/occurrence/classify/batch \
      -H 'Content-Type: application/json' --data-binary @-
```

One entry per input occurrence, in input order:

```json
[
  {
    "gbifID": 1038306167,
    "classification": {
      "scientificName": "Cortinarius cesarioanus A. R. Nilsen & Orlovich, 2021",
      "taxonRank": "species",
      "kingdom": "Fungi",
      "phylum": "Basidiomycota",
      "class": "Agaricomycetes",
      "order": "Agaricales",
      "family": "Cortinariaceae",
      "genus": "Cortinarius",
      "species": "Cortinarius cesarioanus",
      "remarks": "2 sequence(s) matched; selected highest identity (100%) from refseq its (ITS region, seqID=dee481ca728cf22a3c2c4c4dfbb8e83b); all matches: [a82cd5f9ca4f26b427c37342c5e4b7de: dataset=unite its gene=its region identity=98.1 qcovs=68.6; dee481ca728cf22a3c2c4c4dfbb8e83b: dataset=refseq its gene=ITS region identity=100 qcovs=100]"
    }
  }
]
```

(one element shown; the array has one entry per input occurrence)

`test-data/multi_seq_occurrences.json` holds 500 occurrences with 2-4 sequences each;
`test-data/rbcL-occurrences.json` is a plant-marker set. Drop the `jq` filter to send a
whole file. The JSON body limit is 10 MB.

### Search a FASTA batch

```bash
curl -s -X POST http://localhost:3000/search/batch \\
  -H 'Content-Type: text/plain' --data-binary @query.fasta
```

where `query.fasta` holds one or more sequences — the body limit is 50 MB:

```
>a82cd5f9ca4f26b427c37342c5e4b7de
GAAACTAACAAGGATTCCCCTAGTAACTGCGAGTGAAGCGGGAAAAGCTCAAATTTAAAA
TCTGTCAGCCTTGGCTGTCCGAGTTGTAATCTAGAGAAGCGTTATCCGCGCTGGACCGTG
TACAAGTCTCCTGGAATGGAGCGTCATAGAGGGTGAGAATCCCGTCTTTGACACGGACTG
CCAGGGCTTTGTGATGCGCTCTCAAAGAGTCGAGTTGTTTGGGAATGCAGCTCAAAATGG
GTGGTAAATTCCATCTAAAGCTAAATATTGGCGAGAGACCGATAGCGAACAAGTACCGTG
AGGGAAAGATGAAAAGAACTTTGGAAAGAGAGTTAAACAGTACGTGAAATTGCTGAAAGG
GAAACGCTTGAAGTCAGTCGCGTTGTCCAGGGATCAACCTTGCTTTTGCTTGGTGTACTT
TCTGGTTGACGGGTCAGCATCAATTTTGACTATTGGAAAAAGGTCAGGGGAATGTGGCAT
CTTCGGATGTGTTATAGCCCTTGGTTGCATACAATGGTTGGGATTGAGGAACTCAGCACG
CCGCAAGGCCGGGTTTTTAACCACGTACGTGCTTAGGATGCTGGCATAATGGCTTTAATC
GACCCGTCTTGAAACACGGACCAAGGAGTCTAACATGCCTGCGAGTGTTTGGGTGGAAAA
CCCGAGCGCGTAATGAAAGTGAAAGTTGAGATCCCTGTCGTGGGGAGCATCGACGCCCGG
ACCAGACCTTTTGTGACGGTTCCGCGGTAGAGCATGTATGTTGGGACCCGAAAGATGGTG
AACTATGCCTGAATAGGGTGAAGCCAGAGGAAACTCTGGTGGAGGCTCGTAGCGATTCTG
ACGTGCAAATCGATCGTCAAATTTGGGTATAGGGGCGAAAGACTAATCGAACCATCTA
```

The response is keyed by the FASTA query ID, with up to 5 matches ranked by identity
then query coverage. Each match carries all 23 reference header fields plus the vsearch
alignment columns; abbreviated here:

```json
{
  "a82cd5f9ca4f26b427c37342c5e4b7de": [
    {
      "scientificName": "Cortinarius saginus",
      "taxonRank": "species",
      "dataset": "unite its",
      "targetGene": "its region",
      "identity": 98.1,
      "qcovs": 68.6
    }
  ]
}
```

The full field list per match is: `id`, `accessionNumber`, `scientificName`,
`decimalLatitude`, `decimalLongitude`, `typeStatus`, `catalogueNumber`, `identifiedBy`,
`taxonRank`, `country`, `locality`, `basisOfRecord`, `higherClassification`, `dataset`,
`targetGene`, `domain`, `kingdom`, `phylum`, `class`, `order`, `family`, `genus`,
`species`, `identity`, `alignmentLength`, `mismatches`, `gapOpenings`, `qstart`, `qend`,
`sstart`, `send`, `evalue`, `bitScore`, `qcovs`.

A query with no match above the server's identity threshold is simply absent from the
response, so `{}` is a valid answer meaning "nothing matched".

Use `?outfmt=alnout` for vsearch alignment output instead of the default `blast6out`.

### Check health

```bash
curl -s http://localhost:3000/health | jq
```

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
