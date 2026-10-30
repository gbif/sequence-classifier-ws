# Load and end-to-end tests

Python tests against a **deployed** classifier. They use the real sequences in
`test-data/`. Separate from `npm test`, which runs offline.

```bash
pip install -r loadtest/requirements.txt
```

## pytest — does the deployment work, and did the change help?

```bash
pytest loadtest/ -v                                   # default: c6n11.gbif-test.org:31300
CLASSIFIER_URL=http://host:31300 pytest loadtest/ -v
OLD_CLASSIFIER_URL=http://old-host:3000 pytest loadtest/ -v   # also compare with the previous version
```

| Test | Checks |
|---|---|
| `test_service_is_up` | `/livez` and `/health` |
| `test_captured_batch_matches_fixture` | 5 occurrences give exactly the captured classifications |
| `test_cold_batch_completes` | 500 occurrences with sequences the cache has not seen: 200, no errors |
| `test_warm_batch_is_fast_and_identical` | The same batch again: identical, ≥10× faster |
| `test_cold_results_match_cached_results` | A fresh search and a cached answer agree |
| `test_previous_version_on_same_batch` | With `OLD_CLASSIFIER_URL`: the old version fails or is slower |

A timing table is printed at the end of the run.

| Variable | Default | |
|---|---|---|
| `CLASSIFIER_URL` | `http://c6n11.gbif-test.org:31300` | Service under test |
| `OLD_CLASSIFIER_URL` | unset | Previous version, for the comparison test |
| `SAMPLE_OCCURRENCES` | `500` | Occurrences in the cold batch; `100` runs in ~20 s |
| `REQUEST_TIMEOUT_S` | `900` | Per request |

Only the fast checks: `pytest loadtest/ -v -k "captured or up"`.

### Comparing with the previous version

Run `main` locally next to your branch and point the tests at it:

```bash
git worktree add ../classifier-old main
(cd ../classifier-old && npm ci)
(cd ../classifier-old && VSEARCH_URL=http://c6n11.gbif-test.org:31280/search/batch \
  CACHE=none PORT=3997 node index.mjs) &
OLD_CLASSIFIER_URL=http://localhost:3997 pytest loadtest/ -v
kill %1 && git worktree remove ../classifier-old
```

The old version sends the whole batch to vsearch in one request with a 30 s timeout,
so on the 500-occurrence batch it returns 504. vsearch keeps working on the
abandoned request, which ties up one test replica for ~2 minutes.

"Cold" works by giving every sequence a fresh `nucleotideSequenceID` for the run,
since the cache is keyed by ID. That means real vsearch work: the full 500
occurrences (959 sequences) take ~100 s on the 2-replica test vsearch. Use
`SAMPLE_OCCURRENCES=100` for a quicker run. Each run adds its fresh IDs to the
cache (~1 KB per sequence).

## Locust — behaviour under concurrent load

```bash
locust -f loadtest/locustfile.py --host http://c6n11.gbif-test.org:31300 -u 5 -r 1 -t 5m --headless
```

Mixes `[warm]` requests (cached sequences, should stay fast) with `[cold]`
requests (new sequences, bounded by vsearch capacity). Drop `--headless` for the
web UI at http://localhost:8089. Keep `-u` small: every cold request is real work
for the shared vsearch. Tune the mix with `WARM_BATCH` (default 20 occurrences),
`COLD_BATCH` (5) and `COLD_WEIGHT` (1, against 4 for warm).

## vsearch alone — after changing replicas, cores or `--threads`

Measures vsearch throughput without the service or a cache, using the backfill
script. Build a sample from the test data, then run it:

```bash
python3 -c "
import json
seen = {}
for o in json.load(open('test-data/multi_seq_occurrences.json')):
    for s in o.get('nucleotideSequence') or []:
        if s.get('sequence') and not s.get('invalid'):
            seen.setdefault(s['nucleotideSequenceID'], s['sequence'])
print('\\n'.join(f'{k}\\t{v}' for k, v in seen.items()))" > sample.tsv

CACHE=none VSEARCH_URL=http://c6n11.gbif-test.org:31280/search/batch \
  node scripts/backfill.mjs sample.tsv
```

The progress line just before "Checkpoint at line …" reports seq/s. Delete `sample.tsv.checkpoint` before running again,
or the script resumes from the end and does nothing.

Results so far (test data; 2 vsearch replicas unless noted):

| Date | vsearch resources | Service cold batch (959 seqs) | vsearch alone (975 seqs, backfill script) |
|---|---|---|---|
| 2026-10-29 | 4 cores each | 104–121 s (8–9 seq/s) | 9.4 seq/s |
| 2026-10-30 | 8 cores each | 66–79 s (12–15 seq/s) | 17.6 seq/s (batch 25), 18.6 (100), 19.6 (200) |
| 2026-10-30 | **6 replicas**, 8 cores each | 39 s (24 seq/s) | 26 seq/s (batch 25, same at 6/12/18 in flight), 34 (batch 100); 3,900 seqs |

Each replica serves one request at a time. With 8 cores a single request runs ~1.4×
(25 sequences) to ~1.8× (100 sequences) faster than with 4, so larger batches use the
cores slightly better.

With 6 replicas throughput rose only ~1.5× over 2, and did not change with more
requests in flight — about 3 replicas' worth. All replicas do receive traffic, so the
limit is likely shared CPU or memory bandwidth on the nodes they run on.
