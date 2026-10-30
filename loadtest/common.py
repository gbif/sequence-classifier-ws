"""Shared helpers for the pytest suite and the locustfile."""

import copy
import json
import os
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TEST_DATA = REPO / "test-data"

BATCH_PATH = "/occurrence/classify/batch"


def env_url(name, default=None):
    value = os.environ.get(name, default)
    return value.rstrip("/") if value else None


def load_json(relative):
    return json.loads((TEST_DATA / relative).read_text())


def load_occurrences(limit=None):
    occurrences = load_json("multi_seq_occurrences.json")
    return occurrences[:limit] if limit else occurrences


def new_run_id():
    return uuid.uuid4().hex[:8]


def with_fresh_ids(occurrences, run_id):
    """Copy occurrences with every nucleotideSequenceID suffixed by run_id.

    The service caches by nucleotideSequenceID, so fresh IDs force a real
    vsearch search for sequences the cache has already seen.
    """
    fresh = copy.deepcopy(occurrences)
    for occ in fresh:
        for seq in occ.get("nucleotideSequence") or []:
            if seq.get("nucleotideSequenceID"):
                seq["nucleotideSequenceID"] = f"{seq['nucleotideSequenceID']}-{run_id}"
    return fresh


def strip_run_id(results, run_id):
    """Undo with_fresh_ids in a response (the IDs appear in `remarks`)."""
    return json.loads(json.dumps(results).replace(f"-{run_id}", ""))


def unique_sequence_count(occurrences):
    return len({
        s["nucleotideSequenceID"]
        for occ in occurrences
        for s in occ.get("nucleotideSequence") or []
        if s.get("nucleotideSequenceID") and s.get("sequence") and not s.get("invalid")
    })


def summarize(results):
    """Counts for a /occurrence/classify/batch response body."""
    return {
        "occurrences": len(results),
        "classified": sum(1 for r in results if r.get("classification")),
        "errors": sum(1 for r in results if r.get("error")),
    }
