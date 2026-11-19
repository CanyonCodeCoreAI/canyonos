# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos deploy`: bring up the CanyonOS API, create the Global Controller
container, register the workflow group with the dashboard, and upload the workflow
group to its /workspace volume through the API (via `canyonos sync`), which then
starts the container to build and deploy it. The
container's `canyonos deploy` handles both the build (stubs, protos, Docker images)
and the launch -- the CLI just ships files and shows what the API's status says it is
doing.

By default only the deploy's finished steps and current step are shown; `-v`
streams its whole log, and a failure prints the last of it and the root cause.

Once the workflow is up, `canyonos serve` is kicked off automatically so the
local dashboard is ready without an extra manual step -- `canyonos logs`
follows the deploy's log on demand.
"""

import json
import os
import shlex
import sys
import threading
import time
import uuid

from rich.panel import Panel
from rich.text import Text

from canyonos import deployment, internal_ca, ui
from canyonos.auth import (
    curl_auth,
    gc_env,
    hash_api_key,
    resolve_api_key,
)
from canyonos.constants import (
    DEFAULT_API_PORT,
    dashboard_port,
    deployment_config_path,
    endpoint_api_port,
    load_yaml,
    read_config,
    round_trip_yaml,
    sends_to_dashboard,
    workflow_config_path,
    workflow_folder,
    write_config,
)
from canyonos.api import ApiError, controller_log, deploy_status
from canyonos.dashboard_stack import (
    _dashboard_lock,
    dashboard_url,
    run_dashboard,
    running_web_port,
    stop_dashboard,
)
from canyonos.kubernetes_target import _open_dashboard, keep_endpoint_forwarded
from canyonos.theme import GREEN, WHITE
from canyonos.init import (
    _ensure_docker_running,
    load_state,
    remember_api_port,
    run_init,
)
from canyonos.new_app import deployment_template
from canyonos.os_support import is_terminal
from canyonos.resources import configure_resources
from canyonos.serve import (
    _warn_if_dashboard_port_ignored,
    ensure_api,
    register_with_dashboard,
    serve_dashboard,
)
from canyonos.sync import run_sync

_STATUS_POLL_SECONDS = 1.0
_IDLE_WARN_SECONDS = 180.0


class DockerUnavailableError(RuntimeError):
    """Docker isn't installed, running or usable here; `canyonos` exits with 4."""

    exit_code = 4
    error_code = "docker_unavailable"


def _save_id(config_path, key):
    """Add `key`, a new id, to the config when it has none, before the sync, so the
    container's copy carries it and every later deploy keeps the same id. A config that
    is not a mapping is left for the schema check to report."""
    yaml_rt = round_trip_yaml()
    data = load_yaml(config_path, yaml_rt.load)
    if not isinstance(data, dict) or data.get(key):
        return
    data[key] = str(uuid.uuid4())
    write_config(config_path, data, yaml_rt)


def save_deployment_config(config_path):
    """Give the workflow group a `workflow_group.yaml` when it has none, the starter's, which
    sends telemetry to the local dashboard, and give it its `workflow_group_id`, the
    dashboard's id for the workflow group."""
    if not os.path.isfile(config_path):
        with open(config_path, "w", encoding="utf-8") as f:
            f.write(deployment_template())
    _save_id(config_path, "workflow_group_id")


def is_workflow_id(value) -> bool:
    """True when `value` is a UUID in the form `canyonos deploy` writes a `workflow_id`
    or `workflow_group_id`: lowercase and hyphenated."""
    try:
        return isinstance(value, str) and value == str(uuid.UUID(value))
    except ValueError:
        return False


def require_deployment_id(config_path):
    """Raise when the workflow group's `workflow_group_id` is set but is not a lowercase,
    hyphenated UUID, the form `save_deployment_config` writes, since the dashboard and
    the Kubernetes resource names take it as written."""
    config = read_config(config_path)
    if isinstance(config, dict) and "deployment_id" in config:
        raise RuntimeError(
            f"deployment_id in {config_path} is now called workflow_group_id: rename it."
        )
    value = config.get("workflow_group_id") if isinstance(config, dict) else None
    if not value or is_workflow_id(value):
        return
    raise RuntimeError(
        f"workflow_group_id {value!r} in {config_path} is not a valid ID: it must be a "
        "lowercase, hyphenated UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx), the form "
        "`canyonos deploy` writes. Write it in that form, or delete the line and the "
        "deploy makes a new one."
    )


