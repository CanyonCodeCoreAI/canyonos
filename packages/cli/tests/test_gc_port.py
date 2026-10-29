# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import os

import pytest

from canyonos import init as init_cmd, project


@pytest.fixture
def init(monkeypatch, tmp_path):
    """run_init with Docker stubbed out; records how _run_container was asked."""
    (tmp_path / "portfolio").mkdir()
    monkeypatch.chdir(tmp_path / "portfolio")
    seen = {}

    def run_container(image=None, port=None):
        seen.update(port=port)
        return "abcdef123456", seen.get("lands_on", port), None

    def stop_existing():
        # Like the real teardown, a successful stop removes the state file.
        seen["state_at_quit"] = os.path.isfile(project.state_path())
        if seen["state_at_quit"]:
            os.remove(project.state_path())

    monkeypatch.setattr(init_cmd, "_ensure_docker_running", lambda: None)
    monkeypatch.setattr(init_cmd, "stop_existing", stop_existing)
    monkeypatch.setattr(init_cmd, "_pull_image", lambda _image: None)
    monkeypatch.setattr(init_cmd, "_run_container", run_container)
    return seen


def test_a_first_deploy_tries_the_default_port(init):
    init_cmd.run_init(banner=False)

    assert init["port"] == init_cmd.GC_CONTAINER_PORT


def test_a_redeploy_tries_the_port_the_last_deploy_used(init):
    init_cmd._save_state("old", 8003)

    init_cmd.run_init(banner=False)

    # Read before the teardown removed the state file.
    assert init["state_at_quit"] is True
    assert init["port"] == 8003


def test_a_moved_port_is_named(init, capsys):
    init["lands_on"] = 8001

    init_cmd.run_init(banner=False)

    output = " ".join(capsys.readouterr().err.split())
    assert "Port 8000 is taken, so the Global Controller is on 8001" in output


def test_an_unmoved_port_says_nothing_about_it(init, capsys):
    init_cmd.run_init(banner=False)

    assert "is taken" not in capsys.readouterr().err
