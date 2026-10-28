# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos test`: check a project end to end on this machine.

Three phases, each ending the run if it fails:
- The project is deployed locally (the deployment's `provider` set to `local` for the duration, the original file restored verbatim afterwards)
- The running containers are checked against what the config declared
- One prompt is sent to the endpoint.

A passing run leaves nothing behind. A failing one leaves the Global Controller
container up, with the tail of its log, so there is something left to debug.

This file will also need lots of iteration based on what is needed, will expect it to change alot
"""

import json
import subprocess
import time
import urllib.error
import urllib.request

from rich.panel import Panel
from rich.text import Text

from canyonos import ui
from canyonos.constants import (
    endpoint_answers,
    endpoint_api_port,
    existing_config_path,
    round_trip_yaml,
    write_config,
)
from canyonos.deploy import (
    STARTUP_TIMEOUT_SECONDS,
    UP_MARKER,
    PhaseTracker,
    drain,
    follow_gc_log,
    queued_lines,
    run_deploy,
    save_project_id,
)
from canyonos.gc import _error_detail, deploy_status, deployed_endpoint
from canyonos.init import docker_env, load_state, quit_existing
from canyonos.theme import GREEN, WHITE
from canyonos.verify import verify_runtime

DEFAULT_QUERY = "hello"
READY_TIMEOUT = STARTUP_TIMEOUT_SECONDS
REQUEST_TIMEOUT = 300
SUBMIT_TIMEOUT = 30
POLL_INTERVAL = 2
LOG_TAIL_LINES = 40
DOCKER_LOGS_TIMEOUT = 30


def _force_local_providers(config_path):
    """Set the deployment's provider to `local`. Returns the original file's bytes,
    which put it back exactly, line endings included."""
    with open(config_path, "rb") as f:
        original = f.read()

    yaml_rt = round_trip_yaml()
    # Without the CRs: ruamel keeps them inside comments and write_config adds its own.
    data = yaml_rt.load(original.decode("utf-8").replace("\r\n", "\n"))

    data["provider"] = "local"

    write_config(config_path, data, yaml_rt)

    return original


def _root_cause(state):
    """Read the Global Controller's log and explain the first line `canyonos deploy`
    would flag as the failure, or return None when nothing in it was fatal."""
    try:
        result = subprocess.run(
            ["docker", "logs", state["container_id"]],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            errors="replace",
            env=docker_env(state),
            timeout=DOCKER_LOGS_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        return None
    lines = result.stdout.splitlines()
    tracker = PhaseTracker()
    for index, line in enumerate(lines):
        if tracker.parse_line(line)[2]:
            return tracker.explain_failure(line, lines[index + 1 :])
    return None


class _DeployFailed(RuntimeError):
    """Raised when the deploy never brought the workflow up; `root_cause` says why,
    when the Global Controller's log does."""

    def __init__(self, message, root_cause):
        super().__init__(message)
        self.root_cause = root_cause


def _wait_for_endpoint(state, api_port):
    """Follow the Global Controller's log until it says the deploy is up, which it
    only says after the agents are, for as long as `canyonos deploy` would; then
    check the endpoint answers.

    Ends early only when the deploy itself stops, so the Root Cause is read from
    the finished deploy's log rather than one still building.
    """
    deadline = time.monotonic() + READY_TIMEOUT
    process = follow_gc_log(state)
    tracker = PhaseTracker()
    try:
        with ui.status("Building images and starting containers..."):
            for line in drain(queued_lines(process.stdout), state, deadline=deadline):
                tracker.parse_line(line)
                if UP_MARKER in line and not tracker.in_container_log:
                    if endpoint_answers(api_port):
                        return
                    raise _DeployFailed(
                        f"The deploy is up, but nothing answers on port {api_port}.",
                        _root_cause(state),
                    )
    finally:
        process.terminate()
    if time.monotonic() < deadline:
        raise _DeployFailed(
            "The deploy stopped before the workflow came up.", _root_cause(state)
        )
    raise _DeployFailed(
        f"Timed out after {READY_TIMEOUT}s waiting for the workflow to come up.",
        _root_cause(state),
    )


def _send_query(url, body):
    """POST a query or an answer to the endpoint and return the request ID it sends back."""
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=SUBMIT_TIMEOUT) as resp:
        payload = resp.read()
    try:
        return json.loads(payload)["request_id"]
    except (ValueError, KeyError, TypeError) as e:
        raise RuntimeError(
            f"The workflow accepted the request but returned an unexpected response "
            f"(no request_id): {e}"
        ) from None


def _await_result(endpoint, request_id, timeout):
    """Poll the endpoint until the request is done, errors or waits for an answer, or
    return `{"status": "timeout"}`."""
    url = f"http://{endpoint['public_host']}:{endpoint['api_port']}/status/{request_id}"
    deadline = time.time() + timeout
    with ui.status("Running query..."):
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(url, timeout=10) as resp:
                    data = json.loads(resp.read())
                if data.get("status") in ("done", "error", "input_required"):
                    return data
            except (OSError, ValueError):
                # A network blip or a malformed body while the workflow is busy; keep polling.
                pass
            time.sleep(POLL_INTERVAL)
    return {"status": "timeout"}


