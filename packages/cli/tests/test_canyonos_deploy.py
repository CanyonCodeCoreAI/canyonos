# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import pytest

from canyonos import deploy as deploy_cmd
from canyonos.gc import GCError

STATE = {"container_id": "abc", "port": 8000}


@pytest.fixture
def deployable(monkeypatch, tmp_path):
    """Every step run_deploy drives succeeds unless overridden."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "global_controller.yaml").touch()
    monkeypatch.setattr(deploy_cmd, "_ensure_docker_running", lambda: None)
    monkeypatch.setattr(deploy_cmd, "collect_findings", lambda _root: [])
    monkeypatch.setattr(deploy_cmd, "save_project_id", lambda _path: None)
    monkeypatch.setattr(deploy_cmd, "save_deployed_fingerprints", lambda _f: None)
    monkeypatch.setattr(deploy_cmd, "run_init", lambda banner=True: None)
    monkeypatch.setattr(deploy_cmd, "run_sync", lambda: True)
    monkeypatch.setattr(deploy_cmd, "configure_resources", lambda _path: True)
    monkeypatch.setattr(deploy_cmd, "load_state", lambda: dict(STATE))
    monkeypatch.setattr(deploy_cmd, "post_deploy", lambda *_a: None)
    monkeypatch.setattr(deploy_cmd, "_start_dashboard", lambda **_k: None)
    monkeypatch.setattr(deploy_cmd, "stop_project", lambda _state: None)


def test_a_sync_failure_raises(monkeypatch, deployable):
    cleaned = []
    monkeypatch.setattr(deploy_cmd, "run_sync", lambda: False)
    monkeypatch.setattr(deploy_cmd, "stop_project", lambda _state: cleaned.append(True))

    with pytest.raises(RuntimeError, match="Could not sync the project"):
        deploy_cmd.run_deploy(quiet=True)

    assert cleaned == [True]


def test_ctrl_c_during_setup_cleans_up_the_partial_deploy(monkeypatch, deployable):
    cleaned = []
    monkeypatch.setattr(
        deploy_cmd,
        "run_sync",
        lambda: (_ for _ in ()).throw(KeyboardInterrupt()),
    )
    monkeypatch.setattr(deploy_cmd, "stop_project", lambda _state: cleaned.append(True))

    with pytest.raises(KeyboardInterrupt):
        deploy_cmd.run_deploy(quiet=True)

    assert cleaned == [True]


def test_a_log_monitor_failure_cleans_up_the_partial_deploy(monkeypatch, deployable):
    cleaned = []
    monkeypatch.setattr(
        deploy_cmd,
        "_stream_logs_and_autoserve",
        lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("logs broke")),
    )
    monkeypatch.setattr(deploy_cmd, "stop_project", lambda _state: cleaned.append(True))

    with pytest.raises(RuntimeError, match="logs broke"):
        deploy_cmd.run_deploy(serve=False)

    assert cleaned == [True]


def test_a_post_deploy_failure_is_reraised_as_a_runtime_error(monkeypatch, deployable):
    def boom(*_a):
        raise GCError("Deploy failed: conflict")

    monkeypatch.setattr(deploy_cmd, "post_deploy", boom)

    with pytest.raises(RuntimeError, match="Deploy failed: conflict"):
        deploy_cmd.run_deploy(quiet=True)


def test_a_failure_after_the_workflow_is_up_leaves_the_deploy_alone(
    monkeypatch, deployable
):
    """Summary rendering runs after the workflow is serving, so anything that
    fails there is a reporting problem -- not a reason to tear the stack down."""
    cleaned = []

    def ready_then_fail(*_a, on_ready, **_k):
        on_ready(True)
        raise RuntimeError("could not resolve endpoints")

    monkeypatch.setattr(deploy_cmd, "_stream_logs_and_autoserve", ready_then_fail)
    monkeypatch.setattr(deploy_cmd, "stop_project", lambda _state: cleaned.append(True))

    with pytest.raises(RuntimeError, match="could not resolve endpoints"):
        deploy_cmd.run_deploy(serve=False)

    assert cleaned == []


def test_quiet_returns_state_without_streaming(monkeypatch, deployable):
    def unexpected(*_a, **_k):
        raise AssertionError("quiet=True should skip the log-tail/dashboard UI")

    monkeypatch.setattr(deploy_cmd, "_stream_logs_and_autoserve", unexpected)

    assert deploy_cmd.run_deploy(quiet=True) == STATE


def test_non_quiet_still_streams_and_returns_state(monkeypatch, deployable):
    calls = []
    monkeypatch.setattr(
        deploy_cmd,
        "_stream_logs_and_autoserve",
        lambda state, serve, verbose, on_ready: calls.append((state, serve, verbose)),
    )

    assert deploy_cmd.run_deploy(serve=False, verbose=True) == STATE
    assert calls == [(STATE, False, True)]


def test_banner_is_forwarded_to_run_init(monkeypatch, deployable):
    seen = {}
    monkeypatch.setattr(
        deploy_cmd, "run_init", lambda banner=True: seen.update(banner=banner)
    )

    deploy_cmd.run_deploy(quiet=True, banner=False)

    assert seen == {"banner": False}


def test_a_cancelled_resource_picker_stops_before_run_init(monkeypatch, deployable):
    monkeypatch.setattr(deploy_cmd, "configure_resources", lambda _path: False)
    monkeypatch.setattr(
        deploy_cmd, "run_init", lambda **_k: pytest.fail("run_init should not run")
    )

    assert deploy_cmd.run_deploy(serve=False) is None


def test_quiet_skips_the_resource_picker(monkeypatch, deployable):
    monkeypatch.setattr(
        deploy_cmd,
        "configure_resources",
        lambda _path: pytest.fail("picker should not run under quiet"),
    )

    assert deploy_cmd.run_deploy(quiet=True) == STATE


def test_the_deploy_panel_shows_how_to_answer_a_question():
    endpoint = {
        "public_host": "127.0.0.1",
        "api_port": 8084,
        "url": "http://127.0.0.1:8084/main",
        "arguments": ["query"],
    }

    text = deploy_cmd.summary_body(None, endpoint).plain

    assert (
        "respond to agent  curl -X POST http://127.0.0.1:8084/answer/<request_id> "
        '-H "Content-Type: application/json" -d \'{"input": "your answer"}\''
    ) in text


@pytest.mark.parametrize(
    "provider, core_image, warned",
    [
        ("ec2-assign", "canyonos-core:dev", True),
        ("ec2-pool", "canyonos-core:dev", True),
        ("local", "canyonos-core:dev", False),
        ("ec2-assign", deploy_cmd.env.PROD_CORE_IMAGE, False),
    ],
)
def test_a_dev_core_image_warns_that_agent_machines_run_the_released_collector(
    monkeypatch, tmp_path, provider, core_image, warned
):
    config = tmp_path / "global_controller.yaml"
    config.write_text(f"provider: {provider}\n")
    monkeypatch.setattr(deploy_cmd.env, "core_image", core_image)
    warnings = []
    monkeypatch.setattr(deploy_cmd.ui, "warn", warnings.append)

    deploy_cmd._warn_about_the_collector_image(str(config))

    assert bool(warnings) == warned
    if warned:
        assert deploy_cmd.env.PROD_CORE_IMAGE in warnings[0]


@pytest.mark.parametrize(
    ("configured", "remembered", "lands_on", "warning"),
    [
        (None, 8081, 8082, "Port 8081 is taken, so the endpoint is on 8082"),
        (None, None, 8080, None),
        (8090, None, 8090, None),
    ],
    ids=["moved-from-last", "first-deploy", "set-in-config"],
)
def test_the_summary_names_a_moved_endpoint_and_records_its_port(
    monkeypatch, capsys, configured, remembered, lands_on, warning
):
    recorded = []
    monkeypatch.setattr(
        deploy_cmd, "deployed_endpoint", lambda _port: {"api_port": lands_on}
    )
    monkeypatch.setattr(deploy_cmd, "existing_config_path", lambda: "gc.yaml")
    monkeypatch.setattr(deploy_cmd, "endpoint_api_port", lambda _path: configured)
    monkeypatch.setattr(deploy_cmd, "remember_api_port", recorded.append)
    monkeypatch.setattr(deploy_cmd, "_print_deploy_summary", lambda *_a: None)

    deploy_cmd._deploy_summary(
        {**STATE, "api_port": remembered}, serve=False, on_ready=lambda _ready: None
    )

    err = " ".join(capsys.readouterr().err.split())
    assert (warning in err) if warning else ("is taken" not in err)
    assert recorded == ([] if configured else [lands_on])
