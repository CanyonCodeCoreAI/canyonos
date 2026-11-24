# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos quickstart`: the guided first run, from a fresh machine to a
first request answered.

Each stage shows a command and waits for the user to type it back before running
it, so they finish having run `canyonos doctor`, `canyonos deploy` and a `curl`
themselves. Choosing a workflow and copying it out of the package are the
exceptions; neither is a command anyone could type.
"""

import importlib.resources
import json
import os
import shlex
import subprocess
import sys
import time
import urllib.request

from canyonos import ui
from canyonos.clean import run_clean
from canyonos.auth import BEARER_PLACEHOLDER, bearer_header, group_api_key
from canyonos.constants import (
    CANYON_DIR,
    workflow_config_path,
    workflow_folder,
)
from canyonos.dashboard_registration import (
    RegistrationError,
    add_sample_data,
    register_workflows,
)
from canyonos.api import deploy_status, is_running
from canyonos.dashboard_stack import dashboard_url, running_web_port
from canyonos.deploy import run_deploy
from canyonos.doctor import run_doctor
from canyonos.init import load_state
from canyonos.new_app import PYTHON_TEMPLATE_SUFFIX
from canyonos.os_support import write_private_file
from utils.tui import select_menu


# Every stage in order. `_step` takes its heading from here, so a stage is named
# in one place rather than at each call site.
#
# Setting a workflow up is one stage doing two things: copying it out of the
# package and entering its folder. Neither is a step on its own.
STAGES = (
    "System Prerequisites",
    "Workflow Selection",
    "Workflow Setup",
    "Deployment",
    "Workflow Group Health",
    "First Request",
)
TOTAL_STEPS = len(STAGES)

# The progress bar in each heading: one block per stage, not per minute.
BAR_DONE, BAR_TODO = "█", "░"

# Characters of an unexpected endpoint reply to show before truncating it.
MAX_REPLY_SHOWN = 200

# The workflow's env file, which the manifest passes to every container.
ENV_FILENAME = ".env"

# Stage 6's request, in seconds: accepting it, answering it, one poll, and the
# gap between polls.
SUBMIT_TIMEOUT = 30
REQUEST_TIMEOUT = 300
POLL_INTERVAL = 2
POLL_TIMEOUT = 10

# Where typed commands are entered. Fixed rather than the working directory,
# which changes part-way through the run.
PROMPT = "canyonos-quickstart $"

# `_typed`'s answer for an optional command the user declined, told apart from
# what the command itself returns when it does run.
SKIPPED = object()


# Seconds held between stages, so one that finishes instantly is still readable.
STEP_PAUSE = 1.0

# Shown once the run completes, for building a workflow of your own.
FROM_SCRATCH_URL = "https://canyonos.readthedocs.io/en/latest/guides/FROM_SCRATCH/"

# Where the bundled workflows sit inside the package. scripts/bundle-starters.ts
# fills it from examples/; the wheel and the binary both carry it.
STARTERS_DIR = "starters"

# The workflows on offer, in the order the menu lists them. Hello World comes
# first because the cursor starts there: it is the default, and the only one that
# reaches a trace without an API key.
#
# All of them are already in CanyonOS format, so a first run deploys what it
# copied. Porting an app of your own is `canyonos convert`, which the quickstart
# keeps out of the way.
#
# `secrets` is the keys that workflow needs, not every key its `.env.example`
# lists -- and `needs` says the same thing in the menu, so nobody picks a
# workflow and finds out three stages later.
STARTERS = {
    "helloworld": {
        "label": "Hello World",
        "summary": "Two agents and a greeting",
        "needs": "no API key needed",
        "secrets": [],
    },
    "portfolio": {
        "label": "Portfolio",
        "summary": "Portfolio analysis from a plain-English request",
        "needs": "needs an OpenAI key",
        "secrets": ["OPENAI_API_KEY"],
    },
}


def _step(number):
    """Show the heading for stage `number` in the terminal, with its progress
    bar. Pauses first so the stage that just finished can be read, but only where
    someone is watching."""
    if sys.stdin.isatty():
        time.sleep(STEP_PAUSE)

    ui.blank()
    bar = BAR_DONE * number + BAR_TODO * (TOTAL_STEPS - number)
    ui.heading(f"[{number}/{TOTAL_STEPS}] {bar}  {STAGES[number - 1]}")
    ui.blank()


def _typed(command, run, what, optional=False):
    """Show `command` and the phrase `what` it does, wait for the user to type
    it back, then call `run` and return its result.

    Enter runs it too: the command is the only one on offer, so an empty line is
    an answer of yes. Anything else is a typo, which is named and asked again,
    since accepting something near the command would teach the wrong line. An
    `optional` command takes anything else as a no and returns SKIPPED, without
    running anything.
    """
    ui.say(f"Run the command below to {what}:")
    ui.blank()
    ui.command(f"  {command}")
    ui.blank()
    # The same shape as the workflow menu's footer, so both prompts in the run
    # say how to answer them in the same way.
    if optional:
        ui.hint("press enter to run it · or type anything else to skip it")
    else:
        ui.hint("press enter to run it · or type it out · ctrl-c to cancel")
    ui.blank()

    while True:
        typed = " ".join(ui.ask(PROMPT, suffix=" ").split())
        if typed in ("", command):
            ui.blank()
            return run()
        if optional:
            ui.blank()
            return SKIPPED
        ui.warn(f"Expected `{command}`.")


def _is_workflow(folder):
    """True if `folder` holds a `config/workflow_config.yaml`, in either layout: under
    a ported `CANYON_DIR`, or at its root."""
    return os.path.isfile(workflow_config_path(workflow_folder(folder)))


def _bundled(name):
    """The bundled workflow `name` inside the package, as a traversable."""
    return importlib.resources.files("canyonos").joinpath(STARTERS_DIR, name)


def _starter_files(name):
    """Yield (relative target path, contents) for every file of the bundled
    workflow `name`.

    Read as bytes, since a workflow may carry images beside its code, and written
    back byte for byte.
    """
    root = str(_bundled(name))
    for directory, _, filenames in os.walk(root):
        for filename in filenames:
            source = os.path.join(directory, filename)
            relative = os.path.relpath(source, root)
            with open(source, "rb") as f:
                yield relative.removesuffix(PYTHON_TEMPLATE_SUFFIX), f.read()


def _fetch(name, into=None):
    """Copy the bundled workflow `name`, a workflow group folder holding its
    `workflow_group.yaml` and the workflow `name`, into a folder of its own under `into`
    (the current directory by default) and return that folder.

    A folder already holding this workflow is returned untouched, so a second run
    after a failure keeps a filled-in `.env`. One holding anything else raises
    RuntimeError rather than being written over.

    Copied out of the package rather than fetched: a first run works on a machine
    with no network, and the workflow cannot move under the CLI between releases.
    """
    destination = os.path.join(into or os.getcwd(), name)

    if os.path.exists(destination):
        if _is_workflow(os.path.join(destination, name)):
            return destination
        raise RuntimeError(
            f"{destination} already exists and does not hold the {name} workflow. "
            "Move it or run `canyonos quickstart` from another folder."
        )

    # An install whose package data did not make it would otherwise write an
    # empty folder and fail several stages later, as a deploy with no agents.
    if not os.path.isdir(str(_bundled(name))):
        raise RuntimeError(
            f"This CanyonOS install is missing the bundled {name} workflow. "
            "Reinstall the CLI, or copy the workflow from the examples folder."
        )

    for relative, contents in _starter_files(name):
        target = os.path.join(destination, relative)
        os.makedirs(os.path.dirname(target) or destination, exist_ok=True)
        # The user's key goes in `.env`, so only they can read it.
        if relative == os.path.join(name, ENV_FILENAME):
            write_private_file(target, contents.decode("utf-8"))
        else:
            with open(target, "wb") as f:
                f.write(contents)

    return destination


def _choose_starter():
    """Show the workflow picker in the terminal and return the chosen key, or
    None when the user cancelled or there is no terminal to ask on."""
    return select_menu(
        [
            (name, f"{starter['label']} — {starter['summary']}, {starter['needs']}")
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
                "  -> run it directly, or use `canyonos deploy <workflow>` in a "
                "workflow group folder"
            )
        return None

    _step(3)
    ui.say(f"Copying {STARTERS[name]['label']} into this folder...")
    with ui.status("Copying..."):
        try:
            folder = _fetch(name)
        except RuntimeError as e:
            ui.fail(e)
            return None

    ui.ok(f"Workflow set up in ./{os.path.basename(folder)}")
    return name, folder


# Keys reach the agents only through the workflow's `.env`: the manifest passes
# it to every container as `env_file`, and an exported shell variable does not
# reach them. Each workflow ships one naming the keys it needs, so the ask is to
# edit a file that is already there rather than to answer a prompt.


def _ask_for_keys(names, folder):
    """Say which keys the workflow needs and where to put them: the `.env` of its
    workflow folder `folder`. Nothing to say for a workflow that needs none, which
    is the point of Hello World."""
    if not names:
        return

    ui.blank()
    ui.say("In another terminal, open this workflow's env file:")
    ui.blank()
    # The full path, so the command works from whatever folder that terminal
    # happens to be in -- this run's `cd` moved only this process.
    ui.command(f"  vi {os.path.join(os.getcwd(), folder, ENV_FILENAME)}")
    ui.blank()
    ui.say("Set your key in it, then carry on here:")
    ui.blank()
    for name in names:
        ui.command(f"  {name}=<your key>")
    ui.blank()


def _change_into(folder):
    """Change into `folder`. True, so `_typed` can tell it apart from a command
    that was never typed."""
    os.chdir(folder)
    return True


def _prepare_workflow(folder):
    """Finish stage 3: change into the workflow group folder. Returns True
    when it is ready to deploy.

    `cd` is typed rather than done quietly, because every command after it runs
    from in here, and a reader who missed that cannot repeat the run themselves.

    Nothing to convert: every workflow on offer is already in CanyonOS format.
    Porting an app of your own is `canyonos convert`, run in its own folder.
    """
    ui.blank()
    return bool(
        _typed(
            f"cd ./{os.path.basename(folder)}",
            lambda: _change_into(folder),
            "move into the workflow group folder, where the rest of the run happens",
        )
    )


def _deploy(folder):
    """Run stage 4: deploy the starter's workflow from its workflow group folder
    `folder`, the current one, with its API key when it has one, then check
    it and show the dashboard address. Returns True when it is up and healthy."""
    _step(4)
    name = os.path.basename(folder)
    deployed = _typed(
        f"canyonos deploy {name}",
        lambda: run_deploy([name], banner=False),
        "deploy the workflow, building each agent's image",
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
    """Run stage 5: `canyonos doctor` a second time, which switches to its
    post-deploy checklist once it finds a running deploy. Returns True when every
    check passed.

    A stack that only came up part way turns the first request into a long wait
    and then a timeout; this names the missing piece instead.
    """
    _step(5)
    passed = _typed(
        "canyonos doctor",
        run_doctor,
        "check the running workflow group: controller, Redis, agents, endpoint, dashboard",
    )
    if passed is None:
        return False
    if passed:
        ui.blank()
        ui.ok("Workflow group health checks passed.")
        return True

    ui.blank()
    ui.fail("Workflow group health checks failed, so a request would not get through.")
    ui.hint("  -> resolve the items above, then run `canyonos quickstart` again")
    return False


def _deploy_is_up():
    """Whether a deploy is running right now. Asked on the way out of an
    interrupted run, so it can say what it left behind."""
    try:
        return is_running(deploy_status(load_state()))
    except (KeyError, OSError, RuntimeError, ValueError):
        return False


def _offer_clean():
    """Close the run by offering `canyonos clean`. Always True.

    The one optional command here: leaving the workflow up is a fine way to
    finish, and the dashboard just pointed at belongs to the deploy this would
    remove. So anything other than the command is taken as a no.

    `clean` rather than `stop`, because the offer is to undo the run: `stop`
    would leave the agents' images and the workflow's `.canyon` behind on a
    machine someone may have been trying CanyonOS out on. It stops the deploy
    first itself, so one typed command still covers the whole teardown.
    """
    ui.blank()
    result = _typed(
        "canyonos clean",
        run_clean,
        "stop the workflow and remove what the deploy created",
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


def _sample_query(folder="."):
    """The test query of the workflow in `folder` and the file it came from, looked
    for in both the ported `CANYON_DIR` layout and a `config/` at the workflow root.
    `(None, None)` when the workflow ships none."""
    for path in (
        os.path.join(folder, CANYON_DIR, "config", "test_query.txt"),
        os.path.join(folder, "config", "test_query.txt"),
    ):
        try:
            with open(path, encoding="utf-8") as f:
                query = f.read().strip()
        except OSError:
            continue
        if query:
            return query, path
    return None, None


def _show_dashboard(caption="Watch it run in the dashboard:"):
    """Show the dashboard address in the terminal, or say how to start it. Never
    opens a browser: on a server there is none to open."""
    port = running_web_port()
    if port is None:
        ui.warn("The dashboard is not running -- start it with `canyonos serve`.")
        return

    ui.blank()
    ui.say(caption)
    ui.command(f"  {dashboard_url(port)}")


def _await_result(endpoint, request_id, key, timeout=REQUEST_TIMEOUT):
    """Poll the endpoint with the API key `key`, if any, until the request is done or
    errors, showing a spinner in the terminal meanwhile. Returns what it answered with,
    or `{"status": "timeout"}`."""
    url = f"http://{endpoint['public_host']}:{endpoint['api_port']}/status/{request_id}"
    request = urllib.request.Request(url, headers=bearer_header(key))
    deadline = time.time() + timeout
    with ui.status("Waiting for the workflow..."):
        while time.time() < deadline:
            try:
                # The URL is always http:// to the workflow group's own endpoint, never a
                # caller's scheme, which the rule cannot see.
                # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
                with urllib.request.urlopen(request, timeout=POLL_TIMEOUT) as answer:
                    data = json.loads(answer.read())
                if data.get("status") in ("done", "error"):
                    return data
            except (OSError, ValueError):
                # A blip or a half-written body while the workflow is busy; the
                # deadline ends this loop, not one failed poll.
                pass
            time.sleep(POLL_INTERVAL)
    return {"status": "timeout"}


def _curl_for(endpoint, folder, keyed):
    """The `curl` stage 6 asks for, with the API key's placeholder header when the
    deploy is `keyed`, and the file its query came from.

    Built from what the deploy published -- the address and method from the
    manifest, the body keys from the served method's own arguments -- so it works
    as shown rather than needing an edit. It is one line, and the query is
    flattened to single spaces, because it has to survive being typed.
    """
    query, query_path = _sample_query(folder)
    if query:
        query = " ".join(query.split())
    # The starter serves one route.
    route = endpoint["routes"][0]
    body = json.dumps({name: query or f"your {name}" for name in route["arguments"]})
    authorization = f"{BEARER_PLACEHOLDER} " if keyed else ""
    command = (
        f"curl -X POST {route['url']} "
        f"{authorization}"
        f"-H 'Content-Type: application/json' "
        f"-d '{body}'"
    )
    return command, query_path


def _with_key(command, key):
    """The arguments of `command` with the API key `key` in place of its placeholder."""
    placeholder = shlex.split(BEARER_PLACEHOLDER)[1]
    return [
        f"Authorization: Bearer {key}" if key and word == placeholder else word
        for word in shlex.split(command)
    ]


def _send_request(command, endpoint, key):
    """Run the typed `curl`, with the API key `key` in place of its placeholder, wait
    for the workflow, and show the result in the terminal. Returns True when it
    answered.

    The command is run rather than turned back into an HTTP call from here, so
    the request is the user's own. Splitting it is safe because it is this
    module's string: `_typed` only calls through on an exact match.
    """
    try:
        sent = subprocess.run(
            _with_key(command, key),
            capture_output=True,
            text=True,
            timeout=SUBMIT_TIMEOUT,
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
    data = _await_result(endpoint, request_id, key)

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


def _first_request(workflow, folder):
    """Run stage 6: send the first request to the starter in the folder `folder`,
    fill the dashboard with `workflow`'s
    recorded runs, then offer to take the deploy down. Returns True when the
    workflow answered.

    The teardown is part of this stage rather than something after the run: the
    deploy is up whether or not the request landed, so the offer has to come
    either way, and it is the last thing anyone does here.
    """
    _step(6)
    answered = _send_first_request(folder)
    # Whether or not the request landed. A workflow shipping a placeholder key
    # fails its first request until someone fills one in, and that is the run
    # that most needs a dashboard with something in it.
    _add_sample_data(workflow)
    _show_dashboard("See your request and the example runs in the dashboard:")
    _offer_clean()
    return answered


def _add_sample_data(workflow):
    """Ask the dashboard to add `workflow`'s example runs to each workflow of this
    workflow group, whether or not the first request worked. Never fails the run."""
    try:
        state = load_state()
        registered = register_workflows(state)
        ui.blank()
        ui.say("Adding example runs to the dashboard...")
        spans = sum(
            add_sample_data(state["workflow_group_id"], entry["workflow_id"], workflow)[
                "spans"
            ]
            for entry in registered
        )
    except (KeyError, OSError, RuntimeError, ValueError, RegistrationError) as e:
        ui.warn(f"The dashboard kept only this run's trace: {e}")
        return

    ui.ok(f"Added example runs ({spans} spans).")


def _send_first_request(folder):
    """Show the `curl` for the deployed endpoint, with the query of the starter in
    `folder` and the API key's placeholder when the workflow group has a key, wait for the
    user to type it, send it with the key and wait for the answer. True when the
    workflow answered."""
    try:
        endpoint = (deploy_status(load_state()) or {}).get("endpoint")
    except (KeyError, OSError, RuntimeError, ValueError):
        endpoint = None
    if endpoint is None:
        ui.warn("Could not read the endpoint -- `canyonos status` prints it.")
        return False

    key = group_api_key()
    command, query_path = _curl_for(endpoint, folder, key is not None)
    if key:
        ui.hint(
            "  type <your api key> as shown: quickstart sends this workflow group's "
            "key in its place"
        )
    if query_path:
        ui.hint(f"  query from {query_path}")
    ui.blank()

    return bool(
        _typed(
            command,
            lambda: _send_request(command, endpoint, key),
            "send one request through the workflow and wait for the answer",
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
        "check that Docker is installed and running, with Docker Compose",
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

    # `canyonos deploy` runs from the workflow group folder, which names the workflow group
    # and holds its `workflow_group.yaml`, and every command after it runs from there.
    # So the run changes into it, the way a user would `cd`.
    if not _prepare_workflow(folder):
        return False

    _ask_for_keys(STARTERS[name]["secrets"], name)

    if not _deploy(folder):
        return False

    # Stage 6 makes the teardown offer itself, on its way out either way.
    if not _first_request(name, os.path.join(folder, name)):
        return False

    ui.blank()
    ui.ok("CanyonOS quickstart completed.")
    ui.blank()
    ui.say("Do you want to build your own workflow?")
    ui.hint(f"  CHECK OUT:{FROM_SCRATCH_URL}")
    return True
