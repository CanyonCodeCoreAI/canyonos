# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
End-to-end tests of CLI usage reporting: the installed `canyonos` command runs as a
real process with its home in a temporary folder, records events in its outbox, and
its background sender delivers them to the real usage API, read back from DynamoDB.
Run with `bun run cli:usage:test:cli-e2e`; it needs Docker and Bun.
"""

import fcntl
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from cli_usage_stack import free_port, wait_until

pytestmark = pytest.mark.skipif(
    os.environ.get("CANYONOS_CLI_USAGE_E2E") != "1",
    reason="needs Docker and Bun; run with `bun run cli:usage:test:cli-e2e`",
)

# A built binary can stand in for the checkout's CLI, such as the release build.
CANYONOS = Path(
    os.environ.get("CANYONOS_CLI_USAGE_E2E_BINARY")
    or Path(sys.executable).with_name("canyonos")
)
CONTRACT_KEYS = {
    "event_id",
    "installation_id",
    "command",
    "succeeded",
    "occurred_at",
    "cli_version",
}
STORED_KEYS = CONTRACT_KEYS | {"received_at"}
NOT_REPORTED = [
    ["-v"],
    ["-h"],
    ["contact"],
    ["status", "--help"],
    ["validate", "--help"],
    ["no-such-command"],
]


class Cli:
    """The `canyonos` command of this checkout, run with its own temporary home."""

    def __init__(self, home, usage_url):
        self.home = home
        self.usage_url = usage_url
        self.usage = home / ".canyonos" / "usage"
        self.outbox = self.usage / "outbox"
        self.lock = self.usage / "delivery.lock"

    def run(self, *argv, usage_url=None, cwd=None, extra_env=None):
        environment = {
            key: value
            for key, value in os.environ.items()
            if key != "CANYONOS_USAGE_URL"
        }
        environment.update({"HOME": str(self.home), **(extra_env or {})})
        url = self.usage_url if usage_url is None else usage_url
        environment["CANYONOS_USAGE_URL"] = url or ""
        return subprocess.run(
            [str(CANYONOS), *argv],
            cwd=cwd or self.home,
            env=environment,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=120,
        )

    def run_and_settle(self, *argv, **options):
        """Run the CLI and wait until the background sender it starts has finished."""
        self.lock.unlink(missing_ok=True)
        result = self.run(*argv, **options)
        assert wait_until(self._sender_finished), "the usage sender never finished"
        return result

    def _sender_finished(self):
        try:
            with open(self.lock, "rb") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return False
        return True

    def settings(self):
        return json.loads((self.usage / "settings.json").read_text())

    def pending(self):
        if not self.outbox.is_dir():
            return []
        return sorted(self.outbox.glob("*.json"))

    def pending_events(self):
        return [json.loads(path.read_text()) for path in self.pending()]


def new_app(cli, **options):
    """`canyonos new-app` in a fresh empty folder: a command that succeeds without
    Docker."""
    folder = cli.home / f"app-{len(list(cli.home.glob('app-*')))}"
    folder.mkdir()
    return cli.run("new-app", cwd=folder, **options)


def failing_validate(cli, **options):
    """`canyonos validate` on a folder that doesn't exist: a command that fails without
    Docker."""
    return cli.run("validate", str(cli.home / "missing.canyon"), **options)


def stored(stack, installation_id, count):
    """Wait until DynamoDB holds `count` events of this installation and return them."""

    def enough():
        items = stack.table.items_for(installation_id)
        return items if len(items) >= count else None

    items = wait_until(enough)
    assert items is not None, f"expected {count} stored events"
    return items


def plain(item):
    return {key: next(iter(value.values())) for key, value in item.items()}


@pytest.fixture
def cli(tmp_path, usage_stack):
    home = tmp_path / "home"
    home.mkdir()
    return Cli(home, usage_stack.url)


@pytest.fixture
def closed_url():
    return f"http://127.0.0.1:{free_port()}"


def opt_in(cli):
    result = cli.run("contact", "--usage", "on")
    assert result.returncode == 0, result.stderr
    return cli.settings()["installation_id"]


def test_reporting_is_off_until_chosen(cli):
    assert new_app(cli).returncode == 0
    assert failing_validate(cli).returncode != 0
    shown = cli.run("contact")

    assert shown.returncode == 0
    assert "Usage reporting is off" in shown.stdout
    assert not cli.usage.exists()


def test_declining_persists_and_records_nothing(cli):
    assert cli.run("contact", "--usage", "off").returncode == 0
    new_app(cli)
    failing_validate(cli)

    assert cli.settings() == {"usage_reporting": False, "installation_id": None}
    assert cli.pending() == []


def test_opting_in_keeps_one_installation_id(cli, usage_stack):
    installation_id = opt_in(cli)
    assert opt_in(cli) == installation_id

    new_app(cli)
    failing_validate(cli)

    items = [plain(item) for item in stored(usage_stack, installation_id, 2)]
    assert {item["installation_id"] for item in items} == {installation_id}
    assert cli.settings()["installation_id"] == installation_id


def test_changing_the_preference_purges_and_starts_a_new_id(
    cli, usage_stack, closed_url
):
    first_id = opt_in(cli)
    new_app(cli, usage_url=closed_url)
    assert len(cli.pending()) == 1

    assert cli.run("contact", "--usage", "off").returncode == 0
    assert cli.pending() == []
    assert cli.settings() == {"usage_reporting": False, "installation_id": None}

    second_id = opt_in(cli)
    new_app(cli)

    assert second_id != first_id
    assert len(stored(usage_stack, second_id, 1)) == 1
    assert usage_stack.table.items_for(first_id) == []


def test_only_commands_that_act_on_an_app_are_reported(cli, usage_stack):
    installation_id = opt_in(cli)
    for argv in NOT_REPORTED:
        cli.run(*argv)
    assert cli.pending() == []

    assert new_app(cli).returncode == 0
    assert failing_validate(cli).returncode != 0

    items = [plain(item) for item in stored(usage_stack, installation_id, 2)]
    outcomes = sorted((item["command"], item["succeeded"]) for item in items)
    assert outcomes == [("new-app", True), ("validate", False)]
    assert wait_until(lambda: cli.pending() == [])
    assert len(usage_stack.table.items_for(installation_id)) == 2


def test_an_unreachable_api_changes_nothing_and_keeps_the_events(
    cli, usage_stack, closed_url
):
    without_reporting = failing_validate(cli, usage_url="")
    installation_id = opt_in(cli)

    unreachable = cli.run_and_settle(
        "validate", str(cli.home / "missing.canyon"), usage_url=closed_url
    )

    assert (unreachable.returncode, unreachable.stdout, unreachable.stderr) == (
        without_reporting.returncode,
        without_reporting.stdout,
        without_reporting.stderr,
    )
    [queued] = cli.pending_events()
    assert queued["command"] == "validate"

    cli.run("-v")

    [item] = stored(usage_stack, installation_id, 1)
    assert plain(item)["event_id"] == queued["event_id"]
    assert wait_until(lambda: cli.pending() == [])


def test_events_wait_while_the_api_cannot_store_them(cli, usage_stack):
    installation_id = opt_in(cli)
    failing_validate(cli, usage_url="")
    new_app(cli, usage_url="")
    queued = {event["event_id"] for event in cli.pending_events()}

    usage_stack.stop_dynamo()
    try:
        result = cli.run_and_settle("-v")
        assert result.returncode == 0
        assert {event["event_id"] for event in cli.pending_events()} == queued
    finally:
        usage_stack.start_dynamo()

    cli.run("-h")

    items = stored(usage_stack, installation_id, 2)
    assert {plain(item)["event_id"] for item in items} == queued
    assert wait_until(lambda: cli.pending() == [])


def test_a_resent_event_is_stored_once(cli, usage_stack):
    installation_id = opt_in(cli)
    new_app(cli, usage_url="")
    [path] = cli.pending()
    contents = path.read_bytes()

    cli.run("-v")
    [first] = stored(usage_stack, installation_id, 1)
    assert wait_until(lambda: cli.pending() == [])

    path.write_bytes(contents)
    cli.run_and_settle("-v")

    assert cli.pending() == []
    assert usage_stack.table.items_for(installation_id) == [first]


def test_only_the_contract_fields_reach_the_table(cli, usage_stack):
    installation_id = opt_in(cli)
    secret_dir = cli.home / "acme-secret-project" / "sk-live-path-token"
    result = cli.run(
        "validate",
        str(secret_dir),
        "--config",
        "prompt-do-not-send.yaml",
        extra_env={"ACME_API_KEY": "sk-env-do-not-send"},
    )
    assert result.returncode != 0

    [item] = stored(usage_stack, installation_id, 1)
    assert set(item) == STORED_KEYS
    raw = json.dumps(item)
    for private in (
        "acme-secret-project",
        "sk-live-path-token",
        "prompt-do-not-send",
        "sk-env-do-not-send",
        str(cli.home),
        os.environ.get("USER") or "no-user",
        shutil.which("canyonos") or str(CANYONOS),
    ):
        assert private not in raw
