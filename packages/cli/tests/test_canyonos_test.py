import json
import queue
import subprocess
from types import SimpleNamespace

import pytest

from canyonos import deploy as deploy_cmd
from canyonos import test as test_cmd
from canyonos import ui, verify

CONFIG = """\
agents:
  - name: EchoAgent
    entrypoint: echo_agent.py
    provider: EC2
    replicas: 2

  - name: Workflow
    entrypoint: echo_workflow.py
    provider: EC2
    replicas: 1

endpoint:
  api_port: 8080
  agent: Workflow
  method: main
"""
ENDPOINT = {
    "public_host": "127.0.0.1",
    "api_port": 8080,
    "agent": "Workflow",
    "method": "main",
    "arguments": ["query", "n_candidates"],
    "url": "http://127.0.0.1:8080/main",
}


@pytest.fixture(autouse=True)
def loud():
    """Every test starts with output enabled; `--json` runs flip it and restore it."""
    ui.set_quiet(False)
    yield
    ui.set_quiet(False)


@pytest.fixture
def project(monkeypatch, tmp_path):
    root = tmp_path / "portfolio"
    car = root / ".car"
    (car / "config").mkdir(parents=True)
    (car / "app").mkdir()
    (car / "config" / "global_controller.yaml").write_text(CONFIG)
    monkeypatch.chdir(root)
    return root


# ------------------------------------------------------------------ #
#  Runtime verification                                               #
# ------------------------------------------------------------------ #


@pytest.fixture
def runtime(monkeypatch):
    def install(images, containers):
        monkeypatch.setattr(verify, "_built_images", lambda: set(images))
        monkeypatch.setattr(verify, "_running_containers", lambda: list(containers))

    return install


IMAGES = {"canyonos-portfolio-echoagent", "canyonos-portfolio-workflow"}
ALL_UP = [
    "canyonos-portfolio-echoagent-0",
    "canyonos-portfolio-echoagent-1",
    "canyonos-portfolio-workflow-0",
]


def test_a_complete_deploy_passes(project, runtime):
    runtime(IMAGES, ALL_UP)

    result = verify.verify_runtime(
        str(project / ".car" / "config" / "global_controller.yaml")
    )

    assert [(a["name"], a["running"], a["expected"]) for a in result["agents"]] == [
        ("EchoAgent", 2, 2),
        ("Workflow", 1, 1),
    ]


def test_a_short_replica_count_fails(project, runtime):
    runtime(IMAGES, ALL_UP[1:])

    with pytest.raises(RuntimeError, match="1 of 2 replicas"):
        verify.verify_runtime(
            str(project / ".car" / "config" / "global_controller.yaml")
        )


def test_an_image_that_was_never_built_fails(project, runtime):
    runtime({"canyonos-portfolio-workflow"}, ["canyonos-portfolio-workflow-0"])

    with pytest.raises(
        RuntimeError, match="canyonos-portfolio-echoagent was never built"
    ):
        verify.verify_runtime(
            str(project / ".car" / "config" / "global_controller.yaml")
        )


# ------------------------------------------------------------------ #
#  The command itself                                                 #
# ------------------------------------------------------------------ #


@pytest.fixture
def deployable(monkeypatch, project):
    """A project where every step succeeds unless overridden."""
    calls = {"run_deploy": 0, "quit": 0}

    monkeypatch.setattr(
        test_cmd, "load_state", lambda: {"container_id": "abc", "port": 8000}
    )
    monkeypatch.setattr(test_cmd, "deploy_status", lambda *_a: None)
    monkeypatch.setattr(test_cmd, "_wait_for_endpoint", lambda *a: None)
    monkeypatch.setattr(test_cmd, "verify_runtime", lambda *a: {"agents": []})
    monkeypatch.setattr(test_cmd, "deployed_endpoint", lambda _port: ENDPOINT)
    monkeypatch.setattr(test_cmd, "_send_query", lambda *a: "req-1")
    monkeypatch.setattr(
        test_cmd, "_await_result", lambda *a: {"status": "done", "result": {"r": 1}}
    )
    monkeypatch.setattr(test_cmd, "_log_tail", lambda _cid: "boom")

    def run_deploy(*_a, **_k):
        calls["run_deploy"] += 1
        return {"container_id": "abc", "port": 8000}

    def quit_existing():
        calls["quit"] += 1

    monkeypatch.setattr(test_cmd, "run_deploy", run_deploy)
    monkeypatch.setattr(test_cmd, "quit_existing", quit_existing)
    return calls


