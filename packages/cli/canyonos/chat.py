# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos chat`: call running workflows from one terminal session. Each
call is a box per argument of the workflow; `/add <curl command>` remembers a new
workflow and `/switch` picks or deletes one; run from a deployment's folder, its
running workflows are added first. The questions a workflow asks are answered in
boxes as they come, and `/recent` shows the result of one of the last requests again.
"""

import json
import math
import shlex
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from pyfiglet import figlet_format
from rich.console import Group
from rich.markdown import Markdown
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from canyonos import ui
from canyonos.auth import query_token
from canyonos.constants import deployment_config_path, read_config
from canyonos.gc import GCError, _error_detail, deployed_endpoint, existing_deploy
from canyonos.os_support import is_terminal, write_private_file
from canyonos.test import TOKEN_TTL_SECONDS, _parse_answer, _query_route, _Run
from canyonos.theme import GREEN, WHITE
from utils import tui

WORKFLOWS_FILE = Path.home() / ".canyonos" / "chat.json"
REQUESTS_FILE = Path.home() / ".canyonos" / "chat-requests.json"
RECENT_REQUESTS = 5
HINT = "tab next box · enter send · / commands"
COMMANDS = {
    "/add": "add a workflow from its curl command",
    "/switch": "pick another workflow, or delete one",
    "/recent": "show the result of one of the last requests",
    "/clear": "clear the screen",
    "/quit": "leave the chat",
}


def _load_workflows():
    """Return the remembered workflows, last used first: each its `url`, the type name
    of each argument, by name, and either the `project_id` chat signs query tokens for
    or the `authorization` header its curl command sent."""
    try:
        return json.loads(WORKFLOWS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []


def _from_curl(text):
    """Read the workflow a pasted `curl ... <url> ... -d '<json>'` command calls: its
    URL, the type name of each argument in its body, by name, and the Authorization
    header it sends, if any."""
    # A curl split over lines ends each with a backslash.
    words = shlex.split(text.replace("\\\n", " "))
    url = next(word for word in words if word.startswith(("http://", "https://")))
    body = json.loads(words[words.index("-d") + 1])
    # A workflow's route is `/<project>/<agent>/<method>` and its body a JSON object.
    if len(urlsplit(url).path.strip("/").split("/")) < 3 or not isinstance(body, dict):
        raise ValueError("not a workflow's curl command")
    headers = [words[i + 1] for i, word in enumerate(words[:-1]) if word == "-H"]
    authorization = next(
        (
            value.partition(":")[2].strip()
            for value in headers
            if value.partition(":")[0].strip().lower() == "authorization"
        ),
        None,
    )
    workflow = {
        "url": url,
        "arguments": {name: type(value).__name__ for name, value in body.items()},
    }
    if authorization:
        workflow["authorization"] = authorization
    return workflow


def _deployed_workflows():
    """Return the workflows of the deploy running from this folder, each argument read
    as text and each queried with tokens signed for its `deployment_id`, or none when
    no deploy runs here."""
    existing = existing_deploy()
    if existing is None:
        return []
    project_id = read_config(deployment_config_path()).get("deployment_id")
    return [
        {
            "url": route["url"],
            "arguments": {name: "str" for name in route["arguments"]},
            "project_id": project_id,
        }
        for route in deployed_endpoint(existing["port"])["routes"]
    ]


def _signer(workflow, key, auth_dir):
    """A function returning the header each request to `workflow` sends: a new query
    token for its `project_id`, signed with the private key `key` in `auth_dir` and
    valid for TOKEN_TTL_SECONDS, else the Authorization its curl command sent, else
    none."""
    if workflow.get("project_id"):

        def signed():
            token = query_token(
                workflow["project_id"], key, auth_dir, TOKEN_TTL_SECONDS
            )
            return {"Authorization": f"Bearer {token}"}

        return signed
    if workflow.get("authorization"):
        return lambda: {"Authorization": workflow["authorization"]}
    return dict


def _save(workflows):
    """Remember `workflows`, last used first, for the next `canyonos chat`, readable only
    by you since a curl command's token is kept with its workflow."""
    WORKFLOWS_FILE.parent.mkdir(parents=True, exist_ok=True)
    write_private_file(WORKFLOWS_FILE, json.dumps(workflows, indent=2))


def _remember(workflows, new):
    """Put the `new` workflows first in `workflows`, in place of any with the same URL,
    and save them."""
    urls = {workflow["url"] for workflow in new}
    workflows[:] = new + [w for w in workflows if w["url"] not in urls]
    _save(workflows)


