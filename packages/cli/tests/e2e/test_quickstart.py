# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The bundled Hello World, copied out of the package the way `canyonos quickstart`
does it and then deployed for real.

The unit tests check that `_fetch` writes the right filenames. They cannot catch a
bundling bug that keeps the files and breaks the workflow -- a truncated copy, a
skip rule that drops a config file, an entrypoint that no longer resolves once the
`.tmpl` suffix comes off. Only a deploy of what was written catches those, so this
case runs the stage a first-time user reaches with no key: copy, deploy, ask, read
the greeting back.

Unlike the rest of this suite it owns the shared Docker names, ports and daemon,
so it tears the deploy down whether or not it passed.
"""

from __future__ import annotations

import json
import os
import pwd
import re
import shutil
import subprocess
import time
import urllib.request
from collections.abc import Iterator, Mapping
from pathlib import Path

import pytest

from canyonos.quickstart import _fetch

from .harness import CliCase

# The workflow the quickstart offers first, and the only one that reaches a trace
# without an API key -- which is what makes it the one this suite can deploy.
STARTER = "helloworld"

# Building both agent images and waiting for three replicas, in seconds. Generous
# because it is a CI runner's cold Docker, not the 15s a warm machine takes.
DEPLOY_TIMEOUT = 600
CLEAN_TIMEOUT = 300
REQUEST_TIMEOUT = 120
POLL_INTERVAL = 2

# The endpoint address out of `canyonos deploy`'s own summary. The port is picked
# at deploy time, so it is read back rather than assumed.
ENDPOINT = re.compile(r"http://[\d.]+:\d+/main")


def _real_docker_config() -> tuple[str, str]:
    """`(DOCKER_HOST, DOCKER_CONFIG)` as the account outside these tests has them.

    The suite gives each case its own HOME, which on Docker Desktop hides both
    the daemon's socket and the `compose` plugin. On Linux both are the
    system's, so this changes nothing.
    """
    try:
        home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    except KeyError:
        return os.environ.get("DOCKER_HOST", ""), os.environ.get("DOCKER_CONFIG", "")

    config = os.environ.get("DOCKER_CONFIG") or str(home / ".docker")
    host = os.environ.get("DOCKER_HOST", "")
    if not host:
        try:
            found = subprocess.run(
                ["docker", "context", "inspect", "-f", "{{.Endpoints.docker.Host}}"],
                capture_output=True,
                text=True,
                timeout=30,
                env={**os.environ, "HOME": str(home), "DOCKER_CONFIG": config},
            )
            host = found.stdout.strip() if found.returncode == 0 else ""
        except (OSError, subprocess.SubprocessError):
            host = ""
    return host, config if Path(config).is_dir() else ""


def _docker_is_usable(docker: Mapping[str, str]) -> bool:
    """Whether this machine can run the deploy at all: a daemon to reach, and the
    `compose` plugin the dashboard's teardown needs."""
    if shutil.which("docker") is None:
        return False
    try:
        reached = subprocess.run(
            ["docker", "compose", "version"],
            capture_output=True,
            timeout=30,
            env={**os.environ, **docker},
        )
        if reached.returncode != 0:
            return False
        return (
            subprocess.run(
                ["docker", "info"],
                capture_output=True,
                timeout=30,
                env={**os.environ, **docker},
            ).returncode
            == 0
        )
    except (OSError, subprocess.SubprocessError):
        return False


# The core image the Global Controller runs from. Unset means there is nothing to
# deploy against: a released CLI would pull its own version's image from ghcr, which
# does not exist for an unreleased checkout.
#
# Set with `CANYONOS_ENV=development`, which the CLI requires before it accepts a
# core image override at all.
CORE_IMAGE = os.environ.get("CANYONOS_CORE_IMAGE", "").strip()
_HOST, _CONFIG = _real_docker_config()
DOCKER = {
    name: value
    for name, value in (("DOCKER_HOST", _HOST), ("DOCKER_CONFIG", _CONFIG))
    if value
}

needs_a_runtime = pytest.mark.skipif(
    not CORE_IMAGE or not _docker_is_usable(DOCKER),
    reason="needs Docker and CANYONOS_CORE_IMAGE pointing at a core image",
)


@pytest.fixture
def deployed_workflow(cli_case: CliCase) -> Iterator[tuple[CliCase, Path]]:
    """The bundled workflow on disk, torn down after the test either way.

    The teardown is checked rather than attempted: containers and images this
    case leaves behind carry the fixed Docker names, so they would reach every
    run after it.
    """
    folder = Path(_fetch(STARTER, into=cli_case.cwd))
    try:
        yield cli_case, folder
    finally:
        removed = cli_case.run_cli(
            ["clean", "--yes"],
            timeout=CLEAN_TIMEOUT,
            env=_runtime_environment(),
            cwd=folder,
        )
        assert removed.returncode == 0, removed.stdout + removed.stderr


def _runtime_environment() -> dict[str, str]:
    """What the CLI needs to reach a core image and the daemon. The case's
    environment blanks the CANYONOS_* variables, so the one that matters is put
    back here."""
    return {"CANYONOS_CORE_IMAGE": CORE_IMAGE, **DOCKER}


def _answer(endpoint: str, query: str) -> dict:
    """Send `query` through the deployed workflow and return what it answered."""
    submitted = urllib.request.Request(
        endpoint,
        data=json.dumps({"query": query}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(submitted, timeout=30) as reply:
        request_id = json.loads(reply.read())["request_id"]

    status = endpoint.rsplit("/", 1)[0] + f"/status/{request_id}"
    deadline = time.time() + REQUEST_TIMEOUT
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(status, timeout=30) as reply:
                data = json.loads(reply.read())
        except (OSError, ValueError):
            data = {}
        if data.get("status") in ("done", "error"):
            return data
        time.sleep(POLL_INTERVAL)
    return {"status": "timeout"}


@needs_a_runtime
def test_the_bundled_workflow_deploys_and_answers(deployed_workflow):
    """What a first run reaches: the copy out of the package deploys, and the
    endpoint it publishes answers with the agent's greeting."""
    case, folder = deployed_workflow

    # The dashboard is shared across every project on the machine, so this case
    # does not start one; `tests/e2e/multi_project.sh` is where it belongs.
    deployed = case.run_cli(
        ["deploy", "--serve", "false"],
        timeout=DEPLOY_TIMEOUT,
        env=_runtime_environment(),
        cwd=folder,
    )

    output = deployed.stdout + deployed.stderr
    assert deployed.returncode == 0, output

    endpoint = ENDPOINT.search(output)
    assert endpoint, f"the deploy published no endpoint: {output}"

    answered = _answer(endpoint.group(), "CanyonOS")
    assert answered.get("status") == "done", answered
    assert "greeting" in answered.get("result", {}), answered
