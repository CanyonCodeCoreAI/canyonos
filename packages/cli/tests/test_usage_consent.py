# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import json
import os
import stat
import subprocess
import sys
import uuid

import pytest

from canyonos import contact
from canyonos import deploy as deploy_cmd
from canyonos.usage import consent, settings
from canyonos.usage.settings import UsageSettings


@pytest.fixture(autouse=True)
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


@pytest.fixture
def interactive(monkeypatch):
    monkeypatch.setattr(consent, "is_interactive", lambda: True)


def answer_with(monkeypatch, answer):
    asked = []

    def select_menu(options, title):
        asked.append(title)
        return answer

    monkeypatch.setattr(consent, "select_menu", select_menu)
    return asked


def saved():
    return json.loads(settings.settings_path().read_text())


def mode(path):
    return stat.S_IMODE(path.stat().st_mode)


def queue_event(name="event.json"):
    settings.ensure_private_dir(settings.outbox_dir())
    path = settings.outbox_dir() / name
    path.write_text("{}")
    return path


def test_reporting_is_off_until_asked():
    assert settings.load_settings() is None
    assert not settings.settings_path().exists()


@pytest.mark.parametrize(
    "contents",
    [
        "",
        "not json",
        "[]",
        '{"usage_reporting": "yes", "installation_id": null}',
        '{"usage_reporting": true, "installation_id": null}',
        '{"usage_reporting": true, "installation_id": "not-a-uuid"}',
        f'{{"usage_reporting": true, "installation_id": "{uuid.uuid1()}"}}',
        f'{{"usage_reporting": true, "installation_id": "{str(uuid.uuid4()).upper()}"}}',
        f'{{"usage_reporting": false, "installation_id": "{uuid.uuid4()}"}}',
    ],
)
def test_a_corrupt_settings_file_reads_as_never_asked(contents):
    settings.ensure_private_dir(settings.usage_dir())
    settings.settings_path().write_text(contents)

    assert settings.load_settings() is None


def test_an_unreadable_settings_file_reads_as_never_asked():
    settings.ensure_private_dir(settings.settings_path())

    assert settings.load_settings() is None


def test_declining_persists_off_with_no_id(monkeypatch, interactive):
    answer_with(monkeypatch, False)

    consent.offer_after_first_deploy()

    assert saved() == {"usage_reporting": False, "installation_id": None}
    assert settings.load_settings() == UsageSettings(False, None)


def test_dismissing_the_question_counts_as_declining(monkeypatch, interactive):
    answer_with(monkeypatch, None)

    consent.offer_after_first_deploy()

    assert saved() == {"usage_reporting": False, "installation_id": None}


def test_accepting_persists_a_stable_installation_id(monkeypatch, interactive):
    answer_with(monkeypatch, True)

    consent.offer_after_first_deploy()
    first = saved()

    assert first["usage_reporting"] is True
    assert uuid.UUID(first["installation_id"]).version == 4
    assert (
        settings.set_usage_reporting(True).installation_id == first["installation_id"]
    )
    assert saved() == first


def test_the_question_is_asked_only_once(monkeypatch, interactive):
    asked = answer_with(monkeypatch, False)

    consent.offer_after_first_deploy()
    consent.offer_after_first_deploy()

    assert len(asked) == 1


def test_a_corrupt_settings_file_is_asked_again(monkeypatch, interactive):
    settings.ensure_private_dir(settings.usage_dir())
    settings.settings_path().write_text("{")
    asked = answer_with(monkeypatch, False)

    consent.offer_after_first_deploy()

    assert len(asked) == 1
    assert saved() == {"usage_reporting": False, "installation_id": None}


def test_without_a_terminal_nothing_is_asked_or_written(monkeypatch):
    monkeypatch.setattr(consent.sys.stdin, "isatty", lambda: False)
    asked = answer_with(monkeypatch, True)

    consent.offer_after_first_deploy()

    assert asked == []
    assert not settings.usage_dir().exists()


def test_a_save_failure_warns_instead_of_failing_the_deploy(
    monkeypatch, interactive, capsys
):
    answer_with(monkeypatch, True)

    def unwritable(_enabled):
        raise PermissionError("denied")

    monkeypatch.setattr(consent, "set_usage_reporting", unwritable)

    consent.offer_after_first_deploy()

    assert "Could not save your usage reporting choice" in capsys.readouterr().out


def test_the_question_says_exactly_what_is_sent(monkeypatch, capsys):
    answer_with(monkeypatch, False)

    consent.ask_usage_reporting()

    output = " ".join(capsys.readouterr().out.split())
    for detail in (
        "command name",
        "succeeded",
        "when it ran",
        "CLI version",
        "random installation id",
        "canyonos contact",
    ):
        assert detail in output


def test_opting_out_purges_the_outbox_and_forgets_the_id():
    settings.set_usage_reporting(True)
    event = queue_event()

    assert settings.set_usage_reporting(False) == UsageSettings(False, None)

    assert saved() == {"usage_reporting": False, "installation_id": None}
    assert not event.exists()
    assert list(settings.outbox_dir().iterdir()) == []


def test_opting_back_in_starts_a_new_installation_id():
    first = settings.set_usage_reporting(True).installation_id
    settings.set_usage_reporting(False)

    second = settings.set_usage_reporting(True).installation_id

    assert second != first
    assert saved()["installation_id"] == second


@pytest.mark.posix_only("Windows has no permission bits")
def test_settings_are_private(home):
    (home / ".canyonos" / "usage").mkdir(parents=True, mode=0o755)

    settings.set_usage_reporting(True)

    assert mode(settings.usage_dir()) == 0o700
    assert mode(settings.settings_path()) == 0o600
    assert [p.name for p in settings.usage_dir().iterdir()] == ["settings.json"]


