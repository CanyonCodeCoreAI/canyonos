# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Fixtures for scenarios, which stage and deploy their own projects, and the
`steps` marker for a module whose tests run in order on one shared fleet."""

import pytest

from ..harness import stage
from ..projects import load_project

FAILED_STEP_KEY = pytest.StashKey[str]()


def pytest_configure(config):
    """Register the `steps` marker."""
    config.addinivalue_line(
        "markers",
        "steps: the module's tests are steps on one fleet, so once one fails the "
        "later ones are skipped instead of failing on what it left behind",
    )


def pytest_runtest_makereport(item, call):
    """Remember the first step of a `steps` module that failed."""
    if call.when != "call" or call.excinfo is None:
        return
    if call.excinfo.errisinstance(pytest.skip.Exception):
        return
    if item.get_closest_marker("steps") is None:
        return
    item.parent.stash.setdefault(FAILED_STEP_KEY, item.name)


def pytest_runtest_setup(item):
    """Skip a step of a `steps` module once an earlier step failed, naming it."""
    if item.get_closest_marker("steps") is None:
        return
    failed = item.parent.stash.get(FAILED_STEP_KEY, None)
    if failed is not None:
        pytest.skip(f"{failed} failed, and this step starts from what it leaves")


@pytest.fixture
def staged(recorder, tmp_path):
    """Stage a project from tests/e2e/projects by name. No query is sent in a
    scenario, so the secrets a project declares get placeholder values."""

    def staged_project(name: str):
        project = load_project(name)
        secrets = {secret: f"not-a-real-{secret.lower()}" for secret in project.secrets}
        return stage(recorder, project, tmp_path, secrets)

    return staged_project
