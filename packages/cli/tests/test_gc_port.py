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

    def run_container(image=None, port=None, **ports):
        seen.update(port=port, **ports)
        return "abcdef123456", seen.get("lands_on", port), None

    def stop_existing():
        # Like the real teardown, a successful stop removes the state file.
        seen["state_at_quit"] = os.path.isfile(project.state_path())
        if seen["state_at_quit"]:
            os.remove(project.state_path())

    monkeypatch.setattr(init_cmd, "stop_existing", stop_existing)
    monkeypatch.setattr(init_cmd, "_pull_image", lambda _image: None)
    monkeypatch.setattr(init_cmd, "_run_container", run_container)
    monkeypatch.setattr(init_cmd, "existing_config_path", lambda: "gc.yaml")
    monkeypatch.setattr(init_cmd, "endpoint_api_port", lambda _path: 8080)
    monkeypatch.setattr(init_cmd, "port_in_use", lambda _port: False)
    monkeypatch.setattr(init_cmd, "local_redis_port", lambda _path: 6379)
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


def test_an_occupied_api_port_stops_before_the_container_starts(init, monkeypatch):
    monkeypatch.setattr(init_cmd, "port_in_use", lambda _port: True)

    with pytest.raises(
        RuntimeError, match="Port 8080 is already in use.*`endpoint.api_port`"
    ):
        init_cmd.run_init(banner=False)

    assert "port" not in init


@pytest.fixture
def unset_ports(init, monkeypatch):
    """A config that sets neither `endpoint.api_port` nor `redis.port`, with every port
    free unless `init["free_from"]` says where the next free one is."""
    monkeypatch.setattr(init_cmd, "endpoint_api_port", lambda _path: None)
    monkeypatch.setattr(init_cmd, "local_redis_port", lambda _path: None)
    monkeypatch.setattr(
        init_cmd, "find_free_port", lambda port: init.get("free_from", port)
    )
    return init


def test_a_redeploy_starts_redis_and_the_endpoint_from_their_last_ports(unset_ports):
    init_cmd._save_state("old", 8003, None, 6390, 8091)

    init_cmd.run_init(banner=False)

    assert (unset_ports["redis_port"], unset_ports["api_port"]) == (6390, 8091)


def test_a_set_api_port_is_not_moved_from_a_last_one(init):
    init_cmd._save_state("old", 8003, None, 6379, 8091)

    init_cmd.run_init(banner=False)

    assert init["api_port"] is None


def test_a_moved_redis_port_names_the_port_it_wanted(unset_ports, capsys):
    init_cmd._save_state("old", 8003, None, 6390)
    unset_ports["free_from"] = 6391

    init_cmd.run_init(banner=False)

    output = " ".join(capsys.readouterr().err.split())
    assert "Port 6390 is taken, so Redis is on 6391" in output


def test_the_endpoints_port_is_recorded_beside_the_rest(init):
    init_cmd._save_state("abc", 8000, "/sock", 6379)

    init_cmd.remember_api_port(8085)

    assert init_cmd.load_state() == {
        "container_id": "abc",
        "port": 8000,
        "docker_socket": "/sock",
        "redis_port": 6379,
        "api_port": 8085,
    }


def test_without_a_state_file_no_endpoint_port_is_recorded(init):
    init_cmd.remember_api_port(8085)

    assert not os.path.exists(project.state_path())


@pytest.mark.parametrize(
    ("state", "configured", "expected"),
    [
        ({"redis_port": 6390}, 6380, 6390),
        ({}, 6380, 6380),
        ({}, None, 6379),
    ],
    ids=["recorded", "older-cli-config", "older-cli-default"],
)
def test_the_redis_port_falls_back_for_a_state_file_from_an_older_cli(
    monkeypatch, state, configured, expected
):
    monkeypatch.setattr(init_cmd, "local_redis_port", lambda _path: configured)

    assert init_cmd.redis_port_of(state) == expected
