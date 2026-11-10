# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Two projects side by side on one machine with the shared dashboard: helloworld and
portfolio deploy at the same time, each on its own ports, and the dashboard lists
both and reads each one's Redis. helloworld has no `otel:` block, so its traces reach
the dashboard by the default destination; portfolio and the helloworld cases keep
theirs. `canyonos test` in another folder named helloworld tests that folder, not
the running one. Then one project is stopped and the other keeps running; the
stopped one, redeployed without `endpoint.api_port` or `redis.port`, moves past the
other's ports, keeps its machine metrics in its own Redis, and is told the running
dashboard ignores its `dashboard_port`. `canyonos serve` re-registers without
recreating the api, a redeploy keeps the dashboard and the project's id, and the
last stop stops the dashboard while keeping its containers. Last, `canyonos serve`
refuses a taken `dashboard_port`, a deploy pinned to a taken `api_port` stops before
anything starts, and with 8080 held and no dashboard up, the endpoint and the
dashboard starting with it end up on different ports. The cases are steps on one
fleet: once one fails, the rest are skipped."""

import re
import socket
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit

import pytest
import yaml

from ..harness import (
    API_URL,
    Api,
    canyonos,
    cli_value,
    dashboard_containers,
    deployed_endpoint,
    deployed_project_id,
    docker,
    manifest,
    poll,
    project_containers,
    project_group,
    project_root,
    redis_port,
    result_of,
    sign_in,
    stage,
    stop_project,
)
from ..projects import load_project

pytestmark = pytest.mark.steps

PROJECTS = ("helloworld", "portfolio")
DASHBOARD_GROUP = "canyonos-dashboard"
DASHBOARD_CONTAINERS = [
    f"{DASHBOARD_GROUP}-{service}" for service in ("api", "db", "web")
]
DASHBOARD_API = f"{DASHBOARD_GROUP}-api"
DASHBOARD_WEB = f"{DASHBOARD_GROUP}-web"
DEPLOY_TIMEOUT = 1800
HELLOWORLD_API_PORT = 8082
HELLOWORLD_REDIS_PORT = 6380
DASHBOARD_PORT = 8090
TRACE_TIMEOUT = 60
TWIN_GREETING = "Twin hello"


@dataclass
class Fleet:
    """The staged projects by name, their Docker groups and dashboard ids, the
    signed-in dashboard, and the dashboard api's container as it was after the first
    deploy finished: its id and start time, which must not change while a project is
    left running."""

    dirs: dict[str, Path]
    parent: Path
    groups: dict[str, str]
    api: Api
    ids: dict[str, str]
    api_after_first_deploy: str
    api_after_both_deploys: str


def _deploy(recorder, directory: Path, name: str) -> None:
    call = canyonos(recorder, ["deploy"], cwd=directory, timeout=DEPLOY_TIMEOUT)
    assert f"Registered {name} with the dashboard" in call.output, call.output[-3000:]


def _stop(recorder, directory: Path) -> None:
    call = stop_project(recorder, directory)
    assert call is not None, f"nothing is deployed from {directory}"
    assert call.code == 0, call.output


def _api_container(recorder) -> str:
    """The dashboard api container's id and start time: a recreated or restarted
    api changes it."""
    return docker(
        recorder, ["inspect", "-f", "{{.Id}} {{.State.StartedAt}}", DASHBOARD_API]
    ).output.strip()


def _dashboard_port(recorder) -> int:
    """The host port the running dashboard's web container is published on."""
    published = docker(recorder, ["port", DASHBOARD_WEB, "8080/tcp"]).output
    return int(published.split()[0].rsplit(":", 1)[1])


def _port_of(url: str) -> int:
    port = urlsplit(url).port
    assert port is not None, url
    return port


def _edit_manifest(directory: Path, edit) -> None:
    path = project_root(directory) / "config" / "global_controller.yaml"
    path.write_text(edit(path.read_text()))


