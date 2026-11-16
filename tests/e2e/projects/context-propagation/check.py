# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Fail unless every caller in the context-propagation workflow saw the request it
runs for: the same request ID and workflow future as `main`, and a HelloAgent call
that Redis recorded under that request and parent; and unless both agents run on
the Python the run asked for: E2E_AGENT_PYTHON, which the `python` CI job sets to
the version it writes in the project's .python-version, else the default.

Usage: problems(result, request_id=...) yields one line per problem; nothing means
the result is real. Without a request ID it checks against the one `main` saw.
"""

import os

from canyonos_core.stub_generator import DEFAULT_IMAGE_PYTHON_VERSION

CALLERS = (
    "main",
    "thread",
    "thread_subclass",
    "raw_thread",
    "thread_pool",
    "nested_thread",
    "async_task",
    "async_executor",
    "process_pool",
    "spawn_process_pool",
    "mp_apply",
    "mp_map",
    "mp_imap",
    "mp_imap_unordered",
    "mp_thread_pool",
    "mp_process",
    "process_subclass",
    "spawn_process",
)


def problems(result, *, query=None, request_id=None):
    """Yield each caller whose context differs from `main`'s, or from `request_id`
    when it is given."""
    if not isinstance(result, dict) or not isinstance(result.get("main"), dict):
        yield f"result is {result!r}, expected one entry per caller"
        return
    yield from _python_problems(result.get("python"))
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


def _python_problems(seen):
    """Yield each agent whose Python is not the one this run asked for."""
    expected = os.environ.get("E2E_AGENT_PYTHON") or DEFAULT_IMAGE_PYTHON_VERSION
    for agent in ("Workflow", "HelloAgent"):
        version = (seen or {}).get(agent)
        if not isinstance(version, str) or not (
            version == expected or version.startswith(f"{expected}.")
        ):
            yield f"{agent} runs on Python {version!r}, expected {expected}"
