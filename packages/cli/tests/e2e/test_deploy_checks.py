# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos deploy` through the installed command: the checks it runs before
anything is built, from a deployment folder or from inside a project folder. The
key check comes first, after the folder check: a run that must stop there points
DOCKER_HOST at nothing, so a Docker call would show."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric import ed25519
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from .harness import CliCase

NO_DOCKER = {"DOCKER_HOST": "unix:///nonexistent.sock"}
SCHEMA_ERROR = "CANYON-SCHEMA config/workflow_config.yaml:1"
STOPPED = "Deploy stopped: fix the project errors"
APPLE_DOUBLE = b"\x00\x05\x16\x07\x00\x02\x00\x00Mac OS X        "


def _said(result: subprocess.CompletedProcess[str]) -> str:
    return " ".join((result.stdout + result.stderr).split())


def _project(folder: Path) -> None:
    """Write a project whose manifest names code it does not hold into `folder`."""
    (folder / "config").mkdir(parents=True)
    (folder / "config" / "workflow_config.yaml").write_text(
        "agents:\n  - name: Echo\n    entrypoint: agents/missing.py\n"
    )


def _broken_project(case: CliCase) -> None:
    _project(case.cwd / "echo")
    (case.cwd / "echo" / ".env.example").write_text("API_KEY=\n# OPTIONAL_KEY=\n")


def _trusted(case: CliCase) -> Path:
    return case.home / ".canyonos" / "auth" / "trusted"


def _make_key(case: CliCase, *args: str) -> None:
    result = case.run_cli(["keys", "create", *args])
    assert result.returncode == 0, _said(result)


def _teammate_public_key() -> ed25519.Ed25519PublicKey:
    return ed25519.Ed25519PrivateKey.generate().public_key()


def _deploy(case: CliCase, *args: str, docker: bool = True):
    return case.run_cli(
        ["deploy", *args], timeout=120, env=None if docker else NO_DOCKER
    )


def _assert_refused_for_no_key(
    result: subprocess.CompletedProcess[str], trusted: Path
) -> None:
    output = _said(result)
    assert result.returncode == 1, output
    assert str(trusted) in output
    assert "canyonos keys create" in output
    assert "canyonos token create --scope query --project <project_id>" in output
    assert "--dangerous-skip-auth" in output
    for later in ("Missing or empty in", "CANYON-SCHEMA", "Global Controller"):
        assert later not in output
    assert "Docker" not in output


def _assert_reached_the_schema_check(result: subprocess.CompletedProcess[str]) -> None:
    output = _said(result)
    assert result.returncode == 1, output
    assert "Missing or empty in echo/.env: API_KEY. Agents" in output
    assert SCHEMA_ERROR in output
    assert STOPPED in output
    assert "Global Controller" not in output


def test_deploy_without_a_key_stops_before_every_other_check(cli_case: CliCase):
    _broken_project(cli_case)

    result = _deploy(cli_case, "echo", docker=False)

    _assert_refused_for_no_key(result, _trusted(cli_case))


def test_deploy_warns_about_unset_keys_and_stops_on_project_errors(cli_case: CliCase):
    _broken_project(cli_case)
    _make_key(cli_case)

    result = _deploy(cli_case, "echo")

    _assert_reached_the_schema_check(result)
    assert "OPTIONAL_KEY" not in _said(result)


def test_deploy_from_inside_a_project_folder_is_refused(cli_case: CliCase):
    _project(cli_case.cwd)

    result = _deploy(cli_case, ".", docker=False)

    output = _said(result)
    assert result.returncode == 1, output
    assert "This folder is a project. Give the deployment a folder of its own" in output
    assert "canyonos keys create" not in output
    assert not (cli_case.cwd / "deployment.yaml").exists()


def test_deploy_dangerous_skip_auth_warns_and_goes_on_without_a_key(
    cli_case: CliCase,
):
    _broken_project(cli_case)

    result = _deploy(cli_case, "echo", "--dangerous-skip-auth")

    _assert_reached_the_schema_check(result)
    assert "the endpoint and the dashboard will answer anyone" in _said(result)


def test_deploy_needs_only_a_trusted_public_key(cli_case: CliCase):
    _broken_project(cli_case)
    laptop = cli_case.cwd / "laptop.pub"
    laptop.write_bytes(
        _teammate_public_key().public_bytes(
            Encoding.PEM, PublicFormat.SubjectPublicKeyInfo
        )
    )
    trusted = cli_case.run_cli(["keys", "trust", str(laptop)])
    assert trusted.returncode == 0, _said(trusted)
    assert not list(_trusted(cli_case).parent.glob("*.key"))

    result = _deploy(cli_case, "echo")

    _assert_reached_the_schema_check(result)


def test_deploy_skips_apple_double_files_in_trusted(cli_case: CliCase):
    _broken_project(cli_case)
    _make_key(cli_case)
    (_trusted(cli_case) / "._default.pub").write_bytes(APPLE_DOUBLE)

    result = _deploy(cli_case, "echo")

    _assert_reached_the_schema_check(result)


