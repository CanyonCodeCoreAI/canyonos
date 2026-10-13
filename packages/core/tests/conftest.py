"""Compile the controller protos before collection, and keep the developer's
shell from changing the Docker names the tests expect.

canyonos_core.controller bare-imports local_controler_pb2. The container
images put protoc's output on sys.path; a checkout has to generate it.
"""

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from canyonos_core.reconciler import providers

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
PROTO_DIR = PACKAGE_ROOT / "canyonos_core" / "controller" / "proto"
STUB_DIR = PACKAGE_ROOT / "build" / "pb"


def pytest_configure(config):
    shutil.rmtree(STUB_DIR, ignore_errors=True)
    STUB_DIR.mkdir(parents=True)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "grpc_tools.protoc",
            f"-I{PROTO_DIR}",
            f"--python_out={STUB_DIR}",
            f"--grpc_python_out={STUB_DIR}",
            *sorted(str(p) for p in PROTO_DIR.glob("*.proto")),
        ],
        check=True,
    )
    sys.path.insert(0, str(STUB_DIR))


@pytest.fixture(autouse=True)
def _unbind_providers():
    """Start and end every test with no controller bound to any provider, so a test
    only sees the controller it binds itself."""

    def unbind():
        providers.bind(None)
        for name in providers.NAMES:
            providers.get(name)

    unbind()
    yield
    unbind()


def _no_docker_project(monkeypatch):
    """Clear the project a developer shell may export, so every test starts from the
    plain `canyonos-...` names unless it sets a project itself."""
    monkeypatch.delenv("CANYONOS_DOCKER_PROJECT", raising=False)
