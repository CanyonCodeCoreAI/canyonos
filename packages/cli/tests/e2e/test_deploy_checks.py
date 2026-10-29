# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos deploy` through the installed command: the checks it runs before
anything is built."""

from __future__ import annotations

from .harness import CliCase


def test_deploy_warns_about_unset_keys_and_stops_on_project_errors(cli_case: CliCase):
    (cli_case.cwd / ".env.example").write_text("API_KEY=\n# OPTIONAL_KEY=\n")
    (cli_case.cwd / "config").mkdir()
    (cli_case.cwd / "config" / "global_controller.yaml").write_text(
        "agents:\n  - name: Echo\n    entrypoint: agents/missing.py\n"
    )

    result = cli_case.run_cli(["deploy"], timeout=120)

    output = " ".join((result.stdout + result.stderr).split())
    assert result.returncode == 1, output
    assert "Missing or empty in .env: API_KEY. Agents" in output
    assert "OPTIONAL_KEY" not in output
    assert "CANYON-SCHEMA config/global_controller.yaml:1" in output
    assert "Deploy stopped: fix the project errors" in output
    assert "Global Controller" not in output
