# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`canyonos quickstart` is the guided first run. Most of its stages are run by
the user typing the command, so these cover that gate, the stages it guards,
and the wiring into the CLI."""

import json
import os
import shlex
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
    monkeypatch.setattr(quickstart, "_prepare_project", lambda folder: True)
    monkeypatch.setattr(quickstart, "_ask_for_keys", lambda names: None)
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


def test_pressing_enter_runs_the_command(monkeypatch):
    """One command is on offer, so an empty line is an answer of yes. Stopping
    the run on it would send someone back to the shell to start over."""
    asked = types(monkeypatch, "")
    ran = []

    assert (
        quickstart._typed("canyonos validate", lambda: ran.append(True) or 0, "what")
        == 0
    )
    assert ran == [True]
    assert len(asked) == 1


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


def test_no_terminal_reads_as_enter_rather_than_blocking(monkeypatch):
    """`ui.ask` returns its default without a terminal, which reads as Enter, so
    a piped run carries on instead of blocking on stdin. It gets no further than
    the workflow menu, which needs a terminal of its own."""
    monkeypatch.setattr(quickstart.ui, "ask", lambda q, default="", **k: default)
    ran = []

    assert (
        quickstart._typed("canyonos doctor", lambda: ran.append(True) or 0, "what") == 0
    )
    assert ran == [True]


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
def copied():
    """A starter to exercise the copy path with."""
    return A_STARTER


@pytest.mark.parametrize("name", sorted(quickstart.STARTERS))
def test_every_starter_is_described_in_the_menu(name):
    """Both halves are shown on the picker's one line per workflow."""
    starter = quickstart.STARTERS[name]

    assert starter["label"] and starter["summary"]


@pytest.mark.parametrize("name", sorted(quickstart.STARTERS))
def test_every_starter_ships_inside_the_package(name):
    """The workflow is copied out of the install, not fetched, so a first run
    works with no network. One missing from the bundle is a menu entry that only
    breaks when someone picks it."""
    assert os.path.isdir(str(quickstart._bundled(name))), f"{name} is not bundled"


@pytest.mark.parametrize("name", sorted(quickstart.STARTERS))
def test_every_starter_says_what_it_needs(name):
    """The menu names the key requirement, so nobody picks a workflow and finds
    out three stages later that they need a key they do not have."""
    starter = quickstart.STARTERS[name]

    assert starter["needs"], "every starter says whether it needs a key"
    assert starter["secrets"] == sorted(set(starter["secrets"])), "no duplicate keys"


def test_hello_world_comes_first_and_needs_no_key():
    """It is the default -- the menu cursor starts on the first entry -- and the
    one workflow that reaches a trace on a machine with no API key."""
    assert next(iter(quickstart.STARTERS)) == "helloworld"
    assert quickstart.STARTERS["helloworld"]["secrets"] == []


def test_only_the_chosen_workflow_is_copied(tmp_path, copied):
    """Picking one workflow should not write the other two into the folder."""
    quickstart._fetch(copied, into=tmp_path)

    written = {path.name for path in tmp_path.iterdir()}
    assert written == {copied}


def test_the_copy_is_a_runnable_workflow_with_its_python_restored(tmp_path, copied):
    """Bundled Python carries a .tmpl suffix so Nuitka leaves it alone; a copy
    that kept it would deploy agents whose entrypoints do not exist."""
    folder = Path(quickstart._fetch(copied, into=tmp_path))

    assert (folder / "config" / "global_controller.yaml").is_file()
    assert list(folder.glob("agents/*.py")), "agent sources were written as .py"
    assert not list(folder.rglob("*.tmpl")), "a .tmpl suffix survived the copy"


@pytest.mark.skipif(os.name == "nt", reason="Windows has no mode bits to check")
def test_the_env_file_is_written_readable_only_by_its_owner(tmp_path):
    """The run tells the user to put their OpenAI key in `.env`, so it must not
    be world-readable the way the rest of the copied workflow is."""
    with_env = [
        name
        for name in quickstart.STARTERS
        if (Path(str(quickstart._bundled(name))) / quickstart.ENV_FILENAME).is_file()
    ]
    assert with_env, "no bundled workflow ships a .env"

    for name in with_env:
        folder = Path(quickstart._fetch(name, into=tmp_path))
        mode = (folder / quickstart.ENV_FILENAME).stat().st_mode & 0o777
        assert mode == 0o600, f"{name}/.env is {oct(mode)}"


