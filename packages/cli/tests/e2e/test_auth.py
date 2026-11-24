# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Each workflow group's API key through the installed command, each case in its own
HOME. `--api-key` and `--no-api-key` on `canyonos deploy` set, replace or remove the key
in the workflow group's record (`~/.canyonos/workflows/<workflow group>/api_key`) before
the deploy reaches Docker, which these runs point at nothing, so each stops there.
Another workflow group's key is never touched, the key itself is never shown,
`canyonos serve` takes no key, and a key in `~/.canyonos/api_key`, where an older CLI
kept one for the whole machine, moves into the records once."""

from __future__ import annotations

import json
import stat
import subprocess
from pathlib import Path

import pytest

from .harness import CliCase

NO_DOCKER = {"DOCKER_HOST": "unix:///nonexistent.sock"}
API_KEY = "e2e-group-key-3b7f9d2a"
NEXT_API_KEY = "e2e-group-key-c41e0b88"
KEY_SET = "This workflow group now uses an API key for secure connections."
ONLY_THIS_GROUP = (
    "Only this workflow group changes: other workflow groups keep their own keys."
)
REMOVED = "Removed this workflow group's API key."
OPEN_WARNING = (
    "This workflow group has no API key: its endpoint and its dashboard routes answer "
    "anyone who reaches them. Set one with --api-key <key>."
)
ADOPTED = "Each workflow group now keeps its own API key"


def _said(result: subprocess.CompletedProcess[str]) -> str:
    return " ".join((result.stdout + result.stderr).split())


def _records(case: CliCase) -> Path:
    return case.home / ".canyonos" / "workflows"


def _record(case: CliCase, folder: str) -> Path:
    """The record of the workflow group the deploys of `folder` made."""
    (record,) = [
        path
        for path in _records(case).iterdir()
        if path.name.rsplit("-", 1)[0] == folder
    ]
    return record


def _key_file(case: CliCase, folder: str = "echo") -> Path:
    return _record(case, folder) / "api_key"


def _stored(case: CliCase, folder: str = "echo") -> str:
    return _key_file(case, folder).read_text(encoding="utf-8").strip()


def _machine_key_file(case: CliCase) -> Path:
    return case.home / ".canyonos" / "api_key"


def _deploy(
    case: CliCase, *args: str, folder: str = "echo", env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    """`canyonos deploy <folder>` with `args`, Docker unreachable."""
    if not (case.cwd / folder).exists():
        (case.cwd / folder / "config").mkdir(parents=True)
        (case.cwd / folder / "config" / "workflow_config.yaml").write_text(
            "agents:\n  - name: Echo\n    entrypoint: agents/echo.py\n"
        )
    return case.run_cli(
        ["deploy", folder, *args], timeout=60, env={**NO_DOCKER, **(env or {})}
    )


def _assert_never_shows_a_key(result: subprocess.CompletedProcess[str]) -> None:
    output = result.stdout + result.stderr
    assert API_KEY not in output, output
    assert NEXT_API_KEY not in output, output


def test_api_key_saves_the_key_in_the_workflow_groups_record(cli_case: CliCase):
    result = _deploy(cli_case, "--api-key", API_KEY)

    output = _said(result)
    assert output.count(KEY_SET) == 1, output
    assert ONLY_THIS_GROUP not in output, output
    assert OPEN_WARNING not in output, output
    assert _stored(cli_case) == API_KEY
    assert stat.S_IMODE(_key_file(cli_case).stat().st_mode) == 0o600
    assert not _machine_key_file(cli_case).exists()
    _assert_never_shows_a_key(result)


def test_api_key_replaces_the_key_of_this_workflow_group_only(cli_case: CliCase):
    _deploy(cli_case, "--api-key", API_KEY)

    result = _deploy(cli_case, "--api-key", NEXT_API_KEY)

    output = _said(result)
    assert output.count(KEY_SET) == 1, output
    assert ONLY_THIS_GROUP in output, output
    assert _stored(cli_case) == NEXT_API_KEY
    assert stat.S_IMODE(_key_file(cli_case).stat().st_mode) == 0o600
    _assert_never_shows_a_key(result)


def test_two_workflow_groups_keep_their_own_keys(cli_case: CliCase):
    _deploy(cli_case, "--api-key", API_KEY)

    result = _deploy(cli_case, "--api-key", NEXT_API_KEY, folder="other")

    output = _said(result)
    assert output.count(KEY_SET) == 1, output
    assert ONLY_THIS_GROUP not in output, output
    assert _stored(cli_case, "other") == NEXT_API_KEY
    assert _stored(cli_case) == API_KEY
    _assert_never_shows_a_key(result)

    removed = _deploy(cli_case, "--no-api-key", folder="other")

    assert REMOVED in _said(removed), _said(removed)
    assert not _key_file(cli_case, "other").exists()
    assert _stored(cli_case) == API_KEY


def test_no_api_key_removes_the_key_and_warns(cli_case: CliCase):
    _deploy(cli_case, "--api-key", API_KEY)

    result = _deploy(cli_case, "--no-api-key")

    output = _said(result)
    assert REMOVED in output, output
    assert ONLY_THIS_GROUP in output, output
    assert OPEN_WARNING in output, output
    assert not _key_file(cli_case).exists()
    _assert_never_shows_a_key(result)


def test_a_later_deploy_reuses_the_recorded_key(cli_case: CliCase):
    _deploy(cli_case, "--api-key", API_KEY)

    result = _deploy(cli_case)

    output = _said(result)
    for message in (KEY_SET, REMOVED, OPEN_WARNING):
        assert message not in output, output
    assert _stored(cli_case) == API_KEY
    _assert_never_shows_a_key(result)


def test_with_no_key_anywhere_it_warns_that_anyone_is_answered(cli_case: CliCase):
    result = _deploy(cli_case)

    output = _said(result)
    assert OPEN_WARNING in output, output
    assert REMOVED not in output, output
    assert not _key_file(cli_case).exists()


def test_the_api_key_variable_is_the_key_and_is_never_written(cli_case: CliCase):
    alone = _deploy(cli_case, env={"CANYONOS_API_KEY": API_KEY})
    assert OPEN_WARNING not in _said(alone), _said(alone)
    assert not _key_file(cli_case).exists()
    _assert_never_shows_a_key(alone)

    _deploy(cli_case, "--api-key", NEXT_API_KEY)
    over_the_file = _deploy(cli_case, env={"CANYONOS_API_KEY": API_KEY})

    assert OPEN_WARNING not in _said(over_the_file), _said(over_the_file)
    assert _stored(cli_case) == NEXT_API_KEY
    _assert_never_shows_a_key(over_the_file)


def test_a_new_api_key_under_another_api_key_variable_is_refused(cli_case: CliCase):
    _deploy(cli_case, "--api-key", API_KEY)

    result = _deploy(
        cli_case, "--api-key", NEXT_API_KEY, env={"CANYONOS_API_KEY": API_KEY}
    )

    output = _said(result)
    assert result.returncode != 0, output
    assert "Unset CANYONOS_API_KEY or set it to the new key" in output, output
    assert KEY_SET not in output, output
    assert _stored(cli_case) == API_KEY
    assert "Traceback" not in result.stderr, result.stderr
    _assert_never_shows_a_key(result)


def test_no_api_key_under_an_api_key_variable_is_refused(cli_case: CliCase):
    _deploy(cli_case, "--api-key", API_KEY)

    result = _deploy(cli_case, "--no-api-key", env={"CANYONOS_API_KEY": NEXT_API_KEY})

    output = _said(result)
    assert result.returncode != 0, output
    assert "Unset CANYONOS_API_KEY" in output, output
    assert REMOVED not in output, output
    assert _stored(cli_case) == API_KEY
    assert "Traceback" not in result.stderr, result.stderr
    _assert_never_shows_a_key(result)


def test_api_key_under_the_same_api_key_variable_saves_it(cli_case: CliCase):
    result = _deploy(cli_case, "--api-key", API_KEY, env={"CANYONOS_API_KEY": API_KEY})

    output = _said(result)
    assert output.count(KEY_SET) == 1, output
    assert "CANYONOS_API_KEY" not in output, output
    assert _stored(cli_case) == API_KEY
    _assert_never_shows_a_key(result)


def test_an_empty_api_key_is_refused_and_names_no_api_key(cli_case: CliCase):
    _deploy(cli_case, "--api-key", API_KEY)

    result = _deploy(cli_case, "--api-key", "")

    output = _said(result)
    assert result.returncode != 0, output
    assert "--no-api-key" in output, output
    assert KEY_SET not in output and REMOVED not in output, output
    assert _stored(cli_case) == API_KEY
    assert "Traceback" not in result.stderr, result.stderr


def test_api_key_and_no_api_key_together_are_refused(cli_case: CliCase):
    result = _deploy(cli_case, "--api-key", API_KEY, "--no-api-key")

    output = _said(result)
    assert result.returncode == 2, output
    assert "not allowed with argument" in output, output
    assert not _records(cli_case).exists() or not list(
        _records(cli_case).glob("*/api_key")
    )


def test_a_machine_key_moves_into_every_record_once(cli_case: CliCase):
    """An older CLI kept one key for every workflow group in `~/.canyonos/api_key`:
    each record without a key of its own takes it, one with a key keeps its own, and
    the machine file goes."""
    _deploy(cli_case, "--no-api-key")
    _deploy(cli_case, "--api-key", NEXT_API_KEY, folder="keyed")
    _machine_key_file(cli_case).write_text(f"{API_KEY}\n", encoding="utf-8")

    result = _deploy(cli_case, folder="other")

    output = _said(result)
    assert ADOPTED in output, output
    assert OPEN_WARNING not in output, output
    assert not _machine_key_file(cli_case).exists()
    assert _stored(cli_case) == API_KEY
    assert _stored(cli_case, "other") == API_KEY
    assert _stored(cli_case, "keyed") == NEXT_API_KEY
    assert stat.S_IMODE(_key_file(cli_case, "other").stat().st_mode) == 0o600
    _assert_never_shows_a_key(result)

    again = _deploy(cli_case, folder="other")
    assert ADOPTED not in _said(again), _said(again)


def test_a_machine_key_skips_a_workflow_group_last_deployed_with_no_key(
    cli_case: CliCase,
):
    """A Docker workflow group an older CLI deployed with `--no-api-key`, and that still
    runs, stays open: the machine key a later deploy saved for another workflow group
    is not its key. One that is stopped, whose `state.json` the stop removed, takes the
    machine key like every other record, and its next deploy sets it."""
    _deploy(cli_case, "--no-api-key", folder="open")
    (_record(cli_case, "open") / "state.json").write_text(
        json.dumps({"auth_disabled": True}), encoding="utf-8"
    )
    _deploy(cli_case, "--no-api-key", folder="stopped")
    assert not (_record(cli_case, "stopped") / "state.json").exists()
    _machine_key_file(cli_case).write_text(f"{API_KEY}\n", encoding="utf-8")

    result = _deploy(cli_case, folder="other")

    assert ADOPTED in _said(result), _said(result)
    assert not _key_file(cli_case, "open").exists()
    assert _stored(cli_case, "stopped") == API_KEY
    assert _stored(cli_case, "other") == API_KEY
    _assert_never_shows_a_key(result)


def test_only_a_deploy_moves_the_machine_key(cli_case: CliCase):
    """A command that only reads a key, `canyonos dashboard` here, leaves an older CLI's
    `~/.canyonos/api_key` where it is: the next deploy moves it into the records."""
    _deploy(cli_case)
    _machine_key_file(cli_case).write_text(f"{API_KEY}\n", encoding="utf-8")

    result = cli_case.run_cli(["dashboard"], timeout=60, env=NO_DOCKER)

    assert ADOPTED not in _said(result), _said(result)
    assert _machine_key_file(cli_case).exists()
    assert not _key_file(cli_case).exists()
    deployed = _deploy(cli_case)
    assert ADOPTED in _said(deployed), _said(deployed)
    assert _stored(cli_case) == API_KEY
    assert not _machine_key_file(cli_case).exists()


def test_deploy_help_lists_the_api_key_flags(cli_case: CliCase):
    result = cli_case.run_cli(["deploy", "-h"])

    output = _said(result)
    assert result.returncode == 0, output
    assert "--api-key KEY" in output, output
    assert "--no-api-key" in output, output
    assert "--dangerous-skip-auth" not in output, output
    assert "--auth-dir" not in output, output


@pytest.mark.parametrize("flag", [("--api-key", API_KEY), ("--no-api-key",)])
def test_serve_takes_no_api_key(cli_case: CliCase, flag: tuple[str, ...]):
    help_text = _said(cli_case.run_cli(["serve", "-h"]))
    assert "--api-key" not in help_text, help_text

    result = cli_case.run_cli(["serve", *flag], timeout=60, env=NO_DOCKER)

    assert result.returncode == 2, _said(result)
    assert f"unrecognized arguments: {flag[0]}" in result.stderr, result.stderr
    assert not _machine_key_file(cli_case).exists()


@pytest.mark.parametrize("command", ["keys", "token"])
def test_the_keys_and_token_commands_are_gone(cli_case: CliCase, command: str):
    result = cli_case.run_cli([command, "create"])

    assert result.returncode == 2, _said(result)
    assert f"invalid choice: '{command}'" in result.stderr, result.stderr
    assert not (cli_case.home / ".canyonos" / "auth").exists()


@pytest.mark.parametrize("flag", ["--dangerous-skip-auth", "--auth-dir=keys"])
@pytest.mark.parametrize("command", ["deploy", "serve"])
def test_the_retired_auth_flags_are_refused(cli_case: CliCase, command: str, flag: str):
    args = ["echo"] if command == "deploy" else []
    result = cli_case.run_cli([command, *args, flag], timeout=60, env=NO_DOCKER)

    assert result.returncode == 2, _said(result)
    assert f"unrecognized arguments: {flag}" in result.stderr, result.stderr
