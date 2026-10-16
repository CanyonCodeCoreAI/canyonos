# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import fcntl
import json
import math
import os
import re
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cli
import pytest

from canyonos import env
from canyonos.usage import delivery, outbox, settings

CONTRACT = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "cli-usage-api"
    / "src"
    / "usage.contract.ts"
)
MAX_REQUEST_BODY_BYTES = 16 * 1024


def contract_number(name):
    match = re.search(rf"{name} = ([\d *]+);", CONTRACT.read_text())
    assert match, f"{name} not found in {CONTRACT}"
    return math.prod(int(factor) for factor in match.group(1).split("*"))


class UsageApiStub:
    """A usage API on a loopback port that records each batch it is sent and answers
    with the next status in `statuses` (the last one repeats)."""

    def __init__(self):
        self.batches = []
        self.statuses = [200]
        self.delay = 0.0
        self.on_request = None
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                stub.batches.append(
                    {
                        "path": self.path,
                        "content_type": self.headers["Content-Type"],
                        "size": len(body),
                        "events": json.loads(body)["events"],
                    }
                )
                if stub.on_request is not None:
                    stub.on_request()
                time.sleep(stub.delay)
                status = stub.statuses[min(len(stub.batches), len(stub.statuses)) - 1]
                self.send_response(status)
                if status == 302:
                    self.send_header("Location", "/elsewhere")
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(
            target=self.server.serve_forever, args=(0.05,), daemon=True
        ).start()

    def sizes(self):
        return [len(batch["events"]) for batch in self.batches]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


@pytest.fixture
def reporting():
    return settings.set_usage_reporting(True)


@pytest.fixture
def api(monkeypatch):
    stub = UsageApiStub()
    monkeypatch.setattr(env, "usage_url", stub.url)
    yield stub
    stub.close()


def queue(count):
    for second in range(count):
        outbox.record_event("build", True)
        os.utime(outbox.pending_events()[-1], (second, second))
    return [json.loads(path.read_text()) for path in outbox.pending_events()]


def raise_(error):
    raise error


def test_the_batch_limits_match_the_usage_api_contract():
    assert delivery.MAX_EVENTS_PER_REQUEST == contract_number("MAX_EVENTS_PER_BATCH")
    assert MAX_REQUEST_BODY_BYTES == contract_number("MAX_REQUEST_BODY_BYTES")


@pytest.mark.parametrize(
    "value, expected",
    [
        ("https://usage.example.com", "https://usage.example.com"),
        ("https://usage.example.com/", "https://usage.example.com"),
        ("https://usage.example.com/v1/", "https://usage.example.com/v1"),
        ("  https://usage.example.com:8443  ", "https://usage.example.com:8443"),
        ("http://127.0.0.1:8787", "http://127.0.0.1:8787"),
        ("http://localhost:8787", "http://localhost:8787"),
        ("http://[::1]:8787", "http://[::1]:8787"),
        ("HTTP://LOCALHOST:8787", "HTTP://LOCALHOST:8787"),
    ],
)
def test_https_or_loopback_http_usage_urls_are_used(value, expected):
    assert env._resolve_usage_url(env.PRODUCTION, value) == expected


@pytest.mark.parametrize(
    "value",
    [
        "",
        "   ",
        "http://usage.example.com",
        "http://10.0.0.5:8787",
        "http://127.0.0.2:8787",
        "http://localhost.example.com",
        "ftp://usage.example.com",
        "file:///etc/passwd",
        "usage.example.com",
        "https://",
        "https://user:secret@usage.example.com",
        "https://usage.example.com/?token=x",
        "https://usage.example.com/#x",
        "https://usage.example.com/?",
        "https://usage.example.com#",
        "https://usage.example.com:99999",
        "https://[::1",
    ],
)
def test_any_other_usage_url_sends_nothing(value):
    assert env._resolve_usage_url(env.PRODUCTION, value) is None


class Spawned:
    def __init__(self, monkeypatch, popen=None):
        self.calls = []

        def record(command, **options):
            self.calls.append((command, options))

        monkeypatch.setattr(delivery.subprocess, "Popen", popen or record)


