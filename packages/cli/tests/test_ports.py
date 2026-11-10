# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import json
import os

import pytest

from canyonos import dashboard_stack, forwards, ports, project


@pytest.fixture
def home(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    monkeypatch.setattr(dashboard_stack, "_existing_dashboard_port", lambda: None)
    monkeypatch.setattr(dashboard_stack, "_published_port", lambda *_a: None)
    return tmp_path


def _state(name, **state):
    path = os.path.join(project.projects_dir(), name, "state.json")
    os.makedirs(os.path.dirname(path))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f)


def _forward(name, port, fresh=True):
    os.makedirs(forwards.forwards_dir(), exist_ok=True)
    path = os.path.join(forwards.forwards_dir(), f"{name}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"port": port}, f)
    if not fresh:
        os.utime(path, (0, 0))


def test_every_deployed_projects_ports_are_claimed(home):
    _state("a-1", container_id="x", port=8000, redis_port=6379, api_port=8080)
    _state("b-2", container_id="y", port=8001)

    claims = ports.claimed()

    assert {claims[port] for port in (8000, 6379, 8080)} == {"project a-1"}
    assert claims[8001] == "project b-2"


def test_running_forwards_are_claimed_and_stale_ones_are_not(home):
    _forward("endpoint-ns-app", 18080)
    _forward("endpoint-ns-old", 18081, fresh=False)

    claims = ports.claimed()

    assert claims[18080] == "the port-forward endpoint-ns-app"
    assert 18081 not in claims


def _running_dashboard(monkeypatch, published):
    monkeypatch.setattr(
        dashboard_stack, "_existing_dashboard_port", lambda: published["web"]
    )
    monkeypatch.setattr(
        dashboard_stack, "_published_port", lambda service, _port: published[service]
    )


def test_the_dashboards_port_is_claimed_running_set_picked_or_default(
    home, monkeypatch
):
    assert ports.claimed()[8081] == ports.DASHBOARD
    assert ports.claimed(dashboard_port=8090)[8090] == ports.DASHBOARD

    dashboard_stack._save_service_ports({"web": 8082})
    assert ports.claimed()[8082] == ports.DASHBOARD
    assert 8082 not in ports.claimed(dashboard_port=8090)

    _running_dashboard(monkeypatch, {"web": 8095, "api": 3000, "db": 5432})
    assert ports.claimed(dashboard_port=8090)[8095] == ports.DASHBOARD


def test_picking_a_dashboards_port_holds_only_a_running_dashboard_against_it(
    home, monkeypatch
):
    assert ports.DASHBOARD not in ports.claimed(picking_dashboard=True).values()

    _running_dashboard(monkeypatch, {"web": 8081, "api": 3000, "db": 5432})
    assert ports.claimed(picking_dashboard=True)[8081] == ports.DASHBOARD


def test_an_unreadable_state_file_claims_nothing(home):
    os.makedirs(os.path.join(project.projects_dir(), "broken"))
    path = os.path.join(project.projects_dir(), "broken", "state.json")
    with open(path, "w", encoding="utf-8") as f:
        f.write("{not json")

    assert set(ports.claimed()) == {8081, 3000}


def test_the_dashboards_api_port_is_claimed_picked_or_default(home, monkeypatch):
    assert ports.claimed()[3000] == ports.DASHBOARD

    dashboard_stack._save_service_ports({"api": 3001})
    claims = ports.claimed()
    assert claims[3001] == ports.DASHBOARD
    assert 3000 not in claims

    # Picking them, only a running dashboard's are held against the pick.
    assert 3001 not in ports.claimed(picking_dashboard=True)


def test_the_dashboards_ports_start_at_their_defaults(home, monkeypatch):
    monkeypatch.setattr(ports, "find_free_port", lambda port, skip: port)
    dashboard_stack._save_service_ports({"web": 8082, "api": 3001})

    assert dashboard_stack.pick_service_ports({}) == {"web": 8081, "api": 3000}


def test_a_set_dashboard_port_is_used_as_it_is(home, monkeypatch):
    monkeypatch.setattr(
        ports,
        "find_free_port",
        lambda port, skip: next(p for p in range(port, 65536) if p not in skip),
    )

    picked = dashboard_stack.pick_service_ports({}, dashboard_port=3000)

    # The API moves past it.
    assert picked == {"web": 3000, "api": 3001}


def test_a_taken_api_port_moves_and_says_so(home, monkeypatch, capsys):
    monkeypatch.setattr(
        ports, "find_free_port", lambda port, skip: port + 1 if port == 3000 else port
    )

    picked = dashboard_stack.pick_service_ports({})

    assert picked == {"web": 8081, "api": 3001}
    output = capsys.readouterr()
    assert "Port 3000 is taken, so the dashboard's API is on 3001." in (
        output.out + output.err
    )
    saved = json.loads((home / ".canyonos" / "dashboard" / "ports.json").read_text())
    assert saved == picked


def test_a_running_dashboards_ports_are_kept(home, monkeypatch):
    published = {"web": 8087, "api": 3007}
    _running_dashboard(monkeypatch, published)
    monkeypatch.setattr(
        ports, "find_free_port", lambda *_a, **_k: pytest.fail("nothing to pick")
    )

    assert dashboard_stack.pick_service_ports({}) == published
    assert dashboard_stack.service_ports() == published
