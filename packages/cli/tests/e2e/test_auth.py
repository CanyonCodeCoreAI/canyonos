# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos keys` and `canyonos token` through the installed command, each case in
its own HOME. Tokens are checked with `jwt.decode` against the `.pub` the CLI wrote,
which proves the signature as well as the claims."""

from __future__ import annotations

import re
import shutil
import stat
import subprocess
from hashlib import sha256
from pathlib import Path

import jwt
import pexpect
import pytest
from cryptography.hazmat.primitives.asymmetric import ed25519, rsa
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
    load_pem_public_key,
)

from .harness import CliCase, token_in

PROJECT_A = "8a3f6c1e-2b4d-4e5f-9a7b-1c2d3e4f5a6b"
PROJECT_B = "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f"
API_AUDIENCE = "canyonos-api"
KEYS_LINE = re.compile(r"^(\S+)\s+([0-9a-f]{16})\s+(\S+)$")
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
APPLE_DOUBLE = b"\x00\x05\x16\x07\x00\x02\x00\x00Mac OS X        "


def _auth(case: CliCase) -> Path:
    return case.home / ".canyonos" / "auth"


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def _said(result: subprocess.CompletedProcess[str]) -> str:
    return " ".join((result.stdout + result.stderr).split())


def _files_under(path: Path) -> list[Path]:
    return sorted(path.rglob("*")) if path.exists() else []


def _make_key(case: CliCase, *args: str) -> None:
    result = case.run_cli(["keys", "create", *args])
    assert result.returncode == 0, _said(result)


def _token(case: CliCase, *args: str) -> str:
    result = case.run_cli(["token", "create", *args])
    assert result.returncode == 0, _said(result)
    return token_in(result.stdout)


def _claims(token: str, pub: Path, audience: str) -> dict:
    return jwt.decode(
        token,
        pub.read_text(encoding="utf-8"),
        algorithms=["EdDSA"],
        audience=audience,
        issuer="canyonos",
        options={"require": ["iss", "iat", "jti", "aud", "scope"]},
    )


def _teammate_key() -> ed25519.Ed25519PrivateKey:
    return ed25519.Ed25519PrivateKey.generate()


def _public_pem(key) -> str:
    return (
        key.public_key()
        .public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo)
        .decode()
    )


def _kid_of(public: Path) -> str:
    der = load_pem_public_key(public.read_bytes()).public_bytes(
        Encoding.DER, PublicFormat.SubjectPublicKeyInfo
    )
    return sha256(der).hexdigest()[:16]


def _listed(stdout: str) -> list[tuple[str, str, str]]:
    return [
        match.groups()
        for match in (KEYS_LINE.match(line.strip()) for line in stdout.splitlines())
        if match
    ]


def _refused_without_token(result: subprocess.CompletedProcess[str]) -> None:
    assert result.returncode == 1, _said(result)
    assert result.stdout.strip() == "", result.stdout
    with pytest.raises(AssertionError):
        token_in(result.stdout)


def test_keys_create_writes_a_private_key_and_its_trusted_public_half(
    cli_case: CliCase,
):
    result = cli_case.run_cli(["keys", "create"])

    output = _said(result)
    assert result.returncode == 0, output
    auth = _auth(cli_case)
    private, public = auth / "default.key", auth / "trusted" / "default.pub"
    assert _mode(private) == 0o600
    assert "BEGIN PRIVATE KEY" in private.read_text()
    assert _mode(public) == 0o644
    assert "BEGIN PUBLIC KEY" in public.read_text()
    assert _mode(auth) == 0o700
    assert _mode(auth / "trusted") == 0o755
    assert str(private) in output
    assert str(public) in output
    assert "never leaves this machine" in output
    assert "canyonos token create --scope query --project <project_id>" in output
    assert "canyonos token create --scope read" in output
    assert "To rotate" in output


def test_keys_create_never_replaces_an_existing_key(cli_case: CliCase):
    _make_key(cli_case)
    auth = _auth(cli_case)
    private, public = auth / "default.key", auth / "trusted" / "default.pub"
    before = private.read_bytes(), public.read_bytes()

    result = cli_case.run_cli(["keys", "create"])

    assert result.returncode == 1, _said(result)
    assert str(private) in _said(result)
    assert (private.read_bytes(), public.read_bytes()) == before


def test_keys_create_with_a_name_leaves_the_default_key_alone(cli_case: CliCase):
    _make_key(cli_case)
    auth = _auth(cli_case)
    before = (
        (auth / "default.key").read_bytes(),
        (auth / "trusted" / "default.pub").read_bytes(),
    )

    _make_key(cli_case, "--name", "ci")

    assert "BEGIN PRIVATE KEY" in (auth / "ci.key").read_text()
    assert "BEGIN PUBLIC KEY" in (auth / "trusted" / "ci.pub").read_text()
    assert (
        (auth / "default.key").read_bytes(),
        (auth / "trusted" / "default.pub").read_bytes(),
    ) == before


@pytest.mark.parametrize("name", ["../outside", "my key", ".hidden"])
def test_keys_create_refuses_a_name_outside_the_allowed_characters(
    cli_case: CliCase, name: str
):
    result = cli_case.run_cli(["keys", "create", "--name", name])

    assert result.returncode == 1, _said(result)
    assert "[A-Za-z0-9._-]" in _said(result)
    assert _files_under(cli_case.home) == []


def test_keys_list_with_no_key_says_how_to_make_one(cli_case: CliCase):
    result = cli_case.run_cli(["keys", "list"])

    output = _said(result)
    assert result.returncode == 0, output
    assert "No key is registered" in output
    assert "canyonos keys create" in output


def test_keys_list_shows_each_trusted_key_with_the_kid_tokens_carry(
    cli_case: CliCase,
):
    _make_key(cli_case)
    teammate = cli_case.cwd / "bob.pem"
    teammate.write_text(_public_pem(_teammate_key()))
    trusted = cli_case.run_cli(["keys", "trust", str(teammate)])
    assert trusted.returncode == 0, _said(trusted)
    token = _token(cli_case, "--scope", "read")

    result = cli_case.run_cli(["keys", "list"])

    assert result.returncode == 0, _said(result)
    trusted_dir = _auth(cli_case) / "trusted"
    listed = _listed(result.stdout)
    assert [(name, path) for name, _kid, path in listed] == [
        ("bob", str(trusted_dir / "bob.pub")),
        ("default", str(trusted_dir / "default.pub")),
    ], result.stdout
    assert listed[1][1] == jwt.get_unverified_header(token)["kid"]


def test_keys_list_names_a_trusted_file_that_is_not_a_pem_public_key(
    cli_case: CliCase,
):
    _make_key(cli_case)
    laptop = _auth(cli_case) / "trusted" / "laptop.pub"
    laptop.write_text(
        _teammate_key()
        .public_key()
        .public_bytes(Encoding.OpenSSH, PublicFormat.OpenSSH)
        .decode()
        + " user@host\n"
    )

    result = cli_case.run_cli(["keys", "list"])

    assert result.returncode == 1, _said(result)
    assert str(laptop) in _said(result)
    assert "Traceback" not in result.stdout + result.stderr


def test_keys_trust_registers_a_teammates_public_key(cli_case: CliCase):
    source = cli_case.cwd / "alice.pem"
    source.write_text(_public_pem(_teammate_key()))
    before = source.read_bytes()

    result = cli_case.run_cli(["keys", "trust", str(source)])

    assert result.returncode == 0, _said(result)
    stored = _auth(cli_case) / "trusted" / "alice.pub"
    assert _mode(stored) == 0o644
    assert source.read_bytes() == before
    expected_kid = _kid_of(source)
    listed = _listed(cli_case.run_cli(["keys", "list"]).stdout)
    assert ("alice", expected_kid, str(stored)) in listed


def test_keys_trust_never_overwrites_a_trusted_key(cli_case: CliCase):
    source = cli_case.cwd / "alice.pem"
    source.write_text(_public_pem(_teammate_key()))
    first = cli_case.run_cli(["keys", "trust", str(source)])
    assert first.returncode == 0, _said(first)
    stored = _auth(cli_case) / "trusted" / "alice.pub"
    before = stored.read_bytes()
    source.write_text(_public_pem(_teammate_key()))

    result = cli_case.run_cli(["keys", "trust", str(source)])

    assert result.returncode == 1, _said(result)
    assert str(stored) in _said(result)
    assert stored.read_bytes() == before


def test_keys_trust_refuses_what_is_not_an_ed25519_pem_public_key(
    cli_case: CliCase,
):
    ssh = cli_case.home / ".ssh"
    ssh.mkdir()
    openssh = ssh / "id_ed25519.pub"
    openssh.write_text(
        _teammate_key()
        .public_key()
        .public_bytes(Encoding.OpenSSH, PublicFormat.OpenSSH)
        .decode()
        + " user@host\n"
    )
    rsa_pem = cli_case.cwd / "rsa.pem"
    rsa_pem.write_text(
        _public_pem(rsa.generate_private_key(public_exponent=65537, key_size=2048))
    )

    for source in (openssh, rsa_pem):
        result = cli_case.run_cli(["keys", "trust", str(source)])

        output = _said(result)
        assert result.returncode == 1, output
        assert "not a public key" in output or "not an Ed25519" in output, output
        assert _files_under(_auth(cli_case) / "trusted") == []


def test_keys_trust_refuses_a_private_key_sent_by_mistake(cli_case: CliCase):
    source = cli_case.cwd / "alice.key"
    source.write_bytes(
        _teammate_key().private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
    )

    result = cli_case.run_cli(["keys", "trust", str(source)])

    output = _said(result)
    assert result.returncode == 1, output
    assert "is a private key" in output
    assert ".pub" in output
    assert _files_under(_auth(cli_case) / "trusted") == []


def test_keys_trust_names_a_file_that_does_not_exist(cli_case: CliCase):
    missing = cli_case.cwd / "nobody.pub"

    result = cli_case.run_cli(["keys", "trust", str(missing)])

    assert result.returncode == 1, _said(result)
    assert str(missing) in _said(result)
    assert "Traceback" not in result.stdout + result.stderr


def test_token_create_query_prints_a_signed_token_once_with_how_to_use_it(
    cli_case: CliCase,
):
    _make_key(cli_case)

    result = cli_case.run_cli(
        ["token", "create", "--scope", "query", "--project", PROJECT_A]
    )

    output = _said(result)
    assert result.returncode == 0, output
    token = token_in(result.stdout)
    assert (result.stdout + result.stderr).count(token) == 1
    assert jwt.get_unverified_header(token)["alg"] == "EdDSA"
    claims = _claims(token, _auth(cli_case) / "trusted" / "default.pub", PROJECT_A)
    assert claims["iss"] == "canyonos"
    assert claims["aud"] == [PROJECT_A]
    assert claims["scope"] == "query"
    assert re.fullmatch(r"[0-9a-f]{32}", claims["jti"])
    assert isinstance(claims["iat"], int)
    assert "exp" not in claims
    assert "no expiry" in output
    assert "Authorization: Bearer" in output
    assert "curl -X POST" in output
    assert "To rotate" in output


def test_token_create_piped_writes_the_whole_token_alone_on_stdout(
    cli_case: CliCase,
):
    _make_key(cli_case)

    result = cli_case.run_cli(
        ["token", "create", "--scope", "query", "--project", PROJECT_A],
        env={"COLUMNS": "40"},
    )

    assert result.returncode == 0, _said(result)
    token = token_in(result.stdout)
    assert result.stdout == f"{token}\n"
    assert len(token) > 40
    assert len(token.split(".")) == 3


def test_token_create_query_for_several_projects_dedupes_them_in_order(
    cli_case: CliCase,
):
    _make_key(cli_case)

    result = cli_case.run_cli(
        [
            "token",
            "create",
            "--scope",
            "query",
            "--project",
            PROJECT_A,
            "--project",
            PROJECT_B,
            "--project",
            PROJECT_A,
        ]
    )

    assert result.returncode == 0, _said(result)
    claims = _claims(
        token_in(result.stdout),
        _auth(cli_case) / "trusted" / "default.pub",
        PROJECT_B,
    )
    assert claims["aud"] == [PROJECT_A, PROJECT_B]
    assert PROJECT_A in result.stderr
    assert PROJECT_B in result.stderr


def test_token_create_refuses_a_project_that_is_not_a_uuid(cli_case: CliCase):
    _make_key(cli_case)

    result = cli_case.run_cli(
        ["token", "create", "--scope", "query", "--project", "my-project"]
    )

    _refused_without_token(result)
    assert "my-project" in _said(result)


def test_token_create_query_for_all_projects(cli_case: CliCase):
    _make_key(cli_case)

    result = cli_case.run_cli(["token", "create", "--scope", "query", "--all-projects"])

    assert result.returncode == 0, _said(result)
    claims = _claims(
        token_in(result.stdout), _auth(cli_case) / "trusted" / "default.pub", "*"
    )
    assert claims["aud"] == ["*"]
    assert "every project" in _said(result)


@pytest.mark.parametrize("scope", ["read", "write"])
def test_token_create_api_scopes_grant_the_dashboard_api(cli_case: CliCase, scope: str):
    _make_key(cli_case)

    result = cli_case.run_cli(["token", "create", "--scope", scope])

    output = _said(result)
    assert result.returncode == 0, output
    claims = _claims(
        token_in(result.stdout),
        _auth(cli_case) / "trusted" / "default.pub",
        API_AUDIENCE,
    )
    assert claims["aud"] == [API_AUDIENCE]
    assert claims["scope"] == scope
    assert "dashboard API" in output
    assert "curl -X POST" not in output


def test_token_create_query_needs_projects(cli_case: CliCase):
    _make_key(cli_case)

    result = cli_case.run_cli(["token", "create", "--scope", "query"])

    _refused_without_token(result)
    assert "--project" in _said(result)
    assert "--all-projects" in _said(result)


@pytest.mark.parametrize(
    ("args", "flag"),
    [
        (["--scope", "query", "--project", PROJECT_A, "--all-projects"], "not both"),
        (["--scope", "read", "--project", PROJECT_A], "--project"),
        (["--scope", "write", "--all-projects"], "--all-projects"),
    ],
)
def test_token_create_refuses_a_flag_that_does_not_belong(
    cli_case: CliCase, args: list[str], flag: str
):
    _make_key(cli_case)

    result = cli_case.run_cli(["token", "create", *args])

    _refused_without_token(result)
    assert flag in _said(result)


def test_token_create_scope_is_required_and_one_of_three(cli_case: CliCase):
    missing = cli_case.run_cli(["token", "create"])
    admin = cli_case.run_cli(["token", "create", "--scope", "admin"])

    assert missing.returncode == 2, _said(missing)
    assert "the following arguments are required: --scope" in missing.stderr
    assert admin.returncode == 2, _said(admin)
    assert "invalid choice: 'admin'" in admin.stderr
    for scope in ("query", "read", "write"):
        assert scope in admin.stderr


def test_token_create_ttl_sets_an_expiry(cli_case: CliCase):
    _make_key(cli_case)

    result = cli_case.run_cli(["token", "create", "--scope", "read", "--ttl", "3600"])

    assert result.returncode == 0, _said(result)
    claims = _claims(
        token_in(result.stdout),
        _auth(cli_case) / "trusted" / "default.pub",
        API_AUDIENCE,
    )
    assert claims["exp"] == claims["iat"] + 3600
    assert "Expires" in _said(result)
    assert "no expiry" not in _said(result)


@pytest.mark.parametrize("ttl", ["0", "-60"])
def test_token_create_refuses_a_ttl_that_is_not_positive(cli_case: CliCase, ttl):
    _make_key(cli_case)

    result = cli_case.run_cli(["token", "create", "--scope", "read", f"--ttl={ttl}"])

    _refused_without_token(result)
    assert "more than 0" in _said(result)


def test_token_create_ttl_takes_seconds(cli_case: CliCase):
    result = cli_case.run_cli(["token", "create", "--scope", "read", "--ttl", "1h"])

    assert result.returncode == 2, _said(result)
    assert "invalid int value: '1h'" in result.stderr


def test_token_create_without_a_key_says_how_to_make_one(cli_case: CliCase):
    fresh = cli_case.run_cli(["token", "create", "--scope", "read"])
    _make_key(cli_case)
    shutil.rmtree(cli_case.home / ".canyonos")
    cleaned = cli_case.run_cli(["token", "create", "--scope", "read"])

    for result in (fresh, cleaned):
        _refused_without_token(result)
        assert "canyonos keys create" in _said(result)


def test_token_create_with_several_keys_needs_key(cli_case: CliCase):
    _make_key(cli_case)
    _make_key(cli_case, "--name", "ci")
    trusted = _auth(cli_case) / "trusted"

    unnamed = cli_case.run_cli(["token", "create", "--scope", "read"])
    _refused_without_token(unnamed)
    for word in ("default", "ci", "--key"):
        assert word in _said(unnamed)

    token = _token(cli_case, "--scope", "read", "--key", "ci")
    assert jwt.get_unverified_header(token)["kid"] == _kid_of(trusted / "ci.pub")
    assert _claims(token, trusted / "ci.pub", API_AUDIENCE)["scope"] == "read"
    with pytest.raises(jwt.InvalidSignatureError):
        _claims(token, trusted / "default.pub", API_AUDIENCE)

    nosuch = cli_case.run_cli(["token", "create", "--scope", "read", "--key", "nosuch"])
    _refused_without_token(nosuch)
    assert "nosuch" in _said(nosuch)


def test_token_create_warns_when_no_deploy_trusts_the_key(cli_case: CliCase):
    _make_key(cli_case)
    (_auth(cli_case) / "trusted" / "default.pub").unlink()

    result = cli_case.run_cli(["token", "create", "--scope", "read"])

    assert result.returncode == 0, _said(result)
    token_in(result.stdout)
    assert "no deploy trusts" in _said(result)


def test_token_create_warns_when_others_can_read_the_private_key(cli_case: CliCase):
    _make_key(cli_case)
    private = _auth(cli_case) / "default.key"
    private.chmod(0o644)

    result = cli_case.run_cli(["token", "create", "--scope", "read"])

    assert result.returncode == 0, _said(result)
    token_in(result.stdout)
    assert f"chmod 600 {private}" in _said(result)


def test_token_create_names_a_truncated_private_key(cli_case: CliCase):
    _make_key(cli_case)
    private = _auth(cli_case) / "default.key"
    private.write_text(private.read_text()[:40])

    result = cli_case.run_cli(["token", "create", "--scope", "read"])

    _refused_without_token(result)
    assert str(private) in _said(result)
    assert "Traceback" not in result.stderr


def test_auth_dir_after_the_action_keeps_every_file_there(cli_case: CliCase):
    created = cli_case.run_cli(["keys", "create", "--auth-dir", "./team-keys"])
    assert created.returncode == 0, _said(created)

    result = cli_case.run_cli(
        ["token", "create", "--scope", "read", "--auth-dir", "./team-keys"]
    )

    assert result.returncode == 0, _said(result)
    team = cli_case.cwd / "team-keys"
    _claims(token_in(result.stdout), team / "trusted" / "default.pub", API_AUDIENCE)
    assert _mode(team) == 0o700
    assert _mode(team / "trusted") == 0o755
    assert (team / "default.key").is_file()
    assert not (cli_case.home / ".canyonos").exists()


def test_auth_dir_never_falls_back_to_the_home_folder(cli_case: CliCase):
    _make_key(cli_case)

    result = cli_case.run_cli(
        ["token", "create", "--scope", "read", "--auth-dir", "./empty"]
    )

    _refused_without_token(result)
    assert str(cli_case.cwd / "empty") in _said(result)


def test_keys_and_token_help_and_usage_errors(cli_case: CliCase):
    keys_help = cli_case.run_cli(["keys", "-h"])
    bare = cli_case.run_cli(["keys"])
    delete = cli_case.run_cli(["keys", "delete"])
    token_help = cli_case.run_cli(["token", "create", "-h"])

    assert keys_help.returncode == 0, _said(keys_help)
    for action in ("create", "list", "trust"):
        assert action in keys_help.stdout
    for result in (bare, delete):
        assert result.returncode == 2, _said(result)
        assert "{create,list,trust}" in result.stderr
    assert token_help.returncode == 0, _said(token_help)
    for shown in (
        "{query,read,write}",
        "--project",
        "--all-projects",
        "--ttl SECONDS",
        "--key",
        "--auth-dir",
    ):
        assert shown in token_help.stdout


@pytest.mark.parametrize(
    "typed", [PROJECT_A.upper(), f"{{{PROJECT_A}}}", PROJECT_A.replace("-", "")]
)
def test_token_create_takes_a_project_id_only_as_deploy_writes_it(
    cli_case: CliCase, typed: str
):
    _make_key(cli_case)

    result = cli_case.run_cli(
        ["token", "create", "--scope", "query", "--project", typed]
    )

    _refused_without_token(result)
    assert typed in _said(result)
    assert "lowercase, hyphenated UUID" in _said(result)


def test_keys_skip_apple_double_files(cli_case: CliCase):
    _make_key(cli_case)
    auth = _auth(cli_case)
    (auth / "trusted" / "._default.pub").write_bytes(APPLE_DOUBLE)
    (auth / "._default.key").write_bytes(APPLE_DOUBLE)

    listed = cli_case.run_cli(["keys", "list"])
    token = _token(cli_case, "--scope", "read")

    assert listed.returncode == 0, _said(listed)
    assert [name for name, _kid, _path in _listed(listed.stdout)] == ["default"]
    assert "._default" not in listed.stdout
    _claims(token, auth / "trusted" / "default.pub", API_AUDIENCE)


def test_keys_list_names_a_trusted_file_whose_name_cannot_name_a_key(
    cli_case: CliCase,
):
    _make_key(cli_case)
    odd = _auth(cli_case) / "trusted" / "alice@host.pub"
    odd.write_text(_public_pem(_teammate_key()))

    result = cli_case.run_cli(["keys", "list"])

    assert result.returncode == 1, _said(result)
    assert str(odd) in _said(result)
    assert "Traceback" not in result.stdout + result.stderr


def _without_ansi(text: str) -> str:
    return " ".join(ANSI.sub("", text).split())


def test_clean_all_names_the_keys_before_it_deletes_them(cli_case: CliCase):
    _make_key(cli_case)
    auth = _auth(cli_case)

    unattended = cli_case.run_cli(["clean", "--all"])

    assert unattended.returncode == 1, _said(unattended)
    assert "the keys under ~/.canyonos/auth" in _said(unattended)

    terminal = cli_case.spawn_cli(["clean", "--all"])
    terminal.child.expect("Remove CanyonOS from this machine")
    assert "the keys under ~/.canyonos/auth" in _without_ansi(terminal.child.before)
    terminal.child.send("2")
    terminal.child.expect(pexpect.EOF)
    terminal.child.close()

    assert terminal.child.exitstatus == 1
    assert (auth / "default.key").is_file()
    assert (auth / "trusted" / "default.pub").is_file()
