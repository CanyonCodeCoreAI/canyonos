# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""A deployed endpoint pauses for a person's answer and recovers a failed result
from the dashboard after its Redis result expires."""

from dataclasses import dataclass
from pathlib import Path
import json

import pytest
import redis

from ..conftest import DEPLOY_TIMEOUT
from ..harness import (
    canyonos,
    deployed_endpoint,
    docker,
    Endpoint,
    finished,
    http,
    poll,
    project_redis,
    stage,
    stop_project,
    submit,
)
from ..projects import load_project

CLEANUP_TIMEOUT = 240
DASHBOARD_DATABASE = "canyonos-dashboard-db"
QUESTION = "What should the workflow remember?"
FAILURE = "the workflow failed after human input"
WORKFLOW = f'''\
class Workflow:
    def main(self, query: str):
        if query == "fail":
            raise RuntimeError("{FAILURE}")
        answer = input("{QUESTION}")
        return {{"answer": answer}}
'''


@dataclass(frozen=True)
class HumanInputDeploy:
    directory: Path
    endpoint: Endpoint
    store: redis.Redis


@pytest.fixture(scope="module")
def human_input_deploy(recorder, images, tmp_path_factory):
    """A minimal real workflow whose ordinary input() is handled by CanyonOS."""
    directory = stage(
        recorder,
        load_project("helloworld"),
        tmp_path_factory.mktemp("human-input"),
        {},
    )
    (directory / "agents" / "workflow.py").write_text(WORKFLOW)
    try:
        canyonos(recorder, ["deploy"], cwd=directory, timeout=DEPLOY_TIMEOUT)
        yield HumanInputDeploy(
            directory=directory,
            endpoint=deployed_endpoint(recorder, directory),
            store=project_redis(recorder, directory),
        )
    finally:
        stop = stop_project(recorder, directory)
        assert stop is None or stop.code == 0, stop.output[-2000:]


def _waiting_status(recorder, deployment, request_id):
    url = f"{deployment.endpoint.url}/status/{request_id}"

    def waiting():
        call = http(recorder, "GET", url, check=False)
        if call.code != 200:
            return None
        status = call.json()
        return status if status["status"] == "input_required" else None

    return poll(waiting, timeout=120, interval=1, what="workflow input request")


def _dashboard_failure(recorder, request_id):
    """Read the actual dashboard database through its private container network."""
    query = (
        "select coalesce(json_agg(json_build_array(status_code, status_message)), "
        "'[]'::json)::text from otel_spans"
        f" where trace_id = '{request_id}' and parent_span_id is null"
    )
    call = docker(
        recorder,
        [
            "exec",
            DASHBOARD_DATABASE,
            "psql",
            "-U",
            "canyonos",
            "-d",
            "canyonos",
            "-tA",
            "-c",
            query,
        ],
        check=False,
    )
    if call.code != 0:
        return None
    rows = json.loads(call.output)
    return tuple(rows[0]) if rows else None


def test_workflow_pauses_for_an_answer_and_resumes(recorder, human_input_deploy):
    request_id = submit(recorder, human_input_deploy.endpoint, "pause")
    waiting = _waiting_status(recorder, human_input_deploy, request_id)
    assert waiting == {
        "request_id": request_id,
        "status": "input_required",
        "question": {"question": QUESTION, "input_schema": {"input": "str"}},
    }, waiting

    answer = http(
        recorder,
        "POST",
        f"{human_input_deploy.endpoint.url}/answer/{request_id}",
        json={"input": "remember this"},
    )
    assert answer.json() == {"request_id": request_id}, answer.output

    status = finished(recorder, human_input_deploy.endpoint, request_id, timeout=120)
    assert status == {
        "request_id": request_id,
        "status": "done",
        "result": {"answer": "remember this"},
    }, status

    repeated = http(
        recorder,
        "POST",
        f"{human_input_deploy.endpoint.url}/answer/{request_id}",
        json={"input": "too late"},
        check=False,
    )
    assert repeated.code == 409, repeated.output
    assert repeated.json() == {
        "error": f"Request {request_id} is not waiting for input"
    }, repeated.output


def test_failed_status_recovers_from_its_dashboard_span(recorder, human_input_deploy):
    request_id = submit(recorder, human_input_deploy.endpoint, "fail")
    live = finished(recorder, human_input_deploy.endpoint, request_id, timeout=120)
    assert live["status"] == "error", live
    assert FAILURE in (live.get("error") or ""), live

    dashboard = poll(
        lambda: _dashboard_failure(recorder, request_id),
        timeout=120,
        interval=2,
        what=f"failed root span for {request_id}",
    )
    status_code, status_message = dashboard
    assert status_code == "STATUS_CODE_ERROR", dashboard
    assert status_message == live["error"], dashboard

    request = f"request:{request_id}"

    def cleaned_up():
        live_keys = human_input_deploy.store.exists(
            f"{request}:futures", f"{request}:future"
        )
        return not live_keys and human_input_deploy.store.exists(f"{request}:result")

    poll(
        cleaned_up,
        timeout=CLEANUP_TIMEOUT,
        what=f"cleanup to move {request} to {request}:result",
    )
    assert human_input_deploy.store.delete(f"{request}:result") == 1

    recovered = http(
        recorder,
        "GET",
        f"{human_input_deploy.endpoint.url}/status/{request_id}",
    ).json()
    assert recovered == {
        "request_id": request_id,
        "status": "error",
        "error": status_message,
    }, recovered
