# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The dashboard API shows the deployed project's query as it ran: the calls it
made, on which replicas, with their tokens and cost, and the
project's figures agree with each other over this run. Telemetry reaches Postgres
through the Global Controller and the OTLP exporter, each polling every few
seconds, so data cases poll. Every ranged read covers this run only."""

import re
from collections import Counter
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import pytest
import yaml

from ..fleet import routed_replicas, store
from ..harness import CallFailed, manifest, poll, project_root

DATA_TIMEOUT = 90
# Read when pytest collects the cases, before the deploy, so every request this run
# sends starts after it and none of an earlier run's can.
RUN_STARTED = datetime.now(timezone.utc) - timedelta(minutes=1)


def _project_path(deployed, suffix):
    return f"/projects/{deployed.project_id}{suffix}"


def _window():
    """This run up to now, as a `from`/`to` query string."""
    return urlencode(
        {
            "from": RUN_STARTED.isoformat(),
            "to": datetime.now(timezone.utc).isoformat(),
        }
    )


def _get(deployed, suffix, window):
    joiner = "&" if "?" in suffix else "?"
    return deployed.api.get(_project_path(deployed, f"{suffix}{joiner}{window}")).json()


def _wait_for(deployed, suffix, accept, what):
    """GET the project route over this run until `accept(body)` is truthy; return the
    body. The window is read again on each attempt."""

    def attempt():
        body = _get(deployed, suffix, _window())
        return body if accept(body) else None

    return poll(attempt, timeout=DATA_TIMEOUT, what=what)


def _endpoint_call(deployed):
    endpoint = manifest(deployed.dir)["endpoint"]
    return f"{endpoint['agent']}.{endpoint['method']}"


def _replica_id_pattern(deployed):
    """Matches a replica ID of one of the project's agents, the agent as group 1."""
    agents = "|".join(re.escape(agent) for agent in deployed.agents)
    return re.compile(rf"({agents})-[0-9a-f]{{8}}")


def _declared_calls(deployed):
    """Every `<Agent>.<function>` the manifest declares."""
    return {
        f"{spec['name']}.{function['name']}"
        for spec in manifest(deployed.dir).get("agents", [])
        for function in spec.get("functions") or []
    }


def _trace(deployed, request_id):
    """The query's trace once every call it made is recorded: as many as
    project.yaml's `calls` lists, else at least the endpoint's call."""
    path = _project_path(deployed, f"/requests/{request_id}")
    expected = deployed.project.calls
    endpoint_call = _endpoint_call(deployed)

    def recorded():
        call = deployed.api.get(f"{path}?{_window()}", check=False)
        if call.code == 404:
            return None
        if call.code != 200:
            raise CallFailed(call)
        body = call.json()
        labels = Counter(block["label"] for block in body["blocks"])
        if expected is not None:
            return body if sum(labels.values()) >= sum(expected.values()) else None
        return body if labels[endpoint_call] else None

    return poll(recorded, timeout=DATA_TIMEOUT, what="every call of the query's trace")


def _listed(deployed, request_id, window):
    """The query's row of the requests list over `window`, or None."""
    body = _get(deployed, "/requests?limit=100", window)
    return next((i for i in body["items"] if i["session_id"] == request_id), None)


def test_request_trace_names_each_call(deployed, query_result):
    body = _trace(deployed, query_result.request_id)
    labels = Counter(block["label"] for block in body["blocks"])
    expected = deployed.project.calls
    if expected is not None:
        assert labels == Counter(expected), body["blocks"]
    else:
        assert labels[_endpoint_call(deployed)] == 1, body["blocks"]
        assert set(labels) <= _declared_calls(deployed), body["blocks"]
    first = min(body["blocks"], key=lambda block: block["started_offset_ms"])
    assert first["label"] == _endpoint_call(deployed), body["blocks"]
    assert body["status"] == "completed", body
    assert not any(block["failed"] for block in body["blocks"]), body["blocks"]
    window = _window()
    item = _listed(deployed, query_result.request_id, window)
    assert item is not None, f"{query_result.request_id} not listed over {window}"
    assert item["status"] == "completed", item
    assert item["block_count"] == len(body["blocks"]), item
    assert item["failed_block_count"] == 0, item


@pytest.mark.trait("llm")
def test_request_tokens_and_llm_cost(deployed, query_result):
    _trace(deployed, query_result.request_id)
    item = poll(
        lambda: _listed(deployed, query_result.request_id, _window()),
        timeout=DATA_TIMEOUT,
        what="the query in the requests list",
    )
    assert item["token_count"] > 0, item
    assert float(item["llm_cost"]) > 0, item


def test_figures_agree_on_this_run(deployed, query_result):
    """The requests list, KPIs, latency distribution, timeseries, traffic series and
    resources overview count the same requests over the same window."""
    _trace(deployed, query_result.request_id)

    def agreeing():
        window = _window()
        total = _get(deployed, "/requests?limit=1", window)["total"]
        counts = {
            "kpis": _get(deployed, "/metrics/kpis", window)["request_count"],
            "latency distribution": _get(
                deployed, "/metrics/distribution?metric=latency", window
            )["request_count"],
            "timeseries": sum(
                point["request_count"]
                for point in _get(deployed, "/metrics/timeseries", window)["points"]
            ),
            "traffic series": sum(
                value or 0
                for series in _get(deployed, "/monitoring/series", window)["series"]
                if series["signal"] == "traffic"
                for value in series["values"]
            ),
            "resources overview": next(
                (
                    project["requests"]
                    for project in deployed.api.get(
                        f"/resources/overview?{window}"
                    ).json()["projects"]
                    if project["id"] == deployed.project_id
                ),
                None,
            ),
        }
        return (total, counts) if set(counts.values()) == {total} else None

    total, _ = poll(
        agreeing, timeout=DATA_TIMEOUT, what="every figure counting the same requests"
    )
    assert total >= 1


