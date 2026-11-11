# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The governance rules on examples/pr_review, with real agents and a real Bedrock
call: the deploy seeds `governance.yaml` as written, a required agent going down
refuses its dependents (an inner call, then the endpoint's root call with a 403
that `/status` repeats), the query passes again once it is back, spend under the
threshold leaves ReviewAgent's model alone, over it switches the model and over a
deny rule refuses the agent, a config reload seeds the file's new agents without
touching the rules edited in Redis, and a crash-looping replica counts as down.

Rules and spend are written straight to the controller's Redis, as the dashboard
API does, so the deploy runs without the dashboard: its spend publisher would
overwrite the forged figures every minute. It needs AWS keys allowed to invoke both
Bedrock models in us-east-1; BEDROCK_SWITCH_MODEL_ID names the model the spend rule
switches to. The cases are steps on one deploy: once one fails, the rest are
skipped."""

import copy
import json
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import pytest
import redis
import yaml
from canyonos_core.llm_gateway.routing import REFRESH_SECONDS as GATEWAY_REFRESH

from ..conftest import secrets_of
from ..harness import (
    Endpoint,
    canyonos,
    deployed_endpoint,
    finished,
    http,
    manifest,
    poll,
    project_redis,
    project_root,
    stage,
    submit,
    stop_project,
)
from ..projects import load_check, load_project

pytestmark = pytest.mark.steps

DEFAULT_SWITCH_MODEL = "meta.llama3-8b-instruct-v1:0"
REQUEST_TIMEOUT = 300
DEPLOY_TIMEOUT = 1800
UP_TIMEOUT = 120
REMOVAL_TIMEOUT = 60
SYNC_TIMEOUT = 300
RELOAD_TIMEOUT = 60
CRASH_TIMEOUT = 180
# Added to the slowest reader's refresh period: the Redis round trip of its next read.
REFRESH_MARGIN = 2
# How far the controller container's clock may lag the host's when it stamps `since`.
CLOCK_SKEW = 5
# The PR every case sends, held here rather than read from project.yaml, whose query
# the cases of other checks may reshape; TEXT_QUERY is the title-then-diff text
# Workflow.review parses when `canyonos test` sends it.
QUERY = {"title": "Add retry", "diff": "+def retry(): ..."}
TEXT_QUERY = f"{QUERY['title']}\n{QUERY['diff']}"
SINCE_FORMAT = r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"
RUNNER = "TestRunnerAgent"
CONFIG_KEY = "governance:config"
SPEND_KEY = "governance:spend"
UP_KEY = "routing_table:up"
REPLICAS_KEY = "routing_table:replicas"
DESIRED_KEY = f"agent:{RUNNER}:desired_replicas"
# Against governance.yaml's $5 switch rule: under it, over it, then a deny rule above both.
SPEND_UNDER = 4
SPEND_OVER = 6
DENY_RULE = {"above_usd": 7, "action": {"kind": "deny"}}
SPEND_OVER_DENY = 8


@dataclass
class Governed:
    """The deployed pr_review project, its Redis, the rules the deploy seeded, and
    what the cases learn from each other."""

    dir: Path
    endpoint: Endpoint
    store: redis.Redis
    switch_model: str
    poll_interval: float
    deployed_at: float
    seed_raw: str | bytes | None
    seed: dict | None
    baseline_model: str = ""


def _parse_rules(raw: str | bytes | None) -> dict | None:
    """The `agents` of a stored governance document, or None when it has none."""
    try:
        document = json.loads(raw or "{}")
    except ValueError:
        return None
    agents = document.get("agents") if isinstance(document, dict) else None
    return agents if isinstance(agents, dict) and agents else None


def _seeded(governed: Governed) -> dict:
    """A copy of the rules the deploy seeded, to edit and write back."""
    assert governed.seed is not None, (
        f"the deploy left no readable rules in {CONFIG_KEY}: {governed.seed_raw!r}"
    )
    return copy.deepcopy(governed.seed)


def _write_rules(store, agents: dict) -> None:
    store.set(CONFIG_KEY, json.dumps({"agents": agents}))


def _stored_rules(store) -> dict:
    return _parse_rules(store.get(CONFIG_KEY)) or {}


def _rules_naming(store, agent: str) -> dict | None:
    """The stored rules once they have an entry for `agent`, else None."""
    agents = _stored_rules(store)
    return agents if agent in agents else None


def _settle(governed: Governed) -> None:
    """Wait for a Redis edit to reach every reader: each Local Controller re-reads the
    rules once per poll_interval (its metrics loop) and the LLM gateway once per
    REFRESH_SECONDS (llm_gateway/routing.py)."""
    time.sleep(max(governed.poll_interval, GATEWAY_REFRESH) + REFRESH_MARGIN)


def _routes(store) -> str:
    routes = store.hget(REPLICAS_KEY, RUNNER)
    assert routes, f"{REPLICAS_KEY} has no {RUNNER} entry"
    return routes


def _runner_up(store) -> bool:
    """A replica record exists while the container still boots; the reconciler puts
    the agent in routing_table:up, which governance reads, once a replica reports
    healthy with a fresh heartbeat."""
    return bool(store.sismember(UP_KEY, RUNNER))


def _runner_statuses(store) -> list:
    """What each TestRunnerAgent replica last reported about itself, by address."""
    return [
        store.get(f"controller:{address}:status")
        for address in json.loads(_routes(store))
    ]


def _stop_runner(governed: Governed) -> None:
    """Take TestRunnerAgent to zero replicas, as the dashboard's stop does, and wait
    until the reconciler removed its replica and counts it down, then until every
    Local Controller has re-read the rules."""
    store = governed.store
    store.set(DESIRED_KEY, 0)
    poll(
        lambda: _routes(store) == "[]",
        timeout=REMOVAL_TIMEOUT,
        interval=2,
        what=f"{RUNNER} to leave the routing table",
    )
    poll(
        lambda: not _runner_up(store),
        timeout=REMOVAL_TIMEOUT,
        interval=1,
        what=f"{RUNNER} to leave {UP_KEY}",
    )
    _settle(governed)


def _send(recorder, governed: Governed) -> tuple[str, dict]:
    request_id = submit(recorder, governed.endpoint, QUERY)
    status = finished(recorder, governed.endpoint, request_id, timeout=REQUEST_TIMEOUT)
    return request_id, status


def _future(store, request_id: str, agent: str, method: str | None = None) -> str:
    """The id of the future `request_id` made for `agent.method`, or for the root
    call of `agent` when `method` is None."""
    for future in store.smembers(f"request:{request_id}:futures"):
        record = store.hgetall(f"future:{future}")
        if record.get("service") != agent:
            continue
        if method is None and not record.get("parent"):
            return future
        if method is not None and record.get("method") == method:
            return future
    raise AssertionError(
        f"request {request_id} has no future for {agent}{f'.{method}' if method else ''}"
    )


def _error_name(store, request_id: str, agent: str, method: str) -> str:
    future = _future(store, request_id, agent, method)
    return store.hget(f"future:{future}", "error_name") or ""


def _review_model(store, request_id: str) -> str:
    """The model the gateway sent ReviewAgent.review's LLM call to, as its future
    records it."""
    future = _future(store, request_id, "ReviewAgent", "review")
    return store.hget(f"future:{future}", "model") or ""


def _expect_refusal(status: dict, name: str) -> None:
    """A refusal keeps its wording up to the root call: the error text starts with
    the refusing rule's name."""
    assert status["status"] == "error", status
    assert (status.get("error") or "").startswith(f"{name}: "), status


