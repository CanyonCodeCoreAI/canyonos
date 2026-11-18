# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""This machine's API key through the installed command, each case in its own HOME,
so `~/.canyonos/api_key` is the case's own. `--api-key` and `--no-api-key` on
`canyonos deploy` and `canyonos serve` set, replace or remove the key before either
reaches Docker, which these runs point at nothing, so each stops there. The key
itself is never shown. `canyonos keys` and `canyonos token` are gone."""

from __future__ import annotations

import stat
import subprocess
from pathlib import Path

import pytest

from .harness import CliCase

NO_DOCKER = {"DOCKER_HOST": "unix:///nonexistent.sock"}
API_KEY = "e2e-machine-key-3b7f9d2a"
NEXT_API_KEY = "e2e-machine-key-c41e0b88"
KEY_SET = "Your deploys now use an API key for secure connections."
REPLACED_HINT = (
    "The dashboard and this deployment use the new key; other running deployments "
    "keep the old one until you redeploy them."
)
REMOVED = "Removed this machine's API key."
OPEN_WARNING = (
    "No API key is set: the endpoint and the dashboard answer anyone who reaches "
    "them. Set one with --api-key <key>."
)
COMMANDS = ("deploy", "serve")


def _said(result: subprocess.CompletedProcess[str]) -> str:
    return " ".join((result.stdout + result.stderr).split())


def _key_file(case: CliCase) -> Path:
    return case.home / ".canyonos" / "api_key"


def _stored(case: CliCase) -> str:
    return _key_file(case).read_text(encoding="utf-8").strip()


def _run(
    case: CliCase, command: str, *args: str, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    """`canyonos deploy echo` or `canyonos serve` with `args`, Docker unreachable."""
    folders = ["echo"] if command == "deploy" else []
    if command == "deploy" and not (case.cwd / "echo").exists():
        (case.cwd / "echo" / "config").mkdir(parents=True)
        (case.cwd / "echo" / "config" / "workflow_config.yaml").write_text(
            "agents:\n  - name: Echo\n    entrypoint: agents/echo.py\n"
        )
    return case.run_cli(
        [command, *folders, *args], timeout=60, env={**NO_DOCKER, **(env or {})}
    )


def _assert_never_shows_a_key(result: subprocess.CompletedProcess[str]) -> None:
    output = result.stdout + result.stderr
    assert API_KEY not in output, output
    assert NEXT_API_KEY not in output, output
    assert ".canyonos/api_key" not in output, output


@pytest.mark.parametrize("command", COMMANDS)
def test_api_key_saves_the_key_in_a_private_file(cli_case: CliCase, command: str):
    result = _run(cli_case, command, "--api-key", API_KEY)

    output = _said(result)
    assert output.count(KEY_SET) == 1, output
    assert REPLACED_HINT not in output, output
    assert OPEN_WARNING not in output, output
    assert _stored(cli_case) == API_KEY
    assert stat.S_IMODE(_key_file(cli_case).stat().st_mode) == 0o600
    _assert_never_shows_a_key(result)


@pytest.mark.parametrize("command", COMMANDS)
def test_api_key_replaces_the_stored_key(cli_case: CliCase, command: str):
    _run(cli_case, command, "--api-key", API_KEY)

    result = _run(cli_case, command, "--api-key", NEXT_API_KEY)

    output = _said(result)
    assert output.count(KEY_SET) == 1, output
    assert REPLACED_HINT in output, output
    assert _stored(cli_case) == NEXT_API_KEY
    assert stat.S_IMODE(_key_file(cli_case).stat().st_mode) == 0o600
    _assert_never_shows_a_key(result)


@pytest.mark.parametrize("command", COMMANDS)
def test_no_api_key_removes_the_stored_key_and_warns(cli_case: CliCase, command: str):
    _run(cli_case, command, "--api-key", API_KEY)

    result = _run(cli_case, command, "--no-api-key")

    output = _said(result)
    assert REMOVED in output, output
    assert OPEN_WARNING in output, output
    assert not _key_file(cli_case).exists()
    _assert_never_shows_a_key(result)


@pytest.mark.parametrize("command", COMMANDS)
def test_a_later_run_reuses_the_stored_key(cli_case: CliCase, command: str):
    _run(cli_case, command, "--api-key", API_KEY)

    result = _run(cli_case, command)

    output = _said(result)
    for message in (KEY_SET, REMOVED, OPEN_WARNING):
        assert message not in output, output
    assert _stored(cli_case) == API_KEY
    _assert_never_shows_a_key(result)


@pytest.mark.parametrize("command", COMMANDS)
def test_with_no_key_anywhere_it_warns_that_anyone_is_answered(
    cli_case: CliCase, command: str
):
    result = _run(cli_case, command)

    output = _said(result)
    assert OPEN_WARNING in output, output
    assert REMOVED not in output, output
    assert not _key_file(cli_case).exists()


@pytest.mark.parametrize("command", COMMANDS)
def test_the_api_key_variable_is_the_key_and_is_never_written(
    cli_case: CliCase, command: str
):
    alone = _run(cli_case, command, env={"CANYONOS_API_KEY": API_KEY})
    assert OPEN_WARNING not in _said(alone), _said(alone)
    assert not _key_file(cli_case).exists()
    _assert_never_shows_a_key(alone)

    _run(cli_case, command, "--api-key", NEXT_API_KEY)
    over_the_file = _run(cli_case, command, env={"CANYONOS_API_KEY": API_KEY})

    assert OPEN_WARNING not in _said(over_the_file), _said(over_the_file)
    assert _stored(cli_case) == NEXT_API_KEY
    _assert_never_shows_a_key(over_the_file)


@pytest.mark.parametrize("command", COMMANDS)
def test_an_empty_api_key_is_refused_and_names_no_api_key(
    cli_case: CliCase, command: str
):
    _run(cli_case, command, "--api-key", API_KEY)

    result = _run(cli_case, command, "--api-key", "")

    output = _said(result)
    assert result.returncode != 0, output
    assert "--no-api-key" in output, output
    assert KEY_SET not in output and REMOVED not in output, output
    assert _stored(cli_case) == API_KEY
    assert "Traceback" not in result.stderr, result.stderr


@pytest.mark.parametrize("command", COMMANDS)
def test_api_key_and_no_api_key_together_are_refused(cli_case: CliCase, command: str):
    result = _run(cli_case, command, "--api-key", API_KEY, "--no-api-key")

    output = _said(result)
    assert result.returncode == 2, output
    assert "not allowed with argument" in output, output
    assert not _key_file(cli_case).exists()


@pytest.mark.parametrize("command", COMMANDS)
def test_help_lists_the_api_key_flags(cli_case: CliCase, command: str):
    result = cli_case.run_cli([command, "-h"])

    output = _said(result)
    assert result.returncode == 0, output
    assert "--api-key KEY" in output, output
    assert "--no-api-key" in output, output
    assert "--dangerous-skip-auth" not in output, output
    assert "--auth-dir" not in output, output


@pytest.mark.parametrize("command", ["keys", "token"])
def test_the_keys_and_token_commands_are_gone(cli_case: CliCase, command: str):
    result = cli_case.run_cli([command, "create"])

    assert result.returncode == 2, _said(result)
    assert f"invalid choice: '{command}'" in result.stderr, result.stderr
    assert not (cli_case.home / ".canyonos" / "auth").exists()


@pytest.mark.parametrize("flag", ["--dangerous-skip-auth", "--auth-dir=keys"])
@pytest.mark.parametrize("command", COMMANDS)
def test_the_retired_auth_flags_are_refused(cli_case: CliCase, command: str, flag: str):
    result = _run(cli_case, command, flag)

    assert result.returncode == 2, _said(result)
    assert f"unrecognized arguments: {flag}" in result.stderr, result.stderr
