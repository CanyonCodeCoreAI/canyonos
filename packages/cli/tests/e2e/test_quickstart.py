# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The bundled Hello World, copied out of the package the way `canyonos quickstart`
does it and then deployed for real, from its own workflow group folder as the
quickstart types it.

The unit tests check that `_fetch` writes the right filenames. They cannot catch a
bundling bug that keeps the files and breaks the workflow -- a truncated copy, a
skip rule that drops a config file, an entrypoint that no longer resolves once the
`.tmpl` suffix comes off. Only a deploy of what was written catches those, so this
case runs the stage a first-time user reaches with no key: copy, deploy, ask, read
the greeting back, ask again through `canyonos test`, and never launch a coding
agent.

The same deploy carries the endpoint's API key checks that need a real runtime: a
query without the key or with another is refused, a new key refuses the old one,
`--no-api-key` opens the deploy until a key is set again, a later deploy reuses the
stored key, and a paused Redis is a quick 503 rather than a hang. Each case has its
own HOME, so its `~/.canyonos/api_key` touches nobody's.

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
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator, Mapping
from pathlib import Path

import pexpect
import pytest
import yaml

from canyonos.quickstart import _fetch

from .harness import CliCase

# The workflow the quickstart offers first, and the only one that reaches a trace
# without a model provider's API key -- which is what makes it the one this suite
# can deploy.
STARTER = "helloworld"

# Building both agent images and waiting for three replicas, in seconds. Generous
# because it is a CI runner's cold Docker, not the 15s a warm machine takes.
DEPLOY_TIMEOUT = 600
CLEAN_TIMEOUT = 300
REQUEST_TIMEOUT = 120
POLL_INTERVAL = 2
# How long a request may take to be refused while Redis does not answer.
NOT_READY_WITHIN = 10
API_KEY = "quickstart-e2e-key-7f3a"
NEXT_API_KEY = "quickstart-e2e-key-9c1d"
OPEN_WARNING = (
    "No API key is set: the endpoint and the dashboard answer anyone who reaches "
    "them. Set one with --api-key <key>."
)

