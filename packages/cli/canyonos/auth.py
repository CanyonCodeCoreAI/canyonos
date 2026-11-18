# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The keys that sign tokens and the tokens they sign, for `canyonos keys` and
`canyonos token`. A private key under `~/.canyonos/auth/` signs on this machine; the
public keys in its `trusted/` folder are what deploys and the dashboard verify with.
"""

import hashlib
import json
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import jwt
from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
    PublicFormat,
    load_pem_private_key,
    load_pem_public_key,
)

from canyonos import ui
from canyonos.constants import deployment_config_path, project_root, read_config
from canyonos.os_support import (
    make_private_dir,
    readable_by_others,
    shell_command,
    write_private_file,
)

# packages/core/canyonos_core/auth.py repeats these on purpose: the CLI cannot import
# canyonos_core, and both sides must agree on them.
ISSUER = "canyonos"
API_AUDIENCE = "canyonos-api"
ALL_PROJECTS = "*"
SCOPES = ("query", "read", "write")
TRUSTED_KEYS_ENV = "CANYONOS_TRUSTED_KEYS"
AUTH_DISABLED_ENV = "CANYONOS_AUTH_DISABLED"

DEFAULT_KEY_NAME = "default"
_KEY_NAME = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9._-]*")
_PRIVATE_KEY_MARKER = b"PRIVATE KEY-----"
# The dashboard API container runs as another user and bind-mounts trusted/.
_PUBLIC_DIR_MODE = 0o755
_PUBLIC_FILE_MODE = 0o644

SKIP_AUTH_WARNING = (
    "--dangerous-skip-auth: the endpoint and the dashboard will answer anyone who "
    "reaches them, with no token. Use it only for a throwaway run."
)

_ROTATION = (
    "To rotate: make a new key (canyonos keys create --name <new_name>), delete the "
    "old key's .pub from trusted/, then redeploy and restart the dashboard "
    "(canyonos serve). Every token the old key signed stops working."
)


def default_auth_dir() -> Path:
    """The folder of keys every command uses without --auth-dir: `~/.canyonos/auth`."""
    return Path.home() / ".canyonos" / "auth"


def _folder(auth_dir: Path | None) -> Path:
    return (auth_dir or default_auth_dir()).absolute()


def trusted_dir(auth_dir: Path | None) -> Path:
    """The folder of public keys deploys and the dashboard trust, inside `auth_dir`."""
    return _folder(auth_dir) / "trusted"


def _cli(arguments: str, auth_dir: Path | None) -> str:
    """A `canyonos` command to copy, naming --auth-dir when the user picked one."""
    if auth_dir is None:
        return f"canyonos {arguments}"
    return f"canyonos {arguments} --auth-dir {shell_command([str(_folder(auth_dir))])}"


def key_name(value: str) -> str:
    """Return `value` when it can name a key file; raise RuntimeError saying which
    characters a name may use when it cannot."""
    if not _KEY_NAME.fullmatch(value):
        raise RuntimeError(
            f"{value!r} is not a key name: use only the characters [A-Za-z0-9._-], "
            "and do not start it with a dot"
        )
    return value


def key_id(public_pem: str) -> str:
    """The short id `keys list` shows and every token carries in its `kid` header: the
    first 16 hex characters of the sha256 of the public key's SPKI DER."""
    der = load_pem_public_key(public_pem.encode()).public_bytes(
        Encoding.DER, PublicFormat.SubjectPublicKeyInfo
    )
    return hashlib.sha256(der).hexdigest()[:16]


def _public_pem(key: Ed25519PublicKey) -> str:
    return key.public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo).decode()


