#!/usr/bin/env python3
"""
Benchmark a deployed classifier with sequences from a CSV file.

    python3 loadtest/bench_csv.py sequences.csv --url http://c7p9.gbif-test.org:31300
    python3 loadtest/bench_csv.py sequences.csv --limit 5000 --batch-size 100 --concurrency 8
    python3 loadtest/bench_csv.py sequences.csv --fresh-ids          # force cold (real vsearch work)
    python3 loadtest/bench_csv.py sequences.csv --endpoint single    # one occurrence per request

The CSV needs the columns `nucleotidesequenceid` and `sequence` (header names are
matched case-insensitively). Each sequence is sent as an occurrence with one
`nucleotideSequence` entry. Only the standard library is used.

Sequences are cached by ID, so a second run with the same IDs measures the warm
(cached) path. `--fresh-ids` appends a run suffix to every ID so vsearch really
searches; on the shared test vsearch that runs at roughly 25-40 seq/s, so keep
`--limit` modest.
"""

import argparse
import csv
import http.client
import json
import statistics
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlsplit

ENDPOINTS = {
    "batch": "/occurrence/classify/batch",
    "single": "/occurrence/classify",
}


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("csv", help="CSV with nucleotidesequenceid,sequence columns")
    p.add_argument("--url", default="http://c7p9.gbif-test.org:31300", help="classifier base URL")
    p.add_argument("--endpoint", choices=ENDPOINTS, default="batch")
    p.add_argument("--batch-size", type=int, default=50, help="occurrences per batch request (default 50)")
    p.add_argument("--concurrency", type=int, default=4, help="requests in flight (default 4)")
    p.add_argument("--limit", type=int, default=1000, help="sequences to send; 0 = all (default 1000)")
    p.add_argument("--offset", type=int, default=0, help="skip the first N sequences")
    p.add_argument("--fresh-ids", action="store_true", help="suffix IDs so the cache misses")
    p.add_argument("--timeout", type=float, default=900, help="per-request timeout in seconds")
    p.add_argument("--out", help="write one CSV row per request (timings, status) to this file")
    return p.parse_args()


def load_sequences(path, offset, limit):
    seen = {}
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        cols = {c.lower(): c for c in reader.fieldnames or []}
        id_col, seq_col = cols.get("nucleotidesequenceid"), cols.get("sequence")
        if not id_col or not seq_col:
            sys.exit(f"CSV must have nucleotidesequenceid and sequence columns, got {reader.fieldnames}")
        for row in reader:
            sid, seq = row[id_col].strip(), row[seq_col].strip()
            if sid and seq:
                seen.setdefault(sid, seq)
    items = list(seen.items())[offset:]
    return items[:limit] if limit else items


def to_occurrence(i, sid, seq):
    return {"gbifID": f"bench-{i}", "nucleotideSequence": [{"nucleotideSequenceID": sid, "sequence": seq}]}


class Client:
    """One keep-alive HTTP connection per worker thread."""

    def __init__(self, base_url, timeout):
        u = urlsplit(base_url)
        self.https = u.scheme == "https"
        self.host = u.hostname
        self.port = u.port or (443 if self.https else 80)
        self.prefix = u.path.rstrip("/")
        self.timeout = timeout
        self.local = threading.local()

    def _conn(self):
        conn = getattr(self.local, "conn", None)
        if conn is None:
            cls = http.client.HTTPSConnection if self.https else http.client.HTTPConnection
            conn = self.local.conn = cls(self.host, self.port, timeout=self.timeout)
        return conn

    def request(self, method, path, body=None):
        """Returns (status, body_bytes, ttfb_s, total_s). Raises on network errors."""
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"} if data else {}
        conn = self._conn()
        start = time.perf_counter()
        try:
            conn.request(method, self.prefix + path, body=data, headers=headers)
            res = conn.getresponse()
            ttfb = time.perf_counter() - start
            payload = res.read()
        except Exception:
            conn.close()
            self.local.conn = None
            raise
        return res.status, payload, ttfb, time.perf_counter() - start


def run_request(client, path, occurrences, single):
    record = {"sequences": len(occurrences), "status": None, "ttfb_s": None, "total_s": None,
              "classified": 0, "occurrence_errors": 0, "error": ""}
    start = time.perf_counter()
    try:
        status, payload, ttfb, total = client.request("POST", path, occurrences[0] if single else occurrences)
    except Exception as e:
        record.update(total_s=time.perf_counter() - start, error=f"{type(e).__name__}: {e}")
        return record
    record.update(status=status, ttfb_s=ttfb, total_s=total)
    if single:
        record["classified"] = int(status == 200)
        if status not in (200, 204):
            record["error"] = payload[:200].decode(errors="replace")
    elif status == 200:
        results = json.loads(payload)
        record["classified"] = sum(1 for r in results if r.get("classification"))
        record["occurrence_errors"] = sum(1 for r in results if r.get("error"))
        if len(results) != len(occurrences):
            record["error"] = f"{len(results)} results for {len(occurrences)} occurrences"
    else:
        record["error"] = payload[:200].decode(errors="replace")
    return record


