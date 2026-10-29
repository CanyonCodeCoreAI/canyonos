# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos quickstart` is the guided first run. Most of its stages are run by
the user typing the command, so these cover that gate, the stages it guards,
and the wiring into the CLI."""

import json
import os
import re
import shlex
import stat
import subprocess
from pathlib import Path

import pytest

from canyonos import quickstart
from utils.help_screen import DESCRIPTIONS

# Captured before any test replaces it, so a test can put the real one back.
REAL_GET_STARTER = quickstart._get_starter

# A starter to stand in for whichever ones the list holds, so a rename there
# cannot break tests that are not about its name.
A_STARTER = sorted(quickstart.STARTERS)[0]


def types(monkeypatch, *answers):
    """Answer the typed-command prompt with `answers`, in order. Returns the
    list of prompts shown, so a test can check what was asked for."""
    asked = []
    replies = iter(answers)

    def ask(question, default="", **kwargs):
        asked.append(question)
        return next(replies, "")

    monkeypatch.setattr(quickstart.ui, "ask", ask)
    return asked


def shown(capsys):
    """Everything the run put on screen, both streams together.

    `ui` writes failures, warnings and hints to stderr and the rest to stdout,
    which is right for piping but not a distinction any of these tests are
    about -- they ask whether the user was told something at all.
    """
    return " ".join(capsys.readouterr())


def ready(monkeypatch):
    """Stand in for every stage except the one under test."""
    monkeypatch.setattr(quickstart, "select_menu", lambda *a, **k: A_STARTER)
    # The current directory, so the run's own `chdir` into it is a no-op and
    # nothing has to patch `os.chdir` -- patching that would reach far outside
    # this module.
    monkeypatch.setattr(quickstart, "_get_starter", lambda: (A_STARTER, os.getcwd()))
    monkeypatch.setattr(quickstart, "_convert_project", lambda folder: True)
    monkeypatch.setattr(quickstart, "_collect_keys", lambda folder, names: True)
    monkeypatch.setattr(quickstart, "_deploy", lambda: True)
    monkeypatch.setattr(quickstart, "_first_request", lambda: True)
    monkeypatch.setattr(quickstart, "_offer_clean", lambda: True)


def test_quickstart_has_a_help_screen_description():
    """`cli.add()` looks every command up in DESCRIPTIONS, so a missing entry
    takes down the whole CLI with a KeyError rather than just this command."""
    assert "quickstart" in DESCRIPTIONS


def watching(monkeypatch):
    """Someone at a terminal, with the between-stage pause stubbed out."""
    monkeypatch.setattr(quickstart.sys.stdin, "isatty", lambda: True)
    monkeypatch.setattr(quickstart.time, "sleep", lambda s: None)


@pytest.mark.parametrize("number", range(1, quickstart.TOTAL_STEPS + 1))
def test_the_heading_bar_fills_one_block_per_stage(monkeypatch, capsys, number):
    """It counts stages, not time -- which is why the slow ones say so in
    words rather than leaving the bar to imply it."""
    watching(monkeypatch)

    quickstart._step(number)

    heading = capsys.readouterr().out.splitlines()[1]
    assert heading.count(quickstart.BAR_DONE) == number
    assert heading.count(quickstart.BAR_TODO) == quickstart.TOTAL_STEPS - number
    assert quickstart.STAGES[number - 1] in heading


@pytest.mark.parametrize("number", sorted(quickstart.SLOW_STAGES))
def test_the_slow_stages_say_so(monkeypatch, capsys, number):
    """Without this the deploy is indistinguishable from a hang, which is
    exactly when a first-time user reaches for Ctrl-C.

    What it has to say is that the wait is expected, not any particular
    wording -- so this checks the stage's own note reaches the screen rather
    than pinning the words, which are copy and get edited."""
    watching(monkeypatch)

    quickstart._step(number)

    assert quickstart.SLOW_STAGES[number] in capsys.readouterr().out


def test_stages_pause_so_the_last_one_can_be_read(monkeypatch):
    """Several stages finish in milliseconds; eight headings in a row would read
    as a wall going past rather than as steps."""
    monkeypatch.setattr(quickstart.sys.stdin, "isatty", lambda: True)
    slept = []
    monkeypatch.setattr(quickstart.time, "sleep", lambda s: slept.append(s))

    quickstart._step(1)

    assert slept == [quickstart.STEP_PAUSE]


def test_nothing_pauses_where_nobody_is_watching(monkeypatch):
    """Without a terminal there is no one reading at human speed -- and a test
    suite would otherwise pay the pause once per stage per run."""
    monkeypatch.setattr(quickstart.sys.stdin, "isatty", lambda: False)
    monkeypatch.setattr(
        quickstart.time, "sleep", lambda s: pytest.fail("nobody is reading")
    )

    quickstart._step(1)


# --- the typed-command gate ------------------------------------------------


def test_typing_the_command_runs_it(monkeypatch):
    types(monkeypatch, "canyonos validate")
    ran = []

    assert (
        quickstart._typed("canyonos validate", lambda: ran.append(True) or 0, "what")
        == 0
    )
    assert ran == [True]


def test_nothing_runs_until_it_is_typed(monkeypatch):
    """The whole point of the gate: the stage does not happen by itself."""
    types(monkeypatch, "")

    assert (
        quickstart._typed("canyonos validate", lambda: pytest.fail("not typed"), "what")
        is None
    )


def test_a_different_command_is_refused_and_asked_again(monkeypatch):
    """Quietly accepting something near it would teach the wrong line."""
    asked = types(monkeypatch, "canyonos deploy", "canyonos validate")
    ran = []

    assert (
        quickstart._typed("canyonos validate", lambda: ran.append(True) or 0, "what")
        == 0
    )
    assert ran == [True]
    assert len(asked) == 2


def test_extra_spacing_is_still_the_same_command(monkeypatch):
    types(monkeypatch, "  canyonos    validate  ")
    ran = []

    assert (
        quickstart._typed("canyonos validate", lambda: ran.append(True) or 0, "what")
        == 0
    )
    assert ran == [True]


def test_no_terminal_cannot_answer_the_prompt(monkeypatch):
    """`ui.ask` returns its default without a terminal, so a piped run stops
    here rather than blocking on stdin or running something untyped."""
    monkeypatch.setattr(quickstart.ui, "ask", lambda q, default="", **k: default)

    assert (
        quickstart._typed("canyonos doctor", lambda: pytest.fail("not typed"), "what")
        is None
    )


# --- stage 1 ---------------------------------------------------------------


def test_a_machine_that_fails_its_checks_stops_the_run(monkeypatch):
    """`canyonos doctor`'s verdict is the verdict, with no exceptions carved
    out of it -- whatever it objects to is between the user and the next
    stage, and the screen already says which item it was."""
    ready(monkeypatch)
    types(monkeypatch, "canyonos doctor")
    monkeypatch.setattr(quickstart, "run_doctor", lambda: False)
    monkeypatch.setattr(
        quickstart, "_get_starter", lambda: pytest.fail("should not have gone on")
    )

    assert quickstart.run_quickstart() is False


def test_a_passing_machine_goes_on_to_pick_a_workflow(monkeypatch):
    ready(monkeypatch)
    types(monkeypatch, "canyonos doctor")
    monkeypatch.setattr(quickstart, "run_doctor", lambda: True)
    picked = []
    monkeypatch.setattr(
        quickstart,
        "_get_starter",
        lambda: picked.append(True) or (A_STARTER, os.getcwd()),
    )

    assert quickstart.run_quickstart() is True
    assert picked == [True]


# --- stage 2: picking a workflow -------------------------------------------


def unanswered(monkeypatch):
    """Let the real `_get_starter` run against a menu nobody answered."""
    ready(monkeypatch)
    types(monkeypatch, "canyonos doctor")
    monkeypatch.setattr(quickstart, "run_doctor", lambda: True)
    monkeypatch.setattr(quickstart, "_get_starter", REAL_GET_STARTER)
    monkeypatch.setattr(quickstart, "_choose_starter", lambda: None)


def test_quickstart_stops_when_no_workflow_is_chosen(monkeypatch):
    unanswered(monkeypatch)

    assert quickstart.run_quickstart() is False


def test_pressing_escape_is_reported_as_a_cancellation(monkeypatch, capsys):
    unanswered(monkeypatch)
    monkeypatch.setattr(quickstart.sys.stdin, "isatty", lambda: True)

    quickstart.run_quickstart()

    assert "Cancelled." in capsys.readouterr().out


def test_having_no_terminal_is_not_reported_as_a_cancellation(monkeypatch, capsys):
    """Esc is a choice someone made; a pipe with no terminal is not, and the
    way out of each is different."""
    unanswered(monkeypatch)
    monkeypatch.setattr(quickstart.sys.stdin, "isatty", lambda: False)

    quickstart.run_quickstart()

    assert "needs a terminal" in shown(capsys)


# --- stage 3: putting the workflow on disk ----------------------------------


@pytest.fixture
def cloned():
    """A starter to exercise the clone path with."""
    return A_STARTER


@pytest.mark.parametrize("name", sorted(quickstart.STARTERS))
def test_every_starter_is_described_in_the_menu(name):
    """Both halves are shown on the picker's one line per workflow."""
    starter = quickstart.STARTERS[name]

    assert starter["label"] and starter["summary"]


