# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The starter `canyonos new-app` writes deploys from a deployment folder of its own
and answers as it is, with no LLM, through `canyonos test`, with the binary files
macOS hides in config/ next to it, and keeps the deployment's id out of the
project's manifest, in the deployment.yaml it writes beside the project. Its
agent writes to and reads from a database agent, whose stock image never reports
its own health, with the dashboard running as a deploy starts it. Deployed with
`--no-api-key` and no CANYONOS_API_KEY, it warns that it is open, publishes an
empty key hash, prints its curl without an Authorization header, answers without a
key, and `canyonos list` marks it `(unauthenticated)`. A deploy that cannot come up
names the reason: an agent whose replica cannot launch, a config
file that is not valid YAML, with its line, or a `.python-version` outside 3.10
to 3.15 or not saved as UTF-8."""

from pathlib import Path

import pytest

from ..conftest import DEPLOY_TIMEOUT
from ..harness import (
    bearer,
    canyonos,
    cli_value,
    deployed_endpoint,
    docker,
    http,
    project_dir,
    project_redis,
    stop_project,
)

TEST_TIMEOUT = 900
DASHBOARD_GROUP = "canyonos-dashboard"
API_KEY_HASH_KEY = "auth:api_key_hash"
BEARER = '-H "Authorization: Bearer <your api key>"'
OPEN_WARNING = (
    "No API key is set: the endpoint and the dashboard answer anyone who reaches "
    "them. Set one with --api-key <key>."
)
PSYCOPG = "psycopg[binary]==3.3.6"
DATABASE_AGENT = """
  - name: StateDB
    type: database
    image: postgres:16-alpine
    env:
      POSTGRES_PASSWORD: password
"""
# Test-owned: the starter ships no code that reaches a database agent. It finds the
# database the way the docs say, in the routing table on the replica's Redis, under
# its name in the deployment, `<project>.<agent>`, and retries while Postgres
# finishes its first start, which nothing reports.
DATABASE_CLIENT = """
import json
import os
import time

import psycopg
import redis


class MyAgent:
    def run(self, query: str) -> str:
        routes = redis.Redis(
            host=os.environ["CANYONOS_REDIS_HOST"],
            port=int(os.environ["CANYONOS_REDIS_PORT"]),
            password=os.environ.get("CANYONOS_REDIS_PASSWORD"),
            decode_responses=True,
        )
        address = json.loads(routes.hget("routing_table:addresses", "starter.StateDB"))[0]
        host, port = address.rsplit(":", 1)
        deadline = time.monotonic() + 60
        while True:
            try:
                with psycopg.connect(
                    host=host,
                    port=int(port),
                    user="postgres",
                    password="password",
                    connect_timeout=5,
                    autocommit=True,
                ) as db:
                    db.execute("create table if not exists notes (text text)")
                    db.execute("insert into notes values (%s)", (query,))
                    (stored,) = db.execute(
                        "select string_agg(text, ',') from notes"
                    ).fetchone()
                return f"MyAgent stored: {stored}"
            except psycopg.OperationalError:
                if time.monotonic() > deadline:
                    raise
                time.sleep(1)
"""


@pytest.fixture
def starter(recorder, images, tmp_path):
    """The deployment folder of a fresh `canyonos new-app` project, which is in it;
    whatever it deploys is stopped afterwards."""
    directory = tmp_path / "starter"
    project_dir(directory).mkdir(parents=True)
    canyonos(recorder, ["new-app"], cwd=project_dir(directory))
    yield directory
    stop_project(recorder, directory)


def _deploy(recorder, directory, check=True):
    return canyonos(
        recorder,
        ["deploy", str(project_dir(directory))],
        cwd=directory,
        timeout=DEPLOY_TIMEOUT,
        check=check,
    )


def _test(recorder, directory, keyed=True):
    return canyonos(
        recorder,
        ["test", "--json"],
        cwd=directory,
        timeout=TEST_TIMEOUT,
        check=False,
        keyed=keyed,
    )


def _manifest(directory):
    return project_dir(directory) / "config" / "workflow_config.yaml"


def test_new_app_deploys_and_answers(recorder, starter):
    config = project_dir(starter) / "config"
    (config / "._policy.yaml").write_bytes(b"\0\5\26\7\0\2\0\0")
    (config / ".DS_Store").write_bytes(b"\0\0\0\1Bud1")
    _deploy(recorder, starter)
    call = _test(recorder, starter)
    assert call.code == 0, call.output
    result = call.json()["results"][0]["result"]
    assert result == {"answer": "MyAgent got: hello"}, call.stdout
    manifest = _manifest(starter).read_text()
    assert "deployment_id" not in manifest and "project_id" not in manifest, manifest
    written = (starter / "deployment.yaml").read_text().splitlines()
    minted = [line for line in written if line.startswith("deployment_id: ")]
    assert len(minted) == 1, written


def test_a_deploy_without_an_api_key_answers_anyone(recorder, starter):
    """Run without CANYONOS_API_KEY, and `--no-api-key` removes any
    `~/.canyonos/api_key`, so the deploy has no key at all; `--serve false` keeps it
    off the shared dashboard, which needs the session's key."""
    call = canyonos(
        recorder,
        ["deploy", str(project_dir(starter)), "--no-api-key", "--serve", "false"],
        cwd=starter,
        timeout=DEPLOY_TIMEOUT,
        keyed=False,
    )
    assert OPEN_WARNING in " ".join(call.output.split()), call.output
    assert BEARER not in call.output, call.output
    assert not (Path.home() / ".canyonos" / "api_key").exists()
    assert project_redis(recorder, starter).get(API_KEY_HASH_KEY) == ""

    endpoint = deployed_endpoint(recorder, starter, keyed=False)
    url = f"{endpoint.url}/{endpoint.route}"
    for headers in ({}, bearer(recorder.api_key)):
        queued = http(
            recorder, "POST", url, json={endpoint.argument: "hello"}, headers=headers
        )
        assert queued.code == 202, queued.output
    tested = _test(recorder, starter, keyed=False)
    assert tested.code == 0, tested.output
    result = tested.json()["results"][0]["result"]
    assert result == {"answer": "MyAgent got: hello"}, tested.stdout

    name = cli_value(
        recorder,
        starter,
        "deployment_name()",
        "from canyonos.deployment import deployment_name",
    )
    listed = canyonos(recorder, ["list"], cwd=starter)
    line = next(line for line in listed.stdout.splitlines() if name in line)
    assert "(unauthenticated)" in line, listed.output