def test_a_passing_run_tears_everything_down(deployable):
    assert test_cmd.run_test("hi") == 0
    assert deployable["quit"] == 1


def test_the_dashboard_is_not_started_under_test(monkeypatch, deployable):
    """A smoke test never reads the dashboard, so it must not pay to bring it up."""
    seen = {}
    monkeypatch.setattr(
        test_cmd,
        "run_deploy",
        lambda *_a, **kwargs: (
            seen.update(serve=kwargs.get("serve"))
            or {"container_id": "abc", "port": 8000}
        ),
    )
    assert test_cmd.run_test("hi") == 0
    assert seen["serve"] is False


def test_the_provider_is_restored_after_the_run(project, deployable):
    config = project / ".car" / "config" / "global_controller.yaml"

    test_cmd.run_test("hi")

    assert config.read_text() == CONFIG


def test_a_failed_deploy_keeps_the_container_and_reads_its_log(
    monkeypatch, deployable, capsys
):
    def boom(*_a):
        raise RuntimeError("the deploy did not come up")

    monkeypatch.setattr(test_cmd, "_wait_for_endpoint", boom)

    assert test_cmd.run_test("hi", as_json=True) == 1
    payload = json.loads(capsys.readouterr().out)

    assert deployable["quit"] == 0
    assert payload["log_tail"] == "boom"


def test_a_failure_before_the_deploy_leaves_existing_state_alone(
    monkeypatch, deployable, capsys
):
    """A failure that never gets as far as starting this run's own deploy must
    not tear down whatever deploy was already there -- see
    test_refuses_to_run_when_a_deploy_is_already_up.
    """

    def boom(*_a, **_k):
        raise RuntimeError("Could not sync the project into the container.")

    monkeypatch.setattr(test_cmd, "run_deploy", boom)

    assert test_cmd.run_test("hi", as_json=True) == 1
    payload = json.loads(capsys.readouterr().out)

    assert deployable["quit"] == 0
    assert payload["log_tail"] is None


def test_queries_the_existing_deploy_instead_of_standing_up_its_own(
    monkeypatch, deployable, capsys
):
    """When a deploy is already up, `canyonos test` queries it as it stands
    rather than refusing -- and must not deploy or tear anything down."""
    deployed = {
        "public_host": "127.0.0.1",
        "api_port": 9090,
        "agent": "Other",
        "method": "run",
        "arguments": [],
        "url": "http://127.0.0.1:9090/run",
    }
    sent = []
    monkeypatch.setattr(test_cmd, "deploy_status", lambda *_a: {"running": True})
    monkeypatch.setattr(test_cmd, "deployed_endpoint", lambda _port: deployed)
    monkeypatch.setattr(test_cmd, "_send_query", lambda *a: sent.append(a) or "req-1")

    assert test_cmd.run_test("hi", as_json=True) == 0
    payload = json.loads(capsys.readouterr().out)

    assert deployable["run_deploy"] == 0
    assert deployable["quit"] == 0
    assert payload["against_existing_deploy"] is True
    assert payload["result"] == {"r": 1}
    # The query is the only phase in this path.
    assert [(p["name"], p["ok"]) for p in payload["phases"]] == [("query", True)]
    assert sent == [("http://127.0.0.1:9090/run", {})]


def test_json_mode_prints_one_object_and_nothing_else(deployable, capsys):
    assert test_cmd.run_test("a prompt", as_json=True) == 0
    payload = json.loads(capsys.readouterr().out)

    assert payload["ok"] is True
    assert payload["query"] == "a prompt"
    assert payload["result"] == {"r": 1}
    assert payload["error"] is None
    assert [(p["name"], p["ok"]) for p in payload["phases"]] == [
        ("deploy", True),
        ("verify_runtime", True),
        ("query", True),
    ]


def test_a_workflow_error_is_reported_as_a_failure(monkeypatch, deployable, capsys):
    monkeypatch.setattr(
        test_cmd,
        "_await_result",
        lambda *a: {"status": "error", "error": "agent blew up"},
    )

    assert test_cmd.run_test("hi", as_json=True) == 1

    assert json.loads(capsys.readouterr().out)["error"] == "agent blew up"


