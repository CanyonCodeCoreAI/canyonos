# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Each workflow group's API key: one string the user picks with `canyonos deploy
--api-key`, kept in the workflow group's record (`~/.canyonos/workflows/<workflow
group>/api_key`), that opens that workflow group's endpoint and its routes on the
CanyonOS API, never another workflow group's. The containers get only its SHA-256 hash.
A workflow group without a key checks nothing. `CANYONOS_API_KEY` stands in for the
record's key for one command."""

import hashlib
import json
import os
from pathlib import Path

from canyonos import deployment, records, ui
from canyonos.os_support import make_private_dir, write_private_file

# packages/core/canyonos_core/auth.py repeats this on purpose: the CLI cannot import
# canyonos_core, and both sides must agree on it.
API_KEY_HASH_ENV = "CANYONOS_API_KEY_HASH"
API_KEY_ENV = "CANYONOS_API_KEY"
API_KEY_FILE = "api_key"

# The header every printed `curl` sends; the key itself is never printed.
BEARER_PLACEHOLDER = '-H "Authorization: Bearer <your api key>"'

NO_KEY_WARNING = (
    "This workflow group has no API key: its endpoint and its dashboard routes answer "
    "anyone who reaches them. Set one with --api-key <key>."
)
KEY_SET = "This workflow group now uses an API key for secure connections."
ONLY_THIS_GROUP = (
    "Only this workflow group changes: other workflow groups keep their own keys."
)


def api_key_path(name: str | None = None) -> Path:
    """Where the record of workflow group `name`, by default the one this command acts
    on, keeps its API key."""
    return Path(deployment.state_dir(name)) / API_KEY_FILE


def _machine_key_path() -> Path:
    """Where a CLI before per-workflow-group keys kept one key for every workflow group
    on this machine; read once, by `_adopt_machine_key`."""
    return Path.home() / ".canyonos" / API_KEY_FILE


def _read_key(path: Path) -> str | None:
    """The key in the file at `path`, or None when there is no file or it is empty;
    raise RuntimeError when it can't be read."""
    try:
        key = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    except OSError as error:
        raise RuntimeError(
            f"Could not read {path}: {error.strerror or error}"
        ) from error
    return key or None


def _write_key(path: Path, key: str) -> None:
    try:
        make_private_dir(path.parent)
        write_private_file(path, key + "\n")
    except OSError as error:
        raise RuntimeError(
            f"Could not write {path}: {error.strerror or error}"
        ) from error


def _deployed_without_key(name: str) -> bool:
    """Whether the Docker deploy of workflow group `name` that still runs was made with
    no API key, as its `state.json` records it. False when there is no `state.json`,
    which a stop removes and a Kubernetes deploy never writes, or it can't be read:
    such a workflow group takes the machine key, and its next deploy sets it."""
    try:
        with open(deployment.state_path(name), encoding="utf-8") as f:
            state = json.load(f)
    except (OSError, ValueError):
        return False
    return isinstance(state, dict) and state.get("auth_disabled") is True


def _adopt_machine_key(deploying: str) -> None:
    """Upgrade, once, as a deploy starts, from the CLI that kept one key for the whole
    machine in `~/.canyonos/api_key`: every workflow group recorded here without a key
    of its own, and `deploying`, the one the deploy is about to set up, take that key,
    which their deploys were made with, then the file is removed, as no record needs it
    anymore. A Docker workflow group still deployed with no key stays without one."""
    legacy = _machine_key_path()
    key = _read_key(legacy)
    if key is None and not legacy.exists():
        return
    if key is not None:
        for name in {*records.names(), deploying}:
            path = api_key_path(name)
            if not path.exists() and not _deployed_without_key(name):
                _write_key(path, key)
    try:
        legacy.unlink(missing_ok=True)
    except OSError as error:
        raise RuntimeError(
            f"Could not remove {legacy}: {error.strerror or error}"
        ) from error
    if key is not None:
        ui.note(
            f"Each workflow group now keeps its own API key: {legacy} moved into the "
            "record of each workflow group here, in its api_key file."
        )


def group_api_key(name: str | None = None) -> str | None:
    """The API key of workflow group `name`, by default the one this command acts on:
    `CANYONOS_API_KEY` when it is set, else the one its record keeps; None when there
    is none. Reads only: a deploy is what moves an older CLI's machine key into the
    records (`resolve_api_key`)."""
    env_key = os.environ.get(API_KEY_ENV, "").strip()
    if env_key:
        return env_key
    return _read_key(api_key_path(name))


def workflow_group_api_key(workflow_group_id: str) -> str | None:
    """The API key of the workflow group whose ID is `workflow_group_id`, as
    `group_api_key` finds it; None when no record has that ID, so a request about a
    workflow group this machine does not know carries no other workflow group's key."""
    name = records.resolve(workflow_group_id, missing_ok=True)
    if name is None:
        return None
    return group_api_key(name)


def hash_api_key(key: str | None) -> str:
    """The SHA-256 of `key` in lowercase hex, as the verifiers hold it; "" for no key."""
    if not key:
        return ""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def _save(key: str) -> None:
    """Keep `key` in the record of the workflow group this deploy acts on, saying so in
    the terminal, and that only this workflow group changes when the key replaces one
    it ran with: another key, or none on a workflow group deployed before."""
    path = api_key_path()
    previous = _read_key(path)
    if previous is None:
        replaces_a_deploys_key = os.path.isfile(deployment.state_path())
    else:
        replaces_a_deploys_key = previous != key
    _write_key(path, key)
    ui.ok(KEY_SET)
    if replaces_a_deploys_key:
        ui.hint(ONLY_THIS_GROUP)


def _remove() -> None:
    path = api_key_path()
    try:
        path.unlink()
    except FileNotFoundError:
        return
    except OSError as error:
        raise RuntimeError(
            f"Could not remove {path}: {error.strerror or error}"
        ) from error
    ui.ok("Removed this workflow group's API key.")
    ui.hint(ONLY_THIS_GROUP)


def check_api_key_options(api_key: str | None, no_api_key: bool) -> None:
    """Raise RuntimeError for an empty `--api-key`, or when CANYONOS_API_KEY holds
    another key than `--api-key` or `--no-api-key` set, which later commands would send
    instead; a deploy checks this before it changes anything."""
    if api_key is not None and not api_key.strip():
        raise RuntimeError(
            "--api-key needs a key. To run without one, pass --no-api-key instead"
        )
    env_key = os.environ.get(API_KEY_ENV, "").strip()
    if env_key and no_api_key:
        raise RuntimeError(
            f"{API_KEY_ENV} holds a key, which later commands would send to this "
            f"workflow group. Unset {API_KEY_ENV}, then run this again"
        )
    if env_key and api_key is not None and env_key != api_key.strip():
        raise RuntimeError(
            f"{API_KEY_ENV} holds another key, which later commands would send "
            f"instead of this one. Unset {API_KEY_ENV} or set it to the new key, "
            "then run this again"
        )


def resolve_api_key(api_key: str | None, no_api_key: bool) -> str | None:
    """Apply `--api-key` (save it in the record of the workflow group this deploy acts
    on, replacing its key) or `--no-api-key` (remove its key) and return the key this
    deploy sets, warning when there is none; raise RuntimeError as
    `check_api_key_options` does."""
    check_api_key_options(api_key, no_api_key)
    _adopt_machine_key(deployment.deployment_name())
    if no_api_key:
        _remove()
        key = None
    elif api_key is not None:
        key = api_key.strip()
        _save(key)
    else:
        key = group_api_key()
    if key is None:
        ui.warn(NO_KEY_WARNING)
    return key


def bearer_header(key: str | None) -> dict[str, str]:
    """The header that sends `key`; none when there is no key."""
    if not key:
        return {}
    return {"Authorization": f"Bearer {key}"}


def auth_header() -> dict[str, str]:
    """The header that sends the API key of the workflow group this command acts on;
    none when it has no key."""
    return bearer_header(group_api_key())


def curl_auth(keyed: bool) -> str:
    """The placeholder header a printed `curl` shows when the deploy is `keyed`, else
    ""."""
    return f" {BEARER_PLACEHOLDER}" if keyed else ""


def gc_env(key: str | None) -> list[str]:
    """The `docker run` options that hand the Global Controller the hash of `key`; an
    empty hash when there is no key, so nothing is checked."""
    return ["-e", f"{API_KEY_HASH_ENV}={hash_api_key(key)}"]
