# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos new-app` through the installed command: the starter it writes and the
folder it refuses."""

from __future__ import annotations

from canyonos_core.schema import validate_project

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
    assert written_files(cli_case) == sorted(path for path, _ in template_files())
    manifest = cli_case.cwd / "config" / "global_controller.yaml"
    assert validate_project(str(manifest), str(cli_case.cwd)) == ()


def test_new_app_leaves_a_non_empty_folder_untouched(cli_case: CliCase):
    (cli_case.cwd / "existing.txt").write_text("keep")

    result = cli_case.run_cli(["new-app"])

    assert result.returncode == 1
    assert "Directory is not empty" in result.stderr + result.stdout
    assert written_files(cli_case) == ["existing.txt"]