def _answer_in_boxes(question, schema):
    """Show the workflow's `question` as Markdown, ask for each key of its `schema`,
    which maps it to its Python type name, in a box, and return the answers by key;
    Ctrl-C or Ctrl-D stops waiting for the workflow instead."""
    ui.say("The workflow asks:")
    ui.panel(Markdown(question))
    labels = [f"{key} ({kind})" for key, kind in schema.items()]
    values = tui.input_form(labels, "answer the question above · enter send")
    if values is None:
        raise KeyboardInterrupt
    return {
        key: _parse_answer(value, kind)
        for (key, kind), value in zip(schema.items(), values)
    }


def _grid(rows, padding=(0, 2, 0, 0)):
    """Return `rows` as a grid, each cell wrapping inside its own column; `padding` is
    the space (top, right, bottom, left) between cells."""
    grid = Table.grid(padding=padding, collapse_padding=False)
    for row in rows:
        grid.add_row(*row)
    return grid


def _styled(value):
    """Return how to show `value`, a workflow's result or part of one: text with line
    breaks as Markdown, other text white, numbers cyan, and true, false, null and empty
    lists yellow, like `jq`; a dict as dim keys beside their values; a list of dicts as
    cards a blank line apart; any other list one item per line."""
    if isinstance(value, str):
        return Markdown(value) if "\n" in value else Text(value, WHITE)
    if isinstance(value, bool) or value in (None, [], {}):
        return Text(json.dumps(value), "yellow")
    if isinstance(value, (int, float)):
        return Text(str(value), "cyan")
    if isinstance(value, dict):
        return _grid((Text(key, "dim"), _styled(item)) for key, item in value.items())
    if all(isinstance(item, dict) for item in value):
        return _grid([(_card(record),) for record in value], (0, 0, 1, 0))
    return _grid((Text("•", "dim"), _styled(item)) for item in value)


def _card(record):
    """Return a dict as a card: its title, name or first one-line text in bold, then
    its other keys."""
    title = next(
        (
            key
            for key in ("title", "name", *record)
            if isinstance(record.get(key), str) and "\n" not in record[key]
        ),
        None,
    )
    heading = [Text(record[title], f"bold {WHITE}")] if title else []
    return Group(*heading, _styled({k: v for k, v in record.items() if k != title}))


def _show(result):
    """Show a workflow's result after a green ●: text as Markdown, anything else laid out
    by `_styled`; a dict's text with line breaks and lists of dicts come last, each under
    its key in bold green, using the full width and a blank line apart."""
    shown = Markdown(result) if isinstance(result, str) else _styled(result)
    if isinstance(result, dict):
        wide = [
            key
            for key, value in result.items()
            if (isinstance(value, str) and "\n" in value)
            or (value and isinstance(value, list) and isinstance(value[0], dict))
        ]
        narrow = {k: v for k, v in result.items() if k not in wide}
        blocks = [_styled(narrow)] if narrow else []
        blocks += [Group(Text(k, f"bold {GREEN}"), _styled(result[k])) for k in wide]
        shown = _grid([(block,) for block in blocks], (0, 0, 1, 0))
    ui.blank()
    ui.panel(_grid([(Text("●", GREEN), shown)], (0, 1, 0, 0)))