def run_deploy(
    folders,
    serve=True,
    verbose=False,
    banner=True,
    yes=False,
    detach=False,
    api_key=None,
    no_api_key=False,
):
    """Deploy the workflows in `folders` as one workflow group, named after the folder this
    runs from and configured by its `workflow_group.yaml`. `yes` skips the resource picker;
    `detach` returns once the deploy started, without the dashboard. The deploy hands
    the Global Controller the hash of this machine's API key, which `api_key` sets or
    replaces and `no_api_key` removes; with no key, the endpoint checks nothing."""
    ids = deployment.workflow_ids(folders)
    workflows = deployment.workflow_folders(folders, ids)
    config_path = deployment_config_path()
    require_deployment_id(config_path)
    key = resolve_api_key(api_key, no_api_key)
    kubernetes = deployment.configured_target() == "kubernetes"
    if not kubernetes:
        try:
            _ensure_docker_running()
        except RuntimeError as e:
            raise DockerUnavailableError(str(e)) from None
    internal_ca.refuse_redis_that_outlived_its_ca()

    save_deployment_config(config_path)
    deployment.save_workflows(config_path, workflows, ids)
    workflow_configs = {
        name: workflow_config_path(workflow_folder(folder))
        for name, folder in workflows.items()
    }
    if not configure_resources(workflow_configs, config_path, ask=not yes):
        ui.say("Deploy cancelled.")
        return None

    # On Kubernetes, load_state forwards to the cluster's CanyonOS API instead.
    if not kubernetes:
        # First: replacing an old Global Controller and running the new one both go
        # through it.
        started_api = ensure_api(hash_api_key(key))
        try:
            run_init(banner=banner, auth_env=gc_env(key), auth_disabled=key is None)
        except (Exception, KeyboardInterrupt):
            _stop_the_stack_it_started(started_api)
            raise
        # Before the upload starts the Global Controller, so the dashboard knows its
        # Redis by the time it publishes there, toy and --serve false deploys included;
        # a deploy it fails for stops here, as its status could not be read.
        register_with_dashboard(load_state(), required=True)

    # Upload the workflow group into the container before building/deploying.
    if not run_sync(workflows, api_key_hash=hash_api_key(key)):
        raise RuntimeError("Could not sync the workflow group into the container.")

    state = load_state()

    if detach:
        ui.ok("Deploy started.")
        ui.hint(
            "Run `canyonos status` to see when it is up, or `canyonos logs` to follow it."
        )
        return state

    if serve and not kubernetes and running_web_port() is None:
        # A toy deploy doesn't wait for a dashboard that isn't up; `canyonos serve` starts it.
        if str(read_config(config_path).get("deploy_mode")).casefold() == "toy":
            ui.say(
                "Toy mode is on, so this deploy doesn't start the dashboard. "
                "Run `canyonos serve` to launch it."
            )
            serve = False
        else:
            # A daemon, so a failed deploy exits without waiting.
            threading.Thread(
                target=run_dashboard,
                args=(None, dashboard_port(config_path), hash_api_key(key)),
                daemon=True,
            ).start()
    _watch_deploy(state, serve=serve, verbose=verbose, key=key)
    return state


def _stop_the_stack_it_started(started_api):
    """Stop the local stack after a deploy that never created its Global Controller,
    when `started_api`, this deploy started it, and no other workflow group needs it."""
    if started_api and not deployment.other_global_controllers_running(None):
        stop_dashboard()


def _curl_example(url, body, keyed):
    """A single-line, directly copy-pasteable `curl -X POST ...` command.

    Deliberately not split across `\\`-continued lines or pretty-printed JSON --
    a multi-line block is easy to mangle depending on what actually receives the
    paste (some terminals/chat boxes drop the backslashes or the newlines), and
    a single line always works no matter where it lands.
    """
    compact_body = shlex.quote(json.dumps(body))
    return (
        f"curl -X POST {url}{curl_auth(keyed)} "
        f'-H "Content-Type: application/json" -d {compact_body}'
    )