def _expect_real_review(check, status: dict) -> None:
    assert status["status"] == "done", status
    problems = list(check.problems(status["result"]))
    assert not problems, problems


def _epoch(since: str) -> float:
    return datetime.fromisoformat(since.replace("Z", "+00:00")).timestamp()


@pytest.fixture(scope="module")
def check():
    return load_check(load_project("pr_review"))


@pytest.fixture(scope="module")
def governed(recorder, images, tmp_path_factory):
    """pr_review staged with the real AWS keys and deployed without the dashboard;
    the cases start once the reconciler counts every agent up. Stopped afterwards,
    whatever the cases did to it."""
    project = load_project("pr_review")
    switch_model = os.environ.get("BEDROCK_SWITCH_MODEL_ID") or DEFAULT_SWITCH_MODEL
    directory = stage(
        recorder,
        project,
        tmp_path_factory.mktemp("governance"),
        {**secrets_of(project), "BEDROCK_SWITCH_MODEL_ID": switch_model},
    )
    config = manifest(directory)
    agents = {spec["name"] for spec in config["agents"]}
    deployed_at = time.time()
    try:
        canyonos(
            recorder,
            ["deploy", "--serve", "false"],
            cwd=directory,
            timeout=DEPLOY_TIMEOUT,
        )
        store = project_redis(recorder, directory)
        poll(
            lambda: agents <= store.smembers(UP_KEY),
            timeout=UP_TIMEOUT,
            interval=2,
            what=f"every agent in {UP_KEY}: {sorted(agents)}",
        )
        seed_raw = store.get(CONFIG_KEY)
        yield Governed(
            dir=directory,
            endpoint=deployed_endpoint(recorder, directory),
            store=store,
            switch_model=switch_model,
            poll_interval=float(config.get("poll_interval", 5)),
            deployed_at=deployed_at,
            seed_raw=seed_raw,
            seed=_parse_rules(seed_raw),
        )
    finally:
        stop = stop_project(recorder, directory)
    assert stop is None or stop.code == 0, stop.output[-2000:]


