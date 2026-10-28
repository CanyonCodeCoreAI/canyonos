# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos convert --install-only` through the installed command: the skill it
installs and the agent it never launches."""

from __future__ import annotations

import os

from .harness import CliCase


def test_install_only_installs_the_skill_and_launches_no_agent(cli_case: CliCase):
    bin_dir = cli_case.root / "bin"
    bin_dir.mkdir()
    launched = cli_case.root / "claude-was-launched"
    claude = bin_dir / "claude"
    claude.write_text(f"#!/bin/sh\ntouch '{launched}'\n")
    claude.chmod(0o755)

    result = cli_case.run_cli(
        ["convert", "--install-only", "--agent", "claude", "--scope", "local"],
        env={
            "CANYONOS_SKILL_SOURCE": "local",
            "PATH": f"{bin_dir}{os.pathsep}{cli_case.env['PATH']}",
        },
    )

    assert result.returncode == 0, result.stderr
    skill = cli_case.cwd / ".claude" / "skills" / "converting-to-canyonos"
    assert (skill / "SKILL.md").is_file()
    assert not launched.exists()
