# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos -h` through the installed command, piped as a coding agent reads it."""

from __future__ import annotations

from utils.help_screen import DESCRIPTIONS

from .harness import CliCase


def test_piped_help_lists_every_command_whole(cli_case: CliCase):
    result = cli_case.run_cli(["-h"])

    assert result.returncode == 0, result.stderr
    assert "validate" in DESCRIPTIONS, DESCRIPTIONS
    lines = result.stdout.splitlines()
    cut = [
        name
        for name, description in DESCRIPTIONS.items()
        if not any(f" {name} " in line and description in line for line in lines)
    ]
    assert not cut, result.stdout