def test_the_query_passes_with_every_requirement_up(recorder, governed, check):
    """The positive control, through `canyonos test` with the text form of the PR
    that Workflow.review parses: with TestRunnerAgent up MergeAgent is admitted and
    the whole pipeline answers, the tests having read the title and the diff. It runs
    as soon as the reconciler counts every agent up, with no wait for the Local
    Controllers to re-read that, as a user's first query would."""
    call = canyonos(
        recorder,
        ["test", TEXT_QUERY, "--json", "--timeout", str(REQUEST_TIMEOUT)],
        cwd=governed.dir,
        timeout=REQUEST_TIMEOUT + 120,
        check=False,
    )
    report = call.json()
    assert report["against_existing_deploy"] is True, call.stdout
    assert not (report["error"] or "").startswith("DependencyDown"), (
        "refused although every agent is in routing_table:up: a Local Controller "
        f"still holds the snapshot from before the deploy finished\n{call.stdout}"
    )
    assert call.code == 0 and report["error"] is None, call.output[-3000:]
    problems = list(check.problems(report["result"]))
    assert not problems, problems
    assert report["result"]["tests"]["passed"] is True, report["result"]["tests"]


def test_deploy_seeds_the_rules_from_governance_yaml(governed):
    """Every rule of the staged governance.yaml, as written, with its placeholder
    expanded from the project's .env and ReviewAgent's spend counted since the deploy."""
    agents = _seeded(governed)
    path = project_root(governed.dir) / "config" / "governance.yaml"
    from_yaml = yaml.safe_load(path.read_text())["agents"]
    assert set(agents) == set(from_yaml), agents
    assert agents["MergeAgent"] == from_yaml["MergeAgent"], agents["MergeAgent"]
    rule = from_yaml["ReviewAgent"]["spend"]["rules"][0]
    assert rule["action"]["model"] == "${BEDROCK_SWITCH_MODEL_ID}", rule
    expected = {
        "above_usd": rule["above_usd"],
        "action": {"kind": "switch_model", "model": governed.switch_model},
    }
    spend = agents["ReviewAgent"]["spend"]
    assert spend["rules"] == [expected], spend
    since = spend.get("since")
    assert isinstance(since, str) and re.fullmatch(SINCE_FORMAT, since), spend
    assert governed.deployed_at - CLOCK_SKEW <= _epoch(since) <= time.time(), (
        f"since {since} is not between the deploy and now"
    )