def _without_otel(text: str) -> str:
    edited = re.sub(r"^otel:\n(?:[ \t].*\n|\n)*", "", text, flags=re.M)
    assert "otel:" not in edited, edited
    return edited


def _agent_names(directory: Path) -> set[str]:
    return {
        agent["name"]
        for agent in manifest(directory)["agents"]
        if agent.get("type", "agent") == "agent"
    }


def _prompt_names(directory: Path) -> set[str]:
    path = project_root(directory) / "config" / "prompts.yaml"
    if not path.is_file():
        return set()
    return set(yaml.safe_load(path.read_text())["prompts"])


def _all_running(recorder, fleet: Fleet, name: str) -> None:
    """The project's Global Controller, Redis and every replica its manifest asks
    for run in its own Docker group."""
    group = fleet.groups[name]
    containers = project_containers(recorder, group)
    stopped = {c: state for c, state in containers.items() if state != "running"}
    assert not stopped, stopped
    for part in ("global-controller", "redis-localhost"):
        assert f"{group}-{part}" in containers, containers
    for agent in manifest(fleet.dirs[name])["agents"]:
        if agent.get("type", "agent") != "agent":
            continue
        replica = re.compile(
            rf"{re.escape(group)}-{agent['name'].lower()}-[0-9a-f]{{8}}"
        )
        replicas = [c for c in containers if replica.fullmatch(c)]
        assert len(replicas) == agent.get("replicas", 1), (agent["name"], containers)


def _reads_own_redis(recorder, fleet: Fleet, name: str) -> None:
    """The Redis routes show this project's own agents, endpoint and prompts, which
    differ between the two projects, so a Redis read from the other one fails."""
    directory = fleet.dirs[name]
    base = f"/projects/{fleet.ids[name]}"
    agents = fleet.api.get(f"{base}/scaling/agents").json()["agents"]
    assert {agent["name"] for agent in agents} == _agent_names(directory), agents
    endpoint = fleet.api.get(f"{base}/monitoring/endpoint").json()["endpoint"]
    spec = manifest(directory)["endpoint"]
    assert endpoint is not None, f"{name} records no endpoint"
    assert (endpoint["agent"], endpoint["method"]) == (spec["agent"], spec["method"])
    running = deployed_endpoint(recorder, directory)
    assert _port_of(endpoint["url"]) == _port_of(running.url), (endpoint, running)
    prompts = fleet.api.get(f"{base}/prompts").json()
    assert {prompt["name"] for prompt in prompts} == _prompt_names(directory), prompts


def _greets(recorder, directory: Path, name: str, greeting: str = "Hello"):
    endpoint = deployed_endpoint(recorder, directory)
    _, result = result_of(recorder, endpoint, name, timeout=60)
    assert result == {"greeting": f"{greeting}, {name}! I'm the HelloAgent!"}, result
    return endpoint


def _traces(api: Api, project_id: str) -> list[dict]:
    now = datetime.now(timezone.utc)
    window = urlencode(
        {
            "from": (now - timedelta(hours=1)).isoformat(),
            "to": (now + timedelta(minutes=5)).isoformat(),
        }
    )
    path = f"/projects/{project_id}/monitoring/traces?{window}"
    return api.get(path).json()["traces"]


@contextmanager
def _held(port: int):
    """Keep `port` taken on every interface, as another program on the machine would."""
    holder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    holder.bind(("", port))
    holder.listen()
    try:
        yield
    finally:
        holder.close()


def _tear_down(recorder, dirs: dict[str, Path], groups: dict[str, str]) -> None:
    """Stop every folder the fleet deployed from and remove the dashboard, then
    fail naming each stop that failed and each group left with containers."""
    problems = []
    for directory in dirs.values():
        call = stop_project(recorder, directory)
        if call is not None and call.code != 0:
            problems.append(f"canyonos stop in {directory}: {call.output[-2000:]}")
    for group in groups.values():
        left = project_containers(recorder, group, every=True)
        if left:
            problems.append(f"{group} left {left}")
    docker(
        recorder,
        ["compose", "-p", DASHBOARD_GROUP, "down", "--remove-orphans"],
        check=False,
    )
    assert not problems, "\n".join(problems)


