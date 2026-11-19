# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Two workflow groups side by side on one machine with the shared dashboard: helloworld and
portfolio deploy at the same time, each on its own ports, and the dashboard lists
both to the one API key. helloworld's endpoint and Redis containers publish the ports
it pins, and the dashboard reads each one's Redis. Each Redis takes only its own
workflow group's password, and no container's command shows one. helloworld's
workflow_group.yaml has no `otel:` block, so its traces reach the dashboard by the
default destination; portfolio keeps its own. `canyonos test` in another workflow group
folder named helloworld, with nothing deployed from it, refuses rather than test the
running one. Then one workflow is stopped and the other keeps running; the stopped
one, redeployed without `endpoint.api_port` or `redis.port`, moves past the other's
ports, keeps its machine metrics in its own Redis, and is told the running dashboard
ignores its `dashboard_port`. `canyonos serve` re-registers on a new api container,
which reads the key's hash again, a redeploy keeps the dashboard, the workflow's
id and the workflow group's CA, example runs go in with the machine's API key, and the
last stop stops the dashboard while keeping its containers. Last, `canyonos serve`
refuses a taken `dashboard_port`, a deploy pinned to a taken `api_port` stops before
anything starts, a dashboard starting with a deploy takes its `dashboard_port` while
8000-8003 are held, and with 8080 held and no dashboard up, the endpoint and the
dashboard starting with it end up on different ports. The cases are steps on one
fleet: once one fails, the rest are skipped."""

import re
import socket
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import pytest
import yaml

from ..harness import (
    API_URL,
    Api,
    bearer,
    canyonos,
    cli_value,
    dashboard_containers,
    dashboard_key,
    dashboard_port,
    deployed_endpoint,
    deployed_workflow_id,
    deployment_group,
    docker,
    docker_name,
    greets,
    http,
    manifest,
    poll,
    workflow_group_containers,
    workflow_dir,
    workflow_root,
    qualified,
    redis_password,
    redis_port,
    redis_tls_context,
    result_of,
    stage,
    stop_workflow_group,
    traces,
    workflow_name,
)
from ..fleet import redis_reply
from ..workflows import load_workflow

pytestmark = pytest.mark.steps

WORKFLOWS = ("helloworld", "portfolio")
DASHBOARD_GROUP = "canyonos-dashboard"
DASHBOARD_CONTAINERS = [
    f"{DASHBOARD_GROUP}-{service}" for service in ("api", "db", "web")
]
DASHBOARD_API = f"{DASHBOARD_GROUP}-api"
DEPLOY_TIMEOUT = 1800
HELLOWORLD_API_PORT = 8082
HELLOWORLD_REDIS_PORT = 6380
DASHBOARD_PORT = 8090
TRACE_TIMEOUT = 60
# Where a Redis container keeps the certificate it was given (redis_client.SERVER_TLS_DIR).
REDIS_CLI_TLS = [
    "--tls",
    "--cacert",
    "/tmp/canyonos-tls/ca.crt",
    "--cert",
    "/tmp/canyonos-tls/tls.crt",
    "--key",
    "/tmp/canyonos-tls/tls.key",
]


@dataclass
class Fleet:
    """The workflow group folders of the staged workflows by name, their Docker groups and
    dashboard ids, the dashboard API with the session's API key, and the dashboard
    api's container as it was after the first deploy finished: its id and start time,
    which no deploy changes while a workflow group is left running, and as `canyonos serve`
    left it."""

    dirs: dict[str, Path]
    parent: Path
    groups: dict[str, str]
    api: Api
    ids: dict[str, str]
    api_after_first_deploy: str
    api_after_both_deploys: str
    api_after_serve: str = ""


def _deploy(recorder, directory: Path, name: str) -> None:
    call = canyonos(
        recorder,
        ["deploy", str(workflow_dir(directory))],
        cwd=directory,
        timeout=DEPLOY_TIMEOUT,
    )
    registered = (
        f"Registered {workflow_name(workflow_dir(directory))} with the dashboard"
    )
    assert registered in call.output, call.output[-3000:]


def _stop(recorder, directory: Path) -> None:
    call = stop_workflow_group(recorder, directory)
    assert call is not None, f"nothing is deployed from {directory}"
    assert call.code == 0, call.output


def _api_container(recorder) -> str:
    """The dashboard api container's id and start time: a recreated or restarted
    api changes it."""
    return docker(
        recorder, ["inspect", "-f", "{{.Id}} {{.State.StartedAt}}", DASHBOARD_API]
    ).output.strip()


def _port_of(url: str) -> int:
    port = urlsplit(url).port
    assert port is not None, url
    return port


def _settings(directory: Path) -> dict:
    """The workflow group's parsed `workflow_group.yaml`."""
    return yaml.safe_load((directory / "workflow_group.yaml").read_text())