@pytest.mark.parametrize("name", sorted(quickstart.STARTERS))
def test_every_starter_is_pinned_to_a_commit(name):
    """A branch moves under the CLI; a commit does not. A starter that drifts is
    a first run that breaks for reasons the user cannot see."""
    ref = quickstart.STARTERS[name]["ref"]

    assert re.fullmatch(r"[0-9a-f]{40}", ref), f"{name} is not pinned to a full SHA"


@pytest.mark.parametrize("name", sorted(quickstart.STARTERS))
def test_every_starter_declares_where_to_clone_it_from(name):
    """A typo in any of these is a menu entry that only breaks when someone
    picks it, several steps into the run."""
    starter = quickstart.STARTERS[name]

    assert starter["repo"].count("/") == 1, "repo is owner/name"
    assert starter["path"] and not starter["path"].startswith("/")
    assert starter["secrets"] == sorted(set(starter["secrets"])), "no duplicate keys"


def test_the_clone_url_is_built_from_the_repo(cloned):
    assert (
        quickstart._clone_url(quickstart.STARTERS[cloned])
        == "https://github.com/CanyonCodeCoreAI/workflows.git"
    )


def test_only_the_one_workflow_is_checked_out(tmp_path, monkeypatch, cloned):
    """These sit beside each other in one repository; pulling all of them to use
    one makes a slow first impression."""
    calls = []

    def fake_git(args, cwd=None):
        calls.append(args)
        if args[0] == "checkout":
            (Path(cwd) / quickstart.STARTERS[cloned]["path"]).mkdir(parents=True)

    monkeypatch.setattr(quickstart, "_git", fake_git)

    quickstart._fetch(cloned, into=tmp_path)

    starter = quickstart.STARTERS[cloned]
    assert ["sparse-checkout", "set", starter["path"]] in calls
    assert calls[-1] == ["checkout", starter["ref"]]


