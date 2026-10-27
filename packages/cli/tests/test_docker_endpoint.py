# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Which Docker engine the CLI talks to is read from its endpoint, never from the OS:
a unix socket or Docker Desktop's named pipe is on this machine, tcp:// or ssh:// is
not. Paths handed into a container always use forward slashes."""

import os
import subprocess

import pytest

from canyonos import init as init_cmd
from canyonos.constants import container_path

PIPE = "npipe:////./pipe/docker_engine"


@pytest.mark.parametrize(
    "endpoint, local",
    [
        ("unix:///var/run/docker.sock", True),
        (PIPE, True),
        ("tcp://10.0.0.5:2376", False),
        ("ssh://me@build-box", False),
    ],
)
def test_docker_is_local_by_its_endpoint(monkeypatch, endpoint, local):
    monkeypatch.setenv("DOCKER_HOST", endpoint)

    assert init_cmd.docker_is_local() is local


def test_a_named_pipe_is_no_socket_to_name(monkeypatch):
    monkeypatch.setenv("DOCKER_HOST", PIPE)

    assert init_cmd.active_docker_socket() is None


def test_paths_reach_a_container_with_forward_slashes():
    assert container_path(os.path.join(".canyon", "config", "a.yaml")) == (
        ".canyon/config/a.yaml"
    )


class FakeDocker:
    def __init__(self):
        self.calls = []

    def __call__(self, argv, **_):
        self.calls.append(argv)
        if argv[:2] == ["docker", "inspect"]:
            return subprocess.CompletedProcess(argv, 1, "", "No such object")
        if argv[:2] == ["docker", "run"]:
            return subprocess.CompletedProcess(argv, 0, "c" * 64 + "\n", "")
        return subprocess.CompletedProcess(argv, 0, "", "")


@pytest.fixture
def docker(monkeypatch, tmp_path):
    (tmp_path / "portfolio").mkdir()
    monkeypatch.chdir(tmp_path / "portfolio")
    fake = FakeDocker()
    monkeypatch.setattr(init_cmd.subprocess, "run", fake)
    monkeypatch.setattr(init_cmd, "_port_reachable", lambda _port: True)
    monkeypatch.setattr(init_cmd, "private_ip", lambda: None)
    monkeypatch.setattr(init_cmd, "public_ip", lambda: None)
    return fake


def test_over_a_named_pipe_the_engine_socket_is_mounted_but_not_recorded(
    monkeypatch, docker
):
    monkeypatch.setenv("DOCKER_HOST", PIPE)

    _, _, recorded = init_cmd._run_container()

    run = next(argv for argv in docker.calls if argv[:2] == ["docker", "run"])
    assert "/var/run/docker.sock:/var/run/docker.sock" in run
    # Recorded, it would point every later host-side `docker` call at a path this
    # machine doesn't have.
    assert recorded is None


@pytest.mark.posix_only("a unix socket on this machine")
def test_a_real_socket_is_recorded_for_later_docker_calls(
    monkeypatch, docker, tmp_path
):
    socket = tmp_path / "docker.sock"
    socket.touch()
    monkeypatch.setenv("DOCKER_HOST", f"unix://{socket}")

    _, _, recorded = init_cmd._run_container()

    assert recorded == os.path.realpath(socket)


def test_docker_desktop_is_started_with_its_own_cli_where_installed(monkeypatch):
    def run_docker(argv, **_):
        if argv[:3] == ["docker", "context", "show"]:
            return subprocess.CompletedProcess(argv, 0, "desktop-linux\n", "")
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(init_cmd, "run_docker", run_docker)

    assert init_cmd.docker_start_command() == [
        "docker",
        "desktop",
        "start",
        "--detach",
    ]