def test_starts_a_detached_sender_when_events_wait(monkeypatch, reporting, home):
    monkeypatch.setattr(env, "usage_url", "https://usage.example.com")
    outbox.record_event("deploy", True)
    spawned = Spawned(monkeypatch)

    delivery.start_delivery()

    [(command, options)] = spawned.calls
    assert command == delivery.delivery_command()
    assert options == {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "cwd": settings.usage_dir(),
        "start_new_session": True,
        "close_fds": True,
    }


def test_no_sender_without_a_usage_url(monkeypatch, reporting):
    outbox.record_event("deploy", True)
    spawned = Spawned(monkeypatch)

    delivery.start_delivery()

    assert spawned.calls == []


def test_no_sender_with_an_empty_outbox(monkeypatch, reporting):
    monkeypatch.setattr(env, "usage_url", "https://usage.example.com")
    spawned = Spawned(monkeypatch)

    delivery.start_delivery()

    assert spawned.calls == []


@pytest.mark.parametrize("choice", [None, False], ids=["never-asked", "declined"])
def test_no_sender_while_reporting_is_off(monkeypatch, choice):
    monkeypatch.setattr(env, "usage_url", "https://usage.example.com")
    if choice is not None:
        settings.set_usage_reporting(choice)
    settings.ensure_private_dir(settings.outbox_dir())
    (settings.outbox_dir() / "left-over.json").write_text("{}")
    spawned = Spawned(monkeypatch)

    delivery.start_delivery()

    assert spawned.calls == []


def test_a_sender_that_cannot_start_is_silent(monkeypatch, reporting, capsys):
    monkeypatch.setattr(env, "usage_url", "https://usage.example.com")
    outbox.record_event("deploy", True)
    Spawned(monkeypatch, popen=lambda *_a, **_k: raise_(OSError("no fork")))

    delivery.start_delivery()

    assert capsys.readouterr() == ("", "")


def test_unreadable_usage_state_is_silent(monkeypatch, capsys):
    monkeypatch.setattr(env, "usage_url", "https://usage.example.com")
    monkeypatch.setattr(delivery, "load_settings", lambda: raise_(ValueError("bug")))

    delivery.start_delivery()

    assert capsys.readouterr() == ("", "")


def test_python_installs_restart_the_interpreter_on_the_installed_cli():
    assert delivery.delivery_command() == [
        sys.executable,
        "-c",
        "import cli; cli.main()",
        delivery.DELIVERY_ARGUMENT,
    ]