def test_a_path_the_commit_does_not_have_is_named(tmp_path, monkeypatch, cloned):
    """A sparse checkout of a missing path succeeds and leaves nothing behind,
    so a drifted workflow list would otherwise surface as a FileNotFoundError
    naming a temporary directory."""
    # Checks out nothing, the way git does for a path not in the commit.
    monkeypatch.setattr(quickstart, "_git", lambda args, cwd=None: None)

    with pytest.raises(RuntimeError, match="has no .* at"):
        quickstart._fetch(cloned, into=tmp_path)

    assert not (tmp_path / cloned).exists()


def test_a_folder_already_holding_the_workflow_is_reused(tmp_path, monkeypatch, cloned):
    """A second run after a failure should not re-clone it, nor overwrite
    whatever was edited in between -- a filled-in .env, most of all."""
    existing = tmp_path / cloned / "config"
    existing.mkdir(parents=True)
    (existing / "global_controller.yaml").write_text("agents: []\n")
    monkeypatch.setattr(
        quickstart, "_git", lambda *a, **k: pytest.fail("should not have cloned")
    )

    assert quickstart._fetch(cloned, into=tmp_path) == str(tmp_path / cloned)


def test_a_folder_holding_something_else_is_left_alone(tmp_path, cloned):
    """Clobbering an unrelated folder that happens to share the name would be a
    bad way to meet a new user."""
    (tmp_path / cloned).mkdir()
    (tmp_path / cloned / "notes.txt").write_text("mine")

    with pytest.raises(RuntimeError, match="not a CanyonOS project"):
        quickstart._fetch(cloned, into=tmp_path)

    assert (tmp_path / cloned / "notes.txt").read_text() == "mine"