def test_a_flat_layout_project_deploys_fine_with_no_car_directory(
    monkeypatch, tmp_path, deployable, capsys
):
    legacy = tmp_path / "legacy" / "config"
    legacy.mkdir(parents=True)
    (legacy / "global_controller.yaml").write_text(CONFIG)
    monkeypatch.chdir(tmp_path / "legacy")

    assert test_cmd.run_test("hi", as_json=True) == 0
    payload = json.loads(capsys.readouterr().out)

    assert [(p["name"], p["ok"]) for p in payload["phases"]] == [
        ("deploy", True),
        ("verify_runtime", True),
        ("query", True),
    ]


# ------------------------------------------------------------------ #
#  Query body derived from the endpoint record                        #
# ------------------------------------------------------------------ #


# ------------------------------------------------------------------ #
#  Docker plumbing                                                    #
# ------------------------------------------------------------------ #

_GC = "INFO:canyonos_core.controller.global_controller:"
_UP = f"{_GC}Global controller started, polling every 5s...\n"


@pytest.fixture
def followed_log(monkeypatch):
    """`docker logs -f` as a queue the test fills; None ends the stream."""
    lines = queue.Queue()
    monkeypatch.setattr(
        test_cmd,
        "follow_gc_log",
        lambda _state: SimpleNamespace(stdout=None, terminate=lambda: None),
    )
    monkeypatch.setattr(test_cmd, "queued_lines", lambda _stdout: lines)
    return lines


def test_a_workflow_that_never_comes_up_reports_the_logged_root_cause(
    monkeypatch, followed_log
):
    log = (
        "Building Docker image: echoagent\n"
        "ERROR:opentelemetry.exporter:ingest unreachable\n"
        "CRITICAL:canyonos_core.controller.global_controller:Failed to launch Redis on 127.0.0.1: port taken\n"
        "Traceback (most recent call last):\n"
    )
    monkeypatch.setattr(test_cmd, "READY_TIMEOUT", 0)
    monkeypatch.setattr(
        test_cmd.subprocess,
        "run",
        lambda argv, **_k: subprocess.CompletedProcess(argv, 0, log, None),
    )

    with pytest.raises(RuntimeError) as err:
        test_cmd._wait_for_endpoint({"port": 1, "container_id": "cid"}, 2)

    assert str(err.value) == "Timed out after 0s waiting for the workflow to come up."
    assert err.value.root_cause == (
        "CRITICAL:canyonos_core.controller.global_controller:"
        "Failed to launch Redis on 127.0.0.1: port taken"
    )


def test_the_wait_lasts_until_the_deploy_stops_and_explains_it(
    monkeypatch, followed_log
):
    log = (
        "WARNING:canyonos_core.controller.global_controller:"
        "--- begin container log: Workflow (localhost:8001) status=initializing ---\n"
        "WARNING:canyonos_core.controller.global_controller:--- end container log: Workflow ---\n"
        "CRITICAL:canyonos_core:Controller readiness failed: Agent replica(s) "
        "failed to become healthy within 361s: Workflow 0/1\n"
    )
    polls = iter([True] * 40 + [False] * 2)
    seen = []
    monkeypatch.setattr(deploy_cmd, "_STATUS_POLL_SECONDS", 0)
    monkeypatch.setattr(
        deploy_cmd, "deploy_status", lambda _port: {"running": next(polls)}
    )

    def docker_logs(argv, **kwargs):
        seen.append(kwargs)
        return subprocess.CompletedProcess(argv, 0, log, None)

    monkeypatch.setattr(test_cmd.subprocess, "run", docker_logs)
    state = {"port": 1, "container_id": "cid", "docker_socket": "/tmp/docker.sock"}

    with pytest.raises(RuntimeError) as err:
        test_cmd._wait_for_endpoint(state, 2)

    assert str(err.value) == "The deploy stopped before the workflow came up."
    assert err.value.root_cause.endswith("Workflow 0/1")
    assert seen[0]["env"]["DOCKER_HOST"] == "unix:///tmp/docker.sock"
    assert seen[0]["timeout"] == test_cmd.DOCKER_LOGS_TIMEOUT