def test_a_released_binary_restarts_itself_by_absolute_path(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setitem(delivery.__dict__, "__compiled__", object())
    monkeypatch.setattr(sys, "argv", ["bin/canyonos", "deploy"])

    assert delivery.delivery_command() == [
        str(tmp_path / "bin" / "canyonos"),
        delivery.DELIVERY_ARGUMENT,
    ]


def run_cli(monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["canyonos", *argv])
    cli.main()


@pytest.fixture
def started(monkeypatch):
    calls = []
    monkeypatch.setattr(cli, "start_delivery", lambda: calls.append(True))
    return calls


@pytest.mark.parametrize(
    "argv",
    [[], ["-h"], ["-v"], ["clean"], ["status"], ["no-such-command"], ["test", "--x"]],
    ids=["no-command", "help", "version", "command", "status", "unknown", "bad-flag"],
)
def test_every_invocation_ends_by_starting_delivery(monkeypatch, started, argv):
    monkeypatch.setattr(cli, "run_clean", lambda: None)
    monkeypatch.setattr(cli, "run_status", lambda: None)

    try:
        run_cli(monkeypatch, *argv)
    except SystemExit:
        pass

    assert started == [True]


def test_a_failing_command_still_starts_delivery_and_keeps_its_exit(
    monkeypatch, started
):
    monkeypatch.setattr(cli, "run_stop", lambda: raise_(RuntimeError("down")))

    with pytest.raises(SystemExit) as exited:
        run_cli(monkeypatch, "stop")

    assert exited.value.code == 1
    assert started == [True]


def test_the_hidden_argument_only_delivers(monkeypatch, started, capsys):
    delivered = []
    monkeypatch.setattr(cli, "deliver_pending_events", lambda: delivered.append(True))

    run_cli(monkeypatch, delivery.DELIVERY_ARGUMENT)

    assert delivered == [True]
    assert started == []
    assert capsys.readouterr() == ("", "")


def test_the_hidden_argument_is_not_on_any_help_screen(monkeypatch, started, capsys):
    for argv in (["-h"], ["test", "-h"]):
        with pytest.raises(SystemExit):
            run_cli(monkeypatch, *argv)

    assert delivery.DELIVERY_ARGUMENT not in "".join(capsys.readouterr())


def test_a_stored_batch_is_deleted(reporting, api):
    sent = queue(3)

    delivery.deliver_pending_events()

    [batch] = api.batches
    assert batch["path"] == "/usage/events"
    assert batch["content_type"] == "application/json"
    assert batch["events"] == sent
    assert outbox.pending_events() == []


@pytest.mark.parametrize("status", [302, 400, 404, 413, 422, 429, 500, 503])
def test_any_other_answer_keeps_every_event_and_stops(reporting, api, status):
    api.statuses = [status]
    queue(30)

    delivery.deliver_pending_events()

    assert api.sizes() == [25]
    assert len(outbox.pending_events()) == 30


def test_a_timeout_keeps_the_events(monkeypatch, reporting, api):
    monkeypatch.setattr(delivery, "REQUEST_TIMEOUT_SECONDS", 0.2)
    api.delay = 1
    queue(2)

    delivery.deliver_pending_events()

    assert len(outbox.pending_events()) == 2


def test_an_api_that_is_down_keeps_the_events(monkeypatch, reporting, api):
    monkeypatch.setattr(env, "usage_url", api.url)
    api.close()
    queue(2)

    delivery.deliver_pending_events()

    assert len(outbox.pending_events()) == 2


def test_events_go_oldest_first_in_batches_of_25(reporting, api):
    sent = queue(60)

    delivery.deliver_pending_events()

    assert api.sizes() == [25, 25, 10]
    assert [event for batch in api.batches for event in batch["events"]] == sent
    assert outbox.pending_events() == []


def test_a_failure_midway_keeps_only_what_was_not_stored(reporting, api):
    sent = queue(60)
    api.statuses = [200, 503]

    delivery.deliver_pending_events()

    assert api.sizes() == [25, 25]
    remaining = [json.loads(path.read_text()) for path in outbox.pending_events()]
    assert remaining == sent[25:]


def test_turning_reporting_off_midway_stops_sending(reporting, api):
    queue(60)

    def opt_out_without_purging():
        settings.write_private_json(
            settings.settings_path(),
            {"usage_reporting": False, "installation_id": None},
        )

    api.on_request = opt_out_without_purging

    delivery.deliver_pending_events()

    assert api.sizes() == [25]
    assert len(outbox.pending_events()) == 35


def test_nothing_is_sent_while_reporting_is_off(api):
    settings.set_usage_reporting(True)
    queue(2)
    settings.write_private_json(
        settings.settings_path(), {"usage_reporting": False, "installation_id": None}
    )

    delivery.deliver_pending_events()

    assert api.batches == []
    assert len(outbox.pending_events()) == 2


def test_nothing_is_sent_without_a_usage_url(reporting):
    queue(2)

    delivery.deliver_pending_events()

    assert len(outbox.pending_events()) == 2


def test_only_one_sender_runs_at_a_time(reporting, api):
    queue(2)
    with open(settings.usage_dir() / "delivery.lock", "w") as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)

        delivery.deliver_pending_events()

    assert api.batches == []
    assert len(outbox.pending_events()) == 2


def test_the_lock_is_released_for_the_next_sender(reporting, api):
    queue(1)
    api.statuses = [503, 200]

    delivery.deliver_pending_events()
    delivery.deliver_pending_events()

    assert api.sizes() == [1, 1]
    assert outbox.pending_events() == []


