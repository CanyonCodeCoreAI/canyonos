"""The GC launches the machine metrics collector from CANYONOS_CONTROLLER_IMAGE.

It cannot read its own image from inside the container, so `canyonos deploy` has to
hand it down. Without this the collector fell back to a hardcoded published image and
ran whatever code that held, not the code the GC was built from.
"""

import subprocess

import pytest

from canyonos import init as init_cmd

CONTAINER_ID = "c" * 64


def completed(argv, returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(argv, returncode, stdout, stderr)


class FakeDocker:
    def __init__(self):
        self.calls = []

    def __call__(self, argv, **_):
        self.calls.append(argv)
        if argv[:2] == ["docker", "inspect"]:
            return completed(argv, returncode=1, stderr="No such object")
        if argv[:2] == ["docker", "run"]:
            return completed(argv, stdout=f"{CONTAINER_ID}\n")
        return completed(argv)

    @property
    def run_argv(self):
        return next(argv for argv in self.calls if argv[:2] == ["docker", "run"])


@pytest.fixture
def docker(monkeypatch):
    fake = FakeDocker()
    monkeypatch.setattr(init_cmd.subprocess, "run", fake)
    monkeypatch.setattr(init_cmd, "_port_reachable", lambda _port: True)
    return fake


def env_flags(argv):
    return dict(argv[i + 1].split("=", 1) for i, a in enumerate(argv) if a == "-e")


def test_the_controller_image_is_passed_to_the_gc_container(docker):
    init_cmd.run_container(image="canyonos-core:dev")

    assert (
        env_flags(docker.run_argv)["CANYONOS_CONTROLLER_IMAGE"] == "canyonos-core:dev"
    )


def test_it_matches_the_image_the_gc_itself_runs(docker):
    # The collector must not drift onto a different image than the GC.
    init_cmd.run_container(image="ghcr.io/example/canyonos-core:v9")

    argv = docker.run_argv
    assert argv[-1] == "ghcr.io/example/canyonos-core:v9"
    assert env_flags(argv)["CANYONOS_CONTROLLER_IMAGE"] == argv[-1]
