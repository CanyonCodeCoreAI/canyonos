# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The CLI on a deployed workflow, the way a user or a coding agent drives it with
no terminal: the deploy's own output, the containers it started, status, logs,
doctor and `canyonos curl` on the selected workflow group, and their JSON results, with
the deploy up in `status --json` and the Global Controller's address it gives
answering. The deploy hands only the Global Controller the hash of the session's API
key, which it publishes to Redis; the key itself reaches no container."""

import json
import re
import shlex

import pytest

from ..harness import (
    canyonos,
    cli_value,
    controller_headers,
    dashboard_containers,
    docker,
    docker_name,
    hash_api_key,
    http,
    manifest,
    poll,
    workflow_group_containers,
    workflow_group_redis,
    qualified,
    run,
)

pytestmark = pytest.mark.trait("lifecycle")

DASHBOARD = [
    "canyonos-dashboard-api",
    "canyonos-dashboard-db",
    "canyonos-dashboard-web",
]
REPLICA_SUFFIX = "-[0-9a-f]{8}"
API_KEY_HASH_KEY = "auth:api_key_hash"
API_KEY_HASH_ENV = "CANYONOS_API_KEY_HASH"
BEARER = '-H "Authorization: Bearer <your api key>"'


def _whole_curl(url: str, body: str) -> str:
    """The one-line curl the CLI prints for `url`, as piped output has to keep it."""
    return (
        f"curl -X POST {url} {BEARER} -H \"Content-Type: application/json\" -d '{body}'"
    )


def _query_curl(endpoint) -> str:
    return _whole_curl(
        f"{endpoint.url}/{endpoint.route}", f'{{"{endpoint.argument}": "your query"}}'
    )


def _endpoint_lines(endpoint) -> list[str]:
    """The lines a deploy panel shows to call, answer and poll this endpoint."""
    return [
        _query_curl(endpoint),
        _whole_curl(f"{endpoint.url}/answer/<request_id>", '{"input": "your answer"}'),
        f"curl {BEARER} {endpoint.url}/status/<request_id>",
    ]


def _replica_logs(output: str) -> dict[str, list[str]]:
    """The non-blank lines `canyonos logs <agent>` printed under each replica header."""
    sections: dict[str, list[str]] = {}
    lines = None
    for line in output.splitlines():
        header = re.fullmatch(r"--- (\S+) ---", line.strip())
        if header:
            lines = sections.setdefault(header.group(1), [])
        elif lines is not None and line.strip():
            lines.append(line)
    return sections


def test_deploy_and_status_print_the_curl_whole(recorder, deployed):
    status = canyonos(recorder, ["status"], cwd=deployed.dir)
    for output in (deployed.deploy_output, status.output):
        for line in _endpoint_lines(deployed.endpoint):
            assert line in output, f"{line!r} missing\n{output[-3000:]}"
        assert recorder.api_key not in output, output[-3000:]


def test_the_printed_curl_works_with_the_api_key(recorder, deployed):
    printed = _query_curl(deployed.endpoint)
    assert printed in deployed.deploy_output, deployed.deploy_output[-3000:]
    command = printed.replace("<your api key>", recorder.api_key)
    call = run(recorder, ["sh", "-c", command], cwd=deployed.dir)
    assert json.loads(call.stdout)["request_id"], call.output


def test_canyonos_curl_posts_to_the_selected_workflow_group(
    recorder, deployed, tmp_path
):
    body = json.dumps({deployed.endpoint.argument: deployed.query})
    url = f"{deployed.endpoint.url}/{deployed.endpoint.route}"
    route = ["--route", url]
    try:
        canyonos(recorder, ["select-context", deployed.workflow_group_id], cwd=tmp_path)
        printed = canyonos(recorder, ["curl", body, *route, "--print"], cwd=tmp_path)
        call = canyonos(recorder, ["curl", body, *route], cwd=tmp_path)
    finally:
        canyonos(recorder, ["select-context", "--clear"], cwd=tmp_path)

    expected = (
        f'curl -X POST {url} {BEARER} -H "Content-Type: application/json" '
        f"-d {shlex.quote(body)}"
    )
    assert printed.stdout.strip() == expected, printed.output
    assert json.loads(call.stdout)["request_id"], call.output
    assert recorder.api_key not in printed.output + call.output


def test_containers_up(recorder, deployed):
    group = deployed.group
    containers = workflow_group_containers(recorder, group, every=True)
    replicas = {
        qualified(deployed.workflow_dir, agent["name"]): agent.get("replicas", 1)
        for agent in manifest(deployed.workflow_dir)["agents"]
    }
    expected = {
        f"{group}-global-controller": 1,
        f"{group}-redis-localhost": 1,
        f"{group}-metrics-localhost": 1,
        f"{group}-endpoint{REPLICA_SUFFIX}": 1,
        **{
            f"{group}-{docker_name(name)}{REPLICA_SUFFIX}": count
            for name, count in replicas.items()
        },
    }
    found = {
        pattern: sorted(c for c in containers if re.fullmatch(pattern, c))
        for pattern in expected
    }
    wrong = {
        pattern: names
        for pattern, names in found.items()
        if len(names) != expected[pattern]
    }
    assert not wrong, f"expected counts {expected}, found {wrong}\n{containers}"
    matched = {name for names in found.values() for name in names}
    assert set(containers) == matched, f"unexpected: {set(containers) - matched}"
    stopped = {name: state for name, state in containers.items() if state != "running"}
    assert not stopped, f"not running: {stopped}"
    assert dashboard_containers(recorder) == DASHBOARD


def test_the_global_controller_publishes_the_key_hash(recorder, deployed):
    published = workflow_group_redis(recorder, deployed.dir).get(API_KEY_HASH_KEY)
    assert published == hash_api_key(recorder.api_key), published


def test_only_the_global_controller_gets_the_key_hash(recorder, deployed):
    controller = f"{deployed.group}-global-controller"

    for name in workflow_group_containers(recorder, deployed.group):
        inspected = docker(recorder, ["inspect", name]).json()[0]
        env = dict(
            item.partition("=")[::2] for item in inspected["Config"]["Env"] or []
        )
        assert not [k for k, v in env.items() if recorder.api_key in v], name
        assert "CANYONOS_API_KEY" not in env, name
        if name == controller:
            assert env[API_KEY_HASH_ENV] == hash_api_key(recorder.api_key), name
        else:
            assert API_KEY_HASH_ENV not in env, name


def test_status_json_counts_every_replica(recorder, deployed):
    def settled():
        call = canyonos(recorder, ["status", "--json"], cwd=deployed.dir)
        agents = {agent["name"]: agent for agent in call.json()["agents"] or []}
        wrong = {
            name: agents.get(name)
            for name in deployed.agents
            if not agents.get(name)
            or agents[name]["desired_replicas"] < 1
            or agents[name]["running_replicas"] != agents[name]["desired_replicas"]
            or agents[name]["launch_error"] is not None
        }
        return agents if not wrong else None

    poll(settled, timeout=120, what="every agent running its replicas in status --json")
    report = canyonos(recorder, ["status", "--json"], cwd=deployed.dir).json()
    assert report["target"] == "docker", report
    assert report["workflow_group"] == deployed.group.removeprefix("canyonos-"), report
    assert report["phase"] == "up" and report["last_apply"]["ok"], report
    version = cli_value(
        recorder, deployed.dir, "VERSION", "from canyonos.env import VERSION"
    )
    assert report["version"] == version and report["error_code"] is None, report
    controller = http(
        recorder,
        "GET",
        f"{report['controller_url']}/v1/workflow-groups/{deployed.workflow_group_id}",
        headers=controller_headers(recorder, deployed.dir),
    )
    assert controller.json()["running"] is True, controller.output


def test_logs(recorder, deployed):
    controller = canyonos(
        recorder,
        ["logs", "--no-follow", "--tail", "all"],
        cwd=deployed.dir,
        timeout=120,
    )
    assert controller.output.strip(), controller.output
    for agent in deployed.agents:
        call = canyonos(recorder, ["logs", agent, "--tail", "20"], cwd=deployed.dir)
        sections = _replica_logs(call.stdout)
        assert sections, call.output
        for replica, lines in sections.items():
            assert re.fullmatch(f"{re.escape(agent)}{REPLICA_SUFFIX}", replica), (
                call.output
            )
            assert lines, f"{replica} printed no log\n{call.output}"
    agent = deployed.agents[0]
    as_json = canyonos(recorder, ["logs", agent, "--json"], cwd=deployed.dir).json()
    assert as_json["ok"] and as_json["logs"], as_json
    for replica, lines in as_json["logs"].items():
        assert re.fullmatch(f"{re.escape(agent)}{REPLICA_SUFFIX}", replica), as_json
        assert lines, f"{replica} printed no log\n{as_json}"
    controller_json = canyonos(recorder, ["logs", "--json"], cwd=deployed.dir).json()
    assert controller_json["code"] is None, controller_json
    assert controller_json["logs"]["global-controller"], controller_json
    unknown = canyonos(recorder, ["logs", "NoSuchAgent"], cwd=deployed.dir, check=False)
    assert unknown.code != 0, unknown.output
    assert deployed.agents[0] in unknown.output, unknown.output


def test_doctor_checks_the_live_deploy(recorder, deployed):
    call = canyonos(recorder, ["doctor"], cwd=deployed.dir, timeout=300)
    assert "Deploy is up -- post-deploy checks:" in call.output, call.output
    as_json = canyonos(recorder, ["doctor", "--json"], cwd=deployed.dir, timeout=300)
    report = as_json.json()
    assert report["ok"] and report["code"] is None, as_json.output
    assert report["errors"] == [], as_json.output
    checks = {check["name"]: check["ok"] for check in report["checks"]}
    expected = {"Global Controller", "Redis", "Workflow agents", "Endpoint"}
    assert expected <= set(checks) and all(checks.values()), report