@pytest.mark.parametrize("layout", [("config",), (".canyon", "config")])
def test_a_workflow_is_recognised_in_either_layout(tmp_path, layout):
    """A ported project keeps its manifest under `.canyon/`; one already in
    CanyonOS format keeps `config/` at its root. Stage 4 decides whether to
    port on this answer."""
    folder = tmp_path.joinpath(*layout)
    folder.mkdir(parents=True)
    (folder / "global_controller.yaml").write_text("agents: []\n")

    assert quickstart._is_project(str(tmp_path))


# --- stage 4: the build -----------------------------------------------------


def already_ported(tmp_path):
    (tmp_path / ".canyon" / "config").mkdir(parents=True)
    (tmp_path / ".canyon" / "config" / "global_controller.yaml").write_text(
        "agents: []\n"
    )
    return str(tmp_path)


def test_an_already_ported_project_still_asks_for_the_command(monkeypatch, tmp_path):
    """The stage is typed like every other one. That it turns out to have
    nothing to do is the outcome of asking, not a reason to skip asking."""
    asked = types(monkeypatch, "canyonos convert")
    monkeypatch.setattr(
        quickstart, "run_convert", lambda *a, **k: pytest.fail("nothing to port")
    )

    assert quickstart._convert_project(already_ported(tmp_path)) is True
    assert len(asked) == 1


def test_an_already_ported_project_is_not_ported_again(monkeypatch, tmp_path):
    """`canyonos convert` itself would hand it to a coding assistant again, which
    is minutes of work to arrive back where it started."""
    types(monkeypatch, "canyonos convert")
    monkeypatch.setattr(
        quickstart, "run_convert", lambda *a, **k: pytest.fail("nothing to port")
    )

    quickstart._convert_project(already_ported(tmp_path))


def test_the_build_stage_still_stops_if_nothing_is_typed(monkeypatch, tmp_path):
    types(monkeypatch, "")

    assert quickstart._convert_project(already_ported(tmp_path)) is False


def test_a_project_not_in_canyonos_format_is_built(monkeypatch, tmp_path):
    types(monkeypatch, "canyonos convert")
    built = []
    monkeypatch.setattr(
        quickstart, "run_convert", lambda *a, **k: built.append(True) or True
    )

    assert quickstart._convert_project(str(tmp_path)) is True
    assert built == [True]


def test_a_failed_build_stops_the_run(monkeypatch, tmp_path):
    types(monkeypatch, "canyonos convert")
    monkeypatch.setattr(quickstart, "run_convert", lambda *a, **k: False)

    assert quickstart._convert_project(str(tmp_path)) is False


def test_a_failed_deploy_is_reported(monkeypatch, tmp_path):
    staged(monkeypatch, tmp_path, deployed=False)

    assert quickstart._deploy() is False


def test_a_half_up_deploy_is_named_rather_than_handed_over(monkeypatch, tmp_path):
    """A stack missing a piece would turn the user's own first curl into a
    long wait and a timeout, so the checklist names the piece and the run does
    not hand out commands that cannot work."""
    staged(monkeypatch, tmp_path, healthy=False)
    monkeypatch.setattr(
        quickstart,
        "_show_dashboard",
        lambda: pytest.fail("should not hand over a broken deploy"),
    )

    assert quickstart._deploy() is False


def test_the_health_check_is_typed_like_every_other_stage(monkeypatch, tmp_path):
    """`canyonos doctor` a second time, and a different checklist the second
    time -- that it is the same command doing both is worth seeing."""
    staged(monkeypatch, tmp_path)
    asked = types(monkeypatch, "canyonos deploy --now", "canyonos deploy", "")

    assert quickstart._deploy() is False
    assert len(asked) == 3


# --- stage 5: the project's .env --------------------------------------------
#
# API keys reach the agents only through that file, so what goes into it, and
# what survives being rewritten, is the whole contract.

# The shape a starter actually ships: the key it needs is commented out, with
# settings a previous run wrote underneath.
SHIPPED = """\
# Uncomment and fill in the keys you use.

# Required for the default provider
# OPENAI_API_KEY=

#ANTHROPIC_API_KEY=
CANYONOS_REDIS_PORT=6379
TRADINGAGENTS_MAX_DEBATE_ROUNDS=1
"""


