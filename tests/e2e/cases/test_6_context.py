# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Request context crosses threads, asyncio and process pools without leaking
between requests: two rounds of concurrent requests, so the workflow's reused
pools have to switch requests, and each caller has to see its own request's IDs.
Runs only for projects with the `context-propagation` trait."""

from concurrent.futures import ThreadPoolExecutor

import pytest

from ..harness import result_of

pytestmark = pytest.mark.trait("context-propagation")

CONCURRENT_REQUESTS = 3
ROUNDS = 2


def test_each_request_keeps_its_own_context(recorder, deployed, check):
    def one():
        return result_of(
            recorder,
            deployed.endpoint,
            deployed.query,
            timeout=deployed.project.timeout,
        )

    problems = []
    with ThreadPoolExecutor(max_workers=CONCURRENT_REQUESTS) as pool:
        for _ in range(ROUNDS):
            runs = [pool.submit(one) for _ in range(CONCURRENT_REQUESTS)]
            for run in runs:
                request_id, result = run.result()
                problems += list(
                    check.problems(result, query=deployed.query, request_id=request_id)
                )
    assert not problems, "\n".join(problems)