def _log_tail(state):
    result = subprocess.run(
        ["docker", "logs", "--tail", str(LOG_TAIL_LINES), state["container_id"]],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        env=docker_env(state),
        timeout=DOCKER_LOGS_TIMEOUT,
    )
    return (result.stdout + result.stderr).strip() or None


class _Run:
    """One `canyonos test` invocation: the phases it got through, and what they found."""

    def __init__(self, query):
        self.query = query
        self.started = time.monotonic()
        # Only once a deploy is under way is the container worth keeping and its
        # log worth reading; before that it holds nothing about the failure.
        self.deploy_started = False
        # True when we queried a deploy that was already up rather than standing
        # up our own -- it must not be torn down afterwards, it isn't ours.
        self.against_existing = False
        self.phases = []
        self.runtime = None
        self.endpoint = None
        self.result = None
        self.error = None
        self.log_tail = None
        self.root_cause = None

    def begin(self, name, number, title, total=3):
        """Open a phase, recorded as failed until `done` says otherwise."""
        self.phases.append({"name": name, "ok": False, "detail": None})
        ui.blank()
        ui.say(f"[{number}/{total}] {title}")

    def done(self, detail=None):
        """Mark the current phase passed, with a short detail for the summary."""
        self.phases[-1].update(ok=True, detail=detail)

    def failed(self, detail):
        """Record the error on the current phase."""
        if self.phases:
            self.phases[-1]["detail"] = detail

    def elapsed(self):
        """Return seconds since the test started."""
        return round(time.monotonic() - self.started, 3)


def _deploy_locally(run, api_port):
    """Deploy the project locally for `canyonos test` and wait until the
    workflow answers."""
    run.begin("deploy", 1, "Deploy locally")

    # quiet: readiness is checked below.
    state = run_deploy(serve=False, quiet=True, banner=False)
    run.deploy_started = True

    _wait_for_endpoint(state, api_port)
    run.done(f"Global Controller on port {state['port']}")
    return state


def _verify_runtime(run, config_path):
    run.begin("verify_runtime", 2, "Verify runtime")
    run.runtime = verify_runtime(config_path)
    run.done(f"{len(run.runtime['agents'])} agent(s) up")


def _read_answer(prompt, kind):
    """Read one answer to the workflow's question from the terminal: as typed when
    `kind` is `str`, otherwise as JSON when it parses and as typed when it doesn't."""
    text = input(prompt)
    if kind == "str":
        return text
    try:
        return json.loads(text)
    except ValueError:
        return text


def _query(run, endpoint, timeout, number=3, total=3):
    """Send the test query to the deployed endpoint, as every argument of its method,
    and store the result on the run; raises if it errors or times out."""
    run.begin("query", number, "Query the workflow", total=total)
    body = {name: run.query for name in endpoint["arguments"]}
    run.endpoint = endpoint["url"]
    ui.say(f"POST {run.endpoint}  {json.dumps(body)}")

    try:
        request_id = _send_query(run.endpoint, body)
    except OSError as e:
        raise RuntimeError(
            f"Could not reach the workflow at {run.endpoint}: {e}"
        ) from None

    data = _await_result(endpoint, request_id, timeout)
    answer_url = (
        f"http://{endpoint['public_host']}:{endpoint['api_port']}/answer/{request_id}"
    )
    while data.get("status") == "input_required":
        # Quiet means --json: the question can't be shown, and a script can't answer it.
        if ui.console.quiet:
            raise RuntimeError(
                "The workflow asked a question, which --json can't answer. "
                "Run `canyonos test` without --json to answer it."
            )
        asked = data["question"]
        schema = asked["input_schema"]
        ui.say(f"The workflow asks: {json.dumps(asked['question'])}")
        body = {}
        for key, kind in schema.items():
            prompt = f"{key} ({kind}): "
            if list(schema) == ["input"]:
                prompt = "Your answer: " if kind == "str" else f"Your answer ({kind}): "
            body[key] = _read_answer(prompt, kind)
        try:
            _send_query(answer_url, body)
        except urllib.error.HTTPError as e:
            raise RuntimeError(
                f"Could not send the answer to {answer_url}: {_error_detail(e)}"
            ) from None
        except OSError as e:
            raise RuntimeError(
                f"Could not send the answer to {answer_url}: {e}"
            ) from None
        data = _await_result(endpoint, request_id, timeout)
    status = data.get("status")
    if status == "error":
        raise RuntimeError(data.get("error") or "the workflow returned an error.")
    if status != "done":
        raise RuntimeError(f"The workflow did not finish within {timeout}s.")

    run.result = data.get("result")
    run.done(f"answered in {run.elapsed()}s")


def _existing_deploy():
    """The running deploy's state if one is already up, else None."""
    try:
        state = load_state()
    except FileNotFoundError:
        return None
    if (deploy_status(state["port"]) or {}).get("running", False):
        return state
    return None


