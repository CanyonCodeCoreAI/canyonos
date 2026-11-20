# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""portfolio deployed with `deploy_mode: toy`: one replica runs every agent of the
workflow, beside the endpoint's, and the test query still passes, with each call
reaching its agent and each LLM call telling the gateway which agent made it."""

import re

import pytest

from ..conftest import DEPLOY_TIMEOUT, secrets_of
from ..fleet import calls_of
from ..harness import (
    canyonos,
    deployed_endpoint,
    deployment_group,
    docker_name,
    manifest,
    poll,
    workflow_group_containers,
    workflow_dir,
    workflow_group_redis,
    qualified,
    query_for,
    result_of,
    stage,
    stop_workflow_group,
)
from ..workflows import load_check, load_workflow

WORKFLOW = "portfolio"
UP_KEY = "routing_table:up"
UP_TIMEOUT = 120
CALLS = (
    "IntentAgent.parse",
    "MetricsAgent.compute",
    "PriceAgent.get_history",
    "RiskAgent.assess",
    "AdvisorAgent.summarize",
)
LLM_CALLS = ("IntentAgent.parse", "AdvisorAgent.summarize")


@pytest.fixture
def toy(recorder, images, tmp_path):
    """portfolio staged with the real AWS keys and `deploy_mode: toy`, and deployed;
    stopped afterwards."""
    workflow = load_workflow(WORKFLOW)
    directory = stage(recorder, workflow, tmp_path, secrets_of(workflow))
    settings = directory / "workflow_group.yaml"
    settings.write_text(f"{settings.read_text()}\ndeploy_mode: toy\n")
    try:
        canyonos(
            recorder,
            ["deploy", str(workflow_dir(directory))],
            cwd=directory,
            timeout=DEPLOY_TIMEOUT,
        )
        yield directory
    finally:
        stop = stop_workflow_group(recorder, directory)
        assert stop is None or stop.code == 0, stop.output[-2000:]


def test_one_replica_runs_every_agent(recorder, toy):
    """Every agent counts as up and the query passes, though only the endpoint and one
    other replica run; the query's calls reach each agent, and the gateway records the
    tokens and the agent's own prompt version on each LLM call."""
    workflow = load_workflow(WORKFLOW)
    folder = workflow_dir(toy)
    store = workflow_group_redis(recorder, toy)
    agents = {qualified(folder, spec["name"]) for spec in manifest(folder)["agents"]}
    poll(
        lambda: agents <= store.smembers(UP_KEY),
        timeout=UP_TIMEOUT,
        interval=2,
        what=f"every agent in {UP_KEY}: {sorted(agents)}",
    )

    query = query_for(workflow, folder)
    request_id, result = result_of(
        recorder, deployed_endpoint(recorder, toy), query, timeout=workflow.timeout
    )
    check = load_check(workflow)
    problems = list(check.problems(result, query=query, request_id=request_id))
    assert not problems, problems

    group = deployment_group(recorder, toy)
    replica = re.compile(rf"{re.escape(group)}-(.+)-[0-9a-f]{{8}}")
    running = sorted(
        match[1]
        for name in workflow_group_containers(recorder, group)
        if (match := replica.fullmatch(name))
    )
    assert running == sorted(["endpoint", docker_name(qualified(folder, "toy"))]), (
        running
    )

    calls = {call.label: call for call in calls_of(store, request_id)}
    missing = [name for name in CALLS if qualified(folder, name) not in calls]
    assert not missing, f"no call for {missing}: {sorted(calls)}"
    for name in LLM_CALLS:
        call = calls[qualified(folder, name)]
        future = store.hgetall(f"future:{call.future_id}")
        assert int(future.get("gen_ai.usage.input_tokens") or 0) > 0, (name, future)
        # The gateway finds the prompt by the agent header, so this proves it arrived.
        assert call.prompt_version, (name, future)
