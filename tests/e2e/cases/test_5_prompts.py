# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Prompt management on a port with prompts.yaml: a version published and made
live through the dashboard API is the one the LLM gateway sends with the next
query's model call, and the dashboard records that version on the call. The
previous version is made live again afterwards. Runs only for projects with the
`prompts` trait whose queries finish in seconds."""

from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import pytest

from ..fleet import calls_of, store
from ..harness import CallFailed, poll, result_of

pytestmark = pytest.mark.trait("prompts", "quick")

DATA_TIMEOUT = 90
# The LLM gateway reloads the live prompts every 5 seconds (llm_gateway/routing.py),
# so a query sent right after the switch may still get the old version.
QUERIES = 3
EDIT = "\n\nKeep the answer in exactly the format asked for above."


def _versions_sent(recorder, deployed, redis_client, name):
    """Send the test query and return the prompt versions the gateway recorded on
    its calls named `name`, and the request id."""
    request_id, _ = result_of(
        recorder, deployed.endpoint, deployed.query, timeout=deployed.project.timeout
    )
    calls = poll(
        lambda: [c for c in calls_of(redis_client, request_id) if c.label == name],
        timeout=30,
        interval=1,
        what=f"the {name} call of request {request_id}",
    )
    return {c.prompt_version for c in calls}, request_id


def _recorded_versions(deployed, request_id, name, since):
    """The prompt versions the dashboard recorded on the request's `name` blocks,
    looked up in the window from `since` to now."""
    path = f"/projects/{deployed.project_id}/requests/{request_id}"

    def blocks():
        window = urlencode(
            {
                "from": since.isoformat(),
                "to": (datetime.now(timezone.utc) + timedelta(minutes=1)).isoformat(),
            }
        )
        call = deployed.api.get(f"{path}?{window}", check=False)
        if call.code == 404:
            return None
        if call.code != 200:
            raise CallFailed(call)
        found = [b for b in call.json()["blocks"] if b["label"] == name]
        return found or None

    found = poll(blocks, timeout=DATA_TIMEOUT, what=f"the {name} block of {request_id}")
    return {(b["prompt_name"], b["prompt_version"]) for b in found}


def test_live_prompt_version_reaches_the_model_call(recorder, deployed):
    base = f"/projects/{deployed.project_id}/prompts"
    redis_client = store(recorder, deployed)
    prompts = deployed.api.get(base).json()
    assert prompts, "the port declares the prompts trait but lists no prompts"
    name = prompts[0]["name"]
    current = deployed.api.get(f"{base}/{name}").json()["live"]
    since = datetime.now(timezone.utc) - timedelta(minutes=1)
    created = deployed.api.post(
        f"{base}/{name}/versions", json={"content": current["content"] + EDIT}
    ).json()
    assert created["version"] != current["version"], created
    restored = False
    try:
        live = deployed.api.put(
            f"{base}/{name}/live", json={"version": created["version"]}
        ).json()["live"]
        assert live["version"] == created["version"], live
        sent = set()
        for _ in range(QUERIES):
            sent, request_id = _versions_sent(recorder, deployed, redis_client, name)
            if sent == {created["version"]}:
                break
        assert sent == {created["version"]}, (
            f"{name} calls still carry {sent} after {QUERIES} queries, "
            f"live is {created['version']}"
        )
        assert _recorded_versions(deployed, request_id, name, since) == {
            (name, created["version"])
        }
        back = deployed.api.put(
            f"{base}/{name}/live", json={"version": current["version"]}
        ).json()["live"]
        restored = True
        assert back["version"] == current["version"], back
    finally:
        if not restored:
            deployed.api.put(
                f"{base}/{name}/live", json={"version": current["version"]}, check=False
            )
