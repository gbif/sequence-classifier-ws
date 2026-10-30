"""
End-to-end checks against a deployed sequence classifier.

    pytest loadtest/ -v
    CLASSIFIER_URL=http://host:31300 OLD_CLASSIFIER_URL=http://old:3000 pytest loadtest/ -v

The cold-batch tests do real vsearch work (~1 s per 9 new sequences on the
2-replica test vsearch); use SAMPLE_OCCURRENCES to run a smaller batch.
"""

import os

import pytest
import requests

from common import (load_json, load_occurrences, new_run_id, strip_run_id,
                    summarize, unique_sequence_count, with_fresh_ids)

SAMPLE = int(os.environ.get("SAMPLE_OCCURRENCES", "500"))


@pytest.fixture(scope="module")
def occurrences():
    return load_occurrences(SAMPLE)


@pytest.fixture(scope="module")
def cold_run(base_url, post_batch, occurrences):
    """One cold request (fresh IDs, so nothing is cached), shared by the tests below."""
    run_id = new_run_id()
    fresh = with_fresh_ids(occurrences, run_id)
    n = unique_sequence_count(fresh)
    status, seconds, body = post_batch(base_url, fresh, f"cold: {len(fresh)} occ, {n} new seqs")
    return {"run_id": run_id, "request": fresh, "status": status, "seconds": seconds, "body": body}


def test_service_is_up(base_url):
    assert requests.get(f"{base_url}/livez", timeout=10).status_code == 200
    health = requests.get(f"{base_url}/health", timeout=10)
    assert health.status_code == 200, health.text
    assert health.json()["vsearch"] == "ok"


def test_captured_batch_matches_fixture(base_url, post_batch):
    request = load_json("responses/classify-batch.request.json")
    expected = load_json("responses/classify-batch.response.json")
    status, _, body = post_batch(base_url, request, "captured fixture (5 occ)")
    assert status == 200
    expected_by_id = {str(r["gbifID"]): r["classification"] for r in expected}
    assert {str(r["gbifID"]): r["classification"] for r in body} == expected_by_id


def test_cold_batch_completes(cold_run, occurrences):
    assert cold_run["status"] == 200, cold_run["body"]
    counts = summarize(cold_run["body"])
    assert counts["occurrences"] == len(occurrences)
    assert counts["errors"] == 0
    assert counts["classified"] > 0


def test_warm_batch_is_fast_and_identical(base_url, post_batch, cold_run):
    if cold_run["status"] != 200:
        pytest.skip("cold run failed")
    status, seconds, body = post_batch(base_url, cold_run["request"], "warm: same batch again")
    assert status == 200
    assert body == cold_run["body"]
    # Served from the cache: at least 10x faster than searching.
    assert seconds < max(5.0, cold_run["seconds"] / 10)


def test_cold_results_match_cached_results(base_url, post_batch, cold_run, occurrences):
    """A fresh search and a cached answer for the same sequences agree."""
    if cold_run["status"] != 200:
        pytest.skip("cold run failed")
    status, _, body = post_batch(base_url, occurrences, "original IDs (cached after 1st run)")
    assert status == 200
    assert strip_run_id(cold_run["body"], cold_run["run_id"]) == body


def test_previous_version_on_same_batch(old_url, post_batch, cold_run, occurrences):
    """Documents the improvement: the previous version on the same cold batch."""
    if not old_url:
        pytest.skip("set OLD_CLASSIFIER_URL to compare with the previous version")
    fresh = with_fresh_ids(occurrences, new_run_id())
    status, seconds, _ = post_batch(old_url, fresh, "previous version, same cold batch")
    assert cold_run["status"] == 200
    # The previous version sent the whole batch to vsearch in one request with
    # a 30 s timeout, so large cold batches failed with 504.
    assert status != 200 or seconds > cold_run["seconds"], \
        f"previous version handled it too ({status} in {seconds:.1f}s)"