def _edit_settings(directory: Path, edit) -> None:
    path = directory / "workflow_group.yaml"
    path.write_text(edit(path.read_text()))


def _without_otel(text: str) -> str:
    edited = re.sub(r"^otel:\n(?:[ \t].*\n|\n)*", "", text, flags=re.M)
    assert "otel:" not in edited, edited
    return edited


def _pinned(text: str) -> str:
    """`text` with helloworld's api_port and Redis port fixed. Its workflow_group.yaml
    sets neither, so both blocks are added; `endpoint:` stays once a later case
    removes the api_port, for the next to put one back under it."""
    assert not re.search(r"^(endpoint|redis):", text, flags=re.M), text
    return (
        text.rstrip("\n")
        + f"\n\nendpoint:\n  api_port: {HELLOWORLD_API_PORT}\n"
        + f"\nredis:\n  host: localhost\n  port: {HELLOWORLD_REDIS_PORT}\n"
    )


def _agent_names(directory: Path) -> set[str]:
    folder = workflow_dir(directory)
    return {
        qualified(folder, agent["name"])
        for agent in manifest(folder)["agents"]
        if agent.get("type", "agent") == "agent"
    }


def _prompt_names(directory: Path) -> set[str]:
    folder = workflow_dir(directory)
    path = workflow_root(folder) / "config" / "prompts.yaml"
    if not path.is_file():
        return set()
    return {
        qualified(folder, name) for name in yaml.safe_load(path.read_text())["prompts"]
    }


def _all_running(recorder, fleet: Fleet, name: str) -> None:
    """The workflow group's Global Controller, Redis and every replica its manifest asks
    for run in its own Docker group."""
    group = fleet.groups[name]
    containers = workflow_group_containers(recorder, group)
    stopped = {c: state for c, state in containers.items() if state != "running"}
    assert not stopped, stopped
    for part in ("global-controller", "redis-localhost"):
        assert f"{group}-{part}" in containers, containers
    folder = workflow_dir(fleet.dirs[name])
    for agent in manifest(folder)["agents"]:
        if agent.get("type", "agent") != "agent":
            continue
        agent_name = docker_name(qualified(folder, agent["name"]))
        replica = re.compile(rf"{re.escape(group)}-{agent_name}-[0-9a-f]{{8}}")
        replicas = [c for c in containers if replica.fullmatch(c)]
        assert len(replicas) == agent.get("replicas", 1), (agent["name"], containers)


def _reads_own_redis(recorder, fleet: Fleet, name: str) -> None:
    """The Redis routes show this workflow's own agents, endpoint and prompts, which
    differ between the two workflows, so a Redis read from the other one fails."""
    directory = fleet.dirs[name]
    base = f"/workflows/{fleet.ids[name]}"
    agents = fleet.api.get(f"{base}/scaling/agents").json()["agents"]
    assert {agent["name"] for agent in agents} == _agent_names(directory), agents
    endpoint = fleet.api.get(f"{base}/monitoring/endpoint").json()["endpoint"]
    assert endpoint is not None, f"{name} records no endpoint"
    served = [(route["agent"], route["method"]) for route in endpoint["routes"]]
    routes = manifest(workflow_dir(directory))["endpoint"]["routes"]
    assert served == [(route["agent"], route["method"]) for route in routes], endpoint
    running = deployed_endpoint(recorder, directory)
    assert _port_of(endpoint["routes"][0]["url"]) == _port_of(running.url), endpoint
    prompts = fleet.api.get(f"{base}/prompts").json()
    assert {prompt["name"] for prompt in prompts} == _prompt_names(directory), prompts