def env_project(tmp_path, text=SHIPPED):
    (tmp_path / ".env").write_text(text)
    return str(tmp_path)


def test_a_commented_key_does_not_count_as_set(tmp_path):
    """That is how every starter ships the key it needs."""
    assert quickstart._missing_keys(env_project(tmp_path), ["OPENAI_API_KEY"]) == [
        "OPENAI_API_KEY"
    ]


def test_an_empty_value_counts_as_missing(tmp_path):
    """The starters say why in their own `.env`: an empty `KEY=` reaches the
    provider as an empty key and comes back a 401, not a config error."""
    folder = env_project(tmp_path, "OPENAI_API_KEY=\n")

    assert quickstart._missing_keys(folder, ["OPENAI_API_KEY"]) == ["OPENAI_API_KEY"]


def test_a_real_value_counts_as_set(tmp_path):
    folder = env_project(tmp_path, "OPENAI_API_KEY=sk-real\n")

    assert quickstart._missing_keys(folder, ["OPENAI_API_KEY"]) == []


def test_a_project_with_no_env_needs_everything(tmp_path):
    assert quickstart._missing_keys(str(tmp_path), ["OPENAI_API_KEY"]) == [
        "OPENAI_API_KEY"
    ]


def test_writing_a_key_keeps_every_other_line(tmp_path):
    """Those lines are the project's own settings and a previous `canyonos
    serve`'s; losing them breaks the deploy in a way nobody would connect to
    having typed in a key."""
    folder = env_project(tmp_path)

    quickstart._write_keys(folder, {"OPENAI_API_KEY": "sk-real"})

    written = (tmp_path / ".env").read_text()
    assert "CANYONOS_REDIS_PORT=6379" in written
    assert "TRADINGAGENTS_MAX_DEBATE_ROUNDS=1" in written
    assert "#ANTHROPIC_API_KEY=" in written


def test_writing_a_key_drops_the_commented_one_it_replaces(tmp_path):
    """Leaving both in would make the result depend on which assignment the
    reader takes -- not a coin toss worth having on the key that decides
    whether the first run works."""
    folder = env_project(tmp_path)

    quickstart._write_keys(folder, {"OPENAI_API_KEY": "sk-real"})

    lines = (tmp_path / ".env").read_text().splitlines()
    assert [line for line in lines if "OPENAI_API_KEY" in line] == [
        "OPENAI_API_KEY=sk-real"
    ]


@pytest.mark.posix_only("Windows has no permission bits")
def test_the_env_is_written_private(tmp_path):
    """It is the file the user just typed their API keys into."""
    folder = env_project(tmp_path)

    path = quickstart._write_keys(folder, {"OPENAI_API_KEY": "sk-real"})

    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600


def test_a_project_with_no_env_gets_one(tmp_path):
    quickstart._write_keys(str(tmp_path), {"OPENAI_API_KEY": "sk-real"})

    assert "OPENAI_API_KEY=sk-real" in (tmp_path / ".env").read_text()


# --- stages 6 and 7: deploy, then health ------------------------------------


def staged(monkeypatch, tmp_path, *, deployed=True, healthy=True):
    """A directory to run in, with deploy and doctor answering as given.
    Returns the list deploy calls are recorded in."""
    monkeypatch.chdir(tmp_path)
    types(monkeypatch, "canyonos deploy", "canyonos doctor")
    deploys = []
    monkeypatch.setattr(
        quickstart,
        "run_deploy",
        lambda **k: deploys.append(k) or ({"port": 8000} if deployed else None),
    )
    monkeypatch.setattr(quickstart, "run_doctor", lambda: healthy)
    return deploys


def test_the_workflow_is_deployed(monkeypatch, tmp_path):
    deploys = staged(monkeypatch, tmp_path)

    assert quickstart._deploy() is True
    assert deploys == [{"banner": False}]


def test_the_project_folder_becomes_the_working_directory(monkeypatch, tmp_path):
    """`build`, `deploy` and the first request all read the project out of the
    current directory, and the deploy names its containers after it. So the run
    changes into it once, before any of them."""
    project = tmp_path / A_STARTER
    project.mkdir()
    monkeypatch.chdir(tmp_path)
    ready(monkeypatch)
    types(monkeypatch, "canyonos doctor")
    monkeypatch.setattr(quickstart, "run_doctor", lambda: True)
    monkeypatch.setattr(quickstart, "_get_starter", lambda: (A_STARTER, str(project)))
    seen = []
    monkeypatch.setattr(
        quickstart, "_convert_project", lambda folder: seen.append(os.getcwd()) or True
    )

    assert quickstart.run_quickstart() is True
    assert os.path.realpath(seen[0]) == os.path.realpath(project)


