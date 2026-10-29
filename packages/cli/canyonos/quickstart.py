# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos quickstart`: the guided first run, from a fresh machine to a
first request answered.

Each stage shows a command and waits for the user to type it back before running
it, so they finish having run `canyonos doctor`, `canyonos convert`, `canyonos
deploy` and a `curl` themselves. Choosing a workflow and cloning it are the
exceptions; neither is a command anyone could type.
"""

import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request


from canyonos import ui
from canyonos import os_support
from canyonos.convert import run_convert
from canyonos.clean import run_clean
from canyonos.constants import CANYON_DIR
from canyonos.dashboard_stack import _existing_dashboard_port, dashboard_url
from canyonos.deploy import run_deploy
from canyonos.doctor import run_doctor
from canyonos.gc import deploy_status, deployed_endpoint
from canyonos.init import load_state
from utils.tui import select_menu


# Every stage in order. `_step` takes its heading from here, so a stage is named
# in one place rather than at each call site.
STAGES = (
    "System Prerequisites",
    "Workflow Selection",
    "Workflow Setup",
    "Workflow Convert [Optional]",
    "Environment Config",
    "Deployment",
    "Deployment Health",
    "First Request",
)
TOTAL_STEPS = len(STAGES)

# The progress bar in each heading: one block per stage, not per minute.
BAR_DONE, BAR_TODO = "█", "░"

# Stages that take minutes, and the note shown under their heading so a long
# wait does not read as a hang.
SLOW_STAGES = {
    4: "takes a few minutes if the workflow needs conversion",
    6: "takes a while on a first run, while each agent's image builds",
    8: "~1-2 min, while the agents work through the request",
}

# Characters of an unexpected endpoint reply to show before truncating it.
MAX_REPLY_SHOWN = 200

# The project's env file, which the manifest passes to every container.
ENV_FILENAME = ".env"

# Stage 8's request, in seconds: accepting it, answering it, one poll, and the
# gap between polls.
SUBMIT_TIMEOUT = 30
REQUEST_TIMEOUT = 300
POLL_INTERVAL = 2
POLL_TIMEOUT = 10

# Where typed commands are entered. Fixed rather than the working directory,
# which changes part-way through the run.
PROMPT = "canyonos-quickstart $"

# `_typed`'s answer when an optional command was not typed, distinct from a
# command that ran and returned None.
SKIPPED = object()

# Seconds held between stages, so one that finishes instantly is still readable.
STEP_PAUSE = 1.0

# The workflows on offer. `repo`, `ref` and `path` locate one subdirectory of a
# public repository at a pinned commit; `secrets` is what stage 5 asks for: the
# keys the workflow needs, not every key its `.env.example` lists.
#
# Pinned to a commit, never a branch. A workflow that moves under the CLI is a
# first run that breaks for reasons the user cannot see.
STARTERS = {
    "tradingagent": {
        "label": "TradingAgents",
        "summary": "Multi-agent financial analysis",
        "repo": "CanyonCodeCoreAI/workflows",
        "ref": "ed6203f4f99e80c181014959110e514e77ce5b0c",
        "path": "tradingagent",
        "secrets": ["OPENAI_API_KEY"],
    },
}

# `advice.detachedHead` would otherwise print a paragraph about detached HEADs
# at a user who never asked to check anything out.
GIT = ["git", "-c", "advice.detachedHead=false"]
GIT_TIMEOUT = 600


def _step(number):
    """Show the heading for stage `number` in the terminal, with its progress bar
    and any note about how long it takes. Pauses first so the stage that just
    finished can be read, but only where someone is watching."""
    if sys.stdin.isatty():
        time.sleep(STEP_PAUSE)

    ui.blank()
    bar = BAR_DONE * number + BAR_TODO * (TOTAL_STEPS - number)
    ui.heading(f"[{number}/{TOTAL_STEPS}] {bar}  {STAGES[number - 1]}")
    if slow := SLOW_STAGES.get(number):
        ui.hint(f"  {slow}")
    ui.blank()


def _typed(command, run, what, optional=False):
    """Show `command` and the one line `what` it does, wait for the user to type
    it back, then call `run` and return its result.

    Returns None when a required command was not typed, and SKIPPED when an
    optional one was not. A required command refuses anything else and asks
    again, since one command is on offer at a time and accepting something near
    it would teach the wrong line; an optional one takes anything else as a no.
    """
    ui.say(f"{what} Run:")
    ui.blank()
    ui.command(f"  {command}")
    ui.blank()

    while True:
        typed = " ".join(ui.ask(PROMPT, suffix=" ").split())
        if typed == command:
            ui.blank()
            return run()
        if optional:
            ui.blank()
            return SKIPPED
        if not typed:
            ui.blank()
            ui.say("Nothing typed; stopping here.")
            ui.hint(f"  -> run `{command}` yourself to carry on from this step")
            return None
        ui.warn(f"Expected `{command}`.")


def _is_project(folder):
    """True if `folder` holds a `global_controller.yaml`, in either layout: under
    a ported `CANYON_DIR`, or in a `config/` at its root."""
    return os.path.isfile(
        os.path.join(folder, CANYON_DIR, "config", "global_controller.yaml")
    ) or os.path.isfile(os.path.join(folder, "config", "global_controller.yaml"))


def _clone_url(starter):
    """The address `starter`'s repository is cloned from."""
    return f"https://github.com/{starter['repo']}.git"


