# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import json
import os
import re
import stat
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import cli
import pytest

from canyonos.usage import outbox, settings

CONTRACT = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "cli-usage-api"
    / "src"
    / "usage.contract.ts"
)
EVENT_KEYS = {
    "event_id",
    "installation_id",
    "command",
    "succeeded",
    "occurred_at",
    "cli_version",
}
# Zod's default `z.string().datetime()`: UTC only, `Z` suffix, optional fraction.
ZOD_UTC_DATETIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
NOT_REPORTED = ["contact", "status", "logs", "config", "doctor"]


def contract_regex(name):
    match = re.search(rf"const {name} = /(.+)/;", CONTRACT.read_text())
    assert match, f"{name} not found in {CONTRACT}"
    return re.compile(match.group(1))


def contract_commands():
    block = re.search(
        r"REPORTED_COMMANDS = \[(.*?)\] as const", CONTRACT.read_text(), re.S
    )
    assert block, f"REPORTED_COMMANDS not found in {CONTRACT}"
    return set(re.findall(r"'([^']+)'", block.group(1)))


def contract_max_version_length():
    match = re.search(r"MAX_CLI_VERSION_LENGTH = (\d+);", CONTRACT.read_text())
    assert match
    return int(match.group(1))


def assert_accepted_by_the_usage_api(event):
    uuid_v4 = contract_regex("UUID_V4")
    assert set(event) == EVENT_KEYS
    assert uuid_v4.match(event["event_id"])
    assert uuid_v4.match(event["installation_id"])
    assert event["command"] in contract_commands()
    assert isinstance(event["succeeded"], bool)
    assert ZOD_UTC_DATETIME.match(event["occurred_at"])
    assert contract_regex("SEMVER_LIKE").match(event["cli_version"])
    assert len(event["cli_version"]) <= contract_max_version_length()


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


@pytest.fixture
def reporting():
    return settings.set_usage_reporting(True)


def events():
    return [json.loads(path.read_text()) for path in outbox.pending_events()]


def mode(path):
    return stat.S_IMODE(path.stat().st_mode)


def run_cli(monkeypatch, *argv):
    monkeypatch.setattr(sys, "argv", ["canyonos", *argv])
    cli.main()


def test_the_reported_commands_match_the_usage_api_contract():
    assert outbox.REPORTED_COMMANDS == contract_commands()


def test_the_version_rule_matches_the_usage_api_contract():
    assert outbox.SEMVER_LIKE.pattern == contract_regex("SEMVER_LIKE").pattern
    assert outbox.MAX_CLI_VERSION_LENGTH == contract_max_version_length()


def test_an_event_has_exactly_the_contract_fields(reporting):
    outbox.record_event("deploy", True)

    [event] = events()
    assert_accepted_by_the_usage_api(event)
    assert event["installation_id"] == reporting.installation_id
    assert event["command"] == "deploy"
    assert event["succeeded"] is True
    assert outbox.pending_events()[0].name == f"{event['event_id']}.json"


def test_occurred_at_is_utc_with_a_z_suffix():
    local = datetime(2026, 10, 8, 9, 30, 15, 123456).astimezone()

    event = outbox.build_event("convert", False, "id", local)

    expected = local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.123Z")
    assert event["occurred_at"] == expected


def test_each_event_gets_its_own_id(reporting):
    outbox.record_event("test", True)
    outbox.record_event("test", True)

    assert len({event["event_id"] for event in events()}) == 2


@pytest.mark.parametrize("command", sorted(outbox.REPORTED_COMMANDS))
def test_every_reported_command_records(reporting, command):
    with outbox.recording_usage(command):
        pass

    assert [event["command"] for event in events()] == [command]


@pytest.mark.parametrize("command", NOT_REPORTED)
def test_commands_that_only_show_or_set_local_state_record_nothing(reporting, command):
    with outbox.recording_usage(command):
        pass

    assert events() == []


def test_nothing_is_recorded_until_reporting_is_turned_on():
    with outbox.recording_usage("deploy"):
        pass

    assert not settings.usage_dir().exists()


def test_nothing_is_recorded_once_reporting_is_off():
    settings.set_usage_reporting(False)

    with outbox.recording_usage("deploy"):
        pass

    assert events() == []


@pytest.mark.parametrize("version", ["0.2.0.dev1", "development", "1.2", "1" * 65])
def test_a_version_the_usage_api_rejects_records_nothing(
    monkeypatch, reporting, version
):
    monkeypatch.setattr(outbox, "VERSION", version)

    outbox.record_event("deploy", True)

    assert events() == []


@pytest.mark.parametrize(
    "version", ["0.1.734", "1.2.3-rc.1", "1.2.3+build.5", "10.20.30-beta+exp.sha"]
)
def test_a_release_version_is_reportable(version):
    assert outbox.is_reportable_version(version)


RETURNS = object()


def raise_(error):
    raise error


@pytest.mark.parametrize(
    "command, expected_exit, succeeded",
    [
        (lambda: None, RETURNS, True),
        (lambda: sys.exit(), None, True),
        (lambda: sys.exit(0), 0, True),
        (lambda: sys.exit(1), 1, False),
        (lambda: sys.exit(2), 2, False),
        (lambda: sys.exit("broken"), "broken", False),
        (lambda: raise_(RuntimeError("no workflow")), 1, False),
    ],
    ids=[
        "returns",
        "exit-none",
        "exit-0",
        "exit-1",
        "exit-2",
        "exit-message",
        "runtime-error",
    ],
)
def test_success_follows_the_exit_status_and_the_exit_is_unchanged(
    monkeypatch, reporting, command, expected_exit, succeeded
):
    monkeypatch.setattr(cli, "run_clean", command)

    if expected_exit is RETURNS:
        run_cli(monkeypatch, "clean")
    else:
        with pytest.raises(SystemExit) as exited:
            run_cli(monkeypatch, "clean")
        assert exited.value.code == expected_exit

    [event] = events()
    assert event["command"] == "clean"
    assert event["succeeded"] is succeeded