# --- the dashboard handover -------------------------------------------------


def test_the_dashboard_address_is_printed(monkeypatch, capsys):
    """Printed, not opened: every other command in this CLI leaves opening a
    URL to the user, and on a server there is no browser to open anyway."""
    monkeypatch.setattr(quickstart, "_existing_dashboard_port", lambda: 8081)

    quickstart._show_dashboard()

    assert "8081" in capsys.readouterr().out


def test_a_dashboard_that_is_not_running_is_said_so(monkeypatch, capsys):
    monkeypatch.setattr(quickstart, "_existing_dashboard_port", lambda: None)

    quickstart._show_dashboard()

    assert "canyonos serve" in shown(capsys)


# --- stopping part-way ------------------------------------------------------


def interrupted(monkeypatch, *, deployed):
    """Stop the run at its first stage, with or without a deploy behind it."""
    ready(monkeypatch)
    monkeypatch.setattr(
        quickstart, "_step", lambda *a, **k: (_ for _ in ()).throw(KeyboardInterrupt())
    )
    monkeypatch.setattr(quickstart, "_deploy_is_up", lambda: deployed)


def test_ctrl_c_stops_without_a_traceback(monkeypatch, capsys):
    """`cli.py` only catches RuntimeError, so an escaping KeyboardInterrupt
    would reach the user as a Python traceback."""
    interrupted(monkeypatch, deployed=False)

    assert quickstart.run_quickstart() is False
    assert "Stopped." in capsys.readouterr().out


def test_a_deploy_that_came_up_is_left_running_and_named(monkeypatch, capsys):
    """`canyonos deploy` draws this line itself -- it removes a deploy that
    never came up and keeps one that did. An interrupt is not the moment to
    throw away minutes of image building."""
    interrupted(monkeypatch, deployed=True)
    monkeypatch.setattr(
        quickstart, "run_clean", lambda: pytest.fail("should not have torn down")
    )

    quickstart.run_quickstart()

    assert "canyonos clean" in capsys.readouterr().out


def test_nothing_running_says_nothing_about_cleaning(monkeypatch, capsys):
    """There is nothing to remove, so pointing at a teardown command would
    only be one more thing to wonder about."""
    interrupted(monkeypatch, deployed=False)

    quickstart.run_quickstart()

    assert "canyonos clean" not in capsys.readouterr().out


# --- the close -------------------------------------------------------------


@pytest.mark.parametrize("answer", ["", "no", "canyonos stop"])
def test_the_deploy_is_left_running_unless_the_command_is_typed(monkeypatch, answer):
    """The dashboard just pointed at belongs to this deploy, so anything but
    the command is a no -- including a wrong one, which must not hold anyone in
    a loop over a command they did not ask for."""
    types(monkeypatch, answer)
    monkeypatch.setattr(
        quickstart, "run_clean", lambda: pytest.fail("should not have torn down")
    )

    assert quickstart._offer_clean() is True


def test_typing_the_clean_command_tears_the_deploy_down(monkeypatch):
    types(monkeypatch, "canyonos clean")
    torn = []
    monkeypatch.setattr(quickstart, "run_clean", lambda: torn.append(True) or True)

    assert quickstart._offer_clean() is True
    assert torn == [True]


def test_a_teardown_that_leaves_something_behind_still_counts_as_a_run(
    monkeypatch, capsys
):
    """The trace is in the dashboard either way; the leftovers are reported.

    `run_clean` returns False to mean something was left behind, so this pins
    which way round `_offer_clean` reads it -- taking the falsy value for
    success would silently swallow the warning.
    """
    types(monkeypatch, "canyonos clean")
    monkeypatch.setattr(quickstart, "run_clean", lambda: False)

    assert quickstart._offer_clean() is True
    assert "could not be removed" in shown(capsys)


# --- stage 8: the first request ---------------------------------------------