def _git(args, cwd=None):
    """Run one git command, raising RuntimeError carrying git's own message when
    it fails: git says why far better than this could paraphrase."""
    result = subprocess.run(
        [*GIT, *args], cwd=cwd, capture_output=True, text=True, timeout=GIT_TIMEOUT
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"`git {' '.join(args)}` failed: {detail}")


def _fetch(name, into=None):
    """Clone the starter `name` into a folder of its own under `into` (the
    current directory by default) and return that folder.

    A folder already holding this workflow is returned untouched, so a second run
    after a failure keeps a filled-in `.env`. One holding anything else raises
    RuntimeError rather than being written over.

    Only the one workflow's subdirectory is fetched, at its pinned commit: these
    sit beside each other in a single repository, and pulling all of them to use
    one makes a slow first impression.
    """
    starter = STARTERS[name]
    destination = os.path.join(into or os.getcwd(), name)

    if os.path.exists(destination):
        if _is_project(destination):
            return destination
        raise RuntimeError(
            f"{destination} already exists and is not a CanyonOS project. "
            "Move it or run `canyonos quickstart` from another folder."
        )

    with tempfile.TemporaryDirectory() as clone:
        _git(
            ["clone", "--filter=blob:none", "--no-checkout", _clone_url(starter), clone]
        )
        _git(["sparse-checkout", "set", starter["path"]], cwd=clone)
        _git(["checkout", starter["ref"]], cwd=clone)

        # A sparse checkout of a path the commit does not have succeeds and
        # leaves nothing behind, so a workflow list that has drifted from its
        # repository would otherwise surface several steps later as a
        # FileNotFoundError naming a temporary directory.
        source = os.path.join(clone, starter["path"])
        if not os.path.isdir(source):
            raise RuntimeError(
                f"{starter['repo']} has no {starter['path']} at "
                f"{starter['ref'][:12]}. The workflow list and that repository "
                "disagree; one of them needs updating."
            )

        # copytree, not a move: the clone is inside a temporary directory that
        # may be on another filesystem, where a rename cannot cross over.
        shutil.copytree(source, destination, symlinks=True)

    return destination


def _choose_starter():
    """Show the workflow picker in the terminal and return the chosen key, or
    None when the user cancelled or there is no terminal to ask on."""
    return select_menu(
        [
            (name, f"{starter['label']} — {starter['summary']}")
            for name, starter in STARTERS.items()
        ],
        "Select a workflow to get started:",
    )


def _get_starter():
    """Run stages 2 and 3: pick a workflow and copy it onto disk. Returns
    `(name, folder)`, or None after showing why the run cannot go on."""
    name = _choose_starter()
    if name is None:
        # The menu answers None both for Esc and for having no terminal to draw
        # on, and only one of those is something the user chose.
        if sys.stdin.isatty():
            ui.say("Cancelled.")
        else:
            ui.fail("`canyonos quickstart` needs a terminal to ask what to deploy.")
            ui.hint(
                "  -> run it directly, or use `canyonos deploy` in a workflow folder"
            )
        return None

    _step(3)
    ui.say(f"Cloning {STARTERS[name]['label']} at its pinned commit...")
    with ui.status("Cloning..."):
        try:
            folder = _fetch(name)
        except RuntimeError as e:
            ui.fail(e)
            return None

    ui.ok(f"Workflow set up in ./{os.path.basename(folder)}")
    return name, folder


# Keys reach the agents only through the project's `.env`: the manifest passes
# it to every container as `env_file`, and an exported shell variable does not
# reach them.