def test_an_install_missing_its_bundled_workflow_says_so(tmp_path, monkeypatch, copied):
    """Package data that did not make it would otherwise write an empty folder
    and fail several stages later, as a deploy with no agents."""
    monkeypatch.setattr(quickstart, "_bundled", lambda name: tmp_path / "gone")

    with pytest.raises(RuntimeError, match="missing the bundled"):
        quickstart._fetch(copied, into=tmp_path)

    assert not (tmp_path / copied).exists()


def test_a_folder_already_holding_the_workflow_is_reused(tmp_path, monkeypatch, copied):
    """A second run after a failure should not copy over it, nor overwrite
    whatever was edited in between -- a filled-in .env, most of all."""
    existing = tmp_path / copied / "config"
    existing.mkdir(parents=True)
    (existing / "global_controller.yaml").write_text("agents: []\n")
    monkeypatch.setattr(
        quickstart,
        "_starter_files",
        lambda name: pytest.fail("should not have copied"),
    )

    assert quickstart._fetch(copied, into=tmp_path) == str(tmp_path / copied)


def test_a_folder_holding_something_else_is_left_alone(tmp_path, copied):
    """Clobbering an unrelated folder that happens to share the name would be a
    bad way to meet a new user."""
    (tmp_path / copied).mkdir()
    (tmp_path / copied / "notes.txt").write_text("mine")

    with pytest.raises(RuntimeError, match="not a CanyonOS project"):
        quickstart._fetch(copied, into=tmp_path)

    assert (tmp_path / copied / "notes.txt").read_text() == "mine"


@pytest.mark.parametrize("layout", [("config",), (".canyon", "config")])
def test_a_workflow_is_recognised_in_either_layout(tmp_path, layout):
    """A ported project keeps its manifest under `.canyon/`; one already in
    CanyonOS format keeps `config/` at its root. Stage 4 decides whether to
    port on this answer."""
    folder = tmp_path.joinpath(*layout)
    folder.mkdir(parents=True)
    (folder / "global_controller.yaml").write_text("agents: []\n")

    assert quickstart._is_project(str(tmp_path))


# --- stage 3, continued: entering the folder ---------------------------------


def already_ported(tmp_path):
    (tmp_path / ".canyon" / "config").mkdir(parents=True)
    (tmp_path / ".canyon" / "config" / "global_controller.yaml").write_text(
        "agents: []\n"
    )
    return str(tmp_path)


@pytest.fixture(autouse=True)
def _restore_cwd(monkeypatch):
    """`_prepare_project` changes directory, the way a user's `cd` would. Undone
    after each test, so one leaving the tree does not move the next."""
    monkeypatch.chdir(os.getcwd())


def cd_into(folder):
    """The `cd` the stage asks for, for a workflow at `folder`."""
    return f"cd ./{os.path.basename(folder)}"


def test_entering_the_workflow_is_typed_not_done_quietly(monkeypatch, tmp_path):
    """Every command after this one runs from inside the folder; a reader who
    never saw the `cd` cannot repeat the run themselves."""
    folder = already_ported(tmp_path)
    asked = types(monkeypatch, cd_into(folder))

    assert quickstart._prepare_project(folder) is True
    assert len(asked) == 1
    assert os.path.realpath(os.getcwd()) == os.path.realpath(folder)


def test_the_cd_is_the_whole_stage(monkeypatch, tmp_path):
    """Every workflow on offer is already in CanyonOS format, so nothing here
    offers `canyonos convert` -- porting an app of your own is a separate thing,
    run in its own folder."""
    folder = already_ported(tmp_path)
    asked = types(monkeypatch, cd_into(folder))

    assert quickstart._prepare_project(folder) is True
    assert len(asked) == 1