ENDPOINT = {
    "public_host": "127.0.0.1",
    "api_port": 8085,
    "method": "main",
    "url": "http://127.0.0.1:8085/main",
    "arguments": ["query"],
}


def body_of(command):
    """The JSON the curl would POST, parsed back out of the typed command."""
    return json.loads(command.split("-d ", 1)[1].strip().strip("'"))


def sends(monkeypatch, stdout="", returncode=0):
    """Stand in for the curl the user types. Returns the argv it was given."""
    argv = []

    def run(args, **kwargs):
        argv.append(args)
        return subprocess.CompletedProcess(args, returncode, stdout, "")

    monkeypatch.setattr(quickstart.subprocess, "run", run)
    return argv


@pytest.mark.parametrize("layout", [("config",), (".canyon", "config")])
def test_the_sample_query_is_found_in_either_layout(monkeypatch, tmp_path, layout):
    """A ported project keeps it under `.canyon/`; one already in CanyonOS format
    keeps `config/` at its root. Looking in only one place is why an earlier
    version found nothing in our own examples."""
    folder = tmp_path.joinpath(*layout)
    folder.mkdir(parents=True)
    (folder / "test_query.txt").write_text("  NVDA 2026-09-01\n")
    monkeypatch.chdir(tmp_path)

    query, path = quickstart._sample_query()

    assert query == "NVDA 2026-09-01"
    assert path.endswith("test_query.txt")


def test_the_curl_is_built_from_what_the_deploy_published(monkeypatch, tmp_path):
    """Not a template: the address, the method and the body keys all come from
    the running deploy, so it is a command that works rather than one that
    needs editing first."""
    monkeypatch.chdir(tmp_path)

    command, _ = quickstart._curl_for(ENDPOINT)

    assert command.startswith("curl -X POST http://127.0.0.1:8085/main ")
    assert body_of(command) == {"query": "your query"}


def test_the_curl_is_one_line_so_it_can_be_typed(monkeypatch, tmp_path):
    """The wrapped form a README would show cannot be typed at a prompt that
    reads a single line -- the trailing backslash is just a backslash there."""
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "test_query.txt").write_text("NVDA\nas of 2026-09-01\n")
    monkeypatch.chdir(tmp_path)

    command, _ = quickstart._curl_for(ENDPOINT)

    assert "\n" not in command and "\\" not in command
    assert body_of(command) == {"query": "NVDA as of 2026-09-01"}


def test_the_sample_query_fills_in_the_curl(monkeypatch, tmp_path):
    """The difference between a command to run and a command to think about."""
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "test_query.txt").write_text("NVDA 2026-09-01\n")
    monkeypatch.chdir(tmp_path)

    command, query_path = quickstart._curl_for(ENDPOINT)

    assert body_of(command) == {"query": "NVDA 2026-09-01"}
    assert query_path.endswith("test_query.txt")


def test_a_workflow_with_no_sample_query_still_gets_a_curl(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)

    command, query_path = quickstart._curl_for(ENDPOINT)

    assert body_of(command) == {"query": "your query"}
    assert query_path is None


def test_a_query_with_quotes_does_not_break_the_json(monkeypatch, tmp_path):
    """Built with json.dumps, so a quote in the saved query escapes rather
    than closing the body early."""
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "test_query.txt").write_text('Why did "NVDA" move?\n')
    monkeypatch.chdir(tmp_path)

    command, _ = quickstart._curl_for(ENDPOINT)

    assert body_of(command) == {"query": 'Why did "NVDA" move?'}


def test_the_typed_curl_is_the_command_that_runs(monkeypatch, tmp_path):
    """The point of this stage is that the user's own command sends the
    request, not that something equivalent happens behind it."""
    monkeypatch.chdir(tmp_path)
    command, _ = quickstart._curl_for(ENDPOINT)
    argv = sends(monkeypatch, stdout=json.dumps({"request_id": "abc"}))
    monkeypatch.setattr(
        quickstart, "_await_result", lambda *a: {"status": "done", "result": {"r": 1}}
    )

    assert quickstart._send_request(command, ENDPOINT) is True
    assert argv == [shlex.split(command)]


