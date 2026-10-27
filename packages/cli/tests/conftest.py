# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import atexit
import functools
import os
import shutil
import sys
import tempfile

# Before any CLI module is imported: a path computed at import time (such as
# upgrade.CACHE_PATH) must not name the real home folder either.
_SESSION_HOME = tempfile.mkdtemp(prefix="canyonos-tests-home-")
os.environ["HOME"] = os.environ["USERPROFILE"] = _SESSION_HOME
atexit.register(shutil.rmtree, _SESSION_HOME, ignore_errors=True)

# The e2e cases drive a real deploy through a POSIX harness (fcntl, pexpect); on
# Windows `pytest tests` leaves them out instead of failing to collect them.
collect_ignore = ["e2e"] if os.name == "nt" else []

import pytest

from canyonos import env, upgrade

# Every name an OS or a tool the CLI runs may find the user's home folder by.
_HOME_VARIABLES = ("HOME", "USERPROFILE")
_XDG_VARIABLES = (
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
)


@functools.cache
def _can_symlink():
    """Whether this machine lets the tests create symlinks: Windows only does with
    Developer Mode or as an administrator (as on CI's runners)."""
    with tempfile.TemporaryDirectory() as folder:
        try:
            os.symlink(folder, os.path.join(folder, "link"), target_is_directory=True)
        except OSError:
            return False
    return True


# Markers for the few tests that need one OS's own behaviour (such as permission bits)
# or a capability, skipped elsewhere with the reason given.
_MARKERS = {
    "posix_only": lambda: os.name != "nt",
    "windows_only": lambda: os.name == "nt",
    "needs_symlinks": _can_symlink,
}


def pytest_configure(config):
    for name in _MARKERS:
        config.addinivalue_line(
            "markers", f"{name}(reason): runs only where that holds; skipped elsewhere."
        )


def pytest_runtest_setup(item):
    for name, applies in _MARKERS.items():
        marker = item.get_closest_marker(name)
        if marker is not None and not applies():
            pytest.skip(marker.args[0] if marker.args else name)


@pytest.fixture
def fake_command(tmp_path, monkeypatch):
    """Make commands on PATH that run Python `source` with the tests' interpreter:
    `fake_command("uv", source)`. A shell launcher on Linux and macOS, a .cmd one on
    Windows, so a test never depends on a shell the OS doesn't have."""
    bin_dir = tmp_path / "fake-bin"
    bin_dir.mkdir()
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")

    def make(name, source):
        script = bin_dir / f"{name}.py"
        script.write_text(source, encoding="utf-8")
        if os.name == "nt":
            launcher = bin_dir / f"{name}.cmd"
            launcher.write_text(
                f'@"{sys.executable}" "{script}" %*\n', encoding="utf-8"
            )
        else:
            launcher = bin_dir / name
            launcher.write_text(
                f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n',
                encoding="utf-8",
            )
            launcher.chmod(0o755)
        return launcher

    return make


@pytest.fixture(autouse=True)
def no_usage_api(monkeypatch):
    """Keep CLI tests from sending events to any selected usage API: runs in process or
    as a child would otherwise start delivery."""
    monkeypatch.setattr(env, "usage_url", None)
    # Not "": Windows can't hold an empty variable, and a child would then fall back
    # to the production API. Any value that isn't a usable URL turns sending off.
    monkeypatch.setenv(env.USAGE_URL_VAR, "off")


@pytest.fixture(autouse=True)
def _version_check_stays_local(monkeypatch, tmp_path):
    """Every command run through `cli.main` checks the supported CLI versions first;
    keep that check off the network and out of the real `~/.canyonos`."""
    monkeypatch.setattr(upgrade, "CACHE_PATH", tmp_path / "supported-versions.json")
    # Port 9 (discard) refuses at once, so a stray check costs nothing.
    monkeypatch.setattr(upgrade, "POLICY_URL", "http://127.0.0.1:9/")


@pytest.fixture(autouse=True)
def _home_stays_in_tmp(monkeypatch, tmp_path):
    """Point every name of the home folder at tmp_path, so no test reads or writes the
    real one: HOME on Linux and macOS, USERPROFILE, APPDATA and LOCALAPPDATA on
    Windows, the XDG folders, and git's own config."""
    home = tmp_path / "home"
    for name in _HOME_VARIABLES:
        monkeypatch.setenv(name, str(home))
    monkeypatch.setenv("APPDATA", str(home / "AppData" / "Roaming"))
    monkeypatch.setenv("LOCALAPPDATA", str(home / "AppData" / "Local"))
    for name in _XDG_VARIABLES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(home / ".gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