def test_a_failed_write_keeps_the_previous_file(monkeypatch):
    settings.set_usage_reporting(False)

    def broken_dump(*_a, **_k):
        raise OSError("disk full")

    with monkeypatch.context() as patch:
        patch.setattr(settings.json, "dump", broken_dump)
        with pytest.raises(OSError, match="disk full"):
            settings.set_usage_reporting(True)

    assert saved() == {"usage_reporting": False, "installation_id": None}
    assert [p.name for p in settings.usage_dir().iterdir()] == ["settings.json"]


def test_contact_usage_on_and_off(capsys):
    contact.run_contact(usage="on")
    installation_id = saved()["installation_id"]
    assert saved()["usage_reporting"] is True
    assert "Usage reporting is on" in capsys.readouterr().out

    event = queue_event()
    contact.run_contact(usage="off")
    assert saved() == {"usage_reporting": False, "installation_id": None}
    assert not event.exists()
    assert "Usage reporting is off" in capsys.readouterr().out

    contact.run_contact(usage="on")
    assert saved()["installation_id"] != installation_id


def test_contact_without_a_terminal_only_shows_the_state(monkeypatch, capsys):
    monkeypatch.setattr(contact, "is_interactive", lambda: False)
    asked = answer_with(monkeypatch, True)

    contact.run_contact()

    assert asked == []
    assert not settings.usage_dir().exists()
    output = capsys.readouterr().out
    assert "haven't been asked yet" in output
    assert "canyonos contact --usage on" in output


def test_contact_at_a_terminal_asks_and_saves(monkeypatch):
    monkeypatch.setattr(contact, "is_interactive", lambda: True)
    answer_with(monkeypatch, True)

    contact.run_contact()

    assert saved()["usage_reporting"] is True


def test_contact_dismissed_changes_nothing(monkeypatch):
    settings.set_usage_reporting(True)
    before = saved()
    monkeypatch.setattr(contact, "is_interactive", lambda: True)
    answer_with(monkeypatch, None)

    contact.run_contact()

    assert saved() == before


def test_contact_reports_a_save_failure_as_a_command_error(monkeypatch):
    def unwritable(_enabled):
        raise PermissionError("denied")

    monkeypatch.setattr(contact, "set_usage_reporting", unwritable)

    with pytest.raises(RuntimeError, match="Could not save usage settings"):
        contact.run_contact(usage="on")


@pytest.fixture
def deployable(monkeypatch, tmp_path):
    """A deploy whose every step succeeds and whose workflow comes up."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "global_controller.yaml").touch()
    monkeypatch.setattr(deploy_cmd, "run_init", lambda **_k: None)
    monkeypatch.setattr(deploy_cmd, "save_project_id", lambda _path: None)
    monkeypatch.setattr(deploy_cmd, "run_sync", lambda: True)
    monkeypatch.setattr(deploy_cmd, "configure_resources", lambda _path: True)
    monkeypatch.setattr(deploy_cmd, "load_state", lambda: {"port": 8000})
    monkeypatch.setattr(deploy_cmd, "endpoint_api_port", lambda _config: 8080)
    monkeypatch.setattr(deploy_cmd, "port_in_use", lambda _port: False)
    monkeypatch.setattr(deploy_cmd, "post_deploy", lambda *_a: None)
    monkeypatch.setattr(deploy_cmd, "quit_project", lambda _state: None)
    monkeypatch.setattr(
        deploy_cmd,
        "_stream_logs_and_autoserve",
        lambda *_a, on_ready, **_k: on_ready(True),
    )


def test_an_interactive_deploy_that_comes_up_asks(monkeypatch, deployable, interactive):
    asked = answer_with(monkeypatch, False)

    deploy_cmd.run_deploy(serve=False)

    assert len(asked) == 1


def test_a_non_interactive_deploy_never_asks(monkeypatch, deployable):
    monkeypatch.setattr(consent.sys.stdin, "isatty", lambda: False)
    asked = answer_with(monkeypatch, True)

    deploy_cmd.run_deploy(serve=False)

    assert asked == []
    assert not settings.usage_dir().exists()


def test_a_deploy_interrupted_before_it_came_up_does_not_ask(
    monkeypatch, deployable, interactive
):
    monkeypatch.setattr(
        deploy_cmd, "_stream_logs_and_autoserve", lambda *_a, **_k: None
    )
    asked = answer_with(monkeypatch, True)

    deploy_cmd.run_deploy(serve=False)

    assert asked == []


def test_a_quiet_deploy_does_not_ask(monkeypatch, deployable, interactive):
    asked = answer_with(monkeypatch, True)

    deploy_cmd.run_deploy(quiet=True)

    assert asked == []


def test_contact_is_wired_into_the_cli(home):
    result = subprocess.run(
        [sys.executable, "-c", "import cli; cli.main()", "contact", "--usage", "off"],
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, "HOME": str(home)},
    )

    assert result.returncode == 0, result.stderr
    assert saved() == {"usage_reporting": False, "installation_id": None}


def test_contact_rejects_an_unknown_usage_value(home):
    result = subprocess.run(
        [sys.executable, "-c", "import cli; cli.main()", "contact", "--usage", "maybe"],
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, "HOME": str(home)},
    )

    assert result.returncode == 2
    assert not settings.usage_dir().exists()


def test_contact_is_on_the_help_screen():
    from utils.help_screen import DESCRIPTIONS

    assert "contact" in DESCRIPTIONS
