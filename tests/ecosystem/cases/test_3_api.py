# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Every base dashboard endpoint answers for the deployed project and shows the
query that was sent. Telemetry reaches Postgres through the Global Controller and
the OTLP exporter, each polling every few seconds, so data cases poll."""

import pytest

from ..harness import CallFailed, http, poll

DATA_TIMEOUT = 90


def _project_path(deployed, suffix):
    return f"/projects/{deployed.project_id}{suffix}"


def _wait_for(deployed, suffix, accept, what):
    """GET the project route until `accept(body)` is truthy; return the body."""

    def attempt():
        body = deployed.api.get(_project_path(deployed, suffix)).json()
        return body if accept(body) else None

    return poll(attempt, timeout=DATA_TIMEOUT, what=what)


def test_health(recorder, deployed):
    body = http(recorder, "GET", f"{deployed.api.base_url}/healthz").json()
    assert body["status"] == "ok", body


def test_project_registered(deployed):
    project = deployed.api.get(_project_path(deployed, "")).json()
    assert project["name"] == deployed.project.name
    deployed.api.get(_project_path(deployed, "/stats"))


def test_requests_recorded(deployed, query_result):
    body = _wait_for(
        deployed,
        "/requests",
        lambda b: any(i["session_id"] == query_result.request_id for i in b["items"]),
        "the query in the requests list",
    )
    item = next(i for i in body["items"] if i["session_id"] == query_result.request_id)
    assert item["token_count"] > 0, item
    assert float(item["total_cost"]) > 0, item


def test_request_trace(deployed, query_result):
    path = _project_path(deployed, f"/requests/{query_result.request_id}")

    def recorded():
        call = deployed.api.get(path, check=False)
        if call.code == 404:
            return None
        if call.code != 200:
            raise CallFailed(call)
        return call.json()

    body = poll(recorded, timeout=DATA_TIMEOUT, what="the query's trace")
    assert body["session_id"] == query_result.request_id, body
    assert body["token_count"] > 0, body


def test_kpis(deployed, query_result):
    body = _wait_for(
        deployed,
        "/metrics/kpis",
        lambda b: b["windows"]["1d"]["request_count"] >= 1,
        "a request in the 1d KPI window",
    )
    assert float(body["windows"]["1d"]["llm_cost"]) > 0, body["windows"]["1d"]


@pytest.mark.parametrize(
    "metric", ["tokens_per_request", "cost_per_request", "latency"]
)
def test_distribution(deployed, query_result, metric):
    body = _wait_for(
        deployed,
        f"/metrics/distribution?metric={metric}&time_window=1d",
        lambda b: b["request_count"] >= 1,
        f"the {metric} distribution",
    )
    assert body["buckets"], body


def test_timeseries(deployed, query_result):
    _wait_for(
        deployed,
        "/metrics/timeseries?time_window=1d",
        lambda b: any(p["request_count"] >= 1 for p in b["points"]),
        "a timeseries bucket with the request",
    )


def test_blocks_and_agent_detail(deployed, query_result):
    body = _wait_for(
        deployed,
        "/metrics/blocks?time_window=1d",
        lambda b: bool(b["blocks"]),
        "a costed block for an agent",
    )
    agent_id = body["blocks"][0]["agent_id"]
    deployed.api.get(_project_path(deployed, f"/metrics/agents/{agent_id}"))


def test_resources_overview(deployed, query_result):
    def listed():
        body = deployed.api.get("/resources/overview?time_window=1d").json()
        names = [p["name"] for p in body["projects"]]
        return body if deployed.project.name in names else None

    poll(listed, timeout=DATA_TIMEOUT, what="the project in the resources overview")


def test_traces(deployed, query_result):
    body = _wait_for(
        deployed, "/monitoring/traces", lambda b: bool(b["traces"]), "a trace"
    )
    assert body["traces"][0]["spans"], body["traces"][0]


def test_llm_calls(deployed, query_result):
    _wait_for(deployed, "/monitoring/llm", lambda b: bool(b["calls"]), "a model call")


def test_errors_summary(deployed):
    body = deployed.api.get(
        _project_path(deployed, "/monitoring/errors/summary")
    ).json()
    assert "total" in body, body


def test_series(deployed, query_result):
    _wait_for(
        deployed, "/monitoring/series", lambda b: bool(b["series"]), "golden signals"
    )


def test_machine_resources(deployed):
    _wait_for(
        deployed,
        "/monitoring/resources",
        lambda b: bool(b["machines"]),
        "machine utilization",
    )


def test_replicas(deployed):
    body = _wait_for(
        deployed,
        "/monitoring/replicas",
        lambda b: {r["agent"] for r in b["replicas"]} >= set(deployed.agents),
        "every agent reporting up",
    )
    assert body["replicas"]


def test_logs(deployed, query_result):
    _wait_for(deployed, "/monitoring/logs", lambda b: bool(b["logs"]), "logs")
    _wait_for(
        deployed,
        "/monitoring/logs/sources",
        lambda b: bool(b["sources"]),
        "log sources",
    )


def test_endpoint(deployed):
    body = deployed.api.get(_project_path(deployed, "/monitoring/endpoint")).json()
    assert body["endpoint"], body
    assert body["endpoint"]["method"] == deployed.route, body


def test_prompts_list(deployed):
    body = deployed.api.get(_project_path(deployed, "/prompts")).json()
    assert isinstance(body, list), body


def test_scaling_read(deployed):
    status = deployed.api.get(_project_path(deployed, "/scaling")).json()
    assert status["status"] in ("none", "applied", "invalid"), status
    _wait_for(
        deployed,
        "/scaling/agents",
        lambda b: (
            all(a["replicas_running"] == a["replicas_expected"] for a in b["agents"])
            and {a["name"] for a in b["agents"]} == set(deployed.agents)
        ),
        "every agent reporting its running replicas",
    )
