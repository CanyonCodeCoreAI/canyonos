# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

from pathlib import Path

PACKAGES = Path(__file__).resolve().parents[2]


def test_the_cli_and_core_port_rules_are_the_same_file():
    """The CLI and the core image ship separately, so each has its own copy."""
    cli = PACKAGES / "cli" / "canyonos" / "port_utils.py"
    core = (
        PACKAGES / "core" / "canyonos_core" / "controller" / "utils" / "port_utils.py"
    )
    assert cli.read_bytes() == core.read_bytes()