def test_a_stopped_requirement_refuses_its_dependent(recorder, governed):
    """Without the rule the request would fail too, once TestRunnerAgent.run finds
    no replica (NoRunningReplica). The rule changes what fails and how: MergeAgent.merge
    is refused before it is queued, and that refusal is the request's error."""
    _stop_runner(governed)
    request_id, status = _send(recorder, governed)
    _expect_refusal(status, "DependencyDown")
    assert f"MergeAgent requires {RUNNER}" in status["error"], status
    assert (
        _error_name(governed.store, request_id, "MergeAgent", "merge")
        == "DependencyDown"
    )


def test_a_root_call_whose_requirement_is_down_gets_a_403(recorder, governed):
    """The endpoint contract (docs/architecture/ENDPOINT.md): a refused root call is
    never queued, POST answers 403 with the request id and the refusal, and GET
    /status for that id reports the same error."""
    agents = _seeded(governed)
    agents["Workflow"] = {"requires": [RUNNER]}
    _write_rules(governed.store, agents)
    _settle(governed)
    url = f"{governed.endpoint.url}/{governed.endpoint.route}"
    call = http(
        recorder,
        "POST",
        url,
        json={governed.endpoint.argument: QUERY},
        check=False,
    )
    assert call.code == 403, call.output
    refusal = call.json()
    assert refusal.get("error_name") == "DependencyDown", call.output
    assert refusal.get("error", "").startswith(
        f"DependencyDown: Workflow requires {RUNNER}"
    ), call.output
    status_url = f"{governed.endpoint.url}/status/{refusal['request_id']}"
    status = http(recorder, "GET", status_url).json()
    assert status["status"] == "error", status
    assert status["error"] == refusal["error"], status

    cli = canyonos(
        recorder,
        ["test", TEXT_QUERY, "--json", "--timeout", str(REQUEST_TIMEOUT)],
        cwd=governed.dir,
        timeout=REQUEST_TIMEOUT + 120,
        check=False,
    )
    report = cli.json()
    assert cli.code != 0, cli.output[-3000:]
    assert report["against_existing_deploy"] is True, cli.stdout
    assert report["error"] == (
        f"Workflow query was refused: {refusal['error']}. "
        "Run `canyonos status` to check the deploy."
    ), cli.output[-3000:]


def test_the_query_succeeds_once_the_requirement_is_back(recorder, governed, check):
    """With Workflow still requiring TestRunnerAgent, bringing the agent back is
    what admits the root call again; the rule is lifted only after the request.
    The model the review ran on is the baseline the spend cases compare with."""
    store = governed.store
    store.set(DESIRED_KEY, 1)
    poll(
        lambda: _runner_up(store),
        timeout=UP_TIMEOUT,
        interval=2,
        what=f"{RUNNER} to be up",
    )
    _settle(governed)
    request_id, status = _send(recorder, governed)
    _write_rules(store, _seeded(governed))
    _expect_real_review(check, status)
    governed.baseline_model = _review_model(store, request_id)
    assert governed.baseline_model, "ReviewAgent.review's future records no model"


def test_spend_over_the_threshold_switches_the_model(recorder, governed, check):
    """Spend under the $5 rule leaves the review on its own model; over it, the
    gateway sends the call to BEDROCK_SWITCH_MODEL_ID. The spend is forged in
    governance:spend: in a real deploy only the dashboard's publisher writes it,
    from the recorded span costs, which is why this deploy runs without the
    dashboard. Each edit is given the gateway's refresh period to be read."""
    store = governed.store
    assert governed.baseline_model, "the previous case recorded no baseline model"
    assert governed.baseline_model != governed.switch_model, (
        f"BEDROCK_MODEL_ID and BEDROCK_SWITCH_MODEL_ID are both "
        f"{governed.switch_model}: a switch would not show"
    )
    store.set(SPEND_KEY, json.dumps({"ReviewAgent": SPEND_UNDER}))
    _settle(governed)
    request_id, status = _send(recorder, governed)
    _expect_real_review(check, status)
    model = _review_model(store, request_id)
    assert model == governed.baseline_model, f"{model} under the threshold"

    store.set(SPEND_KEY, json.dumps({"ReviewAgent": SPEND_OVER}))
    _settle(governed)
    request_id, status = _send(recorder, governed)
    _expect_real_review(check, status)
    model = _review_model(store, request_id)
    assert model == governed.switch_model, f"{model} over the threshold"


