# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import subprocess

from pathlib import Path

from canyonos import dashboard_stack, docker_cmd, project, quit as quit_cmd
from canyonos.gc import GCError

STATE = {"container_id": "abcdef123456", "port": 8000}


def _state(monkeypatch, tmp_path):
    (tmp_path / "portfolio").mkdir()
    monkeypatch.chdir(tmp_path / "portfolio")
    state_path = Path(project.state_path())
    state_path.parent.mkdir(parents=True)
    state_path.write_text(
        '{"container_id": "abcdef123456", "port": 8000}', encoding="utf-8"
    )
    monkeypatch.setattr(quit_cmd, "require_state", lambda: dict(STATE))
    monkeypatch.setattr(
        quit_cmd, "_container_state", lambda _container_id, _env: (True, True)
    )
    monkeypatch.setattr(quit_cmd, "teardown_dashboard", lambda: True)
    monkeypatch.setattr(
        project, "other_global_controllers_running", lambda _id, _env=None: False
    )
    return state_path


def test_controller_cleanup_failure_preserves_state(monkeypatch, tmp_path):
    state_path = _state(monkeypatch, tmp_path)
    docker_calls = []
    monkeypatch.setattr(
        quit_cmd,
        "post_clean",
        lambda _port: (_ for _ in ()).throw(GCError("controller stuck", code=500)),
    )

    def docker(argv, **_kwargs):
        docker_calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(docker_cmd.subprocess, "run", docker)

    failures = quit_cmd.quit_project(dict(STATE))

    assert any("controller stuck" in failure for failure in failures)
    assert state_path.exists()
    # A controller that won't clean doesn't stop the rest of the teardown.
    assert ["docker", "rm", "abcdef123456"] in docker_calls


def test_docker_cleanup_failure_preserves_state(monkeypatch, tmp_path):
    state_path = _state(monkeypatch, tmp_path)
    monkeypatch.setattr(quit_cmd, "post_clean", lambda _port: None)

    def docker(argv, **_kwargs):
        return subprocess.CompletedProcess(
            argv,
            1 if argv[:2] == ["docker", "rm"] else 0,
            "",
            "daemon error" if argv[:2] == ["docker", "rm"] else "",
        )

    monkeypatch.setattr(docker_cmd.subprocess, "run", docker)

    failures = quit_cmd.quit_project(dict(STATE))

    assert any("daemon error" in failure for failure in failures)
    assert state_path.exists()


def test_successful_cleanup_removes_state(monkeypatch, tmp_path):
    state_path = _state(monkeypatch, tmp_path)
    monkeypatch.setattr(quit_cmd, "post_clean", lambda _port: None)
    monkeypatch.setattr(
        docker_cmd.subprocess,
        "run",
        lambda argv, **_kwargs: subprocess.CompletedProcess(argv, 0, "", ""),
    )

    quit_cmd.run_quit()

    assert not state_path.exists()


def test_stopped_controller_is_removed_without_calling_clean(monkeypatch, tmp_path):
    state_path = _state(monkeypatch, tmp_path)
    monkeypatch.setattr(
        quit_cmd, "_container_state", lambda _container_id, _env: (True, False)
    )
    clean_calls = []
    docker_calls = []
    monkeypatch.setattr(quit_cmd, "post_clean", lambda _port: clean_calls.append(True))

    def docker(argv, **_kwargs):
        docker_calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(docker_cmd.subprocess, "run", docker)

    quit_cmd.run_quit()

    assert clean_calls == []
    assert ["docker", "stop", "abcdef123456"] not in docker_calls
    assert ["docker", "rm", "abcdef123456"] in docker_calls
    assert not state_path.exists()


def test_a_dashboard_teardown_failure_is_reported_after_the_project_is_gone(
    monkeypatch, tmp_path, capsys
):
    state_path = _state(monkeypatch, tmp_path)
    monkeypatch.setattr(quit_cmd, "post_clean", lambda _port: None)
    monkeypatch.setattr(quit_cmd, "teardown_dashboard", lambda: False)
    monkeypatch.setattr(
        docker_cmd.subprocess,
        "run",
        lambda argv, **_kwargs: subprocess.CompletedProcess(argv, 0, "", ""),
    )

    quit_cmd.run_quit()

    assert "dashboard stack failed" in capsys.readouterr().out
    assert not state_path.exists()


def test_quit_outside_the_project_fails_while_dashboard_containers_remain(
    monkeypatch, tmp_path, capsys
):
    _state(monkeypatch, tmp_path)
    monkeypatch.setattr(quit_cmd, "post_clean", lambda _port: None)
    monkeypatch.setattr(
        quit_cmd, "teardown_dashboard", dashboard_stack.teardown_dashboard
    )
    docker_calls = []

    def docker(argv, **_kwargs):
        docker_calls.append(argv)
        leftover = "9f1c2d3e4b5a\n" if argv[-3:] == ["ps", "-q", "--all"] else ""
        return subprocess.CompletedProcess(argv, 0, leftover, "")

    monkeypatch.setattr(docker_cmd.subprocess, "run", docker)

    quit_cmd.run_quit()

    assert ["docker", "compose", "-p", "canyonos-dashboard", "down"] in docker_calls
    assert "dashboard stack failed" in capsys.readouterr().out
