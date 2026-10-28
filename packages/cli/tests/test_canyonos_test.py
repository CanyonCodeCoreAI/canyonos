# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import io
import json
import re
import queue
import subprocess
import urllib.error
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
ANSWER_URL = "http://127.0.0.1:8080/answer/req-1"


@pytest.fixture(autouse=True)
def loud():
    """Every test starts with output enabled; `--json` runs flip it and restore it."""
    ui.set_quiet(False)
    yield
    ui.set_quiet(False)


@pytest.fixture
def project(monkeypatch, tmp_path):
    root = tmp_path / "portfolio"
    canyon = root / ".canyon"
    (canyon / "config").mkdir(parents=True)
    (canyon / "config" / "global_controller.yaml").write_text(CONFIG)
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
        str(project / ".canyon" / "config" / "global_controller.yaml")
    )

    assert [(a["name"], a["running"], a["expected"]) for a in result["agents"]] == [
        ("EchoAgent", 2, 2),
        ("Workflow", 1, 1),
    ]


def test_a_short_replica_count_fails(project, runtime):
    runtime(IMAGES, ALL_UP[1:])

    with pytest.raises(RuntimeError, match="1 of 2 replicas"):
        verify.verify_runtime(
            str(project / ".canyon" / "config" / "global_controller.yaml")
        )


def test_an_image_that_was_never_built_fails(project, runtime):
    runtime({"canyonos-portfolio-workflow"}, ["canyonos-portfolio-workflow-0"])

    with pytest.raises(
        RuntimeError, match="canyonos-portfolio-echoagent was never built"
    ):
        verify.verify_runtime(
            str(project / ".canyon" / "config" / "global_controller.yaml")
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


def test_the_provider_is_restored_and_the_project_id_kept_after_the_run(
    project, deployable
):
    config = project / ".canyon" / "config" / "global_controller.yaml"

    test_cmd.run_test("hi")

    assert re.fullmatch(
        re.escape(CONFIG) + r"project_id: [0-9a-f-]{36}\n", config.read_text()
    )


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


def _ask(monkeypatch, input_schema, *typed):
    """Make the workflow ask one question whose answer has `input_schema`, have the
    person type each of `typed` in turn, and return the calls sent to the endpoint."""
    statuses = iter(
        [
            {
                "status": "input_required",
                "question": {"question": "Sell TSLA?", "input_schema": input_schema},
            },
            {"status": "done", "result": {"r": 2}},
        ]
    )
    sent = []
    lines = iter(typed)
    monkeypatch.setattr(test_cmd, "_await_result", lambda *a: next(statuses))
    monkeypatch.setattr(test_cmd, "_send_query", lambda *a: sent.append(a) or "req-1")
    monkeypatch.setattr("builtins.input", lambda _prompt: next(lines))
    monkeypatch.setattr(test_cmd, "is_terminal", lambda _stream: True)
    return sent


@pytest.mark.parametrize(
    "input_schema, typed, prompts, body",
    [
        ({"input": "str"}, ["false"], ["Your answer: "], {"input": "false"}),
        ({"input": "bool"}, ["true"], ["Your answer (bool): "], {"input": True}),
        ({"input": "int"}, ["42"], ["Your answer (int): "], {"input": 42}),
        ({"input": "float"}, ["2.5"], ["Your answer (float): "], {"input": 2.5}),
        (
            {"input": "any"},
            ['{"approve": true}'],
            ["Your answer (any): "],
            {"input": {"approve": True}},
        ),
        (
            {"approved": "bool", "draft": "str | None"},
            ["true", "null"],
            ["approved (bool): ", "draft (str | None): "],
            {"approved": True, "draft": None},
        ),
        (
            {"approve": "bool", "message": "str"},
            ["false", "Not today"],
            ["approve (bool): ", "message (str): "],
            {"approve": False, "message": "Not today"},
        ),
    ],
)
def test_a_question_is_answered_key_by_key_as_the_types_it_expects(
    monkeypatch, deployable, input_schema, typed, prompts, body
):
    sent = _ask(monkeypatch, input_schema)
    asked, lines = [], iter(typed)
    monkeypatch.setattr(
        "builtins.input", lambda prompt: asked.append(prompt) or next(lines)
    )

    assert test_cmd.run_test("hi") == 0

    assert asked == prompts
    assert sent[-1] == (ANSWER_URL, body)


def test_an_answer_that_is_not_json_is_sent_as_typed(monkeypatch, deployable):
    sent = _ask(monkeypatch, {"input": "bool"}, "yes")

    assert test_cmd.run_test("hi") == 0

    assert sent[1:] == [(ANSWER_URL, {"input": "yes"})]


def _http_error(code, error):
    """The endpoint's answer to a refused POST, carrying `error`."""
    body = io.BytesIO(json.dumps({"error": error}).encode())
    return urllib.error.HTTPError(ANSWER_URL, code, "", {}, body)


def test_a_refused_answer_reports_the_endpoint_reason(monkeypatch, deployable):
    _ask(monkeypatch, {"input": "str"}, "sell")
    errors = []

    def send(*a):
        if a[0] == ANSWER_URL:
            raise _http_error(409, "Request req-1 is not waiting for input")
        return "req-1"

    monkeypatch.setattr(test_cmd, "_send_query", send)
    monkeypatch.setattr(
        test_cmd, "_print_summary", lambda run: errors.append(run.error)
    )

    assert test_cmd.run_test("hi") == 1

    assert errors[0].endswith(": Request req-1 is not waiting for input")


def test_a_question_without_a_terminal_fails_the_run(monkeypatch, deployable):
    sent = _ask(monkeypatch, {"input": "str"})
    errors = []

    monkeypatch.setattr(test_cmd, "is_terminal", lambda _stream: False)
    monkeypatch.setattr(
        test_cmd, "_print_summary", lambda run: errors.append(run.error)
    )

    assert test_cmd.run_test("hi") == 1

    assert "answer request req-1 with: curl -X POST " + ANSWER_URL in errors[0]
    assert len(sent) == 1


def test_a_question_fails_a_json_run_without_prompting(monkeypatch, deployable, capsys):
    sent = _ask(monkeypatch, {"input": "str"})

    assert test_cmd.run_test("hi", as_json=True) == 1

    assert "without --json" in json.loads(capsys.readouterr().out)["error"]
    # Only the query went out; no answer was asked for or sent.
    assert len(sent) == 1


def test_a_flat_layout_project_deploys_fine_with_no_canyon_directory(
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
    assert err.value.root_cause == "Failed to launch Redis on 127.0.0.1: port taken"


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
