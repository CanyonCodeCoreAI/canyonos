# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import json
import subprocess
from pathlib import Path

import pytest

from canyonos import init as init_cmd, project


def test_docker_runtime_start_uses_bounded_translated_command(monkeypatch):
    calls = []
    monkeypatch.setattr(init_cmd.shutil, "which", lambda _name: "/usr/local/bin/docker")
    monkeypatch.setattr(init_cmd, "docker_running", lambda: False)
    monkeypatch.setattr(init_cmd, "docker_start_command", lambda: ["orb", "start"])

    def failed(argv, **kwargs):
        calls.append((argv, kwargs))
        raise RuntimeError("Starting the Docker runtime failed: launch failed")

    monkeypatch.setattr(init_cmd, "run_docker", failed)

    with pytest.raises(
        RuntimeError, match="Starting the Docker runtime failed: launch failed"
    ):
        init_cmd._ensure_docker_running()

    assert calls == [
        (
            ["orb", "start"],
            {
                "timeout": init_cmd.DOCKER_START_TIMEOUT,
                "action": "Starting the Docker runtime",
                "check": True,
            },
        )
    ]


def _project_state_path(monkeypatch, tmp_path):
    (tmp_path / "portfolio").mkdir()
    monkeypatch.chdir(tmp_path / "portfolio")
    state_path = Path(project.state_path())
    state_path.parent.mkdir(parents=True)
    return state_path


def test_failed_state_write_preserves_the_previous_state(monkeypatch, tmp_path):
    state_path = _project_state_path(monkeypatch, tmp_path)
    original = {"container_id": "old", "port": 8000}
    state_path.write_text(json.dumps(original))
    monkeypatch.setattr(
        init_cmd.json,
        "dump",
        lambda *_a, **_k: (_ for _ in ()).throw(OSError("disk full")),
    )

    with pytest.raises(OSError, match="disk full"):
        init_cmd._save_state("new", 8001)

    assert json.loads(state_path.read_text()) == original
    assert list(state_path.parent.glob("state.*.tmp")) == []


def test_state_save_failure_removes_the_new_container(monkeypatch):
    calls = []
    monkeypatch.setattr(init_cmd, "stop_existing", lambda: None)
    monkeypatch.setattr(init_cmd, "_pull_image", lambda _image: None)
    monkeypatch.setattr(init_cmd, "existing_config_path", lambda: "gc.yaml")
    monkeypatch.setattr(init_cmd, "endpoint_api_port", lambda _path: 8080)
    monkeypatch.setattr(init_cmd, "port_in_use", lambda _port: False)
    monkeypatch.setattr(init_cmd, "local_redis_port", lambda _path: 6379)
    monkeypatch.setattr(
        init_cmd,
        "_run_container",
        lambda **_k: ("abcdef123456", 8000, None),
    )
    monkeypatch.setattr(
        init_cmd, "_save_state", lambda *_a: (_ for _ in ()).throw(OSError("disk full"))
    )
    monkeypatch.setattr(
        init_cmd.subprocess,
        "run",
        lambda argv, **_k: (
            calls.append(argv) or subprocess.CompletedProcess(argv, 0, "", "")
        ),
    )

    with pytest.raises(RuntimeError, match="disk full"):
        init_cmd.run_init(banner=False)

    assert calls == [["docker", "rm", "-f", "abcdef123456"]]


@pytest.mark.parametrize(
    "contents",
    [
        "",
        "not json",
        "[]",
        '{"container_id": "abc"}',
        '{"container_id": "abc", "port": 70000}',
    ],
)
def test_invalid_state_has_recovery_guidance(monkeypatch, tmp_path, contents):
    state_path = _project_state_path(monkeypatch, tmp_path)
    state_path.write_text(contents)

    with pytest.raises(RuntimeError, match="Move or remove that file"):
        init_cmd.load_state()
