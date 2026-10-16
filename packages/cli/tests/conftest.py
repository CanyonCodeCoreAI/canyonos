# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import pytest

from canyonos import env, upgrade


@pytest.fixture(autouse=True)
def no_usage_api(monkeypatch):
    """Keep CLI tests from sending events to any selected usage API: runs in process or
    as a child would otherwise start delivery."""
    monkeypatch.setattr(env, "usage_url", None)
    monkeypatch.setenv(env.USAGE_URL_VAR, "")


@pytest.fixture(autouse=True)
def _version_check_stays_local(monkeypatch, tmp_path):
    """Every command run through `cli.main` checks the supported CLI versions first;
    keep that check off the network and out of the real `~/.canyonos`."""
    monkeypatch.setattr(upgrade, "CACHE_PATH", tmp_path / "supported-versions.json")
    # Port 9 (discard) refuses at once, so a stray check costs nothing.
    monkeypatch.setattr(upgrade, "POLICY_URL", "http://127.0.0.1:9/")


@pytest.fixture(autouse=True)
def _home_stays_in_tmp(monkeypatch, tmp_path):
    """Each project's records live under `~/.canyonos/projects`; point HOME at
    tmp_path so no test reads or writes the real ones."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
