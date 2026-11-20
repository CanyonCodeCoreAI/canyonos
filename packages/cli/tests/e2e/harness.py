# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Isolated subprocess, terminal, and service ownership for CLI end-to-end tests, and
what the cases that deploy for real share: the Docker engine and images they need,
and the commands they run on the bundled Hello World."""

from __future__ import annotations

import contextlib
import json
import os
import pwd
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import pexpect
import pytest
import yaml

_INHERITED_ENVIRONMENT = (
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "PATH",
    "TERMINFO",
)
_CANYONOS_ENVIRONMENT = (
    "CANYONOS_API_IMAGE",
    "CANYONOS_CORE_IMAGE",
    "CANYONOS_SKILL_SOURCE",
    "CANYONOS_WEB_IMAGE",
)
_POLL_INTERVAL = 0.02
_STOP_TIMEOUT = 2.0


class ServiceStartError(RuntimeError):
    """A service exited before its readiness probe succeeded."""

    def __init__(self, message: str, service: OwnedService):
        super().__init__(message)
        self.service = service


class ServiceStartTimeout(ServiceStartError):
    """A service stayed alive without becoming ready before its deadline."""


def _signal_group(pid: int, sig: signal.Signals) -> None:
    """Send `sig` to the process group led by `pid`, if any member is still alive."""
    with contextlib.suppress(PermissionError, ProcessLookupError):
        os.killpg(pid, sig)


def _terminate_process_group(process: subprocess.Popen[Any]) -> None:
    """Stop the process group created for one owned command within fixed deadlines."""
    _signal_group(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=_STOP_TIMEOUT)
    except subprocess.TimeoutExpired:
        _signal_group(process.pid, signal.SIGKILL)
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.wait(timeout=_STOP_TIMEOUT)
    _signal_group(process.pid, signal.SIGKILL)


def _log_tail(path: Path, limit: int = 4000) -> str:
    """Read the useful end of a service log for a startup error."""
    try:
        return path.read_text(encoding="utf-8", errors="replace")[-limit:]
    except OSError:
        return ""


@dataclass
class OwnedService:
    """One process group and its durable combined log."""

    name: str
    process: subprocess.Popen[bytes]
    log_path: Path
    _log: Any
    ready_value: Any = None

    def stop(self) -> None:
        """Terminate the complete process group and close its log after reaping it."""
        try:
            _terminate_process_group(self.process)
        finally:
            self._log.close()


@dataclass
class ServiceOwner:
    """Start services transactionally and stop every process group it owns."""

    artifact_dir: Path
    _services: list[OwnedService] = field(default_factory=list)

    def start(
        self,
        name: str,
        argv: Sequence[str | os.PathLike[str]],
        *,
        cwd: Path,
        env: Mapping[str, str],
        ready: Callable[[OwnedService], Any | None],
        timeout: float = 5.0,
    ) -> OwnedService:
        """Start an owned service and return only after its active probe succeeds."""
        log_path = self.artifact_dir / f"service-{name}.log"
        log = log_path.open("wb")
        try:
            process = subprocess.Popen(
                [os.fspath(part) for part in argv],
                cwd=cwd,
                env=dict(env),
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        except BaseException:
            log.close()
            raise

        service = OwnedService(name, process, log_path, log)
        self._services.append(service)
        deadline = time.monotonic() + timeout

        try:
            while True:
                returncode = process.poll()
                if returncode is not None:
                    raise ServiceStartError(
                        (
                            f"{name} exited with {returncode} before readiness; "
                            f"log: {log_path}\n{_log_tail(log_path)}"
                        ),
                        service,
                    )

                ready_value = ready(service)
                if ready_value is not None:
                    service.ready_value = ready_value
                    return service

                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ServiceStartTimeout(
                        f"{name} was not ready after {timeout:.2f}s; log: {log_path}",
                        service,
                    )
                time.sleep(min(_POLL_INTERVAL, remaining))
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        """Stop all registered services in reverse startup order."""
        services, self._services = self._services, []
        failure = None
        for service in reversed(services):
            try:
                service.stop()
            except BaseException as error:
                failure = failure or error
        if failure is not None:
            raise failure

    def __enter__(self) -> ServiceOwner:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()


@dataclass
class TerminalProcess:
    """A Pexpect child whose transcript and process lifecycle belong to one case."""

    child: pexpect.spawn
    transcript_path: Path
    _transcript: Any
    _closed: bool = False

    def close(self) -> None:
        """Terminate and reap the terminal child, then close its transcript."""
        if self._closed:
            return
        try:
            _signal_group(self.child.pid, signal.SIGTERM)
            self.child.close(force=True)
        finally:
            _signal_group(self.child.pid, signal.SIGKILL)
            self._transcript.close()
            self._closed = True


@dataclass
class CliCase:
    """All filesystem, environment, process, and artifact state for one test."""

    root: Path
    home: Path
    cwd: Path
    state: Path
    artifact_dir: Path
    env: dict[str, str]
    cli: Path
    python: Path
    services: ServiceOwner
    _terminals: list[TerminalProcess] = field(default_factory=list)
    _artifact_number: int = 0

    @classmethod
    def create(cls, root: Path, artifact_dir: Path) -> CliCase:
        """Create isolated directories and a minimal environment for one test."""
        home = root / "home"
        cwd = root / "work"
        state = root / "state"
        for path in (home, cwd, state, artifact_dir):
            path.mkdir(parents=True, exist_ok=True)

        env = {
            **{
                key: os.environ[key]
                for key in _INHERITED_ENVIRONMENT
                if key in os.environ
            },
            **{key: "" for key in _CANYONOS_ENVIRONMENT},
            "CANYONOS_ENV": "test",
            "HOME": str(home),
            "PYTHON_DOTENV_DISABLED": "1",
            "TMPDIR": str(state / "tmp"),
            "XDG_CACHE_HOME": str(state / "cache"),
            "XDG_CONFIG_HOME": str(state / "config"),
            "XDG_DATA_HOME": str(state / "data"),
            "TERM": "xterm-256color",
        }
        for key in ("TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"):
            Path(env[key]).mkdir(parents=True, exist_ok=True)

        python = Path(sys.executable).absolute()
        cli = python.parent / "canyonos"
        if not cli.is_file():
            raise RuntimeError(
                f"No installed `canyonos` console script beside {python}; "
                "run `uv sync` and start the tests with `uv run`"
            )

        return cls(
            root,
            home,
            cwd,
            state,
            artifact_dir,
            env,
            cli,
            python,
            ServiceOwner(artifact_dir),
        )

    def _artifact_path(self, label: str, suffix: str) -> Path:
        self._artifact_number += 1
        safe_label = re.sub(r"[^a-zA-Z0-9_.-]+", "-", label).strip("-")
        return self.artifact_dir / f"{self._artifact_number:02d}-{safe_label}.{suffix}"

    def run(
        self,
        argv: Sequence[str | os.PathLike[str]],
        *,
        input_text: str | None = None,
        timeout: float = 10.0,
        env: Mapping[str, str] | None = None,
        cwd: Path | None = None,
    ) -> subprocess.CompletedProcess[str]:
        """Run a command without a terminal, then kill its process group. Output goes
        to artifact files, so a lingering descendant cannot hold the call open.

        `cwd` defaults to the case's own directory; a case passes one when the
        command has to run inside a folder it wrote under there.
        """
        working_dir = cwd or self.cwd
        command = [os.fspath(part) for part in argv]
        stdout_path = self._artifact_path(Path(command[0]).name, "stdout")
        stderr_path = stdout_path.with_suffix(".stderr")
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            process = subprocess.Popen(
                command,
                cwd=working_dir,
                env={**self.env, **(env or {})},
                stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                start_new_session=True,
            )
        timed_out = False
        try:
            process.communicate(
                input_text.encode() if input_text is not None else None,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            timed_out = True
        finally:
            _terminate_process_group(process)

        stdout_text = stdout_path.read_text(errors="replace")
        stderr_text = stderr_path.read_text(errors="replace")
        stdout_path.with_suffix(".json").write_text(
            json.dumps(
                {
                    "argv": command,
                    "cwd": str(working_dir),
                    "returncode": process.returncode,
                    "timed_out": timed_out,
                },
                indent=2,
            )
            + "\n"
        )
        if timed_out:
            raise subprocess.TimeoutExpired(
                command, timeout, output=stdout_text, stderr=stderr_text
            )
        return subprocess.CompletedProcess(
            command, process.returncode, stdout_text, stderr_text
        )

    def run_cli(
        self,
        args: Sequence[str],
        *,
        input_text: str | None = None,
        timeout: float = 10.0,
        env: Mapping[str, str] | None = None,
        cwd: Path | None = None,
    ) -> subprocess.CompletedProcess[str]:
        """Run the installed `canyonos` console script without a terminal."""
        return self.run(
            [self.cli, *args],
            input_text=input_text,
            timeout=timeout,
            env=env,
            cwd=cwd,
        )

    def run_python(
        self,
        script: Path,
        *args: str,
        input_text: str | None = None,
        timeout: float = 10.0,
        env: Mapping[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        """Run a controlled support process with the suite's current interpreter."""
        return self.run(
            [self.python, script, *args],
            input_text=input_text,
            timeout=timeout,
            env=env,
        )

    def spawn_cli(
        self,
        args: Sequence[str],
        *,
        timeout: float = 5.0,
        env: Mapping[str, str] | None = None,
        cwd: Path | None = None,
    ) -> TerminalProcess:
        """Run the installed CLI on a pseudoterminal and record the interaction, from
        `cwd` (the case's own directory by default) with `env` added."""
        transcript_path = self._artifact_path("canyonos-terminal", "log")
        transcript = transcript_path.open("w", encoding="utf-8")
        try:
            child = pexpect.spawn(
                str(self.cli),
                list(args),
                cwd=str(cwd or self.cwd),
                env={**self.env, **(env or {})},
                encoding="utf-8",
                timeout=timeout,
                echo=False,
            )
        except BaseException:
            transcript.close()
            raise
        terminal = TerminalProcess(child, transcript_path, transcript)
        self._terminals.append(terminal)
        child.logfile_read = transcript
        return terminal

    def close(self) -> None:
        """Stop terminal children and services owned by this test case."""
        failure = None
        terminals, self._terminals = self._terminals, []
        for terminal in reversed(terminals):
            try:
                terminal.close()
            except BaseException as error:
                failure = failure or error
        try:
            self.services.close()
        except BaseException as error:
            failure = failure or error
        if failure is not None:
            raise failure


