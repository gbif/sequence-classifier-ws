import os
import time

import pytest
import requests

from common import BATCH_PATH, env_url

# Collected by the tests, printed as a table at the end of the run.
TIMINGS = []


@pytest.fixture(scope="session")
def base_url():
    return env_url("CLASSIFIER_URL", "http://c6n11.gbif-test.org:31300")


@pytest.fixture(scope="session")
def old_url():
    """Previous version, for the comparison test. Skipped when unset."""
    return env_url("OLD_CLASSIFIER_URL")


@pytest.fixture(scope="session")
def request_timeout():
    # A cold batch takes roughly (new sequences / vsearch seq/s) seconds.
    return float(os.environ.get("REQUEST_TIMEOUT_S", "900"))


@pytest.fixture(scope="session")
def post_batch(request_timeout):
    """POST a batch, record the timing, return (status, seconds, body)."""
    def post(url, occurrences, label):
        start = time.monotonic()
        res = requests.post(f"{url}{BATCH_PATH}", json=occurrences, timeout=request_timeout)
        seconds = time.monotonic() - start
        try:
            body = res.json()
        except ValueError:
            body = res.text
        TIMINGS.append((label, url, res.status_code, seconds, body))
        return res.status_code, seconds, body
    return post


def pytest_terminal_summary(terminalreporter):
    if not TIMINGS:
        return
    tr = terminalreporter
    tr.section("classifier timings")
    tr.write_line(f"{'request':<44} {'status':>6} {'time':>9}  result")
    for label, url, status, seconds, body in TIMINGS:
        if isinstance(body, list):
            classified = sum(1 for r in body if r.get("classification"))
            errors = sum(1 for r in body if r.get("error"))
            result = f"{classified}/{len(body)} classified, {errors} errors"
        else:
            result = str(body)[:60]
        tr.write_line(f"{label:<44} {status:>6} {seconds:>8.1f}s  {result}")
