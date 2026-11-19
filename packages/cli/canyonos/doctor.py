# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for `canyonos doctor`: a checklist of environment checks, split into a
pre-deploy view (no Global Controller deploy running yet) and a post-deploy
view (one is up). Each check just reports pass/fail plus a suggested fix --
nothing here attempts to auto-fix anything.
"""

import shutil
import subprocess

from canyonos import deployment, ui
from canyonos.dashboard_stack import (
    _container_health,
    _container_name,
    _endpoint_healthy,
    _existing_dashboard_port,
)
from canyonos.gc import deploy_health, deploy_status
from canyonos.init import docker_running, docker_start_command, load_state


def _compose_available():
    result = subprocess.run(["docker", "compose", "version"], capture_output=True)
    return result.returncode == 0


def _docker_daemon_fix():
    """Names the command for the active docker context, since `canyonos deploy`
    would run exactly that itself."""
    command = docker_start_command()
    if command:
        return f"run `{' '.join(command)}` -- or just run `canyonos deploy <workflow folder>`, which starts it for you"
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
    """Print one check: a ✓ line with what it checked, when there is a `detail`, or a ✗
    line and its fix. Adds it to the `--json` result's `checks` and returns `ok`."""
    ui.json_result.setdefault("checks", []).append(
        {"name": label, "ok": ok, "detail": detail, "fix": None if ok else fix}
    )
    if ok:
        ui.ok(f"{label:<24}{detail}" if detail else label)
    else:
        ui.fail(label)
        ui.hint(f"  -> {fix}")
    return ok


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
        ui.json_result.setdefault("checks", []).append(
            {"name": label, "ok": False, "detail": str(e), "fix": None}
        )
        ui.fail(label)
        ui.hint(f"  -> {label} check could not run: {e}")
        return False


def _print_health(state):
    """Print each check the Global Controller's health route ran on the running
    deploy, a ✓ or ✗ line with what it checked and, when it failed, the fix. True if
    all passed."""
    health = deploy_health(state)
    ui.json_result.setdefault("checks", []).extend(health["checks"])
    for check in health["checks"]:
        (ui.ok if check["ok"] else ui.fail)(f"{check['name']:<24}{check['detail']}")
        if check["fix"]:
            ui.hint(f"  -> {check['fix']}")
    return health["ok"]


def _print_post_deploy(state):
    """Health-check the running deploy: the Global Controller, Redis, the workflow
    agents and the endpoint, as the Global Controller sees them, then the dashboard.

    Both are guarded, so one erroring probe never hides the other or aborts the
    whole report.
    """
    results = [
        _guard("Global Controller", lambda: _print_health(state)),
        _guard("Dashboard", _dashboard_checks),
    ]
    return all(results)


def _run_checks(checks):
    """Run every check, print a pass/fail checklist, and return True if all passed."""
    all_ok = True
    for label, check, fix in checks:
        try:
            passed = bool(check())
        except Exception as e:
            passed = False
            fix = f"{fix} (error: {e})"
        if not _print_check(label, passed, None, fix):
            all_ok = False

    return all_ok


def run_doctor():
    """Print the pre- or post-deploy checklist, whichever applies, and return True if it all passed."""
    try:
        state = load_state()
    except FileNotFoundError:
        state = None

    status = None
    if state:
        try:
            status = deploy_status(state)
        except (KeyError, OSError, ValueError) as e:
            ui.warn(
                f"Could not read deploy status ({e}); assuming no workflow group is running."
            )

    if status and status.get("running"):
        ui.say("Deploy is up -- post-deploy checks:")
        return _print_post_deploy(state)

    if deployment.configured_target() == "kubernetes":
        ui.say(
            "No workflow group running -- run `canyonos deploy <workflow folder>...`"
        )
        return True
    ui.say("No workflow group running -- pre-deploy checks:")
    return _run_checks(_pre_deploy_checks())
