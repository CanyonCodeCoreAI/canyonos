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
running one. With the dashboard's database stopped, the dashboard and both workflow
groups' status answer 503 and `status` and `sync` name the database and the fix; once
it runs again the same API serves both. A deploy of helloworld with a new
`--api-key` moves the dashboard and helloworld to it while portfolio keeps the old key.
Then one workflow is stopped and the other keeps running; the stopped
one, redeployed without `endpoint.api_port` or `redis.port`, moves past the other's
ports, keeps its machine metrics in its own Redis, and is told the running dashboard
ignores its `dashboard_port`. `canyonos serve` re-registers on a new api container,
which reads the key's hash again, a redeploy keeps the dashboard, the workflow's
id and the workflow group's CA, example runs go in with the machine's API key, and the
last stop stops the dashboard while keeping its containers. Last, `canyonos serve`
refuses a taken `dashboard_port`, a deploy pinned to an `api_port` another program
holds or the dashboard's API is on stops before anything starts, a dashboard
starting with a deploy takes its `dashboard_port`, even the API's default, with the
API moving past it, while an unreadable workflow group record and a stale
port-forward record claim nothing, and its Global Controller publishes no port, and
with 8080 held and no dashboard up, the endpoint and the dashboard starting with it end
up on different ports, the dashboard's picked from its default again. The cases are
steps on one fleet: once one fails, the rest are skipped."""

import json
import os
import re
import secrets
import socket
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from urllib.parse import urlsplit

import pytest
import yaml

from ..harness import (
    Api,
    api_url,
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
    workflow_group_id,
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
DASHBOARD_DB = f"{DASHBOARD_GROUP}-db"
DEPLOY_TIMEOUT = 1800
HELLOWORLD_API_PORT = 8082
HELLOWORLD_REDIS_PORT = 6380
DASHBOARD_PORT = 8090
# The API's default port, set as the dashboard's in one case, so the API moves past it.
DASHBOARD_API_PORT = 3000
SYNC_TIMEOUT = 300
# How long the API may take to answer again once its database runs again.
DATABASE_BACK_TIMEOUT = 60
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


def _deploy(recorder, directory: Path, name: str, *args: str):
    """`canyonos deploy` of the workflow in `directory` with `args`; fail unless it
    registered with the dashboard, and return the call."""
    call = canyonos(
        recorder,
        ["deploy", str(workflow_dir(directory)), *args],
        cwd=directory,
        timeout=DEPLOY_TIMEOUT,
    )
    registered = (
        f"Registered {workflow_name(workflow_dir(directory))} with the dashboard"
    )
    assert registered in call.output, call.output[-3000:]
    return call


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
    group_id = workflow_group_id(directory)
    base = f"/v1/workflow-groups/{group_id}/workflows/{fleet.ids[name]}"
    agents = fleet.api.get(f"{base}/scaling/agents").json()["agents"]
    namespace = uuid.UUID(fleet.ids[name])
    assert {(agent["name"], agent["agent_id"]) for agent in agents} == {
        (agent, str(uuid.uuid5(namespace, agent))) for agent in _agent_names(directory)
    }, agents
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


def _said(call) -> str:
    return " ".join(call.output.split())


def _refused_with(call, code: str) -> bool:
    """Whether `call` was refused with 401 and the error `code`, in the dashboard API's
    `error` or the endpoint's `error_name`."""
    if call.code != 401:
        return False
    body = call.json()
    return code in (body.get("error"), body.get("error_name"))


def _status(recorder, directory: Path):
    """`canyonos status --json` from `directory`, whatever it exits with."""
    return canyonos(recorder, ["status", "--json"], cwd=directory, check=False)


@contextmanager
def _api_key_file_kept():
    """Put `~/.canyonos/api_key` back as it was afterwards: a deploy with `--api-key`
    writes the caller's own file, as for any `canyonos` command."""
    stored = Path.home() / ".canyonos" / "api_key"
    before = stored.read_bytes() if stored.is_file() else None
    try:
        yield
    finally:
        if before is None:
            stored.unlink(missing_ok=True)
        else:
            stored.write_bytes(before)
            stored.chmod(0o600)


