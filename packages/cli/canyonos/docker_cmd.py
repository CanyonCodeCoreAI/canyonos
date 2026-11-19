# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Bounded Docker command execution for the CanyonOS CLI."""

import os
import subprocess
import time

# Where a container sees the Docker engine it is handed, and the alias a host without
# a unix socket of its own (Docker Desktop's named pipe on Windows) still serves.
DOCKER_SOCKET = "/var/run/docker.sock"

DOCKER_QUICK_TIMEOUT = 15
DOCKER_CLEANUP_TIMEOUT = 60
DOCKER_RUN_TIMEOUT = 120
DOCKER_PULL_TIMEOUT = 600
DOCKER_CLEANUP_RETRIES = 1
DOCKER_RETRY_DELAY = 0.5


def run_docker(argv, *, timeout, action, check=False, env=None):
    """Run Docker with a bounded wait and a user-facing failure message. Docker writes
    UTF-8 whatever the console's code page is, so its output is read as that."""
    try:
        result = subprocess.run(
            argv,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
            env=env,
        )
    except FileNotFoundError:
        raise RuntimeError(
            "Docker is not installed or is not available on PATH."
        ) from None
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"{action} timed out after {timeout}s.") from None
    except OSError as e:
        raise RuntimeError(f"{action} could not run: {e}") from None

    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(
            f"{action} failed: {detail or f'exit code {result.returncode}'}"
        )
    return result


def cleanup_docker(
    argv, *, action, missing_text=None, timeout=DOCKER_CLEANUP_TIMEOUT, env=None
):
    """Run a cleanup command, retrying once and returning its final result.

    A missing resource is already clean. Other failures are returned so callers
    can continue cleaning independent resources and report them together.
    """
    last_error = None
    for attempt in range(DOCKER_CLEANUP_RETRIES + 1):
        try:
            result = run_docker(argv, timeout=timeout, action=action, env=env)
        except RuntimeError as e:
            last_error = str(e)
        else:
            detail = (result.stderr or result.stdout or "").strip()
            if result.returncode == 0 or (
                missing_text and missing_text.casefold() in detail.casefold()
            ):
                return None
            last_error = (
                f"{action} failed: {detail or f'exit code {result.returncode}'}"
            )

        if attempt < DOCKER_CLEANUP_RETRIES:
            time.sleep(DOCKER_RETRY_DELAY)
    return last_error


def _docker_endpoint():
    """The engine plain `docker` calls reach right now (`DOCKER_HOST`, else the active
    context's): `unix://` a socket, `npipe://` Docker Desktop's pipe on Windows,
    `tcp://` or `ssh://` a remote engine. None when the context can't be read."""
    host = os.environ.get("DOCKER_HOST")
    if host is not None:
        return host
    try:
        result = subprocess.run(
            ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
            capture_output=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def docker_is_local():
    """True when plain `docker` talks to an engine on this machine, so a folder here
    can be bind-mounted: a unix socket, or Docker Desktop's named pipe on Windows."""
    endpoint = _docker_endpoint()
    return endpoint is not None and endpoint.startswith(("unix://", "npipe://"))


def active_docker_socket():
    """Real path of the unix socket plain `docker` calls resolve to right now, or None
    for a named pipe or a remote endpoint (no socket on this machine to name)."""
    endpoint = _docker_endpoint()
    if endpoint is None or not endpoint.startswith("unix://"):
        return None
    return os.path.realpath(endpoint[len("unix://") :])


def mounted_docker_socket():
    """The socket a container is handed at `DOCKER_SOCKET` to reach the engine plain
    `docker` calls reach here: the real one behind the active context, not the alias,
    which another app can point at a different engine; the alias itself when this
    machine has no unix socket to name."""
    return active_docker_socket() or DOCKER_SOCKET