def reported_tcp_address(path: Path) -> Callable[[OwnedService], str | None]:
    """Probe the TCP address a port-zero service writes to `path`."""

    def probe(_service: OwnedService) -> str | None:
        try:
            address = path.read_text(encoding="utf-8").strip()
            parsed = urlsplit(address)
            if parsed.scheme != "tcp" or parsed.hostname is None or parsed.port is None:
                return None
            with socket.create_connection((parsed.hostname, parsed.port), timeout=0.1):
                return address
        except (OSError, ValueError):
            return None

    return probe


def process_exists(pid: int) -> bool:
    """Return whether the operating system still has a process with `pid`."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


# The workflow the quickstart offers first, and the only one that reaches a trace
# without a model provider's API key -- which is what makes it the one this suite
# can deploy.
STARTER = "helloworld"
# Building both agent images and waiting for three replicas, in seconds. Generous
# because it is a CI runner's cold Docker, not the 15s a warm machine takes.
DEPLOY_TIMEOUT = 600
CLEAN_TIMEOUT = 300
# The dashboard's CanyonOS API, as `dashboard.compose.yml` names it.
API_CONTAINER = "canyonos-dashboard-api"
# What a deploy shows once the dashboard stored the workflow group.
REGISTERED = re.compile(rf"Registered {STARTER}-[0-9a-f]{{8}} with the dashboard")
# The endpoint address out of `canyonos deploy`'s own summary. The port is picked
# at deploy time, so it is read back rather than assumed.
ENDPOINT = re.compile(r"http://[\d.]+:\d+/[0-9a-f-]{36}")


def _real_docker_config() -> tuple[str, str]:
    """`(DOCKER_HOST, DOCKER_CONFIG)` as the account outside these tests has them.

    The suite gives each case its own HOME, which on Docker Desktop hides both
    the daemon's socket and the `compose` plugin. On Linux both are the
    system's, so this changes nothing.
    """
    try:
        home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    except KeyError:
        return os.environ.get("DOCKER_HOST", ""), os.environ.get("DOCKER_CONFIG", "")

    config = os.environ.get("DOCKER_CONFIG") or str(home / ".docker")
    host = os.environ.get("DOCKER_HOST", "")
    if not host:
        try:
            found = subprocess.run(
                ["docker", "context", "inspect", "-f", "{{.Endpoints.docker.Host}}"],
                capture_output=True,
                text=True,
                timeout=30,
                env={**os.environ, "HOME": str(home), "DOCKER_CONFIG": config},
            )
            host = found.stdout.strip() if found.returncode == 0 else ""
        except (OSError, subprocess.SubprocessError):
            host = ""
    return host, config if Path(config).is_dir() else ""


def _docker_is_usable(docker: Mapping[str, str]) -> bool:
    """Whether this machine can run the deploy at all: a daemon to reach, and the
    `compose` plugin the dashboard's teardown needs."""
    if shutil.which("docker") is None:
        return False
    try:
        reached = subprocess.run(
            ["docker", "compose", "version"],
            capture_output=True,
            timeout=30,
            env={**os.environ, **docker},
        )
        if reached.returncode != 0:
            return False
        return (
            subprocess.run(
                ["docker", "info"],
                capture_output=True,
                timeout=30,
                env={**os.environ, **docker},
            ).returncode
            == 0
        )
    except (OSError, subprocess.SubprocessError):
        return False