def _ca_certificate(recorder, directory: Path) -> str:
    """The certificate of the workflow group's CA, from the CLI's folder."""
    path = cli_value(
        recorder,
        directory,
        "ca_paths()[0]",
        "from canyonos.internal_ca import ca_paths",
    )
    return Path(path).read_text()


@contextmanager
def _held(port: int):
    """Keep `port` taken on every interface, as another program on the machine would."""
    holder = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    # Binds past a TIME_WAIT a just-stopped Global Controller left on the port.
    holder.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
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
        call = stop_workflow_group(recorder, directory)
        if call is not None and call.code != 0:
            problems.append(f"canyonos stop in {directory}: {call.output[-2000:]}")
    for group in groups.values():
        left = workflow_group_containers(recorder, group, every=True)
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
    """Both workflows staged, helloworld on fixed ports so it can't race portfolio's
    api_port 8080 and Redis 6379 and with its `otel:` block removed, then deployed
    at the same time. `canyonos serve` runs first, as for the `deployed` fixture: the
    dashboard API reads the hash of the session's API key only when it starts, and a deploy
    leaves a running dashboard as it is. Every folder a case deploys from is stopped afterwards and the
    dashboard removed, whether the cases passed or not."""
    parent = tmp_path_factory.mktemp("fleet")
    dirs, groups = {}, {}
    request.addfinalizer(lambda: _tear_down(recorder, dirs, groups))
    for name in WORKFLOWS:
        workflow = load_workflow(name)
        secrets = {
            secret: f"not-a-real-{secret.lower()}" for secret in workflow.secrets
        }
        dirs[name] = stage(recorder, workflow, parent, secrets)
    _edit_settings(dirs["helloworld"], lambda text: _without_otel(_pinned(text)))
    pinned = _settings(dirs["helloworld"])
    assert pinned["endpoint"]["api_port"] == HELLOWORLD_API_PORT, pinned
    assert pinned["redis"]["port"] == HELLOWORLD_REDIS_PORT, pinned
    canyonos(recorder, ["serve"], cwd=parent, timeout=600)
    api_after_first = ""
    with ThreadPoolExecutor(max_workers=len(WORKFLOWS)) as pool:
        running = [
            pool.submit(_deploy, recorder, dirs[name], name) for name in WORKFLOWS
        ]
        for done in as_completed(running):
            done.result()
            api_after_first = api_after_first or _api_container(recorder)
    for name in WORKFLOWS:
        groups[name] = deployment_group(recorder, dirs[name])
    api = Api(recorder, API_URL, dashboard_key(recorder))
    return Fleet(
        dirs=dirs,
        parent=parent,
        groups=groups,
        api=api,
        ids={name: deployed_workflow_id(api, dirs[name]) for name in WORKFLOWS},
        api_after_first_deploy=api_after_first,
        api_after_both_deploys=_api_container(recorder),
    )


def test_both_deploy_at_once_and_register(fleet):
    assert fleet.api_after_both_deploys == fleet.api_after_first_deploy, (
        "the later deploy recreated or restarted the dashboard api"
    )
    assert len(set(fleet.ids.values())) == len(WORKFLOWS), fleet.ids


