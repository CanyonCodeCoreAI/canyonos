# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos deploy` through the installed command: the checks it runs before
anything is built, from a deployment folder or from inside a project folder."""

from __future__ import annotations

from .harness import CliCase


def _project(folder):
    """Write a project whose manifest names code it does not hold into `folder`."""
    (folder / "config").mkdir(parents=True)
    (folder / "config" / "workflow_config.yaml").write_text(
        "agents:\n  - name: Echo\n    entrypoint: agents/missing.py\n"
    )


def test_deploy_warns_about_unset_keys_and_stops_on_project_errors(cli_case: CliCase):
    _project(cli_case.cwd / "echo")
    (cli_case.cwd / "echo" / ".env.example").write_text("API_KEY=\n# OPTIONAL_KEY=\n")

    result = cli_case.run_cli(["deploy", "echo"], timeout=120)

    output = " ".join((result.stdout + result.stderr).split())
    assert result.returncode == 1, output
    assert "Missing or empty in echo/.env: API_KEY. Agents" in output
    assert "OPTIONAL_KEY" not in output
    assert "CANYON-SCHEMA config/workflow_config.yaml:1" in output
    assert "Deploy stopped: fix the project errors" in output
    assert "Global Controller" not in output


def test_deploy_from_inside_a_project_folder_is_refused(cli_case: CliCase):
    _project(cli_case.cwd)

    result = cli_case.run_cli(["deploy", "."], timeout=120)

    output = " ".join((result.stdout + result.stderr).split())
    assert result.returncode == 1, output
    assert "This folder is a project. Give the deployment a folder of its own" in output
    assert not (cli_case.cwd / "deployment.yaml").exists()