@contextmanager
def _unreadable_records(recorder, directory: Path, port: int):
    """Leave, while the block runs, what an earlier CanyonOS left behind and must
    claim no port: a workflow group record whose `state.json` is not JSON, and the
    record of a port-forward on `port` that no process has touched since 1970."""
    deployments, forwards = cli_value(
        recorder,
        directory,
        "[deployments_dir(), forwards_dir()]",
        "from canyonos.deployment import deployments_dir; "
        "from canyonos.forwards import forwards_dir",
    )
    name = f"e2e-left-{secrets.token_hex(4)}"
    record = Path(deployments) / name
    record.mkdir(parents=True)
    (record / "state.json").write_text("{not json")
    forward = Path(forwards) / f"{name}.json"
    forward.parent.mkdir(parents=True, exist_ok=True)
    forward.write_text(json.dumps({"port": port}))
    os.utime(forward, (0, 0))
    try:
        yield
    finally:
        forward.unlink(missing_ok=True)
        (record / "state.json").unlink(missing_ok=True)
        record.rmdir()


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
    api = Api(recorder, api_url(recorder), dashboard_key(recorder))
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
    base_url = fleet.api.base_url
    status = http(recorder, "GET", f"{base_url}/v1/auth/status").json()
    assert status == {"api_key_required": True}, status
    anonymous = http(recorder, "GET", f"{base_url}/v1/workflows", check=False)
    assert anonymous.code == 401, anonymous.output
    assert anonymous.json()["error"] == "auth.missing_key", anonymous.output
    headers = bearer(recorder.api_key)
    workflows = http(
        recorder, "GET", f"{base_url}/v1/workflows", headers=headers
    ).json()
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
        group_id = workflow_group_id(fleet.dirs[name])
        base = f"/v1/workflow-groups/{group_id}/workflows/{fleet.ids[name]}"

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
            for trace in traces(fleet.api, directory, fleet.ids["helloworld"])
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


def test_a_stopped_database_is_named_until_it_runs_again(recorder, fleet):
    """With the dashboard's database stopped, the API stays up but is not ready: the
    dashboard's routes and the workflow groups' status answer 503
    `database.unavailable`, and `canyonos status` and `sync` fail naming the database
    and `canyonos serve`. Once the database runs again, the same API serves both
    workflow groups without a restart."""
    api_before = _api_container(recorder)
    base_url = fleet.api.base_url
    docker(recorder, ["stop", DASHBOARD_DB])
    try:
        assert http(recorder, "GET", f"{base_url}/v1/healthz").code == 200
        ready = http(recorder, "GET", f"{base_url}/v1/readyz", check=False)
        assert ready.code == 503, ready.output
        assert ready.json()["checks"]["database"] != "ok", ready.output
        listed = fleet.api.get("/v1/workflows", check=False)
        assert listed.code == 503, listed.output
        assert listed.json()["error"] == "database.unavailable", listed.output
        for name in WORKFLOWS:
            status = _status(recorder, fleet.dirs[name])
            assert status.code == 1, status.output
            [error] = status.json()["errors"]
            assert "database" in error and "`canyonos serve`" in error, error
        directory = fleet.dirs["helloworld"]
        sync = canyonos(
            recorder,
            ["sync", str(workflow_dir(directory))],
            cwd=directory,
            timeout=SYNC_TIMEOUT,
            check=False,
        )
        assert sync.code == 1, sync.output
        said = _said(sync)
        assert "database" in said and "`canyonos serve`" in said, said
        assert "Traceback" not in said, said
    finally:
        docker(recorder, ["start", DASHBOARD_DB])

    def both_running():
        return all(_status(recorder, fleet.dirs[name]).code == 0 for name in WORKFLOWS)

    poll(
        both_running,
        timeout=DATABASE_BACK_TIMEOUT,
        interval=2,
        what="canyonos status to read both workflow groups again",
    )
    assert _api_container(recorder) == api_before, "the API was restarted"
    for name in WORKFLOWS:
        _reads_own_redis(recorder, fleet, name)