def summary_body(dashboard_url, endpoint, keyed):
    """Build the deploy panel's text: the dashboard URL, a warning when the dashboard
    is down or the workflow group's `otel:` block leaves it out, and how to call, poll and
    answer the endpoint described by its published record, when there is one, each
    `curl` sending the API key when the deploy is `keyed`."""
    body = Text()
    body.append("Dashboard  ", "dim")
    config_path = deployment_config_path()
    to_dashboard = sends_to_dashboard(config_path)
    no_telemetry = (
        "No telemetry configured -- add the `local` entry to your `otel:` block"
    )
    if dashboard_url:
        body.append(dashboard_url, f"bold {GREEN}")
        if not to_dashboard:
            body.append(f"  {no_telemetry}", "yellow")
    elif to_dashboard:
        body.append(
            "Not running -- run `canyonos serve` to bring it up for telemetry",
            "yellow",
        )
    else:
        body.append(f"Not running. {no_telemetry}", "yellow")

    if endpoint:
        host, api_port = endpoint["public_host"], endpoint["api_port"]
        base = f"http://{host}:{api_port}"
        body.append("\n\nmessage           ", "dim")
        for index, route in enumerate(endpoint["routes"]):
            if index:
                body.append("\n                  ")
            example = {name: "your query" for name in route["arguments"]}
            body.append(_curl_example(route["url"], example, keyed), WHITE)
        body.append("\nrespond to agent  ", "dim")
        body.append(
            _curl_example(
                f"{base}/answer/<request_id>", {"input": "your answer"}, keyed
            ),
            WHITE,
        )
        body.append("\ncheck result      ", "dim")
        body.append(f"curl{curl_auth(keyed)} {base}/status/<request_id>", WHITE)
        if not keyed:
            body.append("\napi key           ", "dim")
            body.append("None: anyone who reaches the endpoint can call it", "yellow")
        if host not in ("127.0.0.1", "localhost"):
            body.append(
                f"\n                  needs inbound TCP {api_port} open on {host}",
                "dim",
            )
    return body


def _print_deploy_summary(dashboard_url, endpoint, keyed):
    """The one screen printed once everything is up: the dashboard and the endpoint."""
    ui.blank()
    ui.panel(
        Panel(
            summary_body(dashboard_url, endpoint, keyed),
            title=f"[bold {GREEN}]Deploy is live[/]",
            title_align="left",
            border_style=GREEN,
            padding=(1, 4),
        )
    )
    ui.blank()


def _start_dashboard(key):
    """The dashboard's URL, or None -- a dashboard that won't start doesn't fail the deploy.
    Its web app starts unless it runs already, in front of the API that checks `key`,
    which the deploy brought up and registered the workflow group with."""
    try:
        if deployment.configured_target() == "kubernetes":
            return f"http://127.0.0.1:{_open_dashboard()}"
        # Waits out a background start, so a half-started dashboard is not taken as up.
        with ui.status("Starting the dashboard..."), _dashboard_lock():
            port = running_web_port()
        if port is not None:
            _warn_if_dashboard_port_ignored()
            return dashboard_url(port)
        result = serve_dashboard(api_key_hash=hash_api_key(key))
    except Exception as e:
        ui.fail(f"Could not start the dashboard automatically: {e}")
        ui.hint("Run `canyonos serve` manually to view it.")
        return None
    return result.url


def _deploy_summary(state, endpoint, serve, key):
    if serve:
        dashboard = _start_dashboard(key)
    else:
        port = running_web_port()
        dashboard = dashboard_url(port) if port else None
    if endpoint is None:
        ui.warn(
            "Could not read the running workflow group's endpoint. Run `canyonos logs` to see why."
        )
    elif deployment.configured_target() == "kubernetes":
        endpoint = keep_endpoint_forwarded(endpoint)
    if (
        endpoint
        and deployment.configured_target() != "kubernetes"
        and endpoint_api_port(deployment_config_path()) is None
    ):
        preferred = state.get("api_port") or DEFAULT_API_PORT
        if endpoint["api_port"] != preferred:
            ui.warn(
                f"Port {preferred} is taken, so the endpoint is on "
                f"{endpoint['api_port']}."
            )
        remember_api_port(endpoint["api_port"])
    summary = (dashboard, endpoint)
    _print_deploy_summary(dashboard, endpoint, key is not None)
    ui.hint(
        "Run `canyonos logs` to view logs, or `canyonos stop` to stop the workflow."
    )
    return summary