@pytest.mark.parametrize("error", [ValueError("bug"), KeyboardInterrupt()])
def test_an_error_or_ctrl_c_is_a_failure_and_still_propagates(
    monkeypatch, reporting, error
):
    def command():
        raise error

    monkeypatch.setattr(cli, "run_stop", command)

    with pytest.raises(type(error)) as raised:
        run_cli(monkeypatch, "stop")

    assert raised.value is error
    [event] = events()
    assert event["succeeded"] is False


def test_a_runtime_error_still_shows_the_same_message(monkeypatch, reporting, capsys):
    monkeypatch.setattr(cli, "run_quit", lambda: raise_(RuntimeError("no workflow")))

    with pytest.raises(SystemExit):
        run_cli(monkeypatch, "quit")

    assert "no workflow" in capsys.readouterr().out


def test_a_recording_failure_is_silent(monkeypatch, reporting, capsys):
    def unwritable(*_a, **_k):
        raise PermissionError("denied")

    monkeypatch.setattr(outbox, "write_private_json", unwritable)
    monkeypatch.setattr(cli, "run_clean", lambda: None)

    run_cli(monkeypatch, "clean")

    assert capsys.readouterr() == ("", "")


def test_a_recording_failure_keeps_the_command_exit(monkeypatch, reporting, capsys):
    monkeypatch.setattr(outbox, "load_settings", lambda: raise_(OSError("denied")))
    monkeypatch.setattr(cli, "run_validate", lambda *_a, **_k: 3)

    with pytest.raises(SystemExit) as exited:
        run_cli(monkeypatch, "validate")

    assert exited.value.code == 3
    assert capsys.readouterr().err == ""


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores directory permissions")
def test_an_unwritable_usage_folder_is_silent(monkeypatch, reporting, capsys):
    settings.usage_dir().chmod(0o500)
    monkeypatch.setattr(cli, "run_stop", lambda: None)
    try:
        run_cli(monkeypatch, "stop")
    finally:
        settings.usage_dir().chmod(0o700)

    assert capsys.readouterr() == ("", "")
    assert not settings.outbox_dir().exists()


def test_a_full_outbox_drops_the_oldest_event(monkeypatch, reporting):
    monkeypatch.setattr(outbox, "MAX_PENDING_EVENTS", 3)
    for second in range(3):
        outbox.record_event("convert", True)
        os.utime(outbox.pending_events()[-1], (second, second))
    oldest, *kept = outbox.pending_events()

    outbox.record_event("deploy", True)

    pending = outbox.pending_events()
    assert len(pending) == 3
    assert oldest not in pending
    assert pending[:2] == kept
    assert json.loads(pending[-1].read_text())["command"] == "deploy"


def test_an_overfull_outbox_is_trimmed_to_the_bound(monkeypatch, reporting):
    settings.ensure_private_dir(settings.outbox_dir())
    for index in range(5):
        (settings.outbox_dir() / f"old-{index}.json").write_text("not json")
    monkeypatch.setattr(outbox, "MAX_PENDING_EVENTS", 3)

    outbox.record_event("deploy", True)

    assert len(outbox.pending_events()) == 3


def test_pending_events_lists_oldest_first_including_malformed_files():
    settings.ensure_private_dir(settings.outbox_dir())
    for age, name in enumerate(["c.json", "a.json", "b.json"]):
        path = settings.outbox_dir() / name
        path.write_text("{" if name == "a.json" else "{}")
        os.utime(path, (age, age))
    (settings.outbox_dir() / ".c.json.123.tmp").write_text("{}")

    assert [path.name for path in outbox.pending_events()] == [
        "c.json",
        "a.json",
        "b.json",
    ]


def test_pending_events_is_empty_without_an_outbox():
    assert outbox.pending_events() == []


def test_the_outbox_and_its_events_are_private(home, reporting):
    settings.outbox_dir().mkdir(mode=0o755)

    outbox.record_event("serve", True)

    assert mode(settings.outbox_dir()) == 0o700
    [path] = outbox.pending_events()
    assert mode(path) == 0o600
    assert [p.name for p in settings.outbox_dir().iterdir()] == [path.name]


def test_a_real_validate_run_records_only_the_contract_fields(home):
    settings.set_usage_reporting(True)
    secret = home / "secret-project" / "api-key-in-path"
    environment = {
        **os.environ,
        "HOME": str(home),
        "SECRET_TOKEN": "sk-do-not-send",
    }

    result = subprocess.run(
        [sys.executable, "-c", "import cli; cli.main()", "validate", str(secret)],
        capture_output=True,
        text=True,
        timeout=60,
        env=environment,
    )

    assert result.returncode != 0
    [path] = outbox.pending_events()
    raw = path.read_text()
    event = json.loads(raw)
    assert_accepted_by_the_usage_api(event)
    assert event["command"] == "validate"
    assert event["succeeded"] is False
    for private in ("secret-project", "api-key-in-path", str(home), "sk-do-not"):
        assert private not in raw