def _env_path(folder):
    """Path to the project's `.env`, whether or not it exists yet."""
    return os.path.join(folder, ENV_FILENAME)


def _assigned_name(line):
    """The variable a `.env` line assigns, or None. Commented lines count: a
    starter ships the key it needs as `# OPENAI_API_KEY=`."""
    if "=" not in line:
        return None
    return line.split("=", 1)[0].lstrip("#").strip() or None


def _env_values(folder):
    """Name to value for every uncommented assignment in the project's `.env`,
    or `{}` when there is no such file. Commented lines are documentation of
    what could be set, not something that is."""
    try:
        with open(_env_path(folder), encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        return {}

    found = {}
    for line in lines:
        if line.lstrip().startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        found[name.strip()] = value.strip()
    return found


def _missing_keys(folder, names):
    """Which of `names` the project's `.env` has no usable value for. Present but
    empty counts as missing: an empty `KEY=` reaches the provider as an empty key
    and comes back a 401."""
    have = _env_values(folder)
    return [name for name in names if not have.get(name)]


def _write_keys(folder, secrets):
    """Write `secrets` into the project's private `.env` and return its path.
    Every other line is kept, and any line assigning one of these names is
    dropped rather than left above the new value, commented ones included."""
    path = _env_path(folder)
    kept = []
    try:
        with open(path, encoding="utf-8") as f:
            kept = [
                line
                for line in f.read().splitlines()
                if _assigned_name(line) not in secrets
            ]
    except OSError:
        pass

    lines = [*kept, "", *(f"{name}={value}" for name, value in secrets.items()), ""]
    os_support.write_private_file(path, "\n".join(lines))
    return path


def _collect_keys(folder, names):
    """Run stage 5: ask for each key the project still needs and save them to its
    `.env`. A key already exported in this shell is taken without asking.

    Returns True once every key has a value, or False after showing where to set
    one the user left empty.
    """
    needed = _missing_keys(folder, names)
    if not needed:
        ui.ok("Environment already configured.")
        return True

    ui.say("Configure the required environment variables:")
    ui.blank()

    collected = {}
    for name in needed:
        from_shell = os.environ.get(name, "").strip()
        if from_shell:
            ui.ok(f"{name} — taken from your environment")
            collected[name] = from_shell
            continue

        value = ui.secret(f"{name}")
        if not value:
            ui.blank()
            ui.fail(f"No value provided for {name}.")
            ui.hint(f"  -> set it in {_env_path(folder)} and run again")
            return False
        collected[name] = value

    _write_keys(folder, collected)
    ui.blank()
    ui.ok("Environment configuration saved.")
    return True


def _convert_project(folder):
    """Run stage 4: convert the workflow to CanyonOS format with `canyonos
    convert`, or say it is already in that format and skip. Returns True when the
    workflow is ready to deploy.

    The command is typed first and the decision comes after it, the same shape as
    every other stage. Running `canyonos convert` on an already-converted project
    would hand it to a coding assistant again for minutes, to end up where it
    started.
    """
    _step(4)

    def convert():
        if _is_project(folder):
            ui.ok("Already in CanyonOS format -- skipping the conversion.")
            return True
        return run_convert()

    return bool(
        _typed(
            "canyonos convert",
            convert,
            "Converts the workflow into CanyonOS format with a coding assistant.",
        )
    )


def _deploy():
    """Run stage 6: deploy the workflow, then check it and show the dashboard
    address. Returns True when it is up and healthy."""
    _step(6)
    deployed = _typed(
        "canyonos deploy",
        lambda: run_deploy(banner=False),
        "Builds an image per agent, then starts the workflow.",
    )
    if deployed is None:
        return False

    ui.blank()
    ui.ok("Workflow deployed successfully.")

    if not _health_check():
        return False
    _show_dashboard()
    return True


def _health_check():
    """Run stage 7: `canyonos doctor` a second time, which switches to its
    post-deploy checklist once it finds a running deploy. Returns True when every
    check passed.

    A stack that only came up part way turns the first request into a long wait
    and then a timeout; this names the missing piece instead.
    """
    _step(7)
    passed = _typed(
        "canyonos doctor",
        run_doctor,
        "Checks the running deploy: controller, Redis, agents, endpoint, dashboard.",
    )
    if passed is None:
        return False
    if passed:
        ui.blank()
        ui.ok("Deployment health checks passed.")
        return True

    ui.blank()
    ui.fail("Deployment health checks failed, so a request would not get through.")
    ui.hint("  -> resolve the items above, then run `canyonos quickstart` again")
    return False


def _deploy_is_up():
    """Whether a deploy is running right now. Asked on the way out of an
    interrupted run, so it can say what it left behind."""
    try:
        state = load_state()
        return bool((deploy_status(state["port"]) or {}).get("running"))
    except (KeyError, OSError, RuntimeError, ValueError):
        return False


def _offer_clean():
    """Close the run by offering `canyonos clean`, and say what is still running
    either way. Always True.

    The one optional command here: leaving the workflow up is a fine way to
    finish, and the dashboard just pointed at belongs to the deploy this would
    remove. So anything other than the command is taken as a no.

    `clean` rather than `stop`, because the offer is to undo the run: `stop`
    would leave the agents' images and the project's `.canyon` behind on a
    machine someone may have been trying CanyonOS out on. It stops the deploy
    first itself, so one typed command still covers the whole teardown.
    """
    ui.blank()
    result = _typed(
        "canyonos clean",
        run_clean,
        "Stops the workflow and removes what the deploy created.",
        optional=True,
    )

    if result is SKIPPED:
        ui.hint("  -> left running; `canyonos clean` removes it whenever you like")
        return True

    # `run_clean` reports what it could not remove rather than raising: it has
    # already said which parts on screen, and returns False to mean some of it
    # is still there.
    if not result:
        ui.warn("Some of it could not be removed; see above.")
    return True


def _sample_query():
    """The workflow's own test query and the file it came from, looked for in
    both the ported `CANYON_DIR` layout and a `config/` at the project root.
    `(None, None)` when the workflow ships none."""
    for path in (
        os.path.join(CANYON_DIR, "config", "test_query.txt"),
        os.path.join("config", "test_query.txt"),
    ):
        try:
            with open(path, encoding="utf-8") as f:
                query = f.read().strip()
        except OSError:
            continue
        if query:
            return query, path
    return None, None


def _show_dashboard():
    """Show the dashboard address in the terminal, or say how to start it. Never
    opens a browser: on a server there is none to open."""
    port = _existing_dashboard_port()
    if port is None:
        ui.warn("The dashboard is not running -- start it with `canyonos serve`.")
        return

    ui.blank()
    ui.say("Watch it run in the dashboard:")
    ui.command(f"  {dashboard_url(port)}")


def _await_result(endpoint, request_id, timeout=REQUEST_TIMEOUT):
    """Poll the endpoint until the request is done or errors, showing a spinner
    in the terminal meanwhile. Returns what it answered with, or
    `{"status": "timeout"}`."""
    url = f"http://{endpoint['public_host']}:{endpoint['api_port']}/status/{request_id}"
    deadline = time.time() + timeout
    with ui.status("Waiting for the workflow..."):
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(url, timeout=POLL_TIMEOUT) as answer:
                    data = json.loads(answer.read())
                if data.get("status") in ("done", "error"):
                    return data
            except (OSError, ValueError):
                # A blip or a half-written body while the workflow is busy; the
                # deadline ends this loop, not one failed poll.
                pass
            time.sleep(POLL_INTERVAL)
    return {"status": "timeout"}


def _curl_for(endpoint):
    """The `curl` stage 8 asks for, and the file its query came from.

    Built from what the deploy published -- the address and method from the
    manifest, the body keys from the served method's own arguments -- so it works
    as shown rather than needing an edit. It is one line, and the query is
    flattened to single spaces, because it has to survive being typed.
    """
    query, query_path = _sample_query()
    if query:
        query = " ".join(query.split())
    body = json.dumps({name: query or f"your {name}" for name in endpoint["arguments"]})
    command = (
        f"curl -X POST {endpoint['url']} "
        f"-H 'Content-Type: application/json' "
        f"-d '{body}'"
    )
    return command, query_path


def _send_request(command, endpoint):
    """Run the typed `curl`, wait for the workflow, and show the result in the
    terminal. Returns True when it answered.

    The command is run rather than turned back into an HTTP call from here, so
    the request is the user's own. Splitting it is safe because it is this
    module's string: `_typed` only calls through on an exact match.
    """
    try:
        sent = subprocess.run(
            shlex.split(command), capture_output=True, text=True, timeout=SUBMIT_TIMEOUT
        )
    except FileNotFoundError:
        ui.fail("curl is not installed, so the request cannot be sent from here.")
        return False
    except subprocess.TimeoutExpired:
        ui.fail(f"The endpoint did not accept the request within {SUBMIT_TIMEOUT}s.")
        return False

    if sent.returncode != 0:
        # curl's own message distinguishes a refused connection from a bad
        # address; a paraphrase would not.
        ui.fail(f"curl exited {sent.returncode}: {sent.stderr.strip() or 'no output'}")
        return False

    try:
        request_id = json.loads(sent.stdout)["request_id"]
    except (ValueError, KeyError, TypeError):
        ui.fail("The endpoint answered, but not with a request_id:")
        ui.command(f"  {sent.stdout.strip()[:MAX_REPLY_SHOWN] or '(nothing)'}")
        return False

    ui.ok(f"Accepted as request {request_id}.")
    data = _await_result(endpoint, request_id)

    if data.get("status") == "done":
        ui.blank()
        ui.ok("The workflow answered:")
        ui.blank()
        # `ui.command` never wraps and never reads its text as markup, so a
        # result full of braces and brackets survives intact.
        for line in json.dumps(data.get("result"), indent=2).splitlines():
            ui.command(f"  {line}")
        return True

    ui.blank()
    if data.get("status") == "error":
        ui.fail(f"The workflow failed: {data.get('error') or 'no reason given'}")
    else:
        ui.fail(f"The workflow did not answer within {REQUEST_TIMEOUT}s.")
    ui.hint("  -> `canyonos logs` shows which agent got stuck, and why")
    return False


def _first_request():
    """Run stage 8: show the `curl` for the deployed endpoint, wait for the user
    to type it, send it and wait for the answer. Returns True when the workflow
    answered."""
    _step(8)

    try:
        endpoint = deployed_endpoint(load_state()["port"])
    except (KeyError, OSError, RuntimeError, ValueError):
        ui.warn("Could not read the endpoint -- `canyonos status` prints it.")
        return False

    command, query_path = _curl_for(endpoint)
    if query_path:
        ui.hint(f"  query from {query_path}")
        ui.blank()

    return bool(
        _typed(
            command,
            lambda: _send_request(command, endpoint),
            "Sends one request through the workflow and waits for the answer.",
        )
    )


def run_quickstart():
    """Run `canyonos quickstart`: walk a new user from this machine to a first
    answered request. Returns True when the run reached the end, False when a
    stage failed and said how to fix it.

    Ctrl-C stops the run wherever it is and leaves a deploy that came up running,
    naming `canyonos clean`: an interrupt means stop, not undo, and tearing down
    would throw away minutes of image building.
    """
    try:
        return _quickstart()
    except KeyboardInterrupt:
        ui.blank()
        ui.blank()
        ui.say("Stopped.")
        if _deploy_is_up():
            ui.hint("  -> the workflow is still running; `canyonos clean` removes it")
        return False


def _quickstart():
    """The run itself; `run_quickstart` wraps it to handle Ctrl-C."""
    ui.say("canyonos quickstart")
    ui.hint(
        "Set up a workflow, configure its environment, deploy it, and send "
        "your first request -- one guided step at a time."
    )

    _step(1)
    passed = _typed(
        "canyonos doctor",
        run_doctor,
        "Checks Docker, git and everything else a deploy needs.",
    )
    if passed is None:
        return False
    if not passed:
        ui.blank()
        ui.fail("Required prerequisites are not satisfied.")
        ui.hint("  -> resolve the items above, then run `canyonos quickstart` again")
        return False

    ui.blank()
    ui.ok("All required prerequisites are satisfied.")

    _step(2)
    picked = _get_starter()
    if picked is None:
        return False

    name, folder = picked

    # `canyonos convert` and `canyonos deploy` read the project out of the current
    # directory, the sample query is found relative to it, and the deploy names
    # its containers after it. So the run changes into it once, the way a user
    # would `cd`, rather than passing a path none of those commands would take.
    os.chdir(folder)
    ui.blank()
    ui.hint(f"  the commands below run from ./{os.path.basename(folder)}")

    if not _convert_project(folder):
        return False

    _step(5)
    if not _collect_keys(folder, STARTERS[name]["secrets"]):
        return False

    if not _deploy():
        return False

    # The deploy is up from here either way, so a failed request still gets the
    # teardown offer rather than leaving containers behind.
    if not _first_request():
        _offer_clean()
        return False

    ui.blank()
    ui.ok("CanyonOS quickstart completed.")
    return _offer_clean()