def test_pressing_enter_enters_the_workflow_too(monkeypatch, tmp_path):
    """The `cd` is the only command on offer, so Enter accepts it."""
    folder = already_ported(tmp_path)
    types(monkeypatch, "")

    assert quickstart._prepare_project(folder) is True
    assert os.path.realpath(os.getcwd()) == os.path.realpath(folder)


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
    time -- that it is the same command doing both is worth seeing.

    Three prompts: a near miss, then the deploy, then the health check, which
    Enter answers.
    """
    staged(monkeypatch, tmp_path)
    asked = types(monkeypatch, "canyonos deploy --now", "canyonos deploy", "")

    assert quickstart._deploy() is True
    assert len(asked) == 3


# --- asking for the keys ----------------------------------------------------
#
# API keys reach the agents only through the workflow's `.env`, which it ships
# with the key names already in it. So the quickstart points at that file rather
# than prompting and writing it.


def test_a_workflow_needing_a_key_is_told_which_one(capsys):
    quickstart._ask_for_keys(["OPENAI_API_KEY"])

    said = shown(capsys)
    assert quickstart.ENV_FILENAME in said
    assert "OPENAI_API_KEY" in said


def test_a_workflow_needing_no_key_is_told_nothing(capsys):
    """Hello World reaches a trace without a key; a note about configuring one
    would be a step that does not apply."""
    quickstart._ask_for_keys([])

    assert shown(capsys).strip() == ""


def test_the_run_asks_for_exactly_the_keys_the_workflow_declares(monkeypatch):
    """Not a fixed list: a workflow that needs nothing must be asked nothing."""
    ready(monkeypatch)
    types(monkeypatch, "canyonos doctor")
    monkeypatch.setattr(quickstart, "run_doctor", lambda: True)
    asked = []
    monkeypatch.setattr(quickstart, "_ask_for_keys", asked.append)

    quickstart.run_quickstart()

    assert asked == [quickstart.STARTERS[A_STARTER]["secrets"]]


# --- stages 4 and 5: deploy, then health ------------------------------------


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
    """`deploy` and the first request both read the project out of the current
    directory, and the deploy names its containers after it. So every stage after
    the typed `cd` runs from inside the workflow."""
    project = tmp_path / A_STARTER
    (project / "config").mkdir(parents=True)
    (project / "config" / "global_controller.yaml").write_text("agents: []\n")
    monkeypatch.chdir(tmp_path)

    entering = quickstart._prepare_project
    ready(monkeypatch)
    # `ready` stands this stage down; the `cd` is the thing under test here.
    monkeypatch.setattr(quickstart, "_prepare_project", entering)
    types(monkeypatch, "canyonos doctor", f"cd ./{A_STARTER}")
    monkeypatch.setattr(quickstart, "run_doctor", lambda: True)
    monkeypatch.setattr(quickstart, "_get_starter", lambda: (A_STARTER, str(project)))
    seen = []
    monkeypatch.setattr(quickstart, "_deploy", lambda: seen.append(os.getcwd()) or True)

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


@pytest.mark.parametrize("answer", ["", "canyonos clean"])
def test_the_teardown_runs_on_enter_as_well_as_on_the_command(monkeypatch, answer):
    """The close is a command like any other, so Enter accepts it."""
    types(monkeypatch, answer)
    torn = []
    monkeypatch.setattr(quickstart, "run_clean", lambda: torn.append(True) or True)

    assert quickstart._offer_clean() is True
    assert torn == [True]


@pytest.mark.parametrize("answer", ["no", "canyonos stop"])
def test_the_close_takes_a_no_and_leaves_the_workflow_running(
    monkeypatch, capsys, answer
):
    """Keeping the deploy up is a fine way to finish, so the close is the one
    prompt that does not ask again. A near miss like `canyonos stop` is a no as
    well: it would leave the images and `.canyon` behind, so running it here
    would do something other than what was offered."""
    asked = types(monkeypatch, answer)
    torn = []
    monkeypatch.setattr(quickstart, "run_clean", lambda: torn.append(True) or True)

    assert quickstart._offer_clean() is True
    assert torn == []
    assert len(asked) == 1
    assert "left running" in shown(capsys)


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

    assert quickstart._send_first_request() is True
    assert offered[0].startswith("curl -X POST http://18.208.211.174:8085/main ")


def test_an_unreadable_endpoint_says_where_to_get_it(monkeypatch, tmp_path, capsys):
    """Nothing can be sent without the address, but `canyonos status` has it."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        quickstart, "load_state", lambda: (_ for _ in ()).throw(OSError("no state"))
    )

    assert quickstart._send_first_request() is False
    assert "canyonos status" in shown(capsys)


def test_a_failed_request_still_offers_to_take_the_deploy_down(monkeypatch):
    """The containers are up either way, and walking away without the offer
    would leave them for someone to find later. The stage makes the offer itself,
    so it cannot be lost by a caller returning early."""
    requesting = quickstart._first_request
    ready(monkeypatch)
    # `ready` stands this stage down; the offer it makes is the thing under test.
    monkeypatch.setattr(quickstart, "_first_request", requesting)
    types(monkeypatch, "canyonos doctor")
    monkeypatch.setattr(quickstart, "run_doctor", lambda: True)
    monkeypatch.setattr(quickstart, "_send_first_request", lambda: False)
    offered = []
    monkeypatch.setattr(
        quickstart, "_offer_clean", lambda: offered.append(True) or True
    )

    assert quickstart.run_quickstart() is False
    assert offered == [True]