def test_a_new_api_key_moves_the_dashboard_and_one_workflow_group(recorder, fleet):
    """`canyonos deploy --api-key` with a new key: the dashboard API and the workflow
    group it deployed take only the new key, the other workflow group keeps the old one
    until it is deployed again, the dashboard lists both under the new key, and the
    other one's status still reads, since the control key did not change. Then
    `canyonos serve` with the session's key puts the dashboard back on it."""
    new_key = f"e2e-rotated-{secrets.token_urlsafe(16)}"
    old_key = recorder.api_key
    rotated, kept = fleet.dirs["helloworld"], fleet.dirs["portfolio"]
    with _api_key_file_kept():
        _deploy(recorder, rotated, "helloworld", "--api-key", new_key)

    endpoint = replace(deployed_endpoint(recorder, rotated), api_key=new_key)
    _, result = result_of(recorder, endpoint, "rotated", timeout=60)
    assert result == {"greeting": "Hello, rotated! I'm the HelloAgent!"}, result
    query = {endpoint.argument: "old key"}
    url = f"{endpoint.url}/{endpoint.route}"
    old = http(recorder, "POST", url, json=query, headers=bearer(old_key), check=False)
    assert _refused_with(old, "auth.invalid_key"), old.output
    # A request id nothing made: past the key check it is only not found, so the
    # other workflow's agents are never called.
    other = f"{deployed_endpoint(recorder, kept).url}/status/{uuid.uuid4()}"
    still = http(recorder, "GET", other, headers=bearer(old_key), check=False)
    assert still.code == 404, still.output
    refused = http(recorder, "GET", other, headers=bearer(new_key), check=False)
    assert _refused_with(refused, "auth.invalid_key"), refused.output

    workflows = f"{fleet.api.base_url}/v1/workflows"
    listed = http(recorder, "GET", workflows, headers=bearer(new_key)).json()
    assert set(fleet.ids.values()) <= {workflow["id"] for workflow in listed}, listed
    stale = http(recorder, "GET", workflows, headers=bearer(old_key), check=False)
    assert _refused_with(stale, "auth.invalid_key"), stale.output
    status = _status(recorder, kept)
    assert status.code == 0 and status.json()["running"] is True, status.output

    canyonos(recorder, ["serve"], cwd=kept, timeout=600)
    assert fleet.api.get("/v1/workflows").code == 200


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
    group_id = workflow_group_id(fleet.dirs["helloworld"])
    stopped = fleet.api.get(
        f"/v1/workflow-groups/{group_id}/workflows/{fleet.ids['helloworld']}/prompts",
        check=False,
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
        f"add_sample_data({workflow_group_id(fleet.dirs['portfolio'])!r}, "
        f"{fleet.ids['portfolio']!r}, 'portfolio')",
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


def _deploy_pinned(recorder, directory: Path, api_port: int):
    """`canyonos deploy` with `endpoint.api_port` set to `api_port` for this deploy
    only; return the call, whatever it exits with."""
    _edit_settings(
        directory,
        lambda text: re.sub(
            r"^endpoint:$", f"endpoint:\n  api_port: {api_port}", text, flags=re.M
        ),
    )
    try:
        return canyonos(
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


def test_a_deploy_pinned_to_a_taken_api_port_stops_before_anything_starts(
    recorder, fleet
):
    """Taken by another program, or the port of the dashboard's API, which the deploy
    brings up first: either way the deploy refuses it before it starts anything of its
    own, and stops the dashboard it started."""
    directory = fleet.dirs["helloworld"]
    api_port = cli_value(
        recorder,
        directory,
        "service_ports()['api']",
        "from canyonos.dashboard_stack import service_ports",
    )
    with _held(8080):
        held = _deploy_pinned(recorder, directory, 8080)
    claimed = _deploy_pinned(recorder, directory, api_port)
    for call, port in ((held, 8080), (claimed, api_port)):
        assert call.code == 1, call.output
        refused = (
            f"Port {port} is already in use, and the endpoint needs it. Free it, or "
            "change `endpoint.api_port` in"
        )
        assert refused in _said(call), call.output
    left = workflow_group_containers(recorder, fleet.groups["helloworld"], every=True)
    assert not left, left
    assert not dashboard_containers(recorder), dashboard_containers(recorder)


def test_a_starting_dashboard_takes_its_dashboard_port(recorder, fleet):
    """Set to the API's own default, `dashboard_port` is the web app's as it is, and the
    API moves past it and says so. Neither a workflow group record that cannot be read
    nor a port-forward record no process keeps up claims a port: with them left on
    disk, nothing refuses the pinned port."""
    directory = fleet.dirs["helloworld"]
    _edit_settings(
        directory,
        lambda text: re.sub(
            r"^dashboard_port:.*$",
            f"dashboard_port: {DASHBOARD_API_PORT}",
            text,
            flags=re.M,
        ),
    )
    try:
        with _unreadable_records(recorder, directory, DASHBOARD_API_PORT):
            call = _deploy(recorder, directory, "helloworld")
        assert dashboard_port(recorder) == DASHBOARD_API_PORT
        moved = _port_of(api_url(recorder))
        assert moved != DASHBOARD_API_PORT, moved
        warned = (
            f"Port {DASHBOARD_API_PORT} is the dashboard's, so the dashboard's API is "
            f"on {moved}."
        )
        assert warned in _said(call), call.output
        controller = f"{fleet.groups['helloworld']}-global-controller"
        published = docker(recorder, ["port", controller]).output.strip()
        assert not published, published
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
        # Picked again from its default, not from the port it was set to last time.
        assert web_port != DASHBOARD_API_PORT, web_port
        assert dashboard_containers(recorder) == DASHBOARD_CONTAINERS
        greets(recorder, directory, "own-port")
    finally:
        stop = stop_workflow_group(recorder, directory)
    assert stop is None or stop.code == 0, stop.output