@pytest.fixture(scope="module")
def fleet(request, recorder, images, tmp_path_factory) -> Fleet:
    """Both projects staged, helloworld on fixed ports so it can't race portfolio's
    api_port 8080 and Redis 6379 and with its `otel:` block removed, then deployed
    at the same time. Every folder a case deploys from is stopped afterwards and the
    dashboard removed, whether the cases passed or not."""
    parent = tmp_path_factory.mktemp("fleet")
    dirs, groups = {}, {}
    request.addfinalizer(lambda: _tear_down(recorder, dirs, groups))
    for name in PROJECTS:
        project = load_project(name)
        secrets = {secret: f"not-a-real-{secret.lower()}" for secret in project.secrets}
        dirs[name] = stage(recorder, project, parent, secrets)
    _edit_manifest(
        dirs["helloworld"],
        lambda text: _without_otel(
            re.sub(
                r"^redis:$",
                f"redis:\n  port: {HELLOWORLD_REDIS_PORT}",
                re.sub(
                    r"^endpoint:$",
                    f"endpoint:\n  api_port: {HELLOWORLD_API_PORT}",
                    text,
                    flags=re.M,
                ),
                flags=re.M,
            )
        ),
    )
    api_after_first = ""
    with ThreadPoolExecutor(max_workers=len(PROJECTS)) as pool:
        running = [
            pool.submit(_deploy, recorder, dirs[name], name) for name in PROJECTS
        ]
        for done in as_completed(running):
            done.result()
            api_after_first = api_after_first or _api_container(recorder)
    for name in PROJECTS:
        groups[name] = project_group(recorder, dirs[name])
    api = Api(recorder, API_URL, sign_in(recorder, API_URL))
    return Fleet(
        dirs=dirs,
        parent=parent,
        groups=groups,
        api=api,
        ids={
            name: deployed_project_id(recorder, api, dirs[name], name)
            for name in PROJECTS
        },
        api_after_first_deploy=api_after_first,
        api_after_both_deploys=_api_container(recorder),
    )


def test_both_deploy_at_once_and_register(fleet):
    assert fleet.api_after_both_deploys == fleet.api_after_first_deploy, (
        "the later deploy recreated or restarted the dashboard api"
    )
    assert len(set(fleet.ids.values())) == len(PROJECTS), fleet.ids


def test_each_project_has_its_own_group_and_one_dashboard(recorder, fleet):
    for name in PROJECTS:
        group = fleet.groups[name]
        expected = rf"canyonos-{name}-{re.escape(fleet.ids[name][:8])}"
        assert re.fullmatch(expected, group), group
        _all_running(recorder, fleet, name)
    assert fleet.groups["helloworld"] != fleet.groups["portfolio"]
    assert dashboard_containers(recorder) == DASHBOARD_CONTAINERS


def test_dashboard_reads_each_projects_own_redis(recorder, fleet):
    for name in PROJECTS:
        _reads_own_redis(recorder, fleet, name)
        base = f"/projects/{fleet.ids[name]}"

        def all_replicas_up(base=base):
            agents = fleet.api.get(f"{base}/scaling/agents").json()["agents"]
            return all(
                agent["replicas_running"] == agent["replicas_expected"] >= 1
                for agent in agents
            )

        poll(all_replicas_up, timeout=120, what=f"every agent of {name} running")


def test_helloworld_without_an_otel_block_sends_traces_to_the_dashboard(
    recorder, fleet
):
    directory = fleet.dirs["helloworld"]
    assert "otel" not in manifest(directory), manifest(directory)
    endpoint = deployed_endpoint(recorder, directory)
    request_id, result = result_of(recorder, endpoint, "no-otel", timeout=60)
    assert result == {"greeting": "Hello, no-otel! I'm the HelloAgent!"}, result

    def helloworld_trace():
        traces = _traces(fleet.api, fleet.ids["helloworld"])
        return [
            trace
            for trace in traces
            if trace["trace_id"] == request_id
            and any(span["name"] == "HelloAgent.hello" for span in trace["spans"])
        ]

    poll(
        helloworld_trace,
        timeout=TRACE_TIMEOUT,
        interval=2,
        what="the no-otel request's HelloAgent.hello span on the dashboard",
    )


