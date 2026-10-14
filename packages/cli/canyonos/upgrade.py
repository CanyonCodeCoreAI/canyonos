# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos upgrade`, and the notice shown before a command when a newer
CLI is out.

The supported CLI versions are listed in `packages/cli/supported-versions.json` on
the public `main`; the Release workflow rewrites it once a stable version is
published. The CLI keeps a copy under `~/.canyonos` and fetches it at most once a
day. Support is what gets tested and maintained, never a gate: every version keeps
running, and any failure to learn the policy means no notice, not a failed command.
"""

import importlib.util
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
import urllib.request
from http.client import HTTPException
from pathlib import Path

from canyonos import env, ui

_RAW_MAIN = "https://raw.githubusercontent.com/CanyonCodeCoreAI/canyonos/main"
POLICY_URL = f"{_RAW_MAIN}/packages/cli/supported-versions.json"
INSTALL_SCRIPT_URL = f"{_RAW_MAIN}/packages/cli/install.sh"
# Spelled like `project.state_dir()`: `expanduser` never raises, so importing the CLI
# can't fail over a home directory the check would only have skipped.
CACHE_PATH = Path(os.path.expanduser("~/.canyonos/supported-versions.json"))
# install.sh's own default, so only another directory has to be spelled out.
DEFAULT_INSTALL_DIR = Path(os.path.expanduser("~/.local/bin"))

REFRESH_INTERVAL = 24 * 60 * 60
# Paid before the command runs, at most once a day, so it stays short.
FETCH_TIMEOUT = 1.5
# The policy is a few hundred bytes; a response far larger than that is not it.
MAX_POLICY_BYTES = 64 * 1024

_RELEASE = re.compile(r"\d+\.\d+\.\d+")
_RELEASE_PREFIX = re.compile(r"(\d+)\.(\d+)\.(\d+)")
_UV_TOOL_ENTRY = re.compile(r"^canyonos v(\S+)(?: \[required: (.+)\])?$", re.MULTILINE)


def _release_key(version):
    """Return the release `version` starts with, as numbers to compare, or None. A
    development build such as `0.1.735.dev0` compares as the release it leads up to."""
    match = _RELEASE_PREFIX.match(version)
    return tuple(int(part) for part in match.groups()) if match else None


def parse_policy(data):
    """Read the content of `supported-versions.json` into (latest, supported versions),
    or return None when it is not a well-formed policy."""
    if not isinstance(data, dict):
        return None
    latest, supported = data.get("latest"), data.get("supported")
    if not isinstance(supported, list) or latest not in supported:
        return None
    if not all(isinstance(v, str) and _RELEASE.fullmatch(v) for v in supported):
        return None
    return latest, supported


def _read_cache():
    """Read the last policy check from `~/.canyonos`, or return None when there is no
    readable, well-formed record."""
    try:
        cache = json.loads(CACHE_PATH.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(cache, dict):
        return None
    checked_at, policy = cache.get("checked_at"), cache.get("policy")
    if isinstance(checked_at, bool) or not isinstance(checked_at, (int, float)):
        return None
    if policy is not None and parse_policy(policy) is None:
        return None
    return checked_at, policy


def _write_cache(checked_at, policy):
    """Record a policy check in `~/.canyonos`. A home that can't be written to only
    means the next command checks again."""
    try:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        partial = CACHE_PATH.with_suffix(f".{os.getpid()}.tmp")
        partial.write_text(json.dumps({"checked_at": checked_at, "policy": policy}))
        os.replace(partial, CACHE_PATH)
    except OSError:
        pass


def _fetch_policy():
    """Download the policy from the public `main`, or return None when it can't be
    reached in time or what comes back is not a policy."""
    try:
        with urllib.request.urlopen(POLICY_URL, timeout=FETCH_TIMEOUT) as response:
            data = json.loads(response.read(MAX_POLICY_BYTES))
    except (OSError, ValueError, HTTPException):
        return None
    return data if parse_policy(data) else None


def load_policy():
    """Load the supported-versions policy: the copy under `~/.canyonos` while it is less
    than a day old, else a fresh download saved there. A failed download keeps the last
    policy and still counts as the day's check, so an offline machine waits once a day.
    Returns None when no policy is known."""
    now = time.time()
    cached = _read_cache()
    if cached and 0 <= now - cached[0] < REFRESH_INTERVAL:
        return parse_policy(cached[1])
    policy = _fetch_policy() or (cached[1] if cached else None)
    _write_cache(now, policy)
    return parse_policy(policy)


def outdated_notice(version, policy):
    """Build the warning for running `version` under `policy`, as (message, urgent), or
    None when there is nothing to warn about: no policy, the latest, or a newer build."""
    if policy is None:
        return None
    latest, supported = policy
    installed = _release_key(version)
    if installed is None or installed >= _release_key(latest):
        return None
    if installed in {_release_key(v) for v in supported}:
        return (
            f"canyonos {latest} is available (you have {version}). "
            "Run `canyonos upgrade` to update.",
            False,
        )
    return (
        f"canyonos {version} is no longer maintained; the supported versions are "
        f"{', '.join(supported)}. Run `canyonos upgrade` to move to {latest}.",
        True,
    )


def notify_if_outdated():
    """Before a command runs, warn on stderr when this CLI is older than the latest
    release, and more strongly once it is no longer supported. Only a released CLI
    checks, and nothing here can stop the command."""
    if not env.is_production:
        return
    # Any failure, expected or not, must leave the command to run as if unchecked.
    try:
        notice = outdated_notice(env.VERSION, load_policy())
        if notice is not None:
            ui.notice(*notice)
    except Exception:
        pass


def _installed_by_uv_tool():
    """True when this CLI runs from an environment `uv tool install` made, which uv
    marks with a receipt at its root."""
    return (Path(sys.prefix) / "uv-receipt.toml").is_file()


def _reinstall_command():
    """Name the command that installs the latest CLI the same way this one was installed:
    Homebrew or `install.sh` for the standalone binary, pip or uv for a Python
    environment."""
    # Nuitka defines `__compiled__` in every module of the standalone binary.
    if "__compiled__" not in globals():
        python = shlex.quote(sys.executable)
        # Environments uv makes (`uv venv`, `uv add`, `uvx`) ship without pip.
        if importlib.util.find_spec("pip") is None:
            return f"uv pip install --python {python} --upgrade canyonos"
        return f"{python} -m pip install --upgrade canyonos"
    binary = os.path.realpath(shutil.which(sys.argv[0]) or sys.argv[0])
    if f"{os.sep}Cellar{os.sep}" in binary:
        return "brew upgrade canyonos"
    install_dir = os.path.dirname(binary)
    target = (
        ""
        if install_dir == os.path.realpath(DEFAULT_INSTALL_DIR)
        else f"CANYONOS_INSTALL_DIR={shlex.quote(install_dir)} "
    )
    return f"curl -fsSL {INSTALL_SCRIPT_URL} | {target}sh"


def _explain_held_back(uv):
    """After `uv tool upgrade`, explain in the terminal when the version constraint the
    CLI was installed with kept it from the latest release. uv keeps that constraint,
    and so does this command; replacing it is left to the user."""
    listed = subprocess.run(
        [uv, "tool", "list", "--show-version-specifiers"],
        capture_output=True,
        text=True,
    )
    entry = _UV_TOOL_ENTRY.search(listed.stdout) if listed.returncode == 0 else None
    if entry is None or entry.group(2) is None:
        return
    version, constraint = entry.groups()
    policy = load_policy()
    held_back = (
        _release_key(version) < _release_key(policy[0])
        if policy and _release_key(version)
        else version == env.VERSION
    )
    if not held_back:
        return
    ui.warn(
        f"canyonos stays at {version} because it was installed with the constraint "
        f"`{constraint}`, which uv keeps. To replace it with the latest release, run:"
    )
    ui.command("uv tool install canyonos@latest")


def run_upgrade():
    """Run `canyonos upgrade`: upgrade the CLI with `uv tool` when uv installed it.
    Otherwise leave the installation alone and show in the terminal the command that
    reinstalls it. Returns the exit status."""
    if not _installed_by_uv_tool():
        ui.say(
            "This canyonos was not installed with `uv tool`, so it is left as it is. "
            "To upgrade it, run:"
        )
        ui.command(_reinstall_command())
        return 0
    uv = shutil.which("uv")
    if uv is None:
        ui.fail(
            "canyonos was installed with `uv tool`, but `uv` is not on your PATH. "
            "Run `uv tool upgrade canyonos` once it is."
        )
        return 1
    upgraded = subprocess.run([uv, "tool", "upgrade", "canyonos"])
    if upgraded.returncode != 0:
        return upgraded.returncode
    _explain_held_back(uv)
    return 0