# The endpoint address out of `canyonos deploy`'s own summary. The port is picked
# at deploy time, so it is read back rather than assumed.
ENDPOINT = re.compile(r"http://[\d.]+:\d+/[0-9a-f-]{36}")


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
# The CanyonOS API image every deploy brings up with its database; unset, the CLI pulls
# its own version's image from ghcr, which does not exist for an unreleased checkout.
API_IMAGE = os.environ.get("CANYONOS_API_IMAGE", "").strip()
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
    """The bundled workflow group folder on disk, as the quickstart copies it,
    torn down after the test either way.

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
    """What the CLI needs to reach the core and API images and the daemon. The case's
    environment blanks the CANYONOS_* variables, so the ones that matter are put
    back here."""
    return {
        "CANYONOS_CORE_IMAGE": CORE_IMAGE,
        "CANYONOS_API_IMAGE": API_IMAGE,
        **DOCKER,
    }


def _bearer(api_key: str | None) -> dict[str, str]:
    return {} if api_key is None else {"Authorization": f"Bearer {api_key}"}


def _post(endpoint: str, query: str, api_key: str | None) -> tuple[int, dict]:
    """POST `query` to the endpoint, with `api_key` when there is one, and return the
    status and the JSON body it answered with, refusals included."""
    submitted = urllib.request.Request(
        endpoint,
        data=json.dumps({"query": query}).encode(),
        headers={"Content-Type": "application/json", **_bearer(api_key)},
    )
    try:
        with urllib.request.urlopen(submitted, timeout=30) as reply:
            return reply.status, json.loads(reply.read())
    except urllib.error.HTTPError as refused:
        return refused.code, json.loads(refused.read())


def _answer(endpoint: str, query: str, api_key: str | None) -> dict:
    """Send `query` through the deployed workflow with `api_key` and return what it
    answered."""
    code, body = _post(endpoint, query, api_key)
    assert code == 202, body
    request_id = body["request_id"]

    status = urllib.parse.urlsplit(endpoint)._replace(path=f"/status/{request_id}")
    status = urllib.request.Request(status.geturl(), headers=_bearer(api_key))
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


def _run(case: CliCase, args: list[str], **options) -> str:
    """Run `canyonos` with `args`, fail the case unless it exits 0, and return what
    it showed."""
    result = case.run_cli(args, **options)
    output = result.stdout + result.stderr
    assert result.returncode == 0, output
    return output


def _deploy(
    case: CliCase, folder: Path, *args: str, env: Mapping[str, str] | None = None
) -> tuple[str, str]:
    """Deploy the workflow from its workflow group folder `folder`, as the quickstart
    types it, naming its workflow, without the dashboard, which is shared across every
    workflow group on the machine (`tests/e2e/scenarios/test_shared_dashboard.py` is where
    it belongs), with `env` or the runtime's environment; return the endpoint it
    published and what it showed."""
    output = _run(
        case,
        ["deploy", STARTER, "--serve", "false", *args],
        timeout=DEPLOY_TIMEOUT,
        env=env or _runtime_environment(),
        cwd=folder,
    )
    endpoint = ENDPOINT.search(output)
    assert endpoint, f"the deploy published no endpoint: {output}"
    return endpoint.group(), output


def _deployment_id(folder: Path) -> str:
    """The `workflow_group_id` the deploy saved in the workflow group folder `folder`."""
    return yaml.safe_load((folder / "workflow_group.yaml").read_text())[
        "workflow_group_id"
    ]


def _store_api_key(case: CliCase, api_key: str) -> Path:
    """Write `api_key` where a deploy with `--api-key` keeps it, as one would have."""
    stored = case.home / ".canyonos" / "api_key"
    stored.parent.mkdir(parents=True, exist_ok=True)
    stored.write_text(f"{api_key}\n")
    stored.chmod(0o600)
    return stored


def _assert_refused(answer: tuple[int, dict], status: int, code: str) -> None:
    assert answer[0] == status, answer
    assert answer[1].get("error_name") == code, answer


@needs_a_runtime
def test_the_bundled_workflow_deploys_and_answers(deployed_workflow):
    """What a first run reaches: the copy out of the package deploys with an API key,
    the endpoint it publishes answers that key with the agent's greeting, and
    nothing without it or with another, `canyonos test` sends the stored key and
    answers with the greeting too, the key is never shown, and no coding agent is
    launched."""
    case, folder = deployed_workflow
    bin_dir = case.root / "bin"
    bin_dir.mkdir()
    launched = case.root / "agent-was-launched"
    for name in ("claude", "codex"):
        agent = bin_dir / name
        agent.write_text(f"#!/bin/sh\ntouch '{launched}'\n")
        agent.chmod(0o755)
    runtime = {
        **_runtime_environment(),
        "PATH": f"{bin_dir}{os.pathsep}{case.env['PATH']}",
    }

    endpoint, output = _deploy(case, folder, "--api-key", API_KEY, env=runtime)
    assert API_KEY not in output, output

    answered = _answer(endpoint, "CanyonOS", API_KEY)
    assert answered.get("status") == "done", answered
    assert "greeting" in answered.get("result", {}), answered
    _assert_refused(_post(endpoint, "CanyonOS", None), 401, "auth.missing_key")
    _assert_refused(_post(endpoint, "CanyonOS", NEXT_API_KEY), 401, "auth.invalid_key")

    test = case.run_cli(
        ["test", "--json"], timeout=REQUEST_TIMEOUT, env=runtime, cwd=folder
    )
    assert not launched.exists()
    assert test.returncode == 0, test.stdout + test.stderr
    assert "greeting" in json.loads(test.stdout)["results"][0]["result"]
    assert API_KEY not in test.stdout + test.stderr


@needs_a_runtime
def test_a_new_api_key_refuses_the_old_one(deployed_workflow):
    case, folder = deployed_workflow
    endpoint, _ = _deploy(case, folder, "--api-key", API_KEY)
    assert _post(endpoint, "CanyonOS", API_KEY)[0] == 202

    endpoint, output = _deploy(case, folder, "--api-key", NEXT_API_KEY)

    assert "other running workflow groups keep the old one" in " ".join(
        output.split()
    ), output
    _assert_refused(_post(endpoint, "CanyonOS", API_KEY), 401, "auth.invalid_key")
    answered = _answer(endpoint, "CanyonOS", NEXT_API_KEY)
    assert answered.get("status") == "done", answered


@needs_a_runtime
def test_no_api_key_opens_the_deploy_until_a_key_is_set_again(deployed_workflow):
    case, folder = deployed_workflow
    _store_api_key(case, API_KEY)

    endpoint, output = _deploy(case, folder, "--no-api-key")
    assert "Removed this machine's API key." in output, output
    assert OPEN_WARNING in " ".join(output.split()), output
    answered = _answer(endpoint, "CanyonOS", None)
    assert answered.get("status") == "done", answered

    _deploy(case, folder, "--api-key", API_KEY)
    endpoint, output = _deploy(case, folder)
    assert OPEN_WARNING not in " ".join(output.split()), output
    _assert_refused(_post(endpoint, "CanyonOS", None), 401, "auth.missing_key")
    assert _post(endpoint, "CanyonOS", API_KEY)[0] == 202


def _docker(*args: str) -> str:
    done = subprocess.run(
        ["docker", *args],
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, **DOCKER},
    )
    assert done.returncode == 0, done.stdout + done.stderr
    return done.stdout.strip()


@needs_a_runtime
def test_a_paused_redis_is_a_quick_503_not_a_hang(deployed_workflow):
    case, folder = deployed_workflow
    endpoint, _ = _deploy(case, folder, "--api-key", API_KEY)
    redis = _docker(
        "ps",
        "--filter",
        f"name={_deployment_id(folder)[:8]}-redis-localhost",
        "--format",
        "{{.Names}}",
    )
    assert redis, "no Redis container for the deploy"

    _docker("pause", redis)
    try:
        started = time.monotonic()
        refused = _post(endpoint, "CanyonOS", API_KEY)
        took = time.monotonic() - started
    finally:
        _docker("unpause", redis)

    _assert_refused(refused, 503, "auth.not_ready")
    assert took < NOT_READY_WITHIN, took
    assert _post(endpoint, "CanyonOS", API_KEY)[0] == 202


needs_docker = pytest.mark.skipif(
    not _docker_is_usable(DOCKER), reason="quickstart's first stage checks Docker"
)

# What stage 4 asks the user to type, by the phrase each command's prompt shows.
# Only the part before the 80-column terminal wraps the line.
DEPLOY_STEP = "deploy the workflow"
PROMPT = "canyonos-quickstart \\$"
STARTER_MENU = "Select a workflow to get started"
RESOURCES_MENU = "Set the upper limit on what its replicas can use"
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def _quickstart_until_the_deploy(case: CliCase) -> tuple[str, int | None]:
    """Run `canyonos quickstart` in a terminal, pressing enter at every prompt up to
    the deploy's, where it stops with ctrl-c so nothing is deployed. Returns what
    it showed, without colors, and its exit status."""
    case.env.update(DOCKER)
    terminal = case.spawn_cli(["quickstart"], timeout=120)
    child = terminal.child
    shown = []
    at_the_deploy = False
    while True:
        index = child.expect(
            [DEPLOY_STEP, PROMPT, STARTER_MENU, RESOURCES_MENU, pexpect.EOF]
        )
        shown.append(child.before + (child.after if index < 4 else ""))
        if index == 4:
            break
        if index == 0:
            at_the_deploy = True
        elif at_the_deploy and index == 1:
            child.send("\x03")
        else:
            child.send("\r")
    child.close()
    return " ".join(ANSI.sub("", "".join(shown)).split()), child.exitstatus


@needs_docker
def test_quickstart_makes_no_key_on_a_machine_with_none(cli_case: CliCase):
    shown, _status = _quickstart_until_the_deploy(cli_case)

    assert DEPLOY_STEP in shown, shown
    assert "canyonos keys" not in shown, shown
    assert not (cli_case.home / ".canyonos" / "api_key").exists()
    assert not (cli_case.home / ".canyonos" / "auth").exists()


@needs_docker
def test_quickstart_leaves_a_stored_key_as_it_is(cli_case: CliCase):
    stored = _store_api_key(cli_case, API_KEY)

    shown, _status = _quickstart_until_the_deploy(cli_case)

    assert DEPLOY_STEP in shown, shown
    assert API_KEY not in shown, shown
    assert stored.read_text() == f"{API_KEY}\n"