def test_one_api_key_lists_both_workflows(recorder, fleet):
    """The dashboard needs the API key, and the key is for the whole machine, not
    for one workflow."""
    status = http(recorder, "GET", f"{API_URL}/auth/status").json()
    assert status == {"api_key_required": True}, status
    anonymous = http(recorder, "GET", f"{API_URL}/workflows", check=False)
    assert anonymous.code == 401, anonymous.output
    assert anonymous.json()["error"] == "auth.missing_key", anonymous.output
    headers = bearer(recorder.api_key)
    workflows = http(recorder, "GET", f"{API_URL}/workflows", headers=headers).json()
    listed = {workflow["id"] for workflow in workflows}
    assert set(fleet.ids.values()) <= listed, workflows


def test_each_workflow_group_has_its_own_docker_group_and_one_dashboard(
    recorder, fleet
):
    for name in WORKFLOWS:
        group = fleet.groups[name]
        config = yaml.safe_load((fleet.dirs[name] / "workflow_group.yaml").read_text())
        expected = rf"canyonos-{name}-{re.escape(config['workflow_group_id'][:8])}"
        assert re.fullmatch(expected, group), group
        _all_running(recorder, fleet, name)
    assert fleet.groups["helloworld"] != fleet.groups["portfolio"]
    assert dashboard_containers(recorder) == DASHBOARD_CONTAINERS


def test_pinned_ports_are_the_published_host_ports(recorder, fleet):
    containers = workflow_group_containers(recorder, fleet.groups["helloworld"])
    for suffix, port in (
        (r"-endpoint-[0-9a-f]{8}", HELLOWORLD_API_PORT),
        ("-redis-localhost", HELLOWORLD_REDIS_PORT),
    ):
        named = [name for name in containers if re.search(f"{suffix}$", name)]
        assert len(named) == 1, (suffix, containers)
        published = docker(recorder, ["port", named[0]]).output.splitlines()
        assert {int(line.rsplit(":", 1)[1]) for line in published} == {port}, published


def test_dashboard_reads_each_workflow_groups_own_redis(recorder, fleet):
    for name in WORKFLOWS:
        _reads_own_redis(recorder, fleet, name)
        base = f"/workflows/{fleet.ids[name]}"

        def all_replicas_up(base=base):
            agents = fleet.api.get(f"{base}/scaling/agents").json()["agents"]
            return all(
                agent["replicas_running"] == agent["replicas_expected"] >= 1
                for agent in agents
            )

        poll(all_replicas_up, timeout=120, what=f"every agent of {name} running")


def test_each_workflow_groups_redis_takes_only_its_own_password(recorder, fleet):
    passwords = {}
    for name in WORKFLOWS:
        password = redis_password(recorder, fleet.dirs[name])
        assert re.fullmatch(r"[0-9a-f]{64}", password), f"{name}'s Redis password"
        passwords[name] = password
    assert passwords["helloworld"] != passwords["portfolio"]
    for name, other in zip(WORKFLOWS, reversed(WORKFLOWS)):
        port = redis_port(recorder, fleet.dirs[name])
        tls = redis_tls_context(recorder, fleet.dirs[name])
        unsigned = redis_reply(port, "PING", tls=tls)
        assert unsigned.startswith("-NOAUTH "), (name, unsigned)
        crossed = redis_reply(port, "AUTH", passwords[other], tls=tls)
        assert crossed.startswith("-WRONGPASS "), (name, other, crossed)
        assert redis_reply(port, "AUTH", passwords[name], tls=tls) == "+OK", name
    containers = [
        container
        for name in WORKFLOWS
        for container in workflow_group_containers(
            recorder, fleet.groups[name], every=True
        )
    ]
    commands = docker(
        recorder,
        ["inspect", "-f", "{{.Name}} {{json .Path}} {{json .Args}}", *containers],
    ).output.splitlines()
    leaked = [
        command.split()[0]
        for command in commands
        if any(password in command for password in passwords.values())
    ]
    assert not leaked, f"a Redis password is in the command of {leaked}"