def malformed_events(valid):
    return {
        "not-json.json": "{",
        "not-utf8.json": b"\xff\xfe",
        "a-list.json": [valid],
        "missing-key.json": {k: v for k, v in valid.items() if k != "cli_version"},
        "extra-key.json": {**valid, "username": "ana"},
        "uppercase-id.json": {**valid, "event_id": valid["event_id"].upper()},
        "uuid1-id.json": {**valid, "event_id": "a8098c1a-f86e-11da-bd1a-00112444be1e"},
        "unreported-command.json": {**valid, "command": "status"},
        "string-succeeded.json": {**valid, "succeeded": "true"},
        "local-time.json": {**valid, "occurred_at": "2026-10-08T09:30:00+02:00"},
        "impossible-date.json": {**valid, "occurred_at": "2026-13-40T09:30:00Z"},
        "long-fraction.json": {
            **valid,
            "occurred_at": "2026-10-08T09:30:00.%sZ" % ("1" * 900),
        },
        "dev-version.json": {**valid, "cli_version": "0.2.0.dev1"},
        "numeric-version.json": {**valid, "cli_version": 1},
        "huge.json": {**valid, "cli_version": "1.0.0+" + "a" * 2000},
    }


def test_malformed_events_are_deleted_and_the_rest_sent(reporting, api):
    [valid] = queue(1)
    for name, contents in malformed_events(valid).items():
        path = settings.outbox_dir() / name
        if isinstance(contents, bytes):
            path.write_bytes(contents)
        elif isinstance(contents, str):
            path.write_text(contents)
        else:
            path.write_text(json.dumps(contents))

    delivery.deliver_pending_events()

    assert [batch["events"] for batch in api.batches] == [[valid]]
    assert outbox.pending_events() == []


def test_only_malformed_events_send_nothing(reporting, api):
    settings.ensure_private_dir(settings.outbox_dir())
    (settings.outbox_dir() / "broken.json").write_text("{")

    delivery.deliver_pending_events()

    assert api.batches == []
    assert outbox.pending_events() == []


def test_stale_temporary_files_are_removed(reporting, api):
    settings.ensure_private_dir(settings.outbox_dir())
    stale = settings.outbox_dir() / ".abc.json.1.tmp"
    fresh = settings.outbox_dir() / ".def.json.2.tmp"
    stale.write_text("{")
    fresh.write_text("{")
    an_hour_ago = time.time() - delivery.STALE_TEMPORARY_FILE_SECONDS - 1
    os.utime(stale, (an_hour_ago, an_hour_ago))

    delivery.deliver_pending_events()

    assert not stale.exists()
    assert fresh.exists()


def test_a_full_batch_of_the_largest_valid_events_fits_the_body_limit(reporting, api):
    [valid] = queue(1)
    largest = {
        **valid,
        "command": max(outbox.REPORTED_COMMANDS, key=len),
        "occurred_at": "2026-10-08T09:30:00.123456789Z",
        "cli_version": "1.0.0+" + "a" * (outbox.MAX_CLI_VERSION_LENGTH - 6),
    }
    assert delivery.is_valid_event(largest)

    assert delivery.send_events(api.url, [largest] * 25)
    assert api.batches[0]["size"] < MAX_REQUEST_BODY_BYTES


def wait_for(condition, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        time.sleep(0.1)
    return False


def test_the_cli_delivers_in_the_background_after_it_exits(
    monkeypatch, home, reporting, api
):
    queue(3)
    environment = {
        **os.environ,
        "HOME": str(home),
        env.USAGE_URL_VAR: api.url,
    }

    started = time.monotonic()
    result = subprocess.run(
        [sys.executable, "-c", "import cli; cli.main()", "status", "--help"],
        capture_output=True,
        text=True,
        timeout=60,
        env=environment,
    )
    elapsed = time.monotonic() - started

    assert result.returncode == 0, result.stderr
    assert delivery.DELIVERY_ARGUMENT not in result.stdout + result.stderr
    assert wait_for(lambda: outbox.pending_events() == [])
    assert api.sizes() == [3]
    assert elapsed < 30
