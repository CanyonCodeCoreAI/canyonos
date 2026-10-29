# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Regression coverage for the automatic 500-candidate port search."""

from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import Mock

import pytest
import yaml

from canyonos import dashboard_stack, port_utils


def test_default_port_limit_is_shared_with_dashboard():
    assert port_utils.DEFAULT_MAX_PORT_ATTEMPTS == 500
    assert dashboard_stack.DEFAULT_MAX_PORT_ATTEMPTS == 500


def test_default_search_can_use_the_500th_candidate(monkeypatch):
    probe = Mock(side_effect=lambda port, host: port == 8499)
    monkeypatch.setattr(port_utils, "is_port_free", probe)

    assert port_utils.find_free_port(8000) == 8499
    assert [call.args[0] for call in probe.call_args_list] == list(range(8000, 8500))


def test_default_search_stops_after_500_candidates(monkeypatch):
    probe = Mock(return_value=False)
    monkeypatch.setattr(port_utils, "is_port_free", probe)

    with pytest.raises(RuntimeError, match="after 500 attempts starting at 8000"):
        port_utils.find_free_port(8000)

    assert [call.args[0] for call in probe.call_args_list] == list(range(8000, 8500))


@pytest.mark.parametrize("conflicts", [499, 500])
def test_dashboard_uses_all_500_candidates(monkeypatch, tmp_path, conflicts):
    attempted_ports = []

    def run(argv, env):
        port = int(env["CANYONOS_WEB_PORT"])
        attempted_ports.append(port)
        if len(attempted_ports) <= conflicts:
            return CompletedProcess(
                argv,
                1,
                "",
                f"Bind for 0.0.0.0:{port} failed: port is already allocated",
            )
        return CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(dashboard_stack, "_run", run)
    monkeypatch.setattr(
        dashboard_stack,
        "_prepare",
        lambda stack: ({"CANYONOS_WEB_PORT": str(stack.web_port)}, ""),
    )
    stack = dashboard_stack.DashboardStack(tmp_path, 8081)
    managed_env = {"CANYONOS_WEB_PORT": "8081"}
    manifest = tmp_path / "dashboard.compose.yml"

    if conflicts == 499:
        started, started_env = dashboard_stack._start(
            stack, manifest, managed_env, movable=True
        )
        assert started.web_port == 8580
        assert started_env["CANYONOS_WEB_PORT"] == "8580"
    else:
        with pytest.raises(
            dashboard_stack.PhaseFailure, match="no free port found after 500 attempts"
        ):
            dashboard_stack._start(stack, manifest, managed_env, movable=True)

    assert attempted_ports == list(range(8081, 8581))


def test_helloworld_endpoint_leaves_port_selection_automatic():
    root = Path(__file__).resolve().parents[3]
    config_path = root / "examples/helloworld/config/global_controller.yaml"
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))

    assert "api_port" not in config["endpoint"]