def _load_requests():
    """Return the last requests sent from chat, by workflow URL, newest first: each its
    `id`, when it was sent (`at`) and what was typed (`input`)."""
    try:
        return json.loads(REQUESTS_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def _note_request(url, request_id, values):
    """Remember request `request_id`, sent to the workflow at `url` with the typed
    `values`, as its newest, keeping its last RECENT_REQUESTS."""
    requests = _load_requests()
    sent = {
        "id": request_id,
        "at": time.strftime("%Y-%m-%d %H:%M"),
        "input": " · ".join(values),
    }
    requests[url] = [sent, *requests.get(url, [])][:RECENT_REQUESTS]
    REQUESTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    REQUESTS_FILE.write_text(json.dumps(requests, indent=2), encoding="utf-8")


def _show_recent(workflow, sign):
    """Ask which of the last requests sent to `workflow` to show, and show its result,
    or its error or state, as the endpoint has it now, asked with the header `sign`
    returns."""
    recent = _load_requests().get(workflow["url"], [])
    if not recent:
        ui.say("No requests saved yet; chat saves the ones it sends from now on.")
        return
    options = [(r, f"{r['at']}  {r['input'][:60]}".replace("\n", " ")) for r in recent]
    picked = tui.select_menu(options, "Show the result of")
    if picked is None:
        return
    parts = urlsplit(workflow["url"])
    url = f"{parts.scheme}://{parts.netloc}/status/{picked['id']}"
    try:
        request = urllib.request.Request(url, headers=sign())
        with urllib.request.urlopen(request, timeout=10) as response:
            status = json.loads(response.read())
    except RuntimeError as e:
        ui.fail(str(e))
        return
    except urllib.error.HTTPError as e:
        ui.fail(f"Could not read request {picked['id']}: {_error_detail(e)}")
        return
    except OSError as e:
        ui.fail(f"Could not reach the workflow at {url}: {e}")
        return
    ui.hint(f"{picked['at']}  {picked['input']}")
    if status["status"] == "done":
        _show(status["result"])
    elif status["status"] == "error":
        ui.fail(status["error"])
    else:
        ui.say(f"Request {picked['id']} is {status['status'].replace('_', ' ')}.")


def _call(workflow, values, sign):
    """Call `workflow` with `values`, typed in its argument boxes in order, each request
    with the header `sign` returns, answer the questions it asks, and show its result
    or error, then its request ID and how long it took."""
    arguments = workflow["arguments"].items()
    body = {
        name: _parse_answer(value, kind)
        for (name, kind), value in zip(arguments, values)
    }
    parts = urlsplit(workflow["url"])
    base = f"{parts.scheme}://{parts.netloc}"
    run = _Run(None)
    started = time.monotonic()
    try:
        result = _query_route(
            # No time limit: Ctrl-C stops waiting instead.
            run,
            base,
            workflow["url"],
            body,
            math.inf,
            sign,
            _answer_in_boxes,
        )
    except RuntimeError as e:
        ui.fail(str(e))
    except KeyboardInterrupt:
        ui.fail("Stopped waiting; the workflow may still be running.")
    else:
        _show(result)
    if run.request_id:
        ui.hint(f"request {run.request_id} · {time.monotonic() - started:.1f}s")
        _note_request(workflow["url"], run.request_id, values)


def _open(workflow):
    """Clear the terminal and show the banner, then the project, agent, method and URL
    of the workflow the boxes call."""
    ui.console.clear()
    size = shutil.get_terminal_size()
    boxes = (len(workflow["arguments"]) or 1) if workflow else 1
    # The banner is 75 columns by 6 rows; it shows only with room left for the boxes.
    if size.columns > 75 and size.lines >= 20 + 3 * boxes:
        ui.gradient(figlet_format("CANYON OS", font="ansi_shadow", width=200))
    about = "No workflow yet: type /add <its curl command>"
    if workflow:
        url = workflow["url"]
        project, agent, method = urlsplit(url).path.strip("/").split("/")[-3:]
        about = f"project   {project}\nworkflow  {agent}.{method}\nendpoint  {url}"
    ui.panel(Panel(Text(about, WHITE), border_style=GREEN, expand=False))


def run_chat(key=None, auth_dir=None):
    """Run `canyonos chat`, starting on the newest remembered workflow, until /quit,
    Ctrl-C or Ctrl-D in its boxes, signing query tokens with the private key `key` in
    `auth_dir`; return the exit code."""
    if not is_terminal(sys.stdin):
        ui.fail("`canyonos chat` needs a terminal to type in.")
        return 1
    workflows = _load_workflows()
    error = None
    try:
        if deployed := _deployed_workflows():
            _remember(workflows, deployed)
    except GCError as e:
        error = f"Could not read the workflows of the deploy running here: {e}"
    workflow = workflows[0] if workflows else None
    _open(workflow)
    # What was sent to each workflow this session, by URL, for Ctrl-P and Ctrl-N.
    history = {}
    try:
        while True:
            arguments = workflow["arguments"] if workflow else {}
            # A workflow without arguments still needs a box to type commands in.
            labels = [f"{n} ({kind})" for n, kind in arguments.items()] or ["command"]
            sent = history.setdefault(workflow["url"], []) if workflow else []
            values = tui.input_form(labels, HINT, error, COMMANDS, sent)
            error = None
            if values is None or values[0] == "/quit":
                return 0
            if values[0].startswith("/add "):
                try:
                    workflow = _from_curl(values[0][len("/add ") :])
                except (StopIteration, ValueError):
                    error = "That is not a workflow's curl command."
                    continue
                _remember(workflows, [workflow])
                _open(workflow)
            elif values[0] == "/switch":
                options = [(w, w["url"]) for w in workflows]
                picked = tui.select_menu(options, "Switch to", deletable=True)
                if isinstance(picked, tuple):
                    workflows.remove(picked[1])
                    _save(workflows)
                    if picked[1] == workflow:
                        workflow = workflows[0] if workflows else None
                elif picked:
                    workflow = picked
                    _remember(workflows, [workflow])
                _open(workflow)
            elif values[0] == "/clear":
                _open(workflow)
            elif workflow is None:
                error = "Add a workflow first: /add <its curl command>"
            elif values[0] == "/recent":
                _show_recent(workflow, _signer(workflow, key, auth_dir))
            else:
                sent.append(values)
                _call(workflow, values, _signer(workflow, key, auth_dir))
    finally:
        # Give the whole screen back to the shell, with its prompt under the boxes.
        sys.stderr.write(f"\x1b[r\x1b[{shutil.get_terminal_size().lines};1H\n")