def _interrupted():
    ui.blank()
    ui.say(
        "Stopped monitoring log stream. Run `canyonos stop` to stop the workflow group."
    )
    ui.hint("To resubscribe to log stream run `canyonos logs`.")


def wait_for_verdict(state, show=lambda status: None):
    """Poll the CanyonOS API's status of the deploy about once a second, handing each
    answer to `show`, until the deploy is up or its process has exited, so a failed
    deploy's log and root cause are complete, and return that answer. None when the
    API stops answering."""
    misses = 0
    while misses < 2:
        status = deploy_status(state)
        misses = 0 if status else misses + 1
        if status:
            show(status)
            if status["phase"] == "up" or not status["running"]:
                return status
        time.sleep(_STATUS_POLL_SECONDS)
    return None


def _progress_printer(spinner):
    """Return what `wait_for_verdict` calls with each status of a quiet deploy: it
    prints each newly finished step as a ✓ line and puts what the deploy does now on
    `spinner`, or once it has printed nothing for 3 minutes, the step holding it up."""
    printed, shown = 0, "Deploying agents..."

    def show(status):
        nonlocal printed, shown
        for step in status["steps"][printed:]:
            ui.ok(step)
        printed = len(status["steps"])
        text = status["message"] or "Deploying agents..."
        if (status["idle_seconds"] or 0) > _IDLE_WARN_SECONDS:
            # Piped, each update prints a line: report a stall once, not every poll.
            if not is_terminal(sys.stdout) and shown.startswith("Still running"):
                return
            text = _still_running(status)
        if text != shown:
            # Text, since build step names such as `[agent 5/7]` are not Rich markup.
            spinner.update(Text(text))
            shown = text

    return show


def _print_controller_log(state, stop):
    """Print the deploy's log as it comes, for `canyonos deploy -v`, until `stop` is
    set or the deploy exits."""
    for line in controller_log(state, follow=True):
        if stop.is_set():
            return
        print(line, end="", flush=True)


def _report_failure(state, status, verbose):
    """Print why the deploy failed: its last 400 log lines unless `verbose` already
    streamed them all, then the root cause when one line marked the failure. Raises."""
    if not verbose:
        ui.fail("Deploy failed.")
        ui.blank()
        print("".join(controller_log(state, tail=400)), end="")
    if status["root_cause"]:
        ui.blank()
        ui.hint("Recent Logging Trace Above, Root Cause Below.")
        ui.root_cause(status["root_cause"])
    ui.blank()
    log = (
        "The full log is above."
        if verbose
        else "Run `canyonos deploy -v` for the full log."
    )
    raise ApiError(f"{status['error']} {log}", code=status["error_code"])


def _watch_deploy(state, serve, verbose, key):
    """Show the deploy's progress, or with `verbose` stream its whole log, until the
    CanyonOS API says it is up, then start the dashboard (unless `serve=False`)
    with its API checking the API key `key`, and print where everything lives; raise
    when it fails. Ctrl-C stops only this."""
    stop_log = threading.Event()
    try:
        if verbose:
            threading.Thread(
                target=_print_controller_log, args=(state, stop_log), daemon=True
            ).start()
            status = wait_for_verdict(state)
        else:
            with ui.status("Deploying agents...") as spinner:
                status = wait_for_verdict(state, _progress_printer(spinner))
        stop_log.set()
        if status and status["phase"] == "up":
            return _deploy_summary(state, status["endpoint"], serve, key)
        if status and status["phase"] == "failed":
            _report_failure(state, status, verbose)
        raise RuntimeError(
            "Deploy stopped before the workflow became ready; rerun with "
            "`canyonos deploy -v` for full logs."
        )
    except KeyboardInterrupt:
        _interrupted()


def _duration(seconds):
    """`seconds` as `MmSSs`, the way the stalled spinner counts time."""
    return f"{int(seconds) // 60}m{int(seconds) % 60:02d}s"


def _still_running(status):
    """Build the spinner text for a quiet deploy that has printed nothing for a while:
    for how long, and the build step running longest, else what the deploy does now."""
    slowest = status["slowest_step"]
    if slowest:
        step = f"{slowest['name'][:100]} (running {_duration(slowest['seconds'])})"
    else:
        step = (status["message"] or "Deploying agents...")[:100]
    return (
        f"Still running, no output for {_duration(status['idle_seconds'])} "
        f"(container is up)\n  step: {step}"
    )