def test_test_in_another_folder_of_the_same_name_tests_that_folder(recorder, fleet):
    twin = stage(recorder, load_project("helloworld"), fleet.parent / "twin", {})
    fleet.dirs["twin"] = twin
    agent = twin / "agents" / "hello_agent.py"
    original = agent.read_text()
    agent.write_text(original.replace('f"Hello, ', f'f"{TWIN_GREETING}, '))
    assert agent.read_text() != original, original
    call = canyonos(recorder, ["test", "twin", "--json"], cwd=twin, timeout=900)
    body = call.json()
    assert body["against_existing_deploy"] is False, call.stdout
    assert body["result"] == {
        "greeting": f"{TWIN_GREETING}, twin! I'm the HelloAgent!"
    }, call.stdout
    fleet.groups["twin"] = project_group(recorder, twin)
    assert fleet.groups["twin"] != fleet.groups["helloworld"]
    left = project_containers(recorder, fleet.groups["twin"], every=True)
    assert not left, left
    _greets(recorder, fleet.dirs["helloworld"], "still-here")


def test_stopping_one_leaves_the_other_and_the_dashboard(recorder, fleet):
    state_of = {
        name: Path(
            cli_value(
                recorder,
                fleet.dirs[name],
                "state_path()",
                "from canyonos.project import state_path",
            )
        )
        for name in PROJECTS
    }
    _stop(recorder, fleet.dirs["helloworld"])
    left = project_containers(recorder, fleet.groups["helloworld"], every=True)
    assert not left, left
    assert not state_of["helloworld"].exists(), state_of["helloworld"]
    assert state_of["portfolio"].is_file(), state_of["portfolio"]
    _all_running(recorder, fleet, "portfolio")
    assert dashboard_containers(recorder) == DASHBOARD_CONTAINERS
    _reads_own_redis(recorder, fleet, "portfolio")
    stopped = fleet.api.get(f"/projects/{fleet.ids['helloworld']}/prompts", check=False)
    assert stopped.code == 502, stopped.output


def test_redeploy_without_fixed_ports_moves_past_the_other_project(recorder, fleet):
    directory = fleet.dirs["helloworld"]
    portfolio = fleet.dirs["portfolio"]
    _edit_manifest(
        directory,
        lambda text: (
            re.sub(
                rf"^\s*api_port:.*\n|^  port: {HELLOWORLD_REDIS_PORT}\n",
                "",
                text,
                flags=re.M,
            )
            + f"dashboard_port: {DASHBOARD_PORT}\n"
        ),
    )
    try:
        _deploy(recorder, directory, "helloworld")
        api_port = _port_of(deployed_endpoint(recorder, directory).url)
        taken_api = _port_of(deployed_endpoint(recorder, portfolio).url)
        assert api_port != taken_api, api_port
        own_redis = redis_port(recorder, directory)
        assert own_redis != redis_port(recorder, portfolio), own_redis
        assert _dashboard_port(recorder) != DASHBOARD_PORT
        _reads_own_redis(recorder, fleet, "helloworld")
        _greets(recorder, directory, "moved")
        container = f"{fleet.groups['helloworld']}-redis-localhost"

        def metrics_stored():
            call = docker(
                recorder,
                [
                    "exec",
                    container,
                    "redis-cli",
                    "-p",
                    str(own_redis),
                    "exists",
                    "machine:localhost:metrics",
                ],
                check=False,
            )
            return call.output.strip() == "1"

        poll(
            metrics_stored,
            timeout=30,
            interval=2,
            what=f"machine metrics in {container}",
        )
    finally:
        stop = stop_project(recorder, directory)
    assert stop is None or stop.code == 0, stop.output