def test_blocks_and_agent_detail(deployed, query_result):
    """The endpoint's call runs once per request, so its agent's request count is
    the project's."""
    _trace(deployed, query_result.request_id)
    endpoint_call = _endpoint_call(deployed)
    body = _wait_for(
        deployed,
        "/metrics/blocks",
        lambda b: any(block["label"] == endpoint_call for block in b["blocks"]),
        f"a block for {endpoint_call}",
    )
    block = next(b for b in body["blocks"] if b["label"] == endpoint_call)
    assert {b["label"] for b in body["blocks"]} <= _declared_calls(deployed), body
    detail = _wait_for(
        deployed,
        f"/metrics/agents/{block['agent_id']}",
        lambda d: d["agent"]["request_count"] == d["project"]["request_count"],
        f"every request's {endpoint_call} span to reach the dashboard",
    )
    assert detail["label"] == endpoint_call, detail
    assert detail["agent"]["block_count"] >= 1, detail
    assert detail["agent"]["request_count"] >= 1, detail


def test_traces_hold_the_query_on_its_replicas(deployed, query_result):
    """The query's trace names each call and the replica that ran it."""
    expected = len(_trace(deployed, query_result.request_id)["blocks"])
    body = _wait_for(
        deployed,
        "/monitoring/traces?limit=500",
        lambda b: any(
            t["trace_id"] == query_result.request_id and t["span_count"] == expected
            for t in b["traces"]
        ),
        "the query's trace with every call",
    )
    trace = next(t for t in body["traces"] if t["trace_id"] == query_result.request_id)
    assert trace["name"] == _endpoint_call(deployed), trace
    assert len(trace["spans"]) == expected, trace
    replica = _replica_id_pattern(deployed)
    for span in trace["spans"]:
        match = replica.fullmatch(span["agent"] or "")
        assert match and span["name"].startswith(f"{match[1]}."), span


@pytest.mark.trait("llm")
def test_llm_calls_of_the_query(deployed, query_result):
    body = _wait_for(
        deployed,
        "/monitoring/llm?limit=500",
        lambda b: any(c["trace_id"] == query_result.request_id for c in b["calls"]),
        "a model call of the query",
    )
    calls = [c for c in body["calls"] if c["trace_id"] == query_result.request_id]
    wrong = [
        c
        for c in calls
        if not c["model"]
        or not (c["input_tokens"] or 0) > 0
        or not (c["output_tokens"] or 0) > 0
        or c["name"] not in _declared_calls(deployed)
    ]
    assert not wrong, wrong


def test_machine_resources(deployed):
    body = _wait_for(
        deployed,
        "/monitoring/resources",
        lambda b: any(
            series["resource"] == "cpu" and series["samples"] > 0
            for machine in b["machines"]
            for series in machine["series"]
        ),
        "a machine's CPU readings",
    )
    assert body["machines"], body


def test_replicas_report_the_routed_ones(recorder, deployed):
    """The dashboard reports up exactly the replicas the reconciler routes to."""
    redis_client = store(recorder, deployed)

    def matching():
        routed = {
            agent: {r.replica_id for r in routed_replicas(redis_client, agent)}
            for agent in deployed.agents
        }
        body = deployed.api.get(_project_path(deployed, "/monitoring/replicas")).json()
        reported = {
            agent: {
                r["replica"]
                for r in body["replicas"]
                if r["agent"] == agent and not r["draining"]
            }
            for agent in deployed.agents
        }
        return reported if reported == routed and all(routed.values()) else None

    poll(matching, timeout=DATA_TIMEOUT, what="the dashboard's replicas to be routed")


@pytest.mark.trait("logs")
def test_logs_come_from_agent_replicas(deployed, query_result):
    replica = _replica_id_pattern(deployed)
    _wait_for(
        deployed,
        "/monitoring/logs/sources",
        lambda b: any(
            source["agent"] in deployed.agents
            and any(
                (m := replica.fullmatch(r)) and m[1] == source["agent"]
                for r in source["replicas"]
            )
            for source in b["sources"]
        ),
        "a log source named after an agent replica",
    )
    _wait_for(
        deployed,
        "/monitoring/logs",
        lambda b: any(log["agent"] in deployed.agents for log in b["logs"]),
        "a log line of an agent",
    )


def test_endpoint(deployed):
    body = deployed.api.get(_project_path(deployed, "/monitoring/endpoint")).json()
    endpoint = body["endpoint"]
    assert endpoint, body
    assert endpoint["agent"] == manifest(deployed.dir)["endpoint"]["agent"], body
    assert endpoint["method"] == deployed.endpoint.route, body
    assert endpoint["arguments"][0] == deployed.endpoint.argument, body
    port = deployed.endpoint.url.rsplit(":", 1)[-1]
    assert endpoint["url"].endswith(f":{port}/{deployed.endpoint.route}"), body


def _shipped_policy(deployed):
    path = project_root(deployed.dir) / "config" / "scaling.yaml"
    if not path.is_file():
        return None
    return (yaml.safe_load(path.read_text()) or {}).get("scaling")


def test_scaling_read(deployed):
    status = deployed.api.get(_project_path(deployed, "/scaling")).json()
    shipped = _shipped_policy(deployed)
    if shipped is None:
        assert status == {"status": "none"}, status
    else:
        assert status["status"] == "applied", status
        assert {k: status["policy"][k] for k in shipped} == shipped, status
