# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos doctor`: a checklist of environment checks, split into a
pre-deploy view (no Global Controller deploy running yet) and a post-deploy
view (one is up). Each check just reports pass/fail plus a suggested fix --
nothing here attempts to auto-fix anything.
"""

import json
import shutil
import subprocess
import urllib.error
import urllib.request

from canyonos import ui
from canyonos.constants import (
    endpoint_answers,
    existing_config_path,
    port_in_use,
)
from canyonos.dashboard_stack import (
    _container_health,
    _container_name,
    _endpoint_healthy,
    _existing_dashboard_port,
)
from canyonos import env, kubernetes_target as k8s
from canyonos.forwards import DASHBOARD, endpoint_forward, forward_port
from canyonos.gc import deploy_status, deployed_endpoint
from canyonos.init import (
    docker_running,
    docker_start_command,
    load_state,
    redis_port_of,
)
from canyonos.verify import _runtime_table, agent_rows


def _compose_available():
    result = subprocess.run(["docker", "compose", "version"], capture_output=True)
    return result.returncode == 0


def _docker_daemon_fix():
    """Names the command for the active docker context, since `canyonos deploy`
    would run exactly that itself."""
    command = docker_start_command()
    if command:
        return f"run `{' '.join(command)}` -- or just run `canyonos deploy`, which starts it for you"
    return "start your Docker runtime (on Linux: `sudo systemctl start docker`)"


def _pre_deploy_checks():
    """Return the checks `canyonos doctor` runs before any deploy, each with its fix."""
    return [
        (
            "Docker installed",
            lambda: shutil.which("docker") is not None,
            "install Docker: https://docs.docker.com/get-docker/",
        ),
        (
            "Docker daemon running",
            docker_running,
            _docker_daemon_fix(),
        ),
        (
            "Docker Compose available",
            _compose_available,
            "update Docker to a version that includes Compose v2 (needed for `canyonos serve`)",
        ),
    ]


def _print_check(label, ok, detail, fix):
    """Like `_run_checks`'s per-check printing, but a passing check also shows
    what it checked -- the address/container -- so the dependency graph is
    visible without extra digging, not just a bare checkmark."""
    if ok:
        ui.ok(f"{label:<24}{detail}")
    else:
        ui.fail(label)
        ui.hint(f"  -> {fix}")
    return ok


def _gc_check(state, status):
    ok = bool(status and status.get("running"))
    return _print_check(
        "Global Controller",
        ok,
        f"container {state['container_id'][:12]} on 127.0.0.1:{state['port']}",
        "GC container isn't answering -- run `canyonos deploy` again",
    )


def _redis_check(state):
    """TCP reachability only -- not a real PING, but enough to say something's
    listening where the local provider and dashboard both expect Redis."""
    redis_port = redis_port_of(state)
    return _print_check(
        "Redis",
        port_in_use(redis_port),
        f"127.0.0.1:{redis_port}",
        f"nothing is listening on {redis_port} -- redeploy, or check `docker ps`",
    )


def _agents_check():
    """Prints the workflow-agent readiness table (reusing the same rows and
    table `canyonos test` shows). True if there's nothing to check or every
    agent is ready.
    """
    try:
        config_path = existing_config_path()
    except RuntimeError as e:
        ui.hint(f"{e} Skipping the workflow agent checks.")
        return True

    rows = agent_rows(config_path)
    if not rows:
        return True
    ui.panel(_runtime_table(rows))
    return all(row["ok"] for row in rows)


def _endpoint_check(state):
    """Any HTTP answer from the running deploy's endpoint counts, the same probe
    `canyonos test` waits on."""
    api_port = deployed_endpoint(state["port"])["api_port"]
    return _print_check(
        "Endpoint",
        endpoint_answers(api_port),
        f"127.0.0.1:{api_port}",
        f"nothing answers on {api_port} -- run `canyonos deploy` again, or check `canyonos logs`",
    )


def _dashboard_checks():
    """Postgres/API/web checks, or one hint if the dashboard was never started
    from here -- it's an optional, separate step from the deploy itself.
    """
    port = _existing_dashboard_port()
    if port is None:
        ui.hint("Dashboard not running -- start it with `canyonos serve`")
        return True

    db_name = _container_name("db")
    db_ok = _print_check(
        "Postgres (db)",
        _container_health(db_name) == "healthy",
        db_name,
        f"the dashboard's Postgres container isn't healthy -- `canyonos serve` again, or check `docker logs {db_name}`",
    )
    api_ok = _print_check(
        "Dashboard API",
        _endpoint_healthy(f"http://127.0.0.1:{port}/api/healthz"),
        f"127.0.0.1:{port}/api/healthz",
        "the dashboard API isn't answering -- `canyonos serve` again",
    )
    web_ok = _print_check(
        "Dashboard web",
        _endpoint_healthy(f"http://127.0.0.1:{port}/healthz"),
        f"127.0.0.1:{port}/healthz",
        "the dashboard web isn't answering -- `canyonos serve` again",
    )
    return db_ok and api_ok and web_ok


def _guard(label, check):
    """Run one post-deploy check so a raised exception becomes a failed line with
    the error shown -- `canyonos doctor` must surface problems, never crash on
    them (a malformed config, an unreachable GC, a missing docker binary, ...).
    """
    try:
        return bool(check())
    except Exception as e:
        ui.fail(label)
        ui.hint(f"  -> {label} check could not run: {e}")
        return False


def _print_post_deploy(state, status):
    """Health-check every service the deploy declared, in dependency order:
    the Global Controller, Redis, each workflow agent, the endpoint, then the dashboard --
    one readiness table instead of `docker ps`/`docker inspect` by hand.

    Every check runs (no short-circuit) and is guarded, so one failing or
    erroring probe never hides the others or aborts the whole report.
    """
    results = [
        _guard("Global Controller", lambda: _gc_check(state, status)),
        _guard("Redis", lambda: _redis_check(state)),
        _guard("Workflow agents", _agents_check),
        _guard("Endpoint", lambda: _endpoint_check(state)),
        _guard("Dashboard", _dashboard_checks),
    ]
    return all(results)


def _run_checks(checks, stop_at_failure=False):
    """Run every check, print a pass/fail checklist, and return True if all passed.
    With `stop_at_failure`, each check needs the ones before it, so the first failure
    ends the list."""
    all_ok = True
    for label, check, fix in checks:
        try:
            passed = bool(check())
        except Exception as e:
            passed = False
            fix = f"{fix} (error: {e})"

        if passed:
            ui.ok(label)
        else:
            ui.fail(label)
            ui.hint(f"  -> {fix}")
            all_ok = False
            if stop_at_failure:
                break

    return all_ok


def _operator_version_check():
    """The operator's release, from the version label Helm puts on its Deployment,
    against the CLI's: `canyonos deploy` stops on a mismatch, so a project still running
    on another release was deployed before an upgrade. Who may not read the operator's
    namespace is told it was not checked."""
    version = k8s.operator_version()
    if not version:
        ui.hint(
            f"CanyonOS operator: version not checked (none readable in {k8s.OPERATOR_NAMESPACE})"
        )
        return True
    return _print_check(
        "CanyonOS operator",
        env.is_development or version == env.VERSION,
        f"version {version}",
        f"the cluster runs CanyonOS {version} and this CLI is {env.VERSION} -- "
        "upgrade one to the other's release, then `canyonos deploy`",
    )


def _project_ready_check(namespace, project, found):
    ready = k8s.condition(found, "Ready")
    return _print_check(
        "Project",
        ready.get("status") == "True",
        f"{project} in namespace {namespace}",
        f"{ready.get('reason') or 'Starting'}: {ready.get('message') or 'not ready yet'}"
        " -- see `canyonos logs`",
    )


def _kubernetes_agents_check(namespace, project):
    agents = k8s.project_agents(namespace, project)
    ui.panel(k8s.agents_table(agents))
    for agent in agents:
        error = k8s._launch_error(agent)
        if error:
            ui.hint(f"  -> {agent.get('spec', {}).get('agentName')}: {error}")
    return all(k8s.condition(a, "Ready").get("status") == "True" for a in agents)


def _kubernetes_endpoint_check(namespace, project, found):
    """The endpoint through this machine's forward of it, or a short one of its own;
    an Ingress or URL the project serves is asked directly."""
    url = found.get("status", {}).get("endpointURL") or ""
    if not k8s._in_cluster_only(url):
        return _print_check(
            "Endpoint",
            _endpoint_answers_at(url),
            url,
            "nothing answers there -- check the Ingress or `endpoint.url`",
        )
    port = forward_port(endpoint_forward(namespace, project))
    if port:
        detail = f"127.0.0.1:{port} (forwarded until `canyonos stop`)"
        return _print_check(
            "Endpoint",
            _endpoint_answers_at(f"http://127.0.0.1:{port}"),
            detail,
            f"nothing answers on {port} -- `canyonos deploy` again opens it anew",
        )
    forward = k8s.PortForward(namespace)
    try:
        answers = _endpoint_answers_at(f"http://127.0.0.1:{forward.port}")
    finally:
        forward.close()
    return _print_check(
        "Endpoint",
        answers,
        f"{url} (not forwarded here: `canyonos deploy` keeps it on 127.0.0.1)",
        "the endpoint isn't answering -- see `canyonos logs`",
    )


def _endpoint_answers_at(url):
    """Any HTTP answer from the endpoint at `url`, the probe `endpoint_answers` sends;
    an unknown request id takes the endpoint about two seconds to refuse, so it gets
    longer here, through a port-forward or an Ingress."""
    try:
        urllib.request.urlopen(
            f"{url.rstrip('/')}/status/canyonos-test-probe", timeout=5
        )
    except urllib.error.HTTPError:
        return True
    except OSError:
        return False
    return True


def _kubernetes_dashboard_check():
    port = forward_port(DASHBOARD)
    if port is None:
        ui.hint("Dashboard not open here -- open it with `canyonos serve`")
        return True
    return _print_check(
        "Dashboard",
        _endpoint_healthy(f"http://127.0.0.1:{port}/healthz"),
        f"127.0.0.1:{port} (forwarded until `canyonos stop`)",
        "the dashboard isn't answering -- `canyonos serve` again",
    )


def _kubernetes_doctor():
    """`canyonos doctor` for a project on Kubernetes: what deploying there needs, then,
    once deployed, the operator's release, the project, each agent's replicas, the
    endpoint and the dashboard, guarded as on Docker."""
    namespace, project = k8s._namespace_and_project(None)
    ui.say(f"Kubernetes: {project} in namespace {namespace}")
    if not _run_checks(k8s.cluster_checks(), stop_at_failure=True):
        return False
    found = k8s.kubectl(
        ["get", "canyonproject", project, "-n", namespace, "-o", "json"], check=False
    )
    if found.returncode:
        if not k8s._not_found(found):
            ui.fail(f"Could not read {project} in {namespace}")
            ui.hint(f"  -> {(found.stderr or '').strip()}")
            return False
        ui.say(f"No deploy of {project} in namespace {namespace} -- `canyonos deploy`")
        return True
    found = json.loads(found.stdout)
    ui.say("Deploy is up -- post-deploy checks:")
    results = [
        _guard("CanyonOS operator", _operator_version_check),
        _guard("Project", lambda: _project_ready_check(namespace, project, found)),
        _guard("Workflow agents", lambda: _kubernetes_agents_check(namespace, project)),
        _guard(
            "Endpoint", lambda: _kubernetes_endpoint_check(namespace, project, found)
        ),
        _guard("Dashboard", _kubernetes_dashboard_check),
    ]
    return all(results)


def run_doctor(kubernetes=False):
    """Print the pre- or post-deploy checklist, whichever applies, and return True if it all passed."""
    if kubernetes:
        return _kubernetes_doctor()
    try:
        state = load_state()
    except FileNotFoundError:
        state = None

    status = None
    if state:
        try:
            status = deploy_status(state["port"])
        except (KeyError, OSError, ValueError) as e:
            ui.warn(
                f"Could not read deploy status ({e}); assuming no deploy is running."
            )

    if status and status.get("running"):
        ui.say("Deploy is up -- post-deploy checks:")
        return _print_post_deploy(state, status)

    ui.say("No deploy running -- pre-deploy checks:")
    return _run_checks(_pre_deploy_checks())