def test_serve_registers_again_without_recreating_the_api(recorder, fleet):
    call = canyonos(recorder, ["serve"], cwd=fleet.dirs["portfolio"], timeout=600)
    assert "Registered portfolio with the dashboard" in call.output, call.output
    assert _api_container(recorder) == fleet.api_after_both_deploys


def test_redeploy_keeps_the_dashboard_and_the_project_id(recorder, fleet):
    _deploy(recorder, fleet.dirs["portfolio"], "portfolio")
    assert _api_container(recorder) == fleet.api_after_both_deploys
    for name in PROJECTS:
        listed = deployed_project_id(recorder, fleet.api, fleet.dirs[name], name)
        assert listed == fleet.ids[name], (name, listed)
    _reads_own_redis(recorder, fleet, "portfolio")


def test_last_stop_stops_the_dashboard_and_keeps_it(recorder, fleet):
    _stop(recorder, fleet.dirs["portfolio"])
    for group in fleet.groups.values():
        left = project_containers(recorder, group, every=True)
        assert not left, left
    assert not dashboard_containers(recorder), dashboard_containers(recorder)
    assert dashboard_containers(recorder, every=True) == DASHBOARD_CONTAINERS


def test_serve_refuses_a_taken_dashboard_port(recorder, fleet):
    directory = fleet.dirs["helloworld"]
    assert manifest(directory)["dashboard_port"] == DASHBOARD_PORT
    with _held(DASHBOARD_PORT):
        call = canyonos(recorder, ["serve"], cwd=directory, timeout=600, check=False)
    assert call.code == 1, call.output
    refused = f"Port {DASHBOARD_PORT} is taken. Change `dashboard_port`, or remove it"
    assert refused in call.output, call.output
    assert not dashboard_containers(recorder), dashboard_containers(recorder)


def test_a_deploy_pinned_to_a_taken_api_port_stops_before_anything_starts(
    recorder, fleet
):
    directory = fleet.dirs["helloworld"]
    _edit_manifest(
        directory,
        lambda text: re.sub(
            r"^endpoint:$", "endpoint:\n  api_port: 8080", text, flags=re.M
        ),
    )
    try:
        with _held(8080):
            call = canyonos(
                recorder, ["deploy"], cwd=directory, timeout=DEPLOY_TIMEOUT, check=False
            )
    finally:
        _edit_manifest(
            directory, lambda text: re.sub(r"^\s*api_port:.*\n", "", text, flags=re.M)
        )
    assert call.code == 1, call.output
    refused = (
        "Port 8080 is already in use, and the endpoint needs it. Free it, or change "
        "`endpoint.api_port` in"
    )
    assert refused in " ".join(call.output.split()), call.output
    left = project_containers(recorder, fleet.groups["helloworld"], every=True)
    assert not left, left
    assert not dashboard_containers(recorder), dashboard_containers(recorder)


def test_endpoint_and_a_starting_dashboard_get_their_own_ports(recorder, fleet):
    directory = fleet.dirs["helloworld"]
    _edit_manifest(
        directory, lambda text: re.sub(r"^dashboard_port:.*\n", "", text, flags=re.M)
    )
    assert dashboard_containers(recorder) == [], (
        "the dashboard must start with this deploy"
    )
    try:
        with _held(8080):
            _deploy(recorder, directory, "helloworld")
        api_port = _port_of(deployed_endpoint(recorder, directory).url)
        dashboard_port = _dashboard_port(recorder)
        assert 8080 not in (api_port, dashboard_port), (api_port, dashboard_port)
        assert api_port != dashboard_port, api_port
        assert dashboard_containers(recorder) == DASHBOARD_CONTAINERS
        _greets(recorder, directory, "own-port")
    finally:
        stop = stop_project(recorder, directory)
    assert stop is None or stop.code == 0, stop.output
