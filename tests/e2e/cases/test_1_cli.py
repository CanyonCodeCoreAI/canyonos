# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The CLI on a deployed project, the way a user or a coding agent drives it with
no terminal: the deploy's own output, the containers it started, status, logs and
doctor."""

import json
import re

from ..harness import (
    canyonos,
    cli_value,
    dashboard_containers,
    docker,
    docker_name,
    manifest,
    poll,
    project_containers,
    project_redis,
    qualified,
    query_token,
    run,
)

DASHBOARD = [
    "canyonos-dashboard-api",
    "canyonos-dashboard-db",
    "canyonos-dashboard-web",
]
REPLICA_SUFFIX = "-[0-9a-f]{8}"
TRUSTED_KEYS_KEY = "auth:trusted_keys"
AUTH_ENV = ("CANYONOS_TRUSTED_KEYS", "CANYONOS_AUTH_DISABLED")
BEARER = '-H "Authorization: Bearer <token>"'


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
    hint = (
        "Make a token with: canyonos token create --scope query --project "
        f"{deployed.project_id}"
    )
    for output in (deployed.deploy_output, status.output):
        for line in [*_endpoint_lines(deployed.endpoint), hint]:
            assert line in output, f"{line!r} missing\n{output[-3000:]}"


def test_the_printed_curl_works_with_a_token(recorder, deployed):
    printed = _query_curl(deployed.endpoint)
    assert printed in deployed.deploy_output, deployed.deploy_output[-3000:]
    command = printed.replace("<token>", query_token(recorder, deployed.dir))
    call = run(recorder, ["sh", "-c", command], cwd=deployed.dir)
    assert json.loads(call.stdout)["request_id"], call.output


def test_containers_up(recorder, deployed):
    group = deployed.group
    containers = project_containers(recorder, group, every=True)
    replicas = {
        qualified(deployed.project_dir, agent["name"]): agent.get("replicas", 1)
        for agent in manifest(deployed.project_dir)["agents"]
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


def _published_keys(recorder, deployed) -> dict:
    return json.loads(project_redis(recorder, deployed.dir).get(TRUSTED_KEYS_KEY))


def test_the_global_controller_publishes_the_trusted_keys(recorder, deployed):
    record = _published_keys(recorder, deployed)
    trusted = cli_value(
        recorder,
        deployed.dir,
        f"trusted_keys(Path({str(recorder.auth_dir)!r}))",
        "from pathlib import Path; from canyonos.auth import trusted_keys",
    )

    assert set(record) == {"keys", "disabled"}, record
    assert record["disabled"] is False
    assert trusted, "the deploy ran with no trusted key"
    assert record["keys"] == trusted


def test_only_the_global_controller_gets_the_public_keys(recorder, deployed):
    keys = _published_keys(recorder, deployed)["keys"]
    controller = f"{deployed.group}-global-controller"
    auth_dir = str(recorder.auth_dir)

    for name in project_containers(recorder, deployed.group):
        inspected = docker(recorder, ["inspect", name]).json()[0]
        env = dict(
            item.partition("=")[::2] for item in inspected["Config"]["Env"] or []
        )
        sources = [mount.get("Source", "") for mount in inspected["Mounts"]]
        assert not [k for k, v in env.items() if "PRIVATE KEY" in v], name
        assert not [s for s in sources if s.startswith(auth_dir)], (name, sources)
        if name == controller:
            assert json.loads(env["CANYONOS_TRUSTED_KEYS"]) == keys
            assert "CANYONOS_AUTH_DISABLED" not in env
        else:
            assert not [k for k in AUTH_ENV if k in env], name


def test_status_json_counts_every_replica(recorder, deployed):
    def settled():
        call = canyonos(recorder, ["status", "--json"], cwd=deployed.dir)
        agents = call.json()["agents"] or {}
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
    unknown = canyonos(recorder, ["logs", "NoSuchAgent"], cwd=deployed.dir, check=False)
    assert unknown.code != 0, unknown.output
    assert deployed.agents[0] in unknown.output, unknown.output


def test_doctor_checks_the_live_deploy(recorder, deployed):
    call = canyonos(recorder, ["doctor"], cwd=deployed.dir, timeout=300)
    assert "Deploy is up -- post-deploy checks:" in call.output, call.output