# The core image the Global Controller runs from. Unset means there is nothing to
# deploy against: a released CLI would pull its own version's image from ghcr, which
# does not exist for an unreleased checkout.
#
# Set with `CANYONOS_ENV=development`, which the CLI requires before it accepts a
# core image override at all.
CORE_IMAGE = os.environ.get("CANYONOS_CORE_IMAGE", "").strip()
# The CanyonOS API image every deploy brings up with its database; unset, the CLI pulls
# its own version's image from ghcr, which does not exist for an unreleased checkout.
API_IMAGE = os.environ.get("CANYONOS_API_IMAGE", "").strip()
_HOST, _CONFIG = _real_docker_config()
DOCKER = {
    name: value
    for name, value in (("DOCKER_HOST", _HOST), ("DOCKER_CONFIG", _CONFIG))
    if value
}

needs_a_runtime = pytest.mark.skipif(
    not CORE_IMAGE or not _docker_is_usable(DOCKER),
    reason="needs Docker and CANYONOS_CORE_IMAGE pointing at a core image",
)
needs_docker = pytest.mark.skipif(
    not _docker_is_usable(DOCKER), reason="needs a Docker engine with compose"
)


def runtime_environment() -> dict[str, str]:
    """What the CLI needs to reach the core and API images and the daemon. The case's
    environment blanks the CANYONOS_* variables, so the ones that matter are put
    back here."""
    return {
        "CANYONOS_CORE_IMAGE": CORE_IMAGE,
        "CANYONOS_API_IMAGE": API_IMAGE,
        **DOCKER,
    }


