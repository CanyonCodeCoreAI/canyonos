# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Manage the local CanyonOS dashboard stack."""

from __future__ import annotations

import importlib.resources
import json
import os
import re
import secrets
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator

from canyonos import env, ports, project
from canyonos.constants import (
    DEFAULT_DASHBOARD_API_PORT,
    DEFAULT_DASHBOARD_PORT,
    public_ip,
)
from canyonos.docker_cmd import DOCKER_CLEANUP_TIMEOUT
from canyonos.os_support import file_lock, make_private_dir, write_private_file
from canyonos.port_utils import (
    DEFAULT_MAX_PORT_ATTEMPTS,
    clashed_port,
    is_port_free,
    next_port,
)

COMPOSE_PROJECT = "canyonos-dashboard"
API_IMAGE = env.api_image
WEB_IMAGE = env.web_image
LOCK_WAIT_MESSAGE = "waiting for another canyonos command to finish with the dashboard"
# Made once per machine and kept in the stack's `.env`: the API signs sign-in tokens with the
# first and encrypts each project's Redis password in its database with the second.
SECRET_KEYS = ("CANYONOS_JWT_SECRET", "CANYONOS_REDIS_PASSWORD_ENCRYPTION_KEY")
# The services the dashboard publishes on the host, each with the port it listens on
# in its container, the host port it starts from, and its name in a warning: the web
# app (none, as the CLI prints its address itself) and the API, which the CLI reaches.
SERVICE_PORTS = {
    "web": (8080, DEFAULT_DASHBOARD_PORT, None),
    "api": (3000, DEFAULT_DASHBOARD_API_PORT, "the dashboard's API"),
}
# The services a project's containers reach by container name on its network.
NETWORK_SERVICES = ("api", "db")


@dataclass(frozen=True)
class ServeResult:
    """How far starting the dashboard got, and whether it succeeded."""

    ok: bool
    phase: str
    message: str
    url: str | None = None
    log_path: str | None = None


class PhaseFailure(Exception):
    """Raised when a step of starting the dashboard fails, naming the step."""

    def __init__(self, phase: str, message: str):
        super().__init__(message)
        self.phase = phase
        self.message = message


@dataclass(frozen=True)
class DashboardStack:
    """Where the dashboard's files live on this machine and the host port each of its
    services (`SERVICE_PORTS`) is published on."""

    state_dir: Path
    host_ports: dict[str, int]

    @property
    def env_path(self) -> Path:
        """Path to the machine's dashboard `.env`, where `canyonos serve` writes the
        stack's settings and secrets, shared by every project."""
        return self.state_dir / ".env"


def _run(
    argv: list[str],
    env: dict[str, str] | None = None,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        capture_output=True,
        check=False,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=timeout,
    )


def _state_dir() -> Path:
    return Path.home() / ".canyonos" / "dashboard"


@contextmanager
def _dashboard_lock(on_wait: Callable[[], None] | None = None) -> Iterator[None]:
    """Hold the machine-wide dashboard lock for the duration of the block.

    Every command that starts, stops, or removes the shared stack takes it, so
    two project folders never interleave their compose calls, port choice, or
    secrets. Blocks until the lock is free, calling `on_wait` first when
    another command holds it. Raises PhaseFailure("validate", ...) when the
    lock file cannot be opened or locked.
    """
    state_dir = _state_dir()
    try:
        state_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        raise PhaseFailure("validate", "dashboard state directory is not writable")

    with ExitStack() as held:
        try:
            held.enter_context(
                file_lock(state_dir / ".lock", wait=True, on_wait=on_wait)
            )
        except OSError as e:
            raise PhaseFailure("validate", f"could not lock the dashboard: {e}") from e
        yield


def _project_argv() -> list[str]:
    """`docker compose` for the dashboard project, found by name from any directory."""
    return ["docker", "compose", "-p", COMPOSE_PROJECT]


def _compose_argv(stack: DashboardStack, manifest: Path) -> list[str]:
    return [
        *_project_argv(),
        "--env-file",
        str(stack.env_path),
        "-f",
        str(manifest),
    ]


def _container_name(service: str) -> str:
    """The container name `dashboard.compose.yml` gives `service`."""
    return f"{COMPOSE_PROJECT}-{service}"


def join_project_network(network: str) -> str | None:
    """Connect the dashboard's api and database to a project's network: the api reaches
    that project's Redis by name, and the project's telemetry and endpoint reach them
    by theirs. Returns why it couldn't, or None once connected, already or now."""
    for service in NETWORK_SERVICES:
        container = _container_name(service)
        result = _run(["docker", "network", "connect", network, container])
        detail = (result.stderr or result.stdout).strip()
        if result.returncode != 0 and "already exists in network" not in detail:
            return (
                f"connecting {container} to the network {network} failed: "
                f"{detail or f'exit code {result.returncode}'}"
            )
    return None


