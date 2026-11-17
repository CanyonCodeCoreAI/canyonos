# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos convert` through the installed command: the skill `--install-only`
installs without launching an agent, and the verdict on a port an agent finished."""

from __future__ import annotations

import os
from pathlib import Path

from .harness import CliCase

HELLOWORLD = (
    Path(__file__).resolve().parents[4] / "examples" / "helloworld" / "helloworld"
)


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


def test_convert_reports_the_port_the_agent_left_as_complete(cli_case: CliCase):
    bin_dir = cli_case.root / "bin"
    bin_dir.mkdir()
    claude = bin_dir / "claude"
    claude.write_text(
        f"#!/bin/sh\nmkdir .canyon\n"
        f"cp -R '{HELLOWORLD}/config' '{HELLOWORLD}/agents' .canyon/\n"
    )
    claude.chmod(0o755)

    result = cli_case.run_cli(
        ["convert", "--agent", "claude", "--scope", "local", "-y"],
        env={
            "CANYONOS_SKILL_SOURCE": "local",
            "PATH": f"{bin_dir}{os.pathsep}{cli_case.env['PATH']}",
        },
        timeout=120,
    )

    output = " ".join((result.stdout + result.stderr).split())
    assert result.returncode == 0, output
    assert "Conversion complete: .canyon/ passed validation." in output
    assert (cli_case.cwd / ".canyon" / "config" / "workflow_config.yaml").is_file()
    assert not (cli_case.cwd / "config").exists()
