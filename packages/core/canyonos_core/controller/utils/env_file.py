# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Hand the project's `.env` to agent containers.

Containers on this machine read it directly, remote ones get a short-lived 0600
copy, and either way it reaches Docker as `--env-file`.
"""

import logging
import os
from contextlib import contextmanager

logger = logging.getLogger(__name__)


@contextmanager
def env_file_args(controller, host, user, is_local):
    """
    Yield the `docker run` flags that hand the user's env file to a container.

    A container on this machine reads the original file. A container on a
    remote host gets a 0600 copy, deleted as soon as the `with` body ends --
    success or failure, since by then the container holds the variables
    itself. Keep that body tight around `docker run` so the copy is never
    on the host longer than it has to be.

    Yields an empty list when there is no env file.
    """
    env_file_path = getattr(controller, "env_file_path", None)
    if not env_file_path:
        yield []
        return

    if is_local:
        yield ["--env-file", env_file_path]
        return

    remote_path = controller._push_file(env_file_path, host, user=user)
    try:
        yield ["--env-file", remote_path]
    finally:
        _remove_remote_copy(controller, remote_path, host, user)


def _remove_remote_copy(controller, remote_path, host, user):
    """Delete a remote copy. Best effort -- never masks the caller's error."""
    try:
        remote_dir = os.path.dirname(remote_path)
        result = controller._run_cmd(["rm", "-rf", remote_dir], host, user=user)
        if getattr(result, "returncode", 0) != 0:
            logger.warning("Failed to delete env file copy %s on %s", remote_path, host)
    except Exception as e:
        logger.warning(
            "Failed to delete env file copy %s on %s: %s", remote_path, host, e
        )
