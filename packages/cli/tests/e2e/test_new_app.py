# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos new-app` through the installed command: the starter project it writes,
with no deployment.yaml, and the folder it refuses."""

from __future__ import annotations

from canyonos_core.schema import check_project

from canyonos.new_app import template_files

from .harness import CliCase


def written_files(case: CliCase) -> list[str]:
    return sorted(
        str(path.relative_to(case.cwd))
        for path in case.cwd.rglob("*")
        if path.is_file()
    )


def test_new_app_writes_a_starter_that_passes_the_manifest_schema(cli_case: CliCase):
    result = cli_case.run_cli(["new-app"])

    assert result.returncode == 0, result.stderr
    assert "Created new CanyonOS project" in result.stdout
    assert "cd .. && canyonos deploy " in result.stdout
    assert written_files(cli_case) == sorted(path for path, _ in template_files())
    assert "deployment.yaml" not in written_files(cli_case)
    project, violations = check_project(str(cli_case.cwd))
    assert project is not None and violations == (), violations


def test_new_app_leaves_a_non_empty_folder_untouched(cli_case: CliCase):
    (cli_case.cwd / "existing.txt").write_text("keep")

    result = cli_case.run_cli(["new-app"])

    assert result.returncode == 1
    assert "Directory is not empty" in result.stderr + result.stdout
    assert written_files(cli_case) == ["existing.txt"]