def test_new_app_agent_uses_its_database_agent(recorder, request, starter):
    config = _manifest(starter)
    text = config.read_text()
    anchor = "\n# `POST /"
    entrypoint = "    entrypoint: agents/my_agent.py\n"
    assert anchor in text and entrypoint in text, text
    text = text.replace(entrypoint, f'{entrypoint}    requirements: ["{PSYCOPG}"]\n')
    config.write_text(text.replace(anchor, DATABASE_AGENT + anchor))
    (project_dir(starter) / "agents" / "my_agent.py").write_text(DATABASE_CLIENT)
    request.addfinalizer(
        lambda: docker(
            recorder,
            ["compose", "-p", DASHBOARD_GROUP, "down", "--remove-orphans"],
            check=False,
        )
    )
    canyonos(recorder, ["serve"], cwd=starter, timeout=600)
    _deploy(recorder, starter)
    call = _test(recorder, starter)
    assert call.code == 0, call.output
    result = call.json()["results"][0]["result"]
    assert result == {"answer": "MyAgent stored: hello"}, call.stdout


def test_unlaunchable_replica_names_its_agent(recorder, starter):
    config = _manifest(starter)
    text = config.read_text()
    entrypoint = "    entrypoint: agents/my_agent.py\n"
    assert entrypoint in text, text
    config.write_text(
        text.replace(entrypoint, f"{entrypoint}    resources: {{cpu: 999}}\n")
    )
    call = _deploy(recorder, starter, check=False)
    assert call.code != 0, call.output
    assert "starter.MyAgent could not start: " in call.output, call.output
    assert "CPUs" in call.output, call.output


def test_invalid_yaml_names_the_file_and_line(recorder, starter):
    llms = project_dir(starter) / "config" / "llms.yaml"
    text = llms.read_text()
    assert text.endswith("\n"), text
    llms.write_text(text + "models:\n  bad: x: y\n")
    broken_line = len(text.splitlines()) + 2
    call = _deploy(recorder, starter, check=False)
    assert call.code != 0, call.output
    expected = f"config/llms.yaml:{broken_line}: is not valid YAML"
    assert expected in call.output, call.output


@pytest.mark.parametrize(
    ("version", "encoding"), [("3.9", "utf-8"), ("3.99", "utf-8-sig")]
)
def test_unsupported_python_version_names_the_file_and_value(
    recorder, starter, version, encoding
):
    """The 3.99 file starts with a UTF-8 BOM, which the message leaves out."""
    python_version = project_dir(starter) / ".python-version"
    python_version.write_text(f"{version}\n", encoding=encoding)
    call = _deploy(recorder, starter, check=False)
    assert call.code != 0, call.output
    expected = (
        f"✗ Root Cause: starter/.python-version says '{version}', but agents need "
        "Python 3.10 to 3.15, written like 3.12 or 3.12.4."
    )
    assert expected in call.output.splitlines(), call.output


def test_utf16_python_version_asks_for_utf8(recorder, starter):
    """What Windows PowerShell 5 writes for `echo 3.12 > .python-version`."""
    (project_dir(starter) / ".python-version").write_text("3.12\n", encoding="utf-16")
    call = _deploy(recorder, starter, check=False)
    assert call.code != 0, call.output
    expected = (
        "✗ Root Cause: starter/.python-version is not UTF-8 text; save it as UTF-8."
    )
    assert expected in call.output.splitlines(), call.output
