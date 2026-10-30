"""
Load test: concurrent clients mixing cached and new sequences.

    locust -f loadtest/locustfile.py --host http://c6n11.gbif-test.org:31300 \
           -u 5 -r 1 -t 5m --headless

Watch the two request names separately:
  [warm] occurrences whose sequences are already cached — should stay fast
         under load.
  [cold] occurrences with fresh sequence IDs, so vsearch really searches them —
         bounded by vsearch capacity (~6 seq/s per replica).

Every cold request is real vsearch work, so keep -u small against the shared
test vsearch. Tune the mix with WARM_BATCH, COLD_BATCH and COLD_WEIGHT.
"""

import os
import random

from locust import HttpUser, between, task

from common import BATCH_PATH, load_occurrences, new_run_id, with_fresh_ids

OCCURRENCES = load_occurrences()
WARM_BATCH = int(os.environ.get("WARM_BATCH", "20"))
COLD_BATCH = int(os.environ.get("COLD_BATCH", "5"))
COLD_WEIGHT = int(os.environ.get("COLD_WEIGHT", "1"))
TIMEOUT_S = float(os.environ.get("REQUEST_TIMEOUT_S", "300"))


class PipelineClient(HttpUser):
    wait_time = between(1, 3)

    def post_batch(self, occurrences, name):
        with self.client.post(BATCH_PATH, json=occurrences, name=name,
                              timeout=TIMEOUT_S, catch_response=True) as res:
            if res.status_code != 200:
                res.failure(f"HTTP {res.status_code}: {res.text[:100]}")
                return
            body = res.json()
            if len(body) != len(occurrences):
                res.failure(f"{len(body)} results for {len(occurrences)} occurrences")
            elif any(r.get("error") for r in body):
                res.failure("per-occurrence error in response")

    @task(4)
    def warm(self):
        # Original IDs: cached after the first time any client sends them.
        self.post_batch(random.sample(OCCURRENCES, WARM_BATCH), f"{BATCH_PATH} [warm]")

    @task(COLD_WEIGHT)
    def cold(self):
        sample = random.sample(OCCURRENCES, COLD_BATCH)
        self.post_batch(with_fresh_ids(sample, new_run_id()), f"{BATCH_PATH} [cold]")
