"""Copy a locally built agent image to a remote Docker host over SSH."""

import logging
import shlex
import subprocess

logger = logging.getLogger(__name__)


def transfer_image(controller, image, host, user):
    """Stream `image` to `host` with docker save | zstd | ssh docker load."""
    logger.info("Transferring image %s to %s", image, host)
    result = subprocess.run(
        "set -o pipefail; "
        f"docker save {shlex.quote(image)} | zstd -T0 | "
        f"{shlex.join(controller._ssh_args(host, user))} "
        "'set -o pipefail; zstd -d | sudo docker load'",
        shell=True,
        capture_output=True,
        text=True,
        executable="/bin/bash",
        timeout=180,
    )
    logger.info(
        "docker save|load returncode=%s stdout=%s stderr=%s",
        result.returncode,
        result.stdout,
        result.stderr,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to transfer image to {host}: {result.stderr}")
