"""Isolated subprocess, terminal, and service ownership for CLI end-to-end tests."""

from __future__ import annotations

import contextlib
import json
import os
import re
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
        return path.read_text(errors="replace")[-limit:]
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
    ) -> subprocess.CompletedProcess[str]:
        """Run a command without a terminal, then kill its process group. Output goes
        to artifact files, so a lingering descendant cannot hold the call open."""
        command = [os.fspath(part) for part in argv]
        stdout_path = self._artifact_path(Path(command[0]).name, "stdout")
        stderr_path = stdout_path.with_suffix(".stderr")
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            process = subprocess.Popen(
                command,
                cwd=self.cwd,
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
                    "cwd": str(self.cwd),
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
    ) -> subprocess.CompletedProcess[str]:
        """Run the installed `canyonos` console script without a terminal."""
        return self.run(
            [self.cli, *args], input_text=input_text, timeout=timeout, env=env
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
        self, args: Sequence[str], *, timeout: float = 5.0
    ) -> TerminalProcess:
        """Run the installed CLI on a pseudoterminal and record the interaction."""
        transcript_path = self._artifact_path("canyonos-terminal", "log")
        transcript = transcript_path.open("w", encoding="utf-8")
        try:
            child = pexpect.spawn(
                str(self.cli),
                list(args),
                cwd=str(self.cwd),
                env=self.env,
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
            address = path.read_text().strip()
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
