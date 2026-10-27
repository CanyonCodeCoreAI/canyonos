# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import subprocess
import sys

from canyonos import docker_cmd


def test_run_docker_reports_timeout(monkeypatch):
    def timed_out(*args, **kwargs):
        raise subprocess.TimeoutExpired(kwargs["timeout"], args[0])

    monkeypatch.setattr(docker_cmd.subprocess, "run", timed_out)
    try:
        docker_cmd.run_docker(["docker", "info"], timeout=3, action="Checking Docker")
    except RuntimeError as exc:
        assert str(exc) == "Checking Docker timed out after 3s."
    else:
        raise AssertionError("expected timeout error")


def test_cleanup_retries_once_and_returns_final_failure(monkeypatch):
    calls = []

    def failed(argv, **kwargs):
        calls.append((argv, kwargs["timeout"]))
        return subprocess.CompletedProcess(argv, 1, "", "busy")

    monkeypatch.setattr(docker_cmd.subprocess, "run", failed)
    monkeypatch.setattr(docker_cmd.time, "sleep", lambda _: None)

    error = docker_cmd.cleanup_docker(
        ["docker", "rm", "x"], action="Removing x", timeout=7
    )

    assert error == "Removing x failed: busy"
    assert len(calls) == 2
    assert all(timeout == 7 for _, timeout in calls)


def test_run_docker_reads_utf8_output_whatever_the_console_code_page_is():
    # Docker writes UTF-8; "Ł" is bytes the Windows ANSI code page can't decode.
    result = docker_cmd.run_docker(
        [sys.executable, "-c", "import sys; sys.stdout.buffer.write('Ł'.encode())"],
        timeout=30,
        action="Printing",
    )

    assert result.stdout == "Ł"