def test_helloworld_without_an_otel_block_sends_traces_to_the_dashboard(
    recorder, fleet
):
    directory = fleet.dirs["helloworld"]
    assert "otel" not in _settings(directory), _settings(directory)
    endpoint = deployed_endpoint(recorder, directory)
    request_id, result = result_of(recorder, endpoint, "no-otel", timeout=60)
    assert result == {"greeting": "Hello, no-otel! I'm the HelloAgent!"}, result

    hello_call = qualified(workflow_dir(directory), "HelloAgent.hello")

    def helloworld_trace():
        return [
            trace
            for trace in traces(fleet.api, fleet.ids["helloworld"])
            if trace["trace_id"] == request_id
            and any(span["name"] == hello_call for span in trace["spans"])
        ]

    poll(
        helloworld_trace,
        timeout=TRACE_TIMEOUT,
        interval=2,
        what=f"the no-otel request's {hello_call} span on the dashboard",
    )


def test_test_in_another_folder_of_the_same_name_refuses(recorder, fleet):
    twin = stage(recorder, load_workflow("helloworld"), fleet.parent / "twin", {})
    assert twin.name == fleet.dirs["helloworld"].name, twin
    call = canyonos(recorder, ["test", "twin", "--json"], cwd=twin, check=False)
    assert call.code != 0, call.output
    assert call.json()["error"].startswith(
        "No workflow group is running from this folder."
    ), call.stdout
    greets(recorder, fleet.dirs["helloworld"], "still-here")


def test_stopping_one_leaves_the_other_and_the_dashboard(recorder, fleet):
    state_of = {
        name: Path(
            cli_value(
                recorder,
                fleet.dirs[name],
                "state_path()",
                "from canyonos.deployment import state_path",
            )
        )
        for name in WORKFLOWS
    }
    _stop(recorder, fleet.dirs["helloworld"])
    left = workflow_group_containers(recorder, fleet.groups["helloworld"], every=True)
    assert not left, left
    assert not state_of["helloworld"].exists(), state_of["helloworld"]
    assert state_of["portfolio"].is_file(), state_of["portfolio"]
    _all_running(recorder, fleet, "portfolio")
    assert dashboard_containers(recorder) == DASHBOARD_CONTAINERS
    _reads_own_redis(recorder, fleet, "portfolio")
    stopped = fleet.api.get(
        f"/workflows/{fleet.ids['helloworld']}/prompts", check=False
    )
    assert stopped.code == 502, stopped.output


