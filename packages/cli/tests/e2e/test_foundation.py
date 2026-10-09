"""Executable checks for the reusable CLI end-to-end foundation."""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pexpect
import pytest

from .harness import (
    CliCase,
    ServiceOwner,
    ServiceStartError,
    ServiceStartTimeout,
    process_exists,
    reported_tcp_address,
)

SUPPORT_PROCESS = Path(__file__).with_name("support_process.py")


def service_command(case: CliCase, *args: str) -> list[str | Path]:
    """Build an argv for the controlled service with the current interpreter."""
    return [case.python, SUPPORT_PROCESS, *args]


def test_installed_cli_and_captured_processes_use_isolated_state(cli_case: CliCase):
    assert cli_case.cli == Path(sys.executable).absolute().parent / "canyonos"

    version = cli_case.run_cli(["--version"])
    assert version.returncode == 0
    assert version.stdout == "canyonos test\n"
    assert version.stderr == ""

    result = cli_case.run_python(
        SUPPORT_PROCESS,
        "stdio",
        input_text="ordinary stdin\n",
        env={"CASE_TOKEN": "owned"},
    )
    state = json.loads(result.stderr)
    assert result.returncode == 7
    assert result.stdout == "ordinary stdin\n"
    assert state == {
        "cwd": str(cli_case.cwd),
        "home": str(cli_case.home),
        "path": cli_case.env["PATH"],
        "token": "owned",
    }
    assert cli_case.env["CANYONOS_ENV"] == "test"
    assert all(
        value == "" for key, value in cli_case.env.items() if key.endswith("_IMAGE")
    )


def _wait_for_process_exit(pid: int, timeout: float = 1.0) -> bool:
    """Wait briefly for a controlled child to disappear without hanging a test."""
    deadline = time.monotonic() + timeout
    while process_exists(pid) and time.monotonic() < deadline:
        time.sleep(0.02)
    return not process_exists(pid)


def _stop_controlled_process(pid: int) -> None:
    """Clean up a support-process child if a regression check fails."""
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    _wait_for_process_exit(pid)


def test_leader_exit_returns_promptly_and_kills_its_group(cli_case: CliCase):
    child_file = cli_case.state / "detached-child-pid"
    try:
        started = time.monotonic()
        result = cli_case.run_python(SUPPORT_PROCESS, "detached-child", str(child_file))
        assert time.monotonic() - started < 5
        assert result.returncode == 0
        assert result.stdout == "leader done\n"
        assert _wait_for_process_exit(int(child_file.read_text()))
    finally:
        if child_file.exists():
            _stop_controlled_process(int(child_file.read_text()))


def test_child_in_its_own_session_cannot_hold_the_command_open(cli_case: CliCase):
    child_file = cli_case.state / "new-session-child-pid"
    try:
        started = time.monotonic()
        result = cli_case.run_python(
            SUPPORT_PROCESS, "detached-child", str(child_file), "--new-session"
        )
        assert time.monotonic() - started < 5
        assert result.returncode == 0
        assert result.stdout == "leader done\n"
    finally:
        if child_file.exists():
            _stop_controlled_process(int(child_file.read_text()))


def test_command_timeout_keeps_partial_output_and_artifacts(cli_case: CliCase):
    with pytest.raises(subprocess.TimeoutExpired) as raised:
        cli_case.run_python(SUPPORT_PROCESS, "partial-output", timeout=0.5)

    assert raised.value.output == "before-timeout\n"
    assert raised.value.stderr == "before-timeout-error\n"
    stdout_artifact = next(cli_case.artifact_dir.glob("*.stdout"))
    assert stdout_artifact.read_text() == "before-timeout\n"
    assert (
        stdout_artifact.with_suffix(".stderr").read_text() == "before-timeout-error\n"
    )
    metadata = json.loads(stdout_artifact.with_suffix(".json").read_text())
    assert metadata["timed_out"] is True


def test_cli_terminal_prompt_is_driven_through_pexpect(cli_case: CliCase):
    terminal = cli_case.spawn_cli(["config"])
    terminal.child.expect("What do you want to do?")
    terminal.child.send("\x1b")
    terminal.child.expect("Cancelled.")
    terminal.child.expect(pexpect.EOF)
    terminal.close()

    assert terminal.child.exitstatus == 0
    assert terminal.transcript_path.is_file()


def test_ready_service_reports_a_port_zero_address_and_cleans_descendants(
    cli_case: CliCase,
):
    address_file = cli_case.state / "service-address"
    child_file = cli_case.state / "child-pid"
    service = cli_case.services.start(
        "ready",
        service_command(
            cli_case,
            "service",
            str(address_file),
            "--child-file",
            str(child_file),
        ),
        cwd=cli_case.cwd,
        env=cli_case.env,
        ready=reported_tcp_address(address_file),
    )

    host, port = service.ready_value.removeprefix("tcp://").split(":")
    assert int(port) > 0
    with socket.create_connection((host, int(port)), timeout=1):
        pass

    child_pid = int(child_file.read_text())
    cli_case.services.close()
    assert service.process.returncode == 0
    assert not process_exists(child_pid)


def test_early_exit_fails_setup_with_logs_and_reaps_the_process(cli_case: CliCase):
    with pytest.raises(ServiceStartError, match="exited with 23") as raised:
        cli_case.services.start(
            "early-exit",
            service_command(cli_case, "early-exit"),
            cwd=cli_case.cwd,
            env=cli_case.env,
            ready=lambda _service: None,
        )

    assert "controlled startup failure" in str(raised.value)
    assert raised.value.service.process.returncode == 23
    assert not process_exists(raised.value.service.process.pid)


def test_readiness_timeout_stops_and_reaps_the_process(cli_case: CliCase):
    with pytest.raises(ServiceStartTimeout, match="was not ready") as raised:
        cli_case.services.start(
            "timeout",
            service_command(cli_case, "idle"),
            cwd=cli_case.cwd,
            env=cli_case.env,
            ready=lambda _service: None,
            timeout=0.1,
        )
    process = raised.value.service.process

    assert process.returncode is not None
    assert not process_exists(process.pid)


def test_partial_setup_and_assertion_failure_stop_existing_services(cli_case: CliCase):
    first_address = cli_case.state / "first-address"
    first = cli_case.services.start(
        "first",
        service_command(cli_case, "service", str(first_address)),
        cwd=cli_case.cwd,
        env=cli_case.env,
        ready=reported_tcp_address(first_address),
    )
    with pytest.raises(ServiceStartError):
        cli_case.services.start(
            "second",
            service_command(cli_case, "early-exit"),
            cwd=cli_case.cwd,
            env=cli_case.env,
            ready=lambda _service: None,
        )
    assert first.process.returncode is not None

    assertion_address = cli_case.state / "assertion-address"
    owner = ServiceOwner(cli_case.artifact_dir)
    with pytest.raises(AssertionError):
        with owner:
            service = owner.start(
                "assertion",
                service_command(cli_case, "service", str(assertion_address)),
                cwd=cli_case.cwd,
                env=cli_case.env,
                ready=reported_tcp_address(assertion_address),
            )
            raise AssertionError("controlled assertion failure")
    assert service.process.returncode is not None
