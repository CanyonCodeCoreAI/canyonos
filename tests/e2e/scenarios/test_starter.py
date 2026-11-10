# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The starter `canyonos new-app` writes deploys and answers as it is, with no LLM,
through `canyonos test`, with the binary files macOS hides in config/ next to it, and
a passing run leaves no container behind and the manifest as it was. Its agent
writes to and reads from a database agent, whose stock image never reports its own
health, with the dashboard running as a deploy starts it. A deploy that cannot come
up names the reason: an agent whose replica cannot launch, or a config file that is
not valid YAML, with its line."""

import pytest

from ..harness import canyonos, docker, project_containers, project_group, stop_project

TEST_TIMEOUT = 900
DASHBOARD_GROUP = "canyonos-dashboard"
PSYCOPG = "psycopg[binary]==3.3.6"
DATABASE_AGENT = """
  - name: StateDB
    type: database
    image: postgres:16-alpine
    env:
      POSTGRES_PASSWORD: password
"""
# Test-owned: the starter ships no code that reaches a database agent. It finds the
# database the way the docs say, in the routing table on the replica's Redis, and
# retries while Postgres finishes its first start, which nothing reports.
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
            decode_responses=True,
        )
        address = json.loads(routes.hget("routing_table:addresses", "StateDB"))[0]
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
    """A fresh `canyonos new-app` project; whatever it deploys is stopped afterwards."""
    directory = tmp_path / "starter"
    directory.mkdir()
    canyonos(recorder, ["new-app"], cwd=directory)
    yield directory
    stop_project(recorder, directory)


def _test(recorder, directory):
    return canyonos(
        recorder, ["test", "--json"], cwd=directory, timeout=TEST_TIMEOUT, check=False
    )


def _manifest(directory):
    return directory / "config" / "workflow_config.yaml"


def test_new_app_deploys_and_answers(recorder, starter):
    (starter / "config" / "._policy.yaml").write_bytes(b"\0\5\26\7\0\2\0\0")
    (starter / "config" / ".DS_Store").write_bytes(b"\0\0\0\1Bud1")
    before = _manifest(starter).read_text()
    call = _test(recorder, starter)
    assert call.code == 0, call.output
    assert call.json()["result"] == {"answer": "MyAgent got: hello"}, call.stdout
    after = _manifest(starter).read_text().splitlines()
    minted = [line for line in after if line.startswith("project_id: ")]
    assert len(minted) == 1, after
    assert [line for line in after if line not in minted] == before.splitlines()
    left = project_containers(recorder, project_group(recorder, starter), every=True)
    assert not left, left


def test_new_app_agent_uses_its_database_agent(recorder, request, starter):
    config = _manifest(starter)
    text = config.read_text()
    anchor = "\n# `POST /main`"
    entrypoint = "    entrypoint: agents/my_agent.py\n"
    assert anchor in text and entrypoint in text, text
    text = text.replace(entrypoint, f'{entrypoint}    requirements: ["{PSYCOPG}"]\n')
    config.write_text(text.replace(anchor, DATABASE_AGENT + anchor))
    (starter / "agents" / "my_agent.py").write_text(DATABASE_CLIENT)
    request.addfinalizer(
        lambda: docker(
            recorder,
            ["compose", "-p", DASHBOARD_GROUP, "down", "--remove-orphans"],
            check=False,
        )
    )
    canyonos(recorder, ["serve"], cwd=starter, timeout=600)
    call = _test(recorder, starter)
    assert call.code == 0, call.output
    assert call.json()["result"] == {"answer": "MyAgent stored: hello"}, call.stdout


def test_unlaunchable_replica_names_its_agent(recorder, starter):
    config = _manifest(starter)
    text = config.read_text()
    entrypoint = "    entrypoint: agents/my_agent.py\n"
    assert entrypoint in text, text
    config.write_text(
        text.replace(entrypoint, f"{entrypoint}    resources: {{cpu: 999}}\n")
    )
    call = _test(recorder, starter)
    assert call.code != 0, call.output
    root_cause = call.json()["root_cause"]
    assert root_cause.startswith("MyAgent could not start: "), call.stdout
    assert "CPUs" in root_cause, call.stdout


def test_invalid_yaml_names_the_file_and_line(recorder, starter):
    llms = starter / "config" / "llms.yaml"
    text = llms.read_text()
    assert text.endswith("\n"), text
    llms.write_text(text + "models:\n  bad: x: y\n")
    broken_line = len(text.splitlines()) + 2
    call = _test(recorder, starter)
    assert call.code != 0, call.output
    root_cause = call.json()["root_cause"]
    assert root_cause.startswith(
        f"config/llms.yaml:{broken_line}: is not valid YAML"
    ), call.stdout
