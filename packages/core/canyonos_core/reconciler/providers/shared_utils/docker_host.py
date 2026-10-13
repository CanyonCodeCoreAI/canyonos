"""Ask Docker on a replica's host about its container, for providers that run one there."""

import logging

logger = logging.getLogger(__name__)


def container_running(controller, container, host, user):
    """Used by `is_running`: True if `container` is running on `host`. An unreachable
    host or a failed inspect counts as not running and logs a warning."""
    try:
        result = controller._run_cmd(
            ["docker", "inspect", "-f", "{{.State.Running}}", container], host, user
        )
    except RuntimeError as e:
        logger.warning("Could not inspect %s on %s: %s", container, host, e)
        return False
    if result.returncode != 0:
        logger.warning(
            "Could not inspect %s on %s: %s",
            container,
            host,
            (result.stderr or result.stdout or "").strip(),
        )
        return False
    return result.stdout.strip() == "true"


def container_log_tail(controller, container, host, user, lines):
    """Used by `log_tail`: the last `lines` lines `container` wrote on `host`, stdout
    then stderr, as a list. Raises RuntimeError with the reason when there is no
    container or docker can't read its log."""
    if not container:
        raise RuntimeError("no container")
    result = controller._run_cmd(
        ["docker", "logs", "--tail", str(lines), container], host, user
    )
    if result.returncode != 0:
        # stderr here is docker's complaint, not the agent's output.
        raise RuntimeError((result.stderr or result.stdout or "").strip())
    return [
        line
        for stream in (result.stdout, result.stderr)
        if stream
        for line in stream.splitlines()
    ]