def test_spend_over_a_deny_threshold_refuses_the_agent(recorder, governed):
    """With both rules passed, the highest threshold decides: ReviewAgent.review is
    refused instead of switched, and the refusal reaches the root call."""
    store = governed.store
    agents = _seeded(governed)
    agents["ReviewAgent"]["spend"]["rules"].append(DENY_RULE)
    _write_rules(store, agents)
    store.set(SPEND_KEY, json.dumps({"ReviewAgent": SPEND_OVER_DENY}))
    _settle(governed)
    request_id, status = _send(recorder, governed)
    _expect_refusal(status, "SpendLimit")
    assert f"ReviewAgent is over its ${DENY_RULE['above_usd']} cap" in status["error"]
    assert _error_name(store, request_id, "ReviewAgent", "review") == "SpendLimit"


def test_a_reload_keeps_the_rules_edited_in_redis(recorder, governed):
    """The file seeds only the agents the stored rules lack (RUNTIME_CONTRACT.md):
    after `canyonos sync` with an edited governance.yaml, its new agent appears,
    while MergeAgent keeps its stored rule rather than the file's new one and
    ReviewAgent keeps the deny rule written to Redis. The new agent appearing is
    what shows the reload ran at all."""
    store = governed.store
    path = project_root(governed.dir) / "config" / "governance.yaml"
    original = path.read_text()
    document = yaml.safe_load(original)
    document["agents"]["MergeAgent"]["requires"] = [RUNNER, "ReviewAgent"]
    document["agents"]["Workflow"] = {"requires": ["ReviewAgent"]}
    path.write_text(yaml.safe_dump(document, sort_keys=False))
    try:
        canyonos(recorder, ["sync"], cwd=governed.dir, timeout=SYNC_TIMEOUT)
        agents = poll(
            lambda: _rules_naming(store, "Workflow"),
            timeout=RELOAD_TIMEOUT,
            interval=2,
            what=f"the reload to seed Workflow's rule into {CONFIG_KEY}",
        )
    finally:
        path.write_text(original)
    assert agents["Workflow"] == {"requires": ["ReviewAgent"]}, agents
    seeded = _seeded(governed)
    assert agents["MergeAgent"] == seeded["MergeAgent"], agents
    expected_rules = [*seeded["ReviewAgent"]["spend"]["rules"], DENY_RULE]
    assert agents["ReviewAgent"]["spend"]["rules"] == expected_rules, agents


def test_a_crash_looping_requirement_counts_as_down(recorder, governed):
    """TestRunnerAgent's replica is removed first, so the one the reload brings back
    (it restores the configured count) reads the new .env and crashes at every
    start, reporting `failed`. It stays routed: the agent is down by its health,
    not for want of a replica as in the stopped case. The example's agent crashes
    on TESTRUNNER_BROKEN=1."""
    store = governed.store
    _write_rules(store, _seeded(governed))
    store.set(SPEND_KEY, json.dumps({}))
    _stop_runner(governed)
    env_path = governed.dir / ".env"
    original = env_path.read_text()
    env_path.write_text(f"{original.rstrip()}\nTESTRUNNER_BROKEN=1\n")
    try:
        canyonos(recorder, ["sync"], cwd=governed.dir, timeout=SYNC_TIMEOUT)
        poll(
            lambda: store.get(DESIRED_KEY) == "1",
            timeout=RELOAD_TIMEOUT,
            interval=1,
            what=f"the reload to restore {RUNNER}'s configured replica count",
        )
        poll(
            lambda: "failed" in _runner_statuses(store),
            timeout=CRASH_TIMEOUT,
            interval=1,
            what=f"a {RUNNER} replica to report failed",
        )
        poll(
            lambda: _routes(store) != "[]" and not _runner_up(store),
            timeout=REMOVAL_TIMEOUT,
            interval=1,
            what=f"{RUNNER} routed but out of {UP_KEY}",
        )
        _settle(governed)
        request_id, status = _send(recorder, governed)
    finally:
        env_path.write_text(original)
    _expect_refusal(status, "DependencyDown")
    assert _error_name(store, request_id, "MergeAgent", "merge") == "DependencyDown"