def test_the_run_waits_for_the_answer_and_prints_it(monkeypatch, tmp_path, capsys):
    """Watching a request_id by hand is the one part of this nobody should
    have to learn."""
    monkeypatch.chdir(tmp_path)
    command, _ = quickstart._curl_for(ENDPOINT)
    sends(monkeypatch, stdout=json.dumps({"request_id": "abc"}))
    waited = []
    monkeypatch.setattr(
        quickstart,
        "_await_result",
        lambda endpoint, request_id: (
            waited.append(request_id)
            or {"status": "done", "result": {"decision": "HOLD"}}
        ),
    )

    assert quickstart._send_request(command, ENDPOINT) is True
    assert waited == ["abc"]
    assert '"decision": "HOLD"' in capsys.readouterr().out


@pytest.mark.parametrize(
    "answer, expected",
    [
        ({"status": "error", "error": "MarketDataAgent raised"}, "MarketDataAgent"),
        ({"status": "timeout"}, "did not answer"),
    ],
)
def test_a_request_that_does_not_come_back_says_where_to_look(
    monkeypatch, tmp_path, capsys, answer, expected
):
    monkeypatch.chdir(tmp_path)
    command, _ = quickstart._curl_for(ENDPOINT)
    sends(monkeypatch, stdout=json.dumps({"request_id": "abc"}))
    monkeypatch.setattr(quickstart, "_await_result", lambda *a: answer)

    assert quickstart._send_request(command, ENDPOINT) is False

    printed = shown(capsys)
    assert expected in printed
    assert "canyonos logs" in printed


def test_a_curl_that_fails_reports_what_curl_said(monkeypatch, tmp_path, capsys):
    """A refused connection and a bad address fail differently, and curl says
    which far better than a paraphrase could."""
    monkeypatch.chdir(tmp_path)
    command, _ = quickstart._curl_for(ENDPOINT)

    def run(args, **kwargs):
        return subprocess.CompletedProcess(args, 7, "", "Failed to connect")

    monkeypatch.setattr(quickstart.subprocess, "run", run)
    monkeypatch.setattr(
        quickstart, "_await_result", lambda *a: pytest.fail("nothing was accepted")
    )

    assert quickstart._send_request(command, ENDPOINT) is False
    assert "Failed to connect" in shown(capsys)


def test_a_reply_without_a_request_id_is_shown_rather_than_parsed(
    monkeypatch, tmp_path, capsys
):
    """A proxy's HTML error page comes back with a 0 exit code, so the body is
    the only thing that says what answered."""
    monkeypatch.chdir(tmp_path)
    command, _ = quickstart._curl_for(ENDPOINT)
    sends(monkeypatch, stdout="<html>502 Bad Gateway</html>")

    assert quickstart._send_request(command, ENDPOINT) is False
    assert "502 Bad Gateway" in capsys.readouterr().out


def test_the_request_goes_to_the_address_the_deploy_published(monkeypatch, tmp_path):
    """Whatever the deploy published is the address the user is handed, with no
    rewriting on the way -- so the command works anywhere that address does."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(quickstart, "load_state", lambda: {"port": 8000})
    monkeypatch.setattr(
        quickstart,
        "deployed_endpoint",
        lambda port: {
            **ENDPOINT,
            "public_host": "18.208.211.174",
            "url": "http://18.208.211.174:8085/main",
        },
    )
    offered = []
    monkeypatch.setattr(
        quickstart, "_typed", lambda command, run, what: offered.append(command) or True
    )

    assert quickstart._first_request() is True
    assert offered[0].startswith("curl -X POST http://18.208.211.174:8085/main ")


def test_an_unreadable_endpoint_says_where_to_get_it(monkeypatch, tmp_path, capsys):
    """Nothing can be sent without the address, but `canyonos status` has it."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        quickstart, "load_state", lambda: (_ for _ in ()).throw(OSError("no state"))
    )

    assert quickstart._first_request() is False
    assert "canyonos status" in shown(capsys)


def test_a_failed_request_still_offers_to_take_the_deploy_down(monkeypatch):
    """The containers are up either way, and walking away without the offer
    would leave them for someone to find later."""
    ready(monkeypatch)
    types(monkeypatch, "canyonos doctor")
    monkeypatch.setattr(quickstart, "run_doctor", lambda: True)
    monkeypatch.setattr(quickstart, "_first_request", lambda: False)
    offered = []
    monkeypatch.setattr(
        quickstart, "_offer_clean", lambda: offered.append(True) or True
    )

    assert quickstart.run_quickstart() is False
    assert offered == [True]