def leave_project_network(network: str) -> None:
    """Disconnect the dashboard's api and database from a project's network, so the
    network can go; one not connected, or a Docker that doesn't answer in time, is left
    to the network removal that follows to report."""
    for service in NETWORK_SERVICES:
        try:
            _run(
                [
                    "docker",
                    "network",
                    "disconnect",
                    "--force",
                    network,
                    _container_name(service),
                ],
                timeout=DOCKER_CLEANUP_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            pass


def _project_networks() -> list[str]:
    """The name of every project's network on this machine."""
    listed = _run(
        [
            "docker",
            "network",
            "ls",
            "--filter",
            f"label={project.ROLE_LABEL}={project.NETWORK_ROLE}",
            "--format",
            "{{.Name}}",
        ]
    )
    return listed.stdout.split()


def _leave_project_networks() -> None:
    """Disconnect a stopped dashboard from every project's network before it starts.
    Docker Desktop publishes the api's port through one of the networks the container
    starts on, and loses it for the host once that network is disconnected, so the api
    must start on its own network only and join the projects' afterwards."""
    for network in _project_networks():
        leave_project_network(network)


def _join_project_networks() -> None:
    """Connect a just-started dashboard to every project's network, so projects
    already running keep their dashboard when compose recreates it."""
    for network in _project_networks():
        join_project_network(network)


def _existing_dashboard_port() -> int | None:
    """The host port an already-running dashboard `web` container owns, if any
    -- so re-running `canyonos serve` reconnects to the same stack instead of
    picking a new port out from under it."""
    return _published_port("web", SERVICE_PORTS["web"][0])


def _published_port(service: str, container_port: int) -> int | None:
    """The host port the running dashboard's `service` publishes `container_port`
    on, or None when it isn't running."""
    try:
        result = _run(["docker", "container", "inspect", _container_name(service)])
    except OSError:
        return None
    if result.returncode != 0:
        return None

    try:
        containers = json.loads(result.stdout)
        bindings = (
            containers[0]["NetworkSettings"]["Ports"].get(f"{container_port}/tcp") or []
        )
    except (IndexError, KeyError, TypeError, json.JSONDecodeError):
        return None

    for binding in bindings:
        if binding.get("HostIp") in {"127.0.0.1", "0.0.0.0", "::"}:
            try:
                return int(binding["HostPort"])
            except (KeyError, TypeError, ValueError):
                continue
    return None


def _ports_path() -> Path:
    return _state_dir() / "ports.json"


def _saved_service_ports() -> dict[str, int]:
    """The ports picked last, by service; empty before the first pick."""
    try:
        saved = json.loads(_ports_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(saved, dict):
        return {}
    return {
        service: port
        for service, port in saved.items()
        if service in SERVICE_PORTS and isinstance(port, int)
    }


def _save_service_ports(picked: dict[str, int]) -> None:
    _state_dir().mkdir(parents=True, exist_ok=True)
    _ports_path().write_text(json.dumps(picked) + "\n", encoding="utf-8")


def _pinned(dashboard_port: int | None) -> dict[str, int]:
    """The services whose port the config sets: `web`, by `dashboard_port`."""
    return {"web": dashboard_port} if dashboard_port else {}


def service_ports(dashboard_port: int | None = None) -> dict[str, int]:
    """The host ports the dashboard's services are on, by service: a running
    dashboard's, else the ones it starts on next: `dashboard_port` (the config's) for
    `web`, else the ones picked last, else their defaults."""
    saved = {**_saved_service_ports(), **_pinned(dashboard_port)}
    return {
        service: _published_port(service, container_port) or saved.get(service, default)
        for service, (container_port, default, _what) in SERVICE_PORTS.items()
    }


def pick_service_ports(
    claims: dict[int, str] | None = None, dashboard_port: int | None = None
) -> dict[str, int]:
    """Pick and save the host ports the dashboard's services start on, under
    `ports.held()`: a running dashboard's, else `dashboard_port` for `web` as it is
    (`_validate` refuses it when taken), else the defaults when they are free and not
    in `claims` (by default, what the rest of CanyonOS here claims), else the next
    port that is."""
    claims = dict(ports.claimed(picking_dashboard=True) if claims is None else claims)
    saved = _saved_service_ports()
    pinned = _pinned(dashboard_port)
    picked = {}
    for service, (container_port, default, what) in SERVICE_PORTS.items():
        port = (
            _published_port(service, container_port)
            or pinned.get(service)
            or ports.pick(default, what, claims)
        )
        claims[port] = ports.DASHBOARD
        picked[service] = port
    if picked != saved:
        _save_service_ports(picked)
    return picked


def _validate(configured_port: int | None = None) -> DashboardStack:
    """Checks docker is usable and the state dir is writable, then returns a DashboardStack on the
    running dashboard's ports, else on the ones `pick_service_ports` picks, with `configured_port`
    for the web (failing when it is taken)."""
    if shutil.which("docker") is None:
        raise PhaseFailure("validate", "docker is not on PATH")

    try:
        if _run(["docker", "info"]).returncode != 0:
            raise PhaseFailure("validate", "docker daemon or socket is unavailable")
        if _run(["docker", "compose", "version"]).returncode != 0:
            raise PhaseFailure("validate", "docker compose is unavailable")
    except OSError:
        raise PhaseFailure("validate", "docker daemon or socket is unavailable")

    state_dir = _state_dir()
    try:
        state_dir.mkdir(parents=True, exist_ok=True)
        probe_path = state_dir / ".write-probe"
        with open(probe_path, "w", encoding="utf-8") as probe:
            probe.write("")
        probe_path.unlink()
    except OSError:
        raise PhaseFailure("validate", "dashboard state directory is not writable")

    # Past the ports the rest of CanyonOS here holds or picked, such as an endpoint's
    # that Docker publishes only once its deploy gets that far.
    with ports.held():
        claims = ports.claimed(picking_dashboard=True)
        if (
            configured_port
            and _existing_dashboard_port() is None
            and (configured_port in claims or not is_port_free(configured_port))
        ):
            raise PhaseFailure(
                "validate",
                f"Port {configured_port} is taken. Change `dashboard_port`, or remove "
                "it so CanyonOS picks a free port.",
            )
        try:
            picked = pick_service_ports(claims, configured_port)
        except RuntimeError as e:
            raise PhaseFailure("validate", str(e)) from e

    return DashboardStack(state_dir, picked)


def _env_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _read_existing_secret(env_path: Path, key: str) -> str | None:
    """The value `key` already has in the stack's `.env`, so a secret made once stays the
    same across `canyonos serve` runs; None when the file or the value is missing."""
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None

    for line in lines:
        name, separator, value = line.partition("=")
        if separator and name == key and _env_value(value):
            return _env_value(value)
    return None


def _stack_secrets(env_path: Path) -> dict[str, str]:
    """Each of the stack's secrets: the one its `.env` already holds, or a new random one."""
    return {
        key: _read_existing_secret(env_path, key) or secrets.token_urlsafe(32)
        for key in SECRET_KEYS
    }


def _env_line(key: str, value: str) -> str:
    if " " in value or "#" in value:
        return f'{key}="{value}"\n'
    return f"{key}={value}\n"


def _prepare(stack: DashboardStack) -> tuple[dict[str, str], str]:
    try:
        make_private_dir(stack.state_dir)
        managed_env = {
            **_stack_secrets(stack.env_path),
            "CANYONOS_API_IMAGE": API_IMAGE,
            "CANYONOS_WEB_IMAGE": WEB_IMAGE,
            **{
                f"CANYONOS_{service.upper()}_PORT": str(port)
                for service, port in stack.host_ports.items()
            },
        }
        write_private_file(
            stack.env_path,
            "".join(_env_line(key, value) for key, value in managed_env.items()),
        )
        (stack.state_dir / "stack.json").write_text(
            json.dumps(
                {
                    "schema_version": 4,
                    "version": env.VERSION,
                    "compose_project": COMPOSE_PROJECT,
                }
            )
            + "\n",
            encoding="utf-8",
        )
    except (OSError, ValueError):
        raise PhaseFailure("prepare", "could not prepare the dashboard state directory")

    return managed_env, "dashboard state prepared"


def _command_failure_message(
    message: str,
    result: subprocess.CompletedProcess[str],
    managed_env: dict[str, str],
) -> str:
    detail = next(
        (line.strip() for line in reversed(result.stderr.splitlines()) if line.strip()),
        None,
    )
    if detail is None:
        return message
    return f"{message}: {_redact_logs(detail, *_secret_values(managed_env))}"


def _start_failure_message(
    result: subprocess.CompletedProcess[str], managed_env: dict[str, str]
) -> str:
    """Say why `docker compose up` failed, naming the port when another process or
    container already holds one the dashboard publishes."""
    port = clashed_port(result.stderr)
    if port:
        return f"port {port} is already in use by another process or container"
    return _command_failure_message("docker compose up failed", result, managed_env)


def _compose_env(managed_env: dict[str, str]) -> dict[str, str]:
    # Compose prefers the process environment over --env-file, so a shell's
    # CANYONOS_API_IMAGE=local would beat the resolved image ref we wrote.
    return {**os.environ, **managed_env}


def _pull(stack: DashboardStack, manifest: Path, managed_env: dict[str, str]) -> str:
    try:
        result = _run(
            [*_compose_argv(stack, manifest), "pull", "--policy", "missing"],
            env=_compose_env(managed_env),
        )
    except OSError:
        raise PhaseFailure("pull", "could not run docker compose pull")
    if result.returncode != 0:
        raise PhaseFailure(
            "pull",
            _command_failure_message("docker compose pull failed", result, managed_env),
        )
    return "dashboard images pulled"


def _project_has_running_containers(stack: DashboardStack, manifest: Path) -> bool:
    try:
        result = _run([*_compose_argv(stack, manifest), "ps", "-q"])
    except OSError:
        return False
    return result.returncode == 0 and bool(result.stdout.strip())


def _start(
    stack: DashboardStack,
    manifest: Path,
    managed_env: dict[str, str],
    movable: bool,
) -> tuple[DashboardStack, dict[str, str]]:
    """Run `docker compose up` and return the stack and env it started with. A port
    Docker refuses moves to the next one the rest of CanyonOS here doesn't claim, the
    web port only when `movable` (no `dashboard_port`), so only a port Docker holds
    is chosen."""
    others = frozenset(ports.claimed(picking_dashboard=True))
    for _ in range(DEFAULT_MAX_PORT_ATTEMPTS):
        try:
            result = _run(
                [
                    *_compose_argv(stack, manifest),
                    "up",
                    "-d",
                    "--wait",
                    "--wait-timeout",
                    "180",
                ],
                env=_compose_env(managed_env),
            )
        except OSError:
            raise PhaseFailure("start", "could not run docker compose up")
        if result.returncode == 0:
            return stack, managed_env
        clashed = clashed_port(result.stderr)
        service = next(
            (
                service
                for service, port in stack.host_ports.items()
                if port == clashed and (movable or service != "web")
            ),
            None,
        )
        if service is None:
            raise PhaseFailure("start", _start_failure_message(result, managed_env))
        moved = next_port(clashed, others | set(stack.host_ports.values()))
        stack = replace(stack, host_ports={**stack.host_ports, service: moved})
        _save_service_ports(stack.host_ports)
        managed_env, _ = _prepare(stack)
    raise PhaseFailure(
        "start", f"no free port found after {DEFAULT_MAX_PORT_ATTEMPTS} attempts"
    )


def _endpoint_healthy(url: str, timeout: float = 5) -> bool:
    """True if `url` answers 200 right now -- one attempt, no retry."""
    try:
        response = urllib.request.urlopen(url, timeout=timeout)
        try:
            return response.status == 200
        finally:
            response.close()
    except (OSError, urllib.error.URLError):
        return False


def _container_health(name: str) -> str | None:
    """The container's Docker healthcheck status (e.g. "healthy"), or None if
    it has none, isn't running, or doesn't exist."""
    result = _run(["docker", "inspect", "-f", "{{.State.Health.Status}}", name])
    if result.returncode != 0:
        return None
    status = result.stdout.strip()
    return status if status and status != "<no value>" else None


def dashboard_url(port: int) -> str:
    """Where people open the dashboard: this machine's public IP on EC2, else loopback."""
    return f"http://{public_ip() or '127.0.0.1'}:{port}"


def _verify(port: int) -> str:
    local_url = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 30
    endpoints = (f"{local_url}/healthz", f"{local_url}/api/healthz")
    while time.monotonic() < deadline:
        if all(_endpoint_healthy(endpoint) for endpoint in endpoints):
            return dashboard_url(port)
        if time.monotonic() < deadline:
            time.sleep(1)
    raise PhaseFailure(
        "verify", "dashboard health checks did not return 200 within 30 seconds"
    )


def _secret_values(managed_env: dict[str, str]) -> list[str]:
    return [managed_env[key] for key in SECRET_KEYS]


def _redact_logs(logs: str, *secret_values: str) -> str:
    redacted = logs
    for secret in secret_values:
        redacted = redacted.replace(secret, "[redacted]")
    return re.sub(r"://[^/\s@]+@", "://[redacted]@", redacted)


def _capture_failure_logs(
    stack: DashboardStack, manifest: Path, managed_env: dict[str, str]
) -> Path:
    """Save the dashboard's recent logs, secrets removed, and return the file's path."""
    try:
        result = _run(
            [*_compose_argv(stack, manifest), "logs", "--no-color", "--tail", "200"]
        )
        logs = f"{result.stdout}\n{result.stderr}"
    except OSError:
        logs = "Unable to collect docker compose logs."

    log_dir = stack.state_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    log_path = log_dir / f"serve-{timestamp}.log"
    write_private_file(
        log_path,
        _redact_logs(logs, *_secret_values(managed_env)),
    )
    return log_path


def _cleanup(stack: DashboardStack, manifest: Path) -> None:
    try:
        _run([*_compose_argv(stack, manifest), "down", "--volumes"])
    except OSError:
        return


def _dashboard_compose_command(command: list[str], *leftover_flags: str) -> bool:
    """Run `docker compose <command>` on the dashboard project, then confirm it worked.

    Compose finds the project's containers by their labels, so this needs
    neither the project's `.env` nor the manifest. True only when `ps` with
    `leftover_flags` lists none of them afterward; a missing dashboard is
    already the desired end state.
    """
    try:
        if _run([*_project_argv(), *command]).returncode != 0:
            return False
        leftover = _run([*_project_argv(), "ps", "-q", *leftover_flags])
    except OSError:
        return False
    return leftover.returncode == 0 and not leftover.stdout.strip()


def _locked_dashboard_compose_command(command: list[str], *leftover_flags: str) -> bool:
    """`_dashboard_compose_command` under the dashboard lock; False when the lock fails."""
    try:
        with _dashboard_lock():
            return _dashboard_compose_command(command, *leftover_flags)
    except PhaseFailure:
        return False


def stop_dashboard() -> bool:
    """`docker compose stop` -- halts web/api/db, keeping them for a later `canyonos serve`."""
    return _locked_dashboard_compose_command(["stop"])


def teardown_dashboard() -> bool:
    """`docker compose down` -- removes the dashboard's web/api/db containers entirely,
    with the anonymous volume each Postgres start leaves, which no later start reuses."""
    return _locked_dashboard_compose_command(["down", "--volumes"], "--all")


def run_dashboard(
    phase_reporter: Callable[[str, str], None] | None = None,
    configured_port: int | None = None,
) -> ServeResult:
    """Start the local dashboard for `canyonos serve` and `canyonos deploy`, reporting
    each step; on failure, save the logs and remove what this run started.

    The whole run holds the dashboard lock, so a concurrent serve, stop, or clean
    from another project folder waits for it rather than racing it.
    """

    def report(result: ServeResult) -> None:
        if phase_reporter is not None:
            phase_reporter(result.phase, result.message)

    stack: DashboardStack | None = None
    managed_env: dict[str, str] | None = None
    manifest: Path | None = None
    # Whether the stack predates this serve, so a failure only tears down what
    # this run brought up. Read once, before anything here can change it.
    had_containers = False
    with ExitStack() as resources:
        try:
            resources.enter_context(
                _dashboard_lock(
                    lambda: report(ServeResult(True, "validate", LOCK_WAIT_MESSAGE))
                )
            )
            stack = _validate(configured_port)
            report(ServeResult(True, "validate", "dashboard prerequisites validated"))

            managed_env, prepare_message = _prepare(stack)
            report(ServeResult(True, "prepare", prepare_message))

            manifest_resource = importlib.resources.files("canyonos").joinpath(
                "dashboard.compose.yml"
            )
            manifest = resources.enter_context(
                importlib.resources.as_file(manifest_resource)
            )
            had_containers = _project_has_running_containers(stack, manifest)

            report(ServeResult(True, "pull", _pull(stack, manifest, managed_env)))

            _leave_project_networks()
            stack, managed_env = _start(
                stack, manifest, managed_env, movable=not configured_port
            )
            _join_project_networks()
            report(ServeResult(True, "start", "dashboard stack started"))

            url = _verify(stack.host_ports["web"])
            report(ServeResult(True, "verify", "dashboard health checks passed", url))
            return ServeResult(True, "verify", "dashboard health checks passed", url)
        except PhaseFailure as failure:
            log_path = None
            if (
                failure.phase in {"pull", "start", "verify"}
                and stack
                and managed_env
                and manifest
            ):
                log_path = _capture_failure_logs(stack, manifest, managed_env)
                if not had_containers:
                    _cleanup(stack, manifest)
            return ServeResult(
                False,
                failure.phase,
                failure.message,
                None,
                str(log_path) if log_path else None,
            )
