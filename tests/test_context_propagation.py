import sys
import time
from concurrent.futures import ThreadPoolExecutor

import requests

BASE_URL = "http://localhost:8080"
CALLERS = (
    "main",
    "thread",
    "raw_thread",
    "thread_pool",
    "async_task",
    "async_executor",
    "process_pool",
    "mp_apply",
    "mp_map",
    "mp_imap",
    "mp_imap_unordered",
    "mp_process",
)
CONCURRENT_REQUESTS = 3


def _run_request():
    response = requests.post(f"{BASE_URL}/main", json={})
    if response.status_code != 202:
        print(f"Error submitting request: HTTP {response.status_code} {response.text}")
        sys.exit(1)
    request_id = response.json()["request_id"]

    for _ in range(60):
        status = requests.get(f"{BASE_URL}/status/{request_id}").json()
        if status.get("status") == "done":
            return request_id, status["result"]
        if status.get("status") in ("error", "failed"):
            print(f"Workflow failed: {status.get('error')}")
            sys.exit(1)
        time.sleep(1)
    print(f"Timed out waiting for request {request_id}.")
    sys.exit(1)


def _problems(request_id, result):
    workflow_future = result["main"]["future_id"]
    problems = []
    for caller in CALLERS:
        seen = result[caller]
        expected = {
            "request_id": request_id,
            "future_id": workflow_future,
            "function": "main",
            "greeting": f"Hello, {caller}! I'm the HelloAgent!",
            "agent_request_id": request_id,
            "agent_parent": workflow_future,
        }
        problems += [
            f"{caller}: {key} was {seen.get(key)!r}, expected {want!r}"
            for key, want in expected.items()
            if seen.get(key) != want
        ]
    return problems


def run_context_propagation_test():
    # Two rounds, so reused pools must switch requests; concurrent requests must not see each other's IDs.
    problems = []
    with ThreadPoolExecutor(max_workers=CONCURRENT_REQUESTS) as requests_pool:
        for _ in range(2):
            runs = [
                requests_pool.submit(_run_request) for _ in range(CONCURRENT_REQUESTS)
            ]
            for run in runs:
                problems += _problems(*run.result())
    if problems:
        print("Request context did not carry over:\n  " + "\n  ".join(problems))
        sys.exit(1)
    print("Context propagation test passed for: " + ", ".join(CALLERS))
    sys.exit(0)


if __name__ == "__main__":
    run_context_propagation_test()