def docker(*args: str) -> str:
    """Run `docker` on the engine the CLI uses, fail the case unless it exits 0, and
    return what it printed."""
    done = subprocess.run(
        ["docker", *args],
        capture_output=True,
        text=True,
        timeout=60,
        env={**os.environ, **DOCKER},
    )
    assert done.returncode == 0, done.stdout + done.stderr
    return done.stdout.strip()


def run_ok(case: CliCase, args: list[str], **options) -> str:
    """Run `canyonos` with `args`, fail the case unless it exits 0, and return what
    it showed."""
    result = case.run_cli(args, **options)
    output = result.stdout + result.stderr
    assert result.returncode == 0, output
    return output


def deploy_starter(
    case: CliCase, folder: Path, *args: str, env: Mapping[str, str] | None = None
) -> tuple[str, str]:
    """Deploy the workflow from the folder `folder` that holds it and the
    `workflow_group.yaml` its workflow group starts from, as the quickstart types it,
    naming its workflow, without the dashboard, which is shared across every
    workflow group on the machine (`tests/e2e/scenarios/test_shared_dashboard.py` is where
    it belongs), with `env` or the runtime's environment; return the endpoint it
    published and what it showed."""
    output = run_ok(
        case,
        ["deploy", STARTER, "--serve", "false", *args],
        timeout=DEPLOY_TIMEOUT,
        env=env or runtime_environment(),
        cwd=folder,
    )
    endpoint = ENDPOINT.search(output)
    assert endpoint, f"the deploy published no endpoint: {output}"
    return endpoint.group(), output


def workflow_group_record(case: CliCase, folder: Path) -> Path:
    """The record `canyonos deploy` keeps in `case`'s `~/.canyonos/workflows/` for the
    workflow group of `folder`: the one whose `workflow_group.yaml` lists a workflow
    folder that is `folder`, inside it or holds it, as the CLI picks the workflow group
    a command run from `folder` acts on. Fails unless there is exactly one."""
    here = folder.resolve()
    found = []
    for config in sorted(
        (case.home / ".canyonos" / "workflows").glob("*/workflow_group.yaml")
    ):
        workflows = (yaml.safe_load(config.read_text()) or {}).get("workflows") or {}
        paths = [Path(entry["path"]).resolve() for entry in workflows.values()]
        if any(
            here == path or path in here.parents or here in path.parents
            for path in paths
        ):
            found.append(config.parent)
    assert len(found) == 1, f"{folder} belongs to {len(found)} workflow groups: {found}"
    return found[0]


def workflow_config_dir(case: CliCase, folder: Path) -> Path:
    """The `config/` the record of the workflow folder `folder`'s workflow group keeps
    for its workflow, `<record>/<workflow>/config/`: copied from the folder on the
    workflow's first deploy, it is the config every deploy and sync uploads from then
    on, so a case that changes a deployed workflow's config edits this one."""
    record = workflow_group_record(case, folder)
    workflows = yaml.safe_load((record / "workflow_group.yaml").read_text())[
        "workflows"
    ]
    [name] = [
        name
        for name, entry in workflows.items()
        if Path(entry["path"]).resolve() == folder.resolve()
    ]
    return record / name / "config"


def workflow_group_id(case: CliCase, folder: Path) -> str:
    """The `workflow_group_id` of the workflow group deployed from `folder`, from its
    record."""
    record = workflow_group_record(case, folder)
    return yaml.safe_load((record / "workflow_group.yaml").read_text())[
        "workflow_group_id"
    ]
