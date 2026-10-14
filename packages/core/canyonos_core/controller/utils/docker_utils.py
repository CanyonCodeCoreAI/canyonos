# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Helpers for checking the local Docker install."""

import shutil
import subprocess


def docker_available(probe_cmd=("docker", "info")):
    """Return True if Docker is installed and its daemon answers; checked before
    building images and before an EC2 deploy."""
    if not shutil.which("docker"):
        return False

    try:
        result = subprocess.run(
            list(probe_cmd),
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return False

    return result.returncode == 0