def test_redeploy_without_fixed_ports_moves_past_the_other_workflow_group(
    recorder, fleet
):
    directory = fleet.dirs["helloworld"]
    portfolio = fleet.dirs["portfolio"]
    _edit_settings(
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
        assert dashboard_port(recorder) != DASHBOARD_PORT
        _reads_own_redis(recorder, fleet, "helloworld")
        greets(recorder, directory, "moved")
        container = f"{fleet.groups['helloworld']}-redis-localhost"

        def metrics_stored():
            call = docker(
                recorder,
                [
                    "exec",
                    container,
                    "sh",
                    "-c",
                    'REDISCLI_AUTH="$CANYONOS_REDIS_PASSWORD" exec redis-cli "$@"',
                    "redis-cli",
                    # Redis's own certificate is signed by the workflow group's CA too.
                    *REDIS_CLI_TLS,
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
        stop = stop_workflow_group(recorder, directory)
    assert stop is None or stop.code == 0, stop.output


def test_serve_registers_again_on_a_new_api(recorder, fleet):
    call = canyonos(recorder, ["serve"], cwd=fleet.dirs["portfolio"], timeout=600)
    registered = (
        f"Registered {workflow_name(workflow_dir(fleet.dirs['portfolio']))} with"
    )
    assert registered in call.output, call.output
    fleet.api_after_serve = _api_container(recorder)
    assert fleet.api_after_serve != fleet.api_after_both_deploys, (
        "canyonos serve kept the api container, so it never read the key's hash again"
    )
    _reads_own_redis(recorder, fleet, "portfolio")


def test_redeploy_keeps_the_dashboard_and_the_workflow_id(recorder, fleet):
    directory = fleet.dirs["portfolio"]
    ca_before = _ca_certificate(recorder, directory)
    _deploy(recorder, directory, "portfolio")
    assert _ca_certificate(recorder, directory) == ca_before, (
        "the redeploy made a new CA"
    )
    assert _api_container(recorder) == fleet.api_after_serve
    for name in WORKFLOWS:
        listed = deployed_workflow_id(fleet.api, fleet.dirs[name])
        assert listed == fleet.ids[name], (name, listed)
    _reads_own_redis(recorder, fleet, "portfolio")


def test_the_cli_sends_the_api_key_to_add_sample_data(recorder, fleet):
    """What quickstart's last stage calls: example runs go in with the machine's API
    key, here the session's CANYONOS_API_KEY."""
    added = cli_value(
        recorder,
        fleet.dirs["portfolio"],
        f"add_sample_data({fleet.ids['portfolio']!r}, 'portfolio')",
        "from canyonos.dashboard_registration import add_sample_data",
    )
    assert added["spans"] > 0, added


def test_last_stop_stops_the_dashboard_and_keeps_it(recorder, fleet):
    _stop(recorder, fleet.dirs["portfolio"])
    for group in fleet.groups.values():
        left = workflow_group_containers(recorder, group, every=True)
        assert not left, left
    assert not dashboard_containers(recorder), dashboard_containers(recorder)
    assert dashboard_containers(recorder, every=True) == DASHBOARD_CONTAINERS


def test_serve_refuses_a_taken_dashboard_port(recorder, fleet):
    directory = fleet.dirs["helloworld"]
    assert _settings(directory)["dashboard_port"] == DASHBOARD_PORT
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
    _edit_settings(
        directory,
        lambda text: re.sub(
            r"^endpoint:$", "endpoint:\n  api_port: 8080", text, flags=re.M
        ),
    )
    try:
        with _held(8080):
            call = canyonos(
                recorder,
                ["deploy", str(workflow_dir(directory))],
                cwd=directory,
                timeout=DEPLOY_TIMEOUT,
                check=False,
            )
    finally:
        _edit_settings(
            directory, lambda text: re.sub(r"^\s*api_port:.*\n", "", text, flags=re.M)
        )
    assert call.code == 1, call.output
    refused = (
        "Port 8080 is already in use, and the endpoint needs it. Free it, or change "
        "`endpoint.api_port` in"
    )
    assert refused in " ".join(call.output.split()), call.output
    left = workflow_group_containers(recorder, fleet.groups["helloworld"], every=True)
    assert not left, left
    assert not dashboard_containers(recorder), dashboard_containers(recorder)


def test_a_starting_dashboard_takes_its_dashboard_port(recorder, fleet):
    directory = fleet.dirs["helloworld"]
    _edit_settings(
        directory,
        lambda text: re.sub(
            r"^dashboard_port:.*$", "dashboard_port: 8301", text, flags=re.M
        ),
    )
    try:
        with _held(8000), _held(8001), _held(8002), _held(8003):
            _deploy(recorder, directory, "helloworld")
        assert dashboard_port(recorder) == 8301
    finally:
        stop = stop_workflow_group(recorder, directory)
    assert stop is None or stop.code == 0, stop.output


def test_endpoint_and_a_starting_dashboard_get_their_own_ports(recorder, fleet):
    directory = fleet.dirs["helloworld"]
    _edit_settings(
        directory, lambda text: re.sub(r"^dashboard_port:.*\n", "", text, flags=re.M)
    )
    assert dashboard_containers(recorder) == [], (
        "the dashboard must start with this deploy"
    )
    try:
        with _held(8080):
            _deploy(recorder, directory, "helloworld")
        api_port = _port_of(deployed_endpoint(recorder, directory).url)
        web_port = dashboard_port(recorder)
        assert 8080 not in (api_port, web_port), (api_port, web_port)
        assert api_port != web_port, api_port
        assert dashboard_containers(recorder) == DASHBOARD_CONTAINERS
        greets(recorder, directory, "own-port")
    finally:
        stop = stop_workflow_group(recorder, directory)
    assert stop is None or stop.code == 0, stop.output
