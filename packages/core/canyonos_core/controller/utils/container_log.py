"""Show why an agent's container failed, in the output of `canyonos deploy`."""

import logging
import threading

logger = logging.getLogger(__name__)

# Enough for the traceback that names a failed import, short enough not to bury the summary.
FAILURE_LOG_TAIL_LINES = 40
# Replicas often fail at the same moment; this keeps their logs from mixing together.
_dump_lock = threading.Lock()


def dump_container_log(instance, status, log_tail):
    """Copy the last lines of a failed container's output into this log, between
    a start line and an end line.

    `canyonos deploy` treats error lines in this log as a failed deploy. The start
    and end lines tell it that the errors in between came from the container, so it
    prints them instead of reacting to them. Each copied line is indented so it can
    never be mistaken for the end line. The start and end text must match what
    `PhaseTracker` in packages/cli/canyonos/deploy.py looks for.
    """
    name = instance["agent_name"]
    try:
        lines = log_tail(instance, FAILURE_LOG_TAIL_LINES) or [
            "(the container produced no output)"
        ]
    except Exception as e:
        # An unreadable log must not stop the failure summary that follows.
        lines = [f"could not read the log of {name}: {e}"]
    with _dump_lock:
        logger.warning(
            "--- begin container log: %s (%s:%s) status=%s ---",
            name,
            instance["private_host"],
            instance["host_port"],
            status or "unknown",
        )
        for line in lines:
            logger.warning("  %s", line)
        logger.warning("--- end container log: %s ---", name)