def test_deploy_with_a_private_key_but_no_trusted_key_is_refused(cli_case: CliCase):
    _broken_project(cli_case)
    _make_key(cli_case)
    (_trusted(cli_case) / "default.pub").unlink()

    result = _deploy(cli_case, "echo", docker=False)

    _assert_refused_for_no_key(result, _trusted(cli_case))


def test_deploy_names_a_trusted_file_that_is_not_a_pem_public_key(cli_case: CliCase):
    _broken_project(cli_case)
    _trusted(cli_case).mkdir(parents=True)
    laptop = _trusted(cli_case) / "laptop.pub"
    laptop.write_text(
        _teammate_public_key()
        .public_bytes(Encoding.OpenSSH, PublicFormat.OpenSSH)
        .decode()
        + " user@host\n"
    )

    result = _deploy(cli_case, "echo", docker=False)

    output = _said(result)
    assert result.returncode == 1, output
    assert str(laptop) in output
    assert "CANYON-SCHEMA" not in output
    assert "Traceback" not in result.stdout + result.stderr


def test_deploy_names_a_trusted_file_whose_name_cannot_name_a_key(cli_case: CliCase):
    _broken_project(cli_case)
    _make_key(cli_case)
    copy = _trusted(cli_case) / "default (1).pub"
    copy.write_bytes((_trusted(cli_case) / "default.pub").read_bytes())

    result = _deploy(cli_case, "echo", docker=False)

    output = _said(result)
    assert result.returncode == 1, output
    assert str(copy) in output
    assert "CANYON-SCHEMA" not in output
    assert "Traceback" not in result.stdout + result.stderr


@pytest.mark.skipif(
    hasattr(os, "geteuid") and os.geteuid() == 0, reason="root reads any file"
)
def test_deploy_names_a_trusted_file_it_cannot_read(cli_case: CliCase):
    _broken_project(cli_case)
    _make_key(cli_case)
    public = _trusted(cli_case) / "default.pub"
    public.chmod(0o000)
    try:
        result = _deploy(cli_case, "echo", docker=False)
    finally:
        public.chmod(0o644)

    output = _said(result)
    assert result.returncode == 1, output
    assert str(public) in output
    assert "CANYON-SCHEMA" not in output
    assert "Traceback" not in result.stdout + result.stderr


def test_deploy_auth_dir_replaces_the_home_folder(cli_case: CliCase):
    _broken_project(cli_case)
    _make_key(cli_case, "--auth-dir", "./team-keys")
    assert not (cli_case.home / ".canyonos").exists()

    with_team_keys = _deploy(cli_case, "echo", "--auth-dir", "./team-keys")

    _assert_reached_the_schema_check(with_team_keys)

    _make_key(cli_case)
    nowhere = _deploy(cli_case, "echo", "--auth-dir", "./nowhere", docker=False)

    _assert_refused_for_no_key(nowhere, cli_case.cwd / "nowhere" / "trusted")
    assert f"--auth-dir {cli_case.cwd / 'nowhere'}" in _said(nowhere)


def test_deploy_refuses_a_keys_folder_inside_any_of_its_projects(cli_case: CliCase):
    _broken_project(cli_case)
    _project(cli_case.cwd / "other")
    _make_key(cli_case, "--auth-dir", "./other/team-keys")

    result = _deploy(
        cli_case, "echo", "other", "--auth-dir", "./other/team-keys", docker=False
    )

    output = _said(result)
    assert result.returncode == 1, output
    assert str((cli_case.cwd / "other" / "team-keys").resolve()) in output
    assert "inside the project folder" in output
    assert "CANYON-SCHEMA" not in output


def test_deploy_auth_dir_is_read_from_where_it_was_typed_with_folder(
    cli_case: CliCase,
):
    _broken_project(cli_case)
    _make_key(cli_case, "--auth-dir", "./team-keys")

    result = _deploy(
        cli_case,
        "echo",
        "--folder",
        "deployments/team",
        "--auth-dir",
        "./team-keys",
    )

    output = _said(result)
    assert result.returncode == 1, output
    assert SCHEMA_ERROR in output
    assert "canyonos keys create" not in output


def test_deploy_of_a_folder_that_is_no_project_says_so_before_the_key_check(
    cli_case: CliCase,
):
    result = _deploy(cli_case, "nowhere", docker=False)

    output = _said(result)
    assert result.returncode == 1, output
    assert "is nowhere a project folder?" in output
    assert "canyonos keys create" not in output


def test_deploy_help_lists_the_auth_flags(cli_case: CliCase):
    result = cli_case.run_cli(["deploy", "-h"])

    output = _said(result)
    assert result.returncode == 0, output
    assert "--dangerous-skip-auth" in output
    assert "answer anyone" in output
    assert "--auth-dir PATH" in output
    assert "instead of ~/.canyonos/auth" in output
