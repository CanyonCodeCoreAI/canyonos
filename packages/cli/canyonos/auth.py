# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""This machine's API key: one string the user picks with `--api-key`, kept in
`~/.canyonos/api_key`, that opens every endpoint deployed here and the CanyonOS API,
its `/v1/workflow-groups` routes included. The containers get only its SHA-256 hash.
Without a key nothing is checked."""

import hashlib
import os
import secrets
from enum import Enum, auto
from pathlib import Path
from typing import Literal

from canyonos import ui
from canyonos.os_support import make_private_dir, write_private_file

# packages/core/canyonos_core/auth.py repeats this on purpose: the CLI cannot import
# canyonos_core, and both sides must agree on it.
API_KEY_HASH_ENV = "CANYONOS_API_KEY_HASH"
API_KEY_ENV = "CANYONOS_API_KEY"

# The header every printed `curl` sends; the key itself is never printed.
BEARER_PLACEHOLDER = '-H "Authorization: Bearer <your api key>"'

NO_KEY_WARNING = (
    "No API key is set: the endpoint and the dashboard answer anyone who reaches "
    "them. Set one with --api-key <key>."
)
KEY_SET = "Your deploys now use an API key for secure connections."


class _Unresolved(Enum):
    KEY = auto()


# The key this command resolved (`resolve_api_key`), None for none, so every call it
# makes to the CanyonOS API it restarted sends that key, even with another in
# CANYONOS_API_KEY; _Unresolved.KEY until it resolves one.
_command_key: str | None | Literal[_Unresolved.KEY] = _Unresolved.KEY


def api_key_path() -> Path:
    """Where this machine keeps its API key: `~/.canyonos/api_key`."""
    return Path.home() / ".canyonos" / "api_key"


def _stored_api_key() -> str | None:
    try:
        key = api_key_path().read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    except OSError as error:
        raise RuntimeError(
            f"Could not read {api_key_path()}: {error.strerror or error}"
        ) from error
    return key or None


def machine_api_key() -> str | None:
    """The API key commands here send and deploys set: the one this command resolved,
    else `CANYONOS_API_KEY` when it is set, else the stored key; None when there is
    none."""
    if _command_key is not _Unresolved.KEY:
        return _command_key
    return os.environ.get(API_KEY_ENV, "").strip() or _stored_api_key()


def hash_api_key(key: str | None) -> str:
    """The SHA-256 of `key` in lowercase hex, as the verifiers hold it; "" for no key."""
    if not key:
        return ""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _save(key: str) -> None:
    path = api_key_path()
    replaced = _stored_api_key() is not None
    try:
        make_private_dir(path.parent)
        write_private_file(path, key + "\n")
    except OSError as error:
        raise RuntimeError(
            f"Could not write {path}: {error.strerror or error}"
        ) from error
    ui.ok(KEY_SET)
    if replaced:
        ui.hint(
            "The dashboard and this workflow group use the new key; other running "
            "workflow groups keep the old one until you redeploy them."
        )


def _remove() -> None:
    try:
        api_key_path().unlink()
    except FileNotFoundError:
        return
    except OSError as error:
        raise RuntimeError(
            f"Could not remove {api_key_path()}: {error.strerror or error}"
        ) from error
    ui.ok("Removed this machine's API key.")


def resolve_api_key(api_key: str | None, no_api_key: bool) -> str | None:
    """Apply `--api-key` (save it, replacing any stored key) or `--no-api-key` (remove
    the stored key) and return the key this deploy or serve sets, which holds for the
    rest of the command, warning when there is none; raise RuntimeError for an empty
    `--api-key`, or before changing anything when CANYONOS_API_KEY holds another key,
    which later commands would send instead."""
    global _command_key
    if api_key is not None and not api_key.strip():
        raise RuntimeError(
            "--api-key needs a key. To run without one, pass --no-api-key instead"
        )
    env_key = os.environ.get(API_KEY_ENV, "").strip()
    if env_key and no_api_key:
        raise RuntimeError(
            f"{API_KEY_ENV} holds a key, which later commands would send and "
            "`canyonos serve` would put back on the CanyonOS API. Unset "
            f"{API_KEY_ENV}, then run this again"
        )
    if env_key and api_key is not None and env_key != api_key.strip():
        raise RuntimeError(
            f"{API_KEY_ENV} holds another key, which later commands would send "
            f"instead of this one. Unset {API_KEY_ENV} or set it to the new key, "
            "then run this again"
        )
    if no_api_key:
        _remove()
        key = None
    elif api_key is not None:
        key = api_key.strip()
        _save(key)
    else:
        key = machine_api_key()
    _command_key = key
    if key is None:
        ui.warn(NO_KEY_WARNING)
    return key


def ensure_machine_api_key() -> str:
    """This machine's API key, made and saved to `~/.canyonos/api_key` when there is
    none, as `canyonos cluster up` needs one for the cluster's dashboard."""
    key = machine_api_key()
    if key is None:
        key = secrets.token_hex(32)
        _save(key)
    return key


def auth_header(key: str | None = None) -> dict[str, str]:
    """The header that sends `key`, by default this machine's API key; none when there
    is no key."""
    key = key or machine_api_key()
    if not key:
        return {}
    return {"Authorization": f"Bearer {key}"}


def curl_auth(keyed: bool) -> str:
    """The placeholder header a printed `curl` shows when the deploy is `keyed`, else
    ""."""
    return f" {BEARER_PLACEHOLDER}" if keyed else ""


def gc_env(key: str | None) -> list[str]:
    """The `docker run` options that hand the Global Controller the hash of `key`; an
    empty hash when there is no key, so nothing is checked."""
    return ["-e", f"{API_KEY_HASH_ENV}={hash_api_key(key)}"]