def pct(sorted_values, p):
    if not sorted_values:
        return float("nan")
    k = (len(sorted_values) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(sorted_values) - 1)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (k - lo)


def latency_line(label, values):
    v = sorted(values)
    if not v:
        return f"  {label:<10} (none)"
    return (f"  {label:<10} min {v[0]:7.3f}  mean {statistics.fmean(v):7.3f}  p50 {pct(v, 50):7.3f}  "
            f"p90 {pct(v, 90):7.3f}  p95 {pct(v, 95):7.3f}  p99 {pct(v, 99):7.3f}  max {v[-1]:7.3f}")


def report(records, wall_s, args, total_sequences):
    ok = [r for r in records if r["status"] in (200, 204) and not r["error"]]
    done_seqs = sum(r["sequences"] for r in records)
    ok_seqs = sum(r["sequences"] for r in ok)
    statuses = {}
    for r in records:
        key = r["status"] if r["status"] is not None else "network error"
        statuses[key] = statuses.get(key, 0) + 1

    print("\n== Summary ==")
    print(f"  target       {args.url}{ENDPOINTS[args.endpoint]}")
    print(f"  mode         {'cold (fresh IDs)' if args.fresh_ids else 'original IDs (warm if already cached)'}")
    print(f"  settings     batch-size {args.batch_size if args.endpoint == 'batch' else 1}, "
          f"concurrency {args.concurrency}")
    print(f"  sequences    {done_seqs}/{total_sequences} sent, {ok_seqs} in successful requests, "
          f"{sum(r['classified'] for r in records)} classified")
    print(f"  requests     {len(records)}  statuses {statuses}")
    occ_errors = sum(r["occurrence_errors"] for r in records)
    if occ_errors:
        print(f"  occurrence errors in 200 responses: {occ_errors}")
    print(f"  wall time    {wall_s:.1f} s")
    if wall_s > 0:
        print(f"  throughput   {ok_seqs / wall_s:.1f} seq/s, {len(ok) / wall_s:.2f} req/s")
    print("\nLatency per request, seconds (successful requests):")
    print(latency_line("total", [r["total_s"] for r in ok]))
    print(latency_line("ttfb", [r["ttfb_s"] for r in ok]))
    if args.endpoint == "batch":
        print(latency_line("per seq", [r["total_s"] / r["sequences"] for r in ok]))

    errors = [r["error"] for r in records if r["error"]]
    if errors:
        print(f"\nFirst errors ({len(errors)} total):")
        for e in errors[:5]:
            print(f"  - {e}")


def main():
    args = parse_args()
    items = load_sequences(args.csv, args.offset, args.limit)
    if not items:
        sys.exit("No sequences loaded")

    run_id = uuid.uuid4().hex[:8]
    if args.fresh_ids:
        items = [(f"{sid}-{run_id}", seq) for sid, seq in items]
    occurrences = [to_occurrence(i, sid, seq) for i, (sid, seq) in enumerate(items)]
    single = args.endpoint == "single"
    size = 1 if single else args.batch_size
    chunks = [occurrences[i:i + size] for i in range(0, len(occurrences), size)]

    client = Client(args.url, args.timeout)
    try:
        status, payload, _, total = client.request("GET", "/health")
        print(f"/health {status} in {total * 1000:.0f} ms: {payload.decode(errors='replace')}")
    except Exception as e:
        sys.exit(f"Service not reachable at {args.url}: {e}")

    print(f"Sending {len(occurrences)} sequences in {len(chunks)} requests, "
          f"{args.concurrency} in flight (run {run_id})...")

    records = []
    start = time.perf_counter()
    last_print = start
    pool = ThreadPoolExecutor(max_workers=args.concurrency)
    futures = [pool.submit(run_request, client, ENDPOINTS[args.endpoint], c, single) for c in chunks]
    try:
        for fut in as_completed(futures):
            records.append(fut.result())
            now = time.perf_counter()
            if now - last_print >= 5 or len(records) == len(chunks):
                last_print = now
                seqs = sum(r["sequences"] for r in records)
                failed = sum(1 for r in records if r["error"])
                print(f"  [{now - start:7.1f} s] {len(records)}/{len(chunks)} requests, {seqs} seqs, "
                      f"{seqs / (now - start):.1f} seq/s, {failed} failed", flush=True)
    except KeyboardInterrupt:
        print("\nInterrupted; reporting completed requests (in-flight ones keep running on the server).")
        for f in futures:
            f.cancel()
    wall = time.perf_counter() - start
    pool.shutdown(wait=False, cancel_futures=True)

    report(records, wall, args, len(occurrences))

    if args.out:
        with open(args.out, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(records[0].keys()) if records else ["sequences"])
            w.writeheader()
            w.writerows(records)
        print(f"\nPer-request timings written to {args.out}")


if __name__ == "__main__":
    main()
