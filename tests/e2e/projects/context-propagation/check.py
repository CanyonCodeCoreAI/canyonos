# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Fail unless every caller in the context-propagation workflow saw the request it
runs for: the same request ID and workflow future as `main`, and a HelloAgent call
that Redis recorded under that request and parent.

Usage: problems(result, request_id=...) yields one line per problem; nothing means
the result is real. Without a request ID it checks against the one `main` saw.
"""

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


def problems(result, *, query=None, request_id=None):
    """Yield each caller whose context differs from `main`'s, or from `request_id`
    when it is given."""
    if not isinstance(result, dict) or not isinstance(result.get("main"), dict):
        yield f"result is {result!r}, expected one entry per caller"
        return
    request_id = request_id or result["main"].get("request_id")
    workflow_future = result["main"].get("future_id")
    if not request_id or not workflow_future:
        yield f"main saw no request or workflow future: {result['main']!r}"
        return
    for caller in CALLERS:
        seen = result.get(caller) or {}
        expected = {
            "request_id": request_id,
            "future_id": workflow_future,
            "function": "main",
            "greeting": f"Hello, {caller}! I'm the HelloAgent!",
            "agent_request_id": request_id,
            "agent_parent": workflow_future,
        }
        for key, want in expected.items():
            if seen.get(key) != want:
                yield f"{caller}: {key} was {seen.get(key)!r}, expected {want!r}"
