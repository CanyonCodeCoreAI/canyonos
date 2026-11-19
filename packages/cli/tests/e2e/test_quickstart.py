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
stored key, and a paused Redis is a quick 503 rather than a hang. What a deploy does
with the CanyonOS API, and what each command does when it is gone, is
`test_api_lifecycle.py`'s. Each case has its own HOME, so its `~/.canyonos/api_key`
touches nobody's.

Unlike the rest of this suite it owns the shared Docker names, ports and daemon,
so it tears the deploy down whether or not it passed.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import pexpect

from .harness import (
    DOCKER,
    CliCase,
    deploy_starter,
    docker,
    needs_a_runtime,
    needs_docker,
    runtime_environment,
    workflow_group_id,
)

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
        **runtime_environment(),
        "PATH": f"{bin_dir}{os.pathsep}{case.env['PATH']}",
    }

    endpoint, output = deploy_starter(case, folder, "--api-key", API_KEY, env=runtime)
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
    endpoint, _ = deploy_starter(case, folder, "--api-key", API_KEY)
    assert _post(endpoint, "CanyonOS", API_KEY)[0] == 202

    endpoint, output = deploy_starter(case, folder, "--api-key", NEXT_API_KEY)

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

    endpoint, output = deploy_starter(case, folder, "--no-api-key")
    assert "Removed this machine's API key." in output, output
    assert OPEN_WARNING in " ".join(output.split()), output
    answered = _answer(endpoint, "CanyonOS", None)
    assert answered.get("status") == "done", answered

    deploy_starter(case, folder, "--api-key", API_KEY)
    endpoint, output = deploy_starter(case, folder)
    assert OPEN_WARNING not in " ".join(output.split()), output
    _assert_refused(_post(endpoint, "CanyonOS", None), 401, "auth.missing_key")
    assert _post(endpoint, "CanyonOS", API_KEY)[0] == 202


@needs_a_runtime
def test_a_paused_redis_is_a_quick_503_not_a_hang(deployed_workflow):
    case, folder = deployed_workflow
    endpoint, _ = deploy_starter(case, folder, "--api-key", API_KEY)
    redis = docker(
        "ps",
        "--filter",
        f"name={workflow_group_id(folder)[:8]}-redis-localhost",
        "--format",
        "{{.Names}}",
    )
    assert redis, "no Redis container for the deploy"

    docker("pause", redis)
    try:
        started = time.monotonic()
        refused = _post(endpoint, "CanyonOS", API_KEY)
        took = time.monotonic() - started
    finally:
        docker("unpause", redis)

    _assert_refused(refused, 503, "auth.not_ready")
    assert took < NOT_READY_WITHIN, took
    assert _post(endpoint, "CanyonOS", API_KEY)[0] == 202


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
