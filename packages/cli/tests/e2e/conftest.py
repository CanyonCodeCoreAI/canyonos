"""Pytest fixtures for isolated, serial CLI end-to-end cases."""

from __future__ import annotations

import fcntl
import re
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest

from .harness import CliCase


@pytest.fixture(scope="session", autouse=True)
def serial_cli_e2e() -> Iterator[None]:
    """Reject a concurrent CLI E2E session before either can share runtime state."""
    lock_path = Path(tempfile.gettempdir()) / "canyonos-cli-e2e.lock"
    with lock_path.open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise pytest.UsageError(
                "CLI E2E tests support serial execution only"
            ) from error
        yield


@pytest.fixture(scope="session")
def artifact_run_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Keep this run's command output and logs under pytest's base temp directory,
    which pytest prunes to the last three runs."""
    return tmp_path_factory.mktemp("artifacts", numbered=False)


@pytest.fixture
def cli_case(
    request: pytest.FixtureRequest, tmp_path: Path, artifact_run_dir: Path
) -> CliCase:
    """Give one test exclusive directories, environment, processes, and artifacts."""
    name = re.sub(r"[^a-zA-Z0-9_.-]+", "-", request.node.name).strip("-")
    case = CliCase.create(tmp_path, artifact_run_dir / name)
    request.addfinalizer(case.close)
    return case
