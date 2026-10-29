# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Put this checkout's CanyonOS on a machine `canyonos provision` launched, for when it
runs from a development CLI and you choose the dev version over the official release.

The Global Controller image is built here for the machine's platform and streamed to
it over SSH; the checkout is copied with rsync and the CLI installed from it with uv,
in development mode, so `canyonos deploy` on the machine uses that image. Nothing here
depends on which cloud the machine is in.
"""

import shlex
import shutil
import subprocess
import time

from canyonos import env

# Agent machines are x86, so the image the controller runs is built for them too.
PLATFORM = "linux/amd64"
# A tag of its own here, so this machine's `canyonos-core:dev` (often arm64) is kept.
BUILD_TAG = f"{env.LOCAL_CORE_IMAGE}-amd64"
REMOTE_CHECKOUT = "canyonos"
TOOLS = ("docker", "rsync", "ssh")
# Rebuilt on the machine, or must not travel: build output, caches, and the local
# `.env`, which is replaced with one for the machine.
SYNC_EXCLUDES = (
    ".git",
    ".venv",
    "node_modules",
    ".canyon",
    ".turbo",
    "__pycache__",
    "*.egg-info",
    "dist",
    "build",
    "packages/cli/.env",
)
# The machine's CLI uses the shipped image; the dashboard and skill fall back to the
# ones this version pins, since only the Global Controller image is shipped.
REMOTE_ENV = f"""CANYONOS_ENV={env.DEVELOPMENT}
CANYONOS_CORE_IMAGE={env.LOCAL}
"""
BOOT_TIMEOUT_SECONDS = 900
# What `ssh` exits with when it couldn't connect, as opposed to the command failing.
SSH_UNREACHABLE = 255


class DevMachineError(RuntimeError):
    """Putting this checkout on the machine failed."""


def missing_tools():
    """The commands shipping the dev version needs that this machine doesn't have."""
    return [tool for tool in TOOLS if shutil.which(tool) is None]


def ssh_command(key_path, address, user):
    """The `ssh` command for the machine, as a list: no prompts, and the machine's host
    key accepted the first time, since it is new."""
    return [
        "ssh",
        "-i",
        str(key_path),
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=10",
        f"{user}@{address}",
    ]


def build_core_image():
    """Build the Global Controller image from this checkout for the machine's platform,
    showing Docker's output in the terminal. Takes a while on an Arm machine, which
    emulates x86 to build it."""
    subprocess.run(
        [
            "docker",
            "build",
            "--platform",
            PLATFORM,
            "-f",
            "packages/core/Dockerfile",
            "-t",
            BUILD_TAG,
            "packages/core",
        ],
        cwd=env.REPO_ROOT,
        check=True,
    )


def wait_for_boot(ssh, timeout_seconds=BOOT_TIMEOUT_SECONDS):
    """Wait until the machine answers SSH and its boot script has finished. Raises
    DevMachineError if the boot script failed or the machine never answered."""
    deadline = time.monotonic() + timeout_seconds
    while True:
        result = subprocess.run(
            [*ssh, "cloud-init status --wait"], capture_output=True, text=True
        )
        # 2 is cloud-init finishing with warnings it recovered from.
        if result.returncode in (0, 2):
            return
        if result.returncode != SSH_UNREACHABLE:
            raise DevMachineError(
                "The machine's boot script failed; see "
                "/var/log/cloud-init-output.log on it."
            )
        if time.monotonic() >= deadline:
            raise DevMachineError(
                f"The machine didn't answer SSH: {result.stderr.strip()}"
            )
        time.sleep(5)


def sync_command(ssh, destination):
    """The `rsync` command that copies this checkout to `destination` on the machine."""
    excludes = [f"--exclude={pattern}" for pattern in SYNC_EXCLUDES]
    return [
        "rsync",
        "-az",
        "--delete",
        *excludes,
        "-e",
        shlex.join(ssh[:-1]),
        f"{env.REPO_ROOT}/",
        f"{ssh[-1]}:{destination}/",
    ]


def ship_command(ssh, compressor="gzip"):
    """The shell pipeline that streams the built image to the machine, loads it into
    its Docker, and tags it as the dev image the machine's CLI uses."""
    decompress = {"zstd": "zstd -dc", "gzip": "gunzip -c"}[compressor]
    remote = (
        f"{decompress} | docker load && docker tag {BUILD_TAG} {env.LOCAL_CORE_IMAGE}"
    )
    compress = "zstd -c -T0" if compressor == "zstd" else "gzip -1 -c"
    return (
        f"docker save {shlex.quote(BUILD_TAG)} | {compress} | "
        f"{shlex.join(ssh)} {shlex.quote(remote)}"
    )


def install_command(destination):
    """The command run on the machine that installs the CLI from the copied checkout in
    development mode."""
    return (
        "set -e; "
        f"printf %s {shlex.quote(REMOTE_ENV)} > ~/{destination}/packages/cli/.env; "
        "~/.local/bin/uv tool install --python 3.11 --force "
        f"--editable ~/{destination}/packages/cli"
    )


def _run(args, step, **kwargs):
    result = subprocess.run(args, text=True, **kwargs)
    if result.returncode != 0:
        detail = (result.stderr or "").strip().splitlines()[-5:]
        raise DevMachineError(
            f"{step} failed (exit {result.returncode})"
            + (":\n" + "\n".join(detail) if detail else ".")
        )


def install_on(key_path, address, user, status):
    """Copy this checkout to the machine, ship the built image to it, and install the
    CLI there. `status` shows a spinner with a message while a step runs."""
    ssh = ssh_command(key_path, address, user)
    with status("Waiting for the machine to finish booting"):
        wait_for_boot(ssh)
    with status("Copying this checkout to the machine"):
        _run(
            sync_command(ssh, REMOTE_CHECKOUT),
            "Copying the checkout",
            capture_output=True,
        )
    compressor = "zstd" if shutil.which("zstd") else "gzip"
    with status("Sending the Global Controller image to the machine"):
        _run(
            ["bash", "-o", "pipefail", "-c", ship_command(ssh, compressor)],
            "Sending the image",
            capture_output=True,
        )
    with status("Installing this checkout's CLI on the machine"):
        _run(
            [*ssh, install_command(REMOTE_CHECKOUT)],
            "Installing the CLI",
            capture_output=True,
        )