def _run_test(run, timeout=REQUEST_TIMEOUT):
    """Query the workflow, standing up our own local deploy first unless one is
    already up. The config is restored whatever happens."""
    config_path = existing_config_path()

    existing = _existing_deploy()
    if existing is not None:
        # A deploy is already up: query it exactly as it stands (its own
        # providers, no local flip) instead of tearing it down to stand up our
        # own. This is the only phase, and we leave it running.
        endpoint = deployed_endpoint(existing["port"])
        run.against_existing = True
        ui.say(
            "A deploy is already up -- querying it as it stands (providers unchanged)."
        )
        _query(run, endpoint, timeout, number=1, total=1)
        return

    api_port = endpoint_api_port(config_path)
    if api_port is None:
        raise RuntimeError(
            f"No `endpoint:` block with a port number in {config_path}; "
            "nothing to test."
        )

    # Minted here, before the snapshot, so restoring the file keeps the id.
    save_project_id(config_path)
    original_config = _force_local_providers(config_path)
    try:
        state = _deploy_locally(run, api_port)
        _verify_runtime(run, config_path)
        _query(run, deployed_endpoint(state["port"]), timeout)
    finally:
        with open(config_path, "wb") as f:
            f.write(original_config)


# ------------------------------------------------------------------ #
#  Output                                                             #
# ------------------------------------------------------------------ #


def _summary_body(run):
    """Build the text of the `canyonos test` results panel: what ran, and the result."""
    body = Text()
    body.append("Input      ", "dim")
    body.append(run.query, WHITE)
    if run.endpoint:
        body.append("\nEndpoint   ", "dim")
        body.append(run.endpoint, WHITE)
    body.append("\nElapsed    ", "dim")
    body.append(f"{run.elapsed()}s", WHITE)

    body.append("\n")
    for phase in run.phases:
        body.append("\n")
        body.append("✓ " if phase["ok"] else "✗ ", GREEN if phase["ok"] else "bold red")
        body.append(f"{phase['name']:<16}", WHITE)
        # The failing phase's detail is the error, spelled out below in full.
        body.append(phase["detail"] if phase["ok"] else "", "dim")

    body.append("\n\n")
    if run.error is None:
        body.append("Output     ", "dim")
        body.append(json.dumps(run.result, indent=2), WHITE)
    else:
        body.append(run.error, "bold red")
    return body


def _print_summary(run):
    """Show the pass/fail results panel in the terminal when `canyonos test` ends."""
    passed = run.error is None
    ui.blank()
    ui.panel(
        Panel(
            _summary_body(run),
            title=f"[bold {GREEN}]Test passed[/]"
            if passed
            else "[bold red]Test failed[/]",
            title_align="left",
            border_style=GREEN if passed else "red",
            padding=(1, 4),
        )
    )
    ui.blank()


def _print_failure_logs(run):
    if run.log_tail:
        ui.hint(f"last {LOG_TAIL_LINES} lines of the Global Controller log:")
        ui.say(run.log_tail)
        ui.blank()


def _payload(run):
    return {
        "ok": run.error is None,
        "query": run.query,
        "against_existing_deploy": run.against_existing,
        "elapsed_s": run.elapsed(),
        "phases": run.phases,
        "runtime": run.runtime,
        "result": run.result,
        "error": run.error,
        "log_tail": run.log_tail,
        "root_cause": run.root_cause,
    }


def run_test(prompt=None, as_json=False, timeout=REQUEST_TIMEOUT):
    """Run `canyonos test`: deploy the project, send one query, report the result, and
    return the exit code. A failed deploy is left running for debugging."""
    run = _Run(prompt or DEFAULT_QUERY)
    ui.set_quiet(as_json)

    try:
        container_live = False
        try:
            _run_test(run, timeout=timeout)
        except KeyboardInterrupt:
            run.error = "cancelled by user"
        except EOFError:
            run.error = (
                "The workflow asked a question, but there is no terminal to answer it."
            )
        except RuntimeError as e:
            # Every phase raises RuntimeError with a message fit for the terminal and `--json`.
            run.error = str(e)
            run.root_cause = getattr(e, "root_cause", None)

        if run.error is not None:
            run.failed(run.error)

        if run.error is not None and run.deploy_started:
            # Read the log before anything else touches the container, and leave
            # it running -- a torn-down deploy can't be diagnosed.
            try:
                run.log_tail = _log_tail(load_state())
                container_live = True
            except (OSError, subprocess.TimeoutExpired):
                pass
        elif run.error is None and not run.against_existing:
            quit_existing()
        # else: either we queried a deploy that was already up (not ours to tear
        # down), or we failed before this run ever started its own deploy (e.g.
        # bad config) -- leave whatever was already there alone.

        if as_json:
            print(json.dumps(_payload(run), indent=2))
        else:
            _print_summary(run)
            if container_live:
                _print_failure_logs(run)
            if run.root_cause:
                ui.hint("Recent Logging Trace Above, Root Cause Below.")
                ui.root_cause(run.root_cause)

        return 0 if run.error is None else 1
    finally:
        ui.set_quiet(False)