def _read(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except OSError as error:
        raise RuntimeError(
            f"Could not read {path}: {error.strerror or error}"
        ) from error


def load_public_key(path: Path) -> str:
    """Read the Ed25519 public key in the PEM file at `path` and return it as SPKI PEM;
    raise RuntimeError naming the file when it holds anything else, with its own
    message for a private key sent by mistake."""
    data = _read(path)
    try:
        key = load_pem_public_key(data)
    except (ValueError, UnsupportedAlgorithm):
        if _PRIVATE_KEY_MARKER in data:
            raise RuntimeError(
                f"{path} is a private key: it never leaves the machine that signs. "
                "Only its public half, the .pub in trusted/, is shared"
            ) from None
        raise RuntimeError(
            f"{path} is not a public key CanyonOS can read: it takes an Ed25519 "
            "public key in PEM (-----BEGIN PUBLIC KEY-----), such as the .pub "
            "`canyonos keys create` writes"
        ) from None
    if not isinstance(key, Ed25519PublicKey):
        raise RuntimeError(
            f"{path} is not an Ed25519 public key: CanyonOS signs and verifies tokens "
            "with Ed25519 keys only"
        )
    return _public_pem(key)


def _named_keys(folder: Path, suffix: str) -> list[Path]:
    """The files in `folder` ending in `suffix`, sorted, leaving out dotfiles such as
    the `._default.pub` macOS writes beside a copy; raise RuntimeError naming a file
    whose name cannot name a key."""
    paths = sorted(
        path for path in folder.glob(f"*{suffix}") if not path.name.startswith(".")
    )
    for path in paths:
        if not _KEY_NAME.fullmatch(path.stem):
            raise RuntimeError(
                f"{path} cannot be a key: its name may use only the characters "
                "[A-Za-z0-9._-]. Rename it, or move it out of the folder"
            )
    return paths


def _trusted_files(auth_dir: Path | None) -> list[Path]:
    return _named_keys(trusted_dir(auth_dir), ".pub")


def trusted_keys(auth_dir: Path | None) -> list[str]:
    """The public keys in `trusted/`, as SPKI PEM sorted by file name; raise
    RuntimeError naming the first file that is not an Ed25519 public key."""
    return [load_public_key(path) for path in _trusted_files(auth_dir)]


def require_keys(auth_dir: Path | None) -> list[str]:
    """The trusted public keys a deploy hands its verifiers; raise RuntimeError saying
    how to make one when there is none."""
    keys = trusted_keys(auth_dir)
    if not keys:
        raise RuntimeError(
            f"No key is trusted in {trusted_dir(auth_dir)}, so nothing could query "
            f"the workflow. Make one with `{_cli('keys create', auth_dir)}`, then a "
            "token with `"
            + _cli("token create --scope query --project <project_id>", auth_dir)
            + "`. For a throwaway run, --dangerous-skip-auth skips this check"
        )
    return keys


def refuse_keys_in_project(
    auth_dir: Path | None, project_folders: list[str] | None = None
) -> None:
    """Raise RuntimeError naming both folders when the keys folder is inside one of
    `project_folders`, by default the current folder's project, whose files go into
    the image build and the Kubernetes upload."""
    folder = _folder(auth_dir).resolve()
    for root in project_folders or [project_root()]:
        project = Path(root).resolve()
        if folder.is_relative_to(project):
            raise RuntimeError(
                f"The keys folder {folder} is inside the project folder {project}, "
                "so its private keys would be copied into the images and the "
                "Kubernetes upload. Keep the keys outside the project and pass that "
                "folder to --auth-dir"
            )


def _key_names(folder: Path) -> list[str]:
    return [path.stem for path in _named_keys(folder, ".key")]


def signing_keys(auth_dir: Path | None) -> list[str]:
    """The names of the private keys in `auth_dir` that can sign tokens here."""
    return _key_names(_folder(auth_dir))


def holds_a_key(auth_dir: Path | None) -> bool:
    """True when `auth_dir` holds a private key or a trusted public key, so a first
    run knows whether making the default pair would be its first key."""
    return bool(_key_names(_folder(auth_dir)) or _trusted_files(auth_dir))


def private_key_path(name: str | None, auth_dir: Path | None) -> Path:
    """The private key to sign with: the one named `name`, else the only one in
    `auth_dir`; raise RuntimeError when it is missing or there are several to pick
    from."""
    folder = _folder(auth_dir)
    names = _key_names(folder)
    if name is not None:
        if key_name(name) not in names:
            raise RuntimeError(
                f"No private key named {name} in {folder}; "
                + (f"it holds {', '.join(names)}" if names else "it holds none")
            )
        return folder / f"{name}.key"
    if len(names) > 1:
        raise RuntimeError(
            f"{folder} holds several private keys ({', '.join(names)}): pick the one "
            "to sign with, with --key <name>"
        )
    if not names:
        raise RuntimeError(
            f"No private key in {folder}: make one with "
            f"`{_cli('keys create', auth_dir)}`"
        )
    return folder / f"{names[0]}.key"


def make_key_pair() -> tuple[str, str]:
    """Generate an Ed25519 key pair: the private key as PKCS8 PEM and its public half
    as SPKI PEM."""
    key = Ed25519PrivateKey.generate()
    private = key.private_bytes(
        Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()
    ).decode()
    return private, _public_pem(key.public_key())


def load_key_pair(path: Path) -> tuple[str, str]:
    """Read the private key at `path` and return it with its public half, both PEM;
    raise RuntimeError naming the file when it is not an Ed25519 private key."""
    data = _read(path)
    try:
        key = load_pem_private_key(data, password=None)
    except (ValueError, TypeError, UnsupportedAlgorithm):
        key = None
    if not isinstance(key, Ed25519PrivateKey):
        raise RuntimeError(
            f"{path} is not a private key CanyonOS can sign with: it should be the "
            "unencrypted Ed25519 PEM `canyonos keys create` wrote. If it was damaged, "
            "make a new key and rotate"
        )
    return data.decode(), _public_pem(key.public_key())


def _write_public_key(path: Path, public_pem: str) -> Path:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.parent.chmod(_PUBLIC_DIR_MODE)
        path.write_text(public_pem, encoding="utf-8")
        path.chmod(_PUBLIC_FILE_MODE)
    except OSError as error:
        raise RuntimeError(
            f"Could not write {path}: {error.strerror or error}"
        ) from error
    return path


def write_key_pair(
    name: str, private_pem: str, public_pem: str, auth_dir: Path | None
) -> tuple[Path, Path]:
    """Write the private key to `<name>.key` in `auth_dir`, readable only by you, and
    its public half to `trusted/<name>.pub`, readable by all; return both paths."""
    folder = _folder(auth_dir)
    private = folder / f"{name}.key"
    try:
        make_private_dir(folder)
        write_private_file(private, private_pem)
    except OSError as error:
        raise RuntimeError(
            f"Could not write {private}: {error.strerror or error}"
        ) from error
    return private, _write_public_key(trusted_dir(auth_dir) / f"{name}.pub", public_pem)


def _audience(scope: str, projects: list[str], all_projects: bool) -> list[str]:
    if scope != "query":
        for flag, given in (("--project", projects), ("--all-projects", all_projects)):
            if given:
                raise RuntimeError(
                    f"{flag} is for --scope query only: a {scope} token is for the "
                    "dashboard API, which covers every project"
                )
        return [API_AUDIENCE]
    if projects and all_projects:
        raise RuntimeError("Pass --project or --all-projects, not both")
    if all_projects:
        return [ALL_PROJECTS]
    if not projects:
        raise RuntimeError(
            "A query token needs the projects it may query: --project <project_id> "
            "(repeat it for more) or --all-projects"
        )
    return list(dict.fromkeys(_project_id(value) for value in projects))


def is_project_id(value) -> bool:
    """True when `value` is a UUID in the form `canyonos deploy` writes `deployment_id`:
    lowercase and hyphenated, since the endpoint compares `aud` with it as written."""
    try:
        return isinstance(value, str) and value == str(uuid.UUID(value))
    except ValueError:
        return False


def _project_id(value: str) -> str:
    """`value` when it is a project ID (see `is_project_id`); raise RuntimeError
    saying what one looks like otherwise."""
    if not is_project_id(value):
        raise RuntimeError(
            f"--project {value!r} is not a project ID: a project ID is a lowercase, "
            "hyphenated UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx), the `deployment_id` "
            "in its deployment.yaml"
        )
    return value


def _this_deployment_id() -> str:
    """The `deployment_id` in the `deployment.yaml` of the folder the command runs
    from, the project a query token given none is for; raise RuntimeError saying how
    to name one when there is none."""
    project_id = read_config(deployment_config_path()).get("deployment_id")
    if not project_id:
        raise RuntimeError(
            "A query token needs the projects it may query: --project <project_id> "
            "(repeat it for more) or --all-projects. Run it from a deployment's "
            "folder, or after `canyonos select-context <deployment>`, and it is for "
            "that deployment"
        )
    return project_id


def token_claims(
    scope: str, projects: list[str], all_projects: bool, ttl: int | None
) -> dict:
    """The claims of a new token: who it is for (`aud`), what it may do (`scope`) and,
    with `ttl` seconds, when it expires; raise RuntimeError when the options do not
    make a token."""
    if scope not in SCOPES:
        raise RuntimeError(f"--scope is one of {', '.join(SCOPES)}, not {scope!r}")
    if ttl is not None and ttl <= 0:
        raise RuntimeError(f"--ttl must be more than 0 seconds, not {ttl}")
    issued = int(time.time())
    claims = {
        "iss": ISSUER,
        "iat": issued,
        "jti": uuid.uuid4().hex,
        "aud": _audience(scope, projects, all_projects),
        "scope": scope,
    }
    if ttl is not None:
        claims["exp"] = issued + ttl
    return claims


def sign_token(private_pem: str, claims: dict, kid: str) -> str:
    """Sign `claims` with the private key into a JWT (EdDSA) carrying `kid`."""
    return jwt.encode(claims, private_pem, algorithm="EdDSA", headers={"kid": kid})


def query_token(
    project_id: str,
    key: str | None = None,
    auth_dir: Path | None = None,
    ttl: int | None = None,
) -> str:
    """Sign a token that may query the project `project_id`, with the private key
    named `key` in `auth_dir` (or its only one), for a command that queries the
    workflow itself; with `ttl`, it expires that many seconds from now."""
    private, public = load_key_pair(private_key_path(key, auth_dir))
    return sign_token(
        private, token_claims("query", [project_id], False, ttl), key_id(public)
    )


def api_token(
    scope: str,
    ttl: int,
    key: str | None = None,
    auth_dir: Path | None = None,
) -> str:
    """Sign a `read` or `write` token for the dashboard API, expiring `ttl` seconds
    from now, with the private key named `key` in `auth_dir` (or its only one), for
    a command that calls the dashboard API itself."""
    private, public = load_key_pair(private_key_path(key, auth_dir))
    return sign_token(private, token_claims(scope, [], False, ttl), key_id(public))


def gc_env(keys: list[str], disabled: bool) -> list[str]:
    """The `docker run` options that hand the Global Controller the trusted public
    keys, and the switch that turns verification off when `disabled`."""
    options = ["-e", f"{TRUSTED_KEYS_ENV}={json.dumps(keys)}"]
    if disabled:
        options += ["-e", f"{AUTH_DISABLED_ENV}=true"]
    return options


def show_new_key(private: Path, public: Path, auth_dir: Path | None) -> None:
    """Show in the terminal where a new key pair is, what each half is for, the
    commands that make a token with it, and how to rotate it."""
    ui.ok(f"Made the key pair {private.stem}")
    ui.say(f"Private key: {private}")
    ui.hint(
        "It signs your tokens and never leaves this machine: keep it like a password, "
        "and never commit or send it."
    )
    ui.say(f"Public key: {public}")
    ui.hint(
        "Deploys and the dashboard trust every token a key in this folder signed. "
        "Share the .pub, never the .key."
    )
    ui.blank()
    ui.say(
        "Make a token to query a workflow, from its deployment's folder, or to read "
        "the dashboard API:"
    )
    ui.command(_cli("token create --scope query", auth_dir))
    ui.command(_cli("token create --scope read", auth_dir))
    ui.blank()
    ui.hint(_ROTATION)


def _grants(claims: dict) -> str:
    audience = claims["aud"]
    return {
        "query": (
            "query the workflow of every project"
            if audience == [ALL_PROJECTS]
            else f"query the workflow of project {', '.join(audience)}"
        ),
        "read": "read the dashboard API (every GET), for every project it shows",
        "write": (
            "change things through the dashboard API (POST, PUT, DELETE), and "
            "read what it can change: project detail, scaling, governance and prompts; "
            "every other GET (project list, stats, requests, logs, metrics, "
            "monitoring, resources) needs a read token"
        ),
    }[claims["scope"]]


def _expiry(claims: dict) -> str:
    if "exp" not in claims:
        return "never (no expiry): it works until its key is rotated"
    when = datetime.fromtimestamp(claims["exp"], timezone.utc)
    return f"{when:%Y-%m-%d %H:%M:%S} UTC, {claims['exp'] - claims['iat']}s from now"


def show_token(token: str, claims: dict) -> None:
    """Write the token alone to stdout, and on stderr what it grants, how to send it
    and how to rotate it, so `$(canyonos token create ...)` captures only the token."""
    with ui.to_stderr():
        ui.ok(
            f"Signed a {claims['scope']} token. It is shown once and stored nowhere: "
            "keep it now."
        )
    ui.result(token)
    with ui.to_stderr():
        ui.say(f"Grants: {_grants(claims)}")
        ui.say(f"Expires: {_expiry(claims)}")
        if claims["scope"] == "query":
            ui.say("Send it as the header Authorization: Bearer <token>, as in:")
            ui.command(
                'curl -X POST <endpoint-url>/<method> -H "Authorization: Bearer '
                '<token>" -H "Content-Type: application/json" -d \'<request body>\''
            )
        else:
            ui.say(
                "Send it to the dashboard API as the header "
                "Authorization: Bearer <token>."
            )
        ui.hint(_ROTATION)


def run_keys_create(name: str, auth_dir: Path | None) -> bool:
    """Make a key pair for `canyonos keys create` and show where it is; refuse, without
    touching anything, a name whose key or public key already exists."""
    name = key_name(name)
    for existing in (
        _folder(auth_dir) / f"{name}.key",
        trusted_dir(auth_dir) / f"{name}.pub",
    ):
        if existing.exists():
            ui.fail(
                f"{existing} already exists, and the tokens key {name} signed depend "
                "on it. Pick another name with --name, or delete it first to rotate."
            )
            return False
    private, public = write_key_pair(name, *make_key_pair(), auth_dir)
    show_new_key(private, public, auth_dir)
    return True


def run_keys_list(auth_dir: Path | None) -> bool:
    """Show the trusted public keys for `canyonos keys list`, one line each with its
    name, kid and file, or how to make one when there is none."""
    files = _trusted_files(auth_dir)
    if not files:
        ui.say(f"No key is registered in {trusted_dir(auth_dir)}. Make one with:")
        ui.command(_cli("keys create", auth_dir))
        return True
    kids = [key_id(load_public_key(path)) for path in files]
    width = max(len(path.stem) for path in files)
    for path, kid in zip(files, kids):
        ui.say(f"{path.stem:<{width}}  {kid}  {path}")
    return True


def run_keys_trust(file: str, auth_dir: Path | None) -> bool:
    """Register someone's public key for `canyonos keys trust`, as `trusted/<name>.pub`
    whatever its suffix; refuse one that is not an Ed25519 public key, or whose name
    is taken."""
    source = Path(file)
    public = load_public_key(source)
    destination = trusted_dir(auth_dir) / f"{key_name(source.stem)}.pub"
    if destination.exists():
        ui.fail(
            f"{destination} already exists: delete it first to replace that key, or "
            f"rename {source.name} to trust it under another name."
        )
        return False
    _write_public_key(destination, public)
    ui.ok(f"Trusted {source} as {destination}")
    ui.say(f"Key ID: {key_id(public)}")
    ui.hint(
        "Deploys and the dashboard read trusted/ when they start: redeploy and restart "
        "the dashboard (canyonos serve) for the key to count."
    )
    return True


def run_token_create(
    scope: str,
    projects: list[str],
    all_projects: bool,
    ttl: int | None,
    key: str | None,
    auth_dir: Path | None,
) -> bool:
    """Sign a token for `canyonos token create` and show it once, warning when the key
    is readable by others or no deploy trusts it. A query token given no project is for
    the deployment of the folder it runs from."""
    if scope == "query" and not projects and not all_projects:
        projects = [_this_deployment_id()]
    claims = token_claims(scope, projects, all_projects, ttl)
    path = private_key_path(key, auth_dir)
    private, public = load_key_pair(path)
    token = sign_token(private, claims, key_id(public))
    if readable_by_others(path):
        ui.warn(
            f"{path} is readable by other users of this machine, and whoever reads it "
            f"can sign tokens. Run: {shell_command(['chmod', '600', str(path)])}"
        )
    trusted = trusted_dir(auth_dir) / f"{path.stem}.pub"
    if not trusted.is_file():
        ui.warn(
            f"Signed, but no deploy trusts this key: {trusted} is missing, so "
            "workflows and the dashboard refuse this token. Put the public key back "
            "with `canyonos keys trust <file>` and redeploy."
        )
    show_token(token, claims)
    return True
