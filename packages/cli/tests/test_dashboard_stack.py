# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import importlib.resources
import json
import subprocess
from pathlib import Path

import pytest
import yaml

from canyonos import dashboard_stack


def completed(argv, returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(argv, returncode, stdout, stderr)


@pytest.fixture
def project(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.chdir(tmp_path)
    for key in (
        "JWT_SECRET",
        "CANYONOS_JWT_SECRET",
        "CANYONOS_API_IMAGE",
        "CANYONOS_WEB_IMAGE",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(dashboard_stack.shutil, "which", lambda _: "/usr/bin/docker")
    monkeypatch.setattr(
        dashboard_stack, "find_free_port", lambda start, max_attempts=50: start
    )
    return tmp_path


def install_docker(monkeypatch, calls, responses=None):
    responses = responses or {}

    def fake_run(argv, **_):
        calls.append(argv)
        if callable(responses):
            return responses(argv)
        for marker, result in responses.items():
            if argv[-len(marker) :] == list(marker):
                return result(argv)
        if argv[:3] == ["docker", "container", "inspect"]:
            return completed(argv, returncode=1)
        return completed(argv)

    monkeypatch.setattr(dashboard_stack.subprocess, "run", fake_run)


@pytest.mark.parametrize(
    ("prepare", "message"),
    [
        (
            lambda monkeypatch, _: monkeypatch.setattr(
                dashboard_stack.shutil, "which", lambda _: None
            ),
            "docker is not on PATH",
        ),
        (
            lambda _, responses: responses.update(
                {("info",): lambda argv: completed(argv, returncode=1)}
            ),
            "docker daemon or socket is unavailable",
        ),
        (
            lambda _, responses: responses.update(
                {("compose", "version"): lambda argv: completed(argv, returncode=1)}
            ),
            "docker compose is unavailable",
        ),
    ],
)
def test_docker_validation_failures_do_not_pull(monkeypatch, project, prepare, message):
    calls = []
    responses = {}
    prepare(monkeypatch, responses)
    install_docker(monkeypatch, calls, responses)

    result = dashboard_stack.run_dashboard()

    assert result == dashboard_stack.ServeResult(False, "validate", message)
    assert all("pull" not in command for command in calls)


def test_state_directory_and_port_validation_failures_do_not_pull(
    monkeypatch, project, tmp_path
):
    calls = []
    install_docker(monkeypatch, calls)
    blocked_state_dir = tmp_path / "blocked"
    blocked_state_dir.write_text("not a directory")
    monkeypatch.setattr(dashboard_stack, "_state_dir", lambda: blocked_state_dir)

    state_result = dashboard_stack.run_dashboard()

    assert state_result.message == "dashboard state directory is not writable"
    assert all("pull" not in command for command in calls)

    calls.clear()
    monkeypatch.setattr(dashboard_stack, "_state_dir", lambda: tmp_path / "state")
    monkeypatch.setattr(
        dashboard_stack,
        "find_free_port",
        lambda start=8080, max_attempts=50: (_ for _ in ()).throw(
            RuntimeError(
                "no free port found for the dashboard after 50 attempts starting at 8080"
            )
        ),
    )
    port_result = dashboard_stack.run_dashboard()

    assert (
        port_result.message
        == "no free port found for the dashboard after 50 attempts starting at 8080"
    )
    assert all("pull" not in command for command in calls)


def test_redaction_removes_urls_secrets_and_credentials():
    database_url = "postgres://user:password@db.example/canyonos"
    secret = "secret-value"
    logs = f"{database_url}\n{secret}\nredis://other:credential@cache:6379/0"

    redacted = dashboard_stack._redact_logs(logs, secret)

    assert (
        database_url not in redacted
    )  # credentials portion is stripped by the generic regex
    assert secret not in redacted
    assert "user:password@" not in redacted
    assert "other:credential@" not in redacted


def _fail_start(monkeypatch, had_containers):
    """Run the dashboard with a start that fails; returns its result and the docker calls."""
    calls = []

    def response(argv):
        if argv[-2:] == ["ps", "-q"]:
            return completed(argv, stdout="existing\n" if had_containers else "")
        if argv[-5:] == ["up", "-d", "--wait", "--wait-timeout", "180"]:
            return completed(argv, returncode=1)
        if argv[-4:] == ["logs", "--no-color", "--tail", "200"]:
            return completed(
                argv, stdout="postgres://user:password@db.example/canyonos"
            )
        return completed(argv)

    install_docker(monkeypatch, calls, response)
    return dashboard_stack.run_dashboard(), calls


@pytest.mark.parametrize("had_containers", [False, True])
def test_start_failure_saves_log_and_cleans_up_only_new_stack(
    monkeypatch, project, had_containers
):
    result, calls = _fail_start(monkeypatch, had_containers)

    assert result.ok is False
    assert result.phase == "start"
    assert result.log_path is not None
    assert "postgres://user:password@db.example/canyonos" not in Path(
        result.log_path
    ).read_text(encoding="utf-8")
    assert any("logs" in command for command in calls)
    assert any(command[-2:] == ["down", "--volumes"] for command in calls) is (
        not had_containers
    )


@pytest.mark.posix_only("Windows has no permission bits; the user folder's access list")
def test_the_saved_start_log_is_readable_only_by_you(monkeypatch, project):
    result, _ = _fail_start(monkeypatch, had_containers=False)

    assert Path(result.log_path).stat().st_mode & 0o777 == 0o600


def test_pull_failure_includes_redacted_stderr(monkeypatch, project):
    calls = []
    secret = None

    def response(argv):
        nonlocal secret
        if "pull" in argv:
            secret = next(
                line.split("=", 1)[1]
                for line in dashboard_stack._state_dir()
                .joinpath(".env")
                .read_text()
                .splitlines()
                if line.startswith("CANYONOS_JWT_SECRET=")
            )
            return completed(
                argv,
                returncode=1,
                stderr=f"first line\npull unauthorized postgres://user:password@db.example/canyonos {secret}\n",
            )
        return completed(argv)

    install_docker(monkeypatch, calls, response)
    result = dashboard_stack.run_dashboard()

    assert result.phase == "pull"
    assert "pull unauthorized" in result.message
    assert "postgres://user:password@db.example/canyonos" not in result.message
    assert "user:password@" not in result.message
    assert secret not in result.message


def test_verify_failure_saves_a_log(monkeypatch, project):
    calls = []
    install_docker(monkeypatch, calls)
    probes = []

    def urlopen(*_args, **_kwargs):
        probes.append(True)
        raise dashboard_stack.urllib.error.URLError("down")

    monkeypatch.setattr(
        dashboard_stack.urllib.request,
        "urlopen",
        urlopen,
    )
    clock = iter([0, 0, 0, 31])
    monkeypatch.setattr(dashboard_stack.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(dashboard_stack.time, "sleep", lambda _: None)

    result = dashboard_stack.run_dashboard()

    assert result.ok is False
    assert result.phase == "verify"
    assert result.log_path is not None
    assert Path(result.log_path).is_file()
    assert probes == [True]
    assert any("logs" in command for command in calls)
    assert any(command[-2:] == ["down", "--volumes"] for command in calls)


def test_success_pulls_starts_and_verifies(monkeypatch, project):
    calls = []
    install_docker(monkeypatch, calls)

    class Response:
        status = 200

        def close(self):
            pass

    endpoints = []

    def urlopen(endpoint, timeout):
        endpoints.append((endpoint, timeout))
        return Response()

    monkeypatch.setattr(dashboard_stack.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(dashboard_stack, "public_ip", lambda: None)
    result = dashboard_stack.run_dashboard()

    assert result == dashboard_stack.ServeResult(
        True, "verify", "dashboard health checks passed", "http://127.0.0.1:8081"
    )
    pull_index = next(index for index, command in enumerate(calls) if "pull" in command)
    up_index = next(index for index, command in enumerate(calls) if "up" in command)
    assert pull_index < up_index
    assert calls[pull_index][4:6] == [
        "--env-file",
        str(project / "home" / ".canyonos" / "dashboard" / ".env"),
    ]
    assert calls[up_index][-5:] == ["up", "-d", "--wait", "--wait-timeout", "180"]
    assert not any("rm" in command for command in calls)
    assert not (project / ".env").exists()
    assert endpoints == [
        ("http://127.0.0.1:8081/healthz", 5),
        ("http://127.0.0.1:8081/api/healthz", 5),
    ]


def test_shell_image_keyword_does_not_override_resolved_images(monkeypatch, project):
    monkeypatch.setenv("CANYONOS_API_IMAGE", "local")
    monkeypatch.setenv("CANYONOS_WEB_IMAGE", "local")
    env_by_subcommand = {}

    def fake_run(argv, env=None, **_):
        for subcommand in ("pull", "up"):
            if subcommand in argv:
                env_by_subcommand[subcommand] = env
        return completed(argv, returncode=1 if "up" in argv else 0)

    monkeypatch.setattr(dashboard_stack.subprocess, "run", fake_run)
    dashboard_stack.run_dashboard()

    assert set(env_by_subcommand) == {"pull", "up"}
    for env in env_by_subcommand.values():
        assert env["CANYONOS_API_IMAGE"] == dashboard_stack.API_IMAGE
        assert env["CANYONOS_WEB_IMAGE"] == dashboard_stack.WEB_IMAGE


DASHBOARD_PROJECT = ["docker", "compose", "-p", "canyonos-dashboard"]
STOP_AND_TEARDOWN = pytest.mark.parametrize(
    ("dashboard_command", "compose_command", "leftover_query"),
    [
        (dashboard_stack.stop_dashboard, ["stop"], ["ps", "-q"]),
        (
            dashboard_stack.teardown_dashboard,
            ["down", "--volumes"],
            ["ps", "-q", "--all"],
        ),
    ],
)


@STOP_AND_TEARDOWN
def test_stop_and_teardown_reach_the_dashboard_outside_the_project(
    monkeypatch, project, dashboard_command, compose_command, leftover_query
):
    calls = []
    install_docker(monkeypatch, calls)

    assert not (project / ".env").exists()
    assert dashboard_command() is True
    assert calls == [
        [*DASHBOARD_PROJECT, *compose_command],
        [*DASHBOARD_PROJECT, *leftover_query],
    ]


@STOP_AND_TEARDOWN
def test_stop_and_teardown_fail_while_dashboard_containers_remain(
    monkeypatch, project, dashboard_command, compose_command, leftover_query
):
    install_docker(
        monkeypatch,
        [],
        lambda argv: completed(argv, stdout="9f1c2d3e4b5a\n" if "ps" in argv else ""),
    )

    assert dashboard_command() is False


@STOP_AND_TEARDOWN
def test_stop_and_teardown_fail_when_compose_fails(
    monkeypatch, project, dashboard_command, compose_command, leftover_query
):
    install_docker(
        monkeypatch,
        [],
        lambda argv: completed(argv, returncode=int(compose_command[0] in argv)),
    )

    assert dashboard_command() is False


def test_existing_dashboard_container_skips_port_check(monkeypatch, project):
    calls = []

    def response(argv):
        if argv[:3] == ["docker", "container", "inspect"]:
            return completed(
                argv,
                stdout=json.dumps(
                    [
                        {
                            "NetworkSettings": {
                                "Ports": {
                                    "8080/tcp": [
                                        {"HostIp": "127.0.0.1", "HostPort": "8080"}
                                    ]
                                }
                            }
                        }
                    ]
                ),
            )
        if argv[-2:] == ["ps", "-q"]:
            return completed(argv, stdout="existing\n")
        return completed(argv)

    install_docker(monkeypatch, calls, response)
    monkeypatch.setattr(
        dashboard_stack,
        "find_free_port",
        lambda *a, **k: pytest.fail(
            "the existing dashboard owns port 8080, should not search for a new one"
        ),
    )
    monkeypatch.setattr(
        dashboard_stack.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: type(
            "Response", (), {"status": 200, "close": lambda self: None}
        )(),
    )
    monkeypatch.setattr(dashboard_stack, "public_ip", lambda: None)

    result = dashboard_stack.run_dashboard()

    assert result.ok
    assert result.url == "http://127.0.0.1:8080"


def _shipped_manifest() -> dict:
    manifest = importlib.resources.files("canyonos").joinpath("dashboard.compose.yml")
    return yaml.safe_load(manifest.read_text(encoding="utf-8"))


def test_manifest_gives_the_api_its_self_hosted_environment():
    environment = _shipped_manifest()["services"]["api"]["environment"]

    assert set(environment) == {
        "DATABASE_URL",
        "JWT_SECRET",
        "LOG_LEVEL",
        "METRICS_RAW_RETENTION_DAYS",
        "METRICS_ROLLUP_RETENTION_DAYS",
    }


def test_manifest_publishes_the_web_on_every_interface():
    ports = _shipped_manifest()["services"]["web"]["ports"]

    assert ports == ["${CANYONOS_WEB_PORT}:8080"]


def test_dashboard_url_uses_the_public_ip_on_ec2(monkeypatch):
    monkeypatch.setattr(dashboard_stack, "public_ip", lambda: "54.85.117.239")

    assert dashboard_stack.dashboard_url(8081) == "http://54.85.117.239:8081"


def test_dashboard_url_falls_back_to_loopback_off_ec2(monkeypatch):
    monkeypatch.setattr(dashboard_stack, "public_ip", lambda: None)

    assert dashboard_stack.dashboard_url(8081) == "http://127.0.0.1:8081"


@pytest.mark.parametrize(
    "stderr",
    [
        "Error response from daemon: driver failed programming external connectivity "
        "on endpoint canyonos-dashboard-api-1 (fd4d): "
        "Bind for 0.0.0.0:3000 failed: port is already allocated",
        "Error response from daemon: Ports are not available: exposing port TCP "
        "0.0.0.0:3000 -> 127.0.0.1:0: listen tcp 0.0.0.0:3000: bind: address already in use",
    ],
)
def test_a_port_conflict_on_start_names_the_port(monkeypatch, project, stderr):
    def response(argv):
        if argv[-5:] == ["up", "-d", "--wait", "--wait-timeout", "180"]:
            return completed(argv, returncode=1, stderr=stderr)
        return completed(argv)

    install_docker(monkeypatch, [], response)
    result = dashboard_stack.run_dashboard()

    assert result.phase == "start"
    assert result.message == (
        "port 3000 is already in use by another process or container"
    )
    assert result.log_path is not None
