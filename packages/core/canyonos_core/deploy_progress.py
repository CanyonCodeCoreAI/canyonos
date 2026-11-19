# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Read a deploy's output lines into its progress: the phase it is in, the steps it
finished, and why it failed. The server's
`GET /v1/workflow-groups/<workflow_group_id>` reports it."""

import re
import threading
import time
from collections import deque

_TRACEBACK = "Traceback (most recent call last):"

# Substrings that mean the in-container deploy hit something fatal. `WARNING:` is
# deliberately absent: the OTel-not-configured notice and stub_generator's
# "Warning:" lines are benign and fire on nearly every run. `CRITICAL:` is the
# levelname prefix logging emits for the GlobalController's pre-exit failures
# (a Redis port collision, a missing Docker), which otherwise vanish in quiet mode.
_ERROR_MARKERS = (
    "ERROR:",
    "CRITICAL:",
    _TRACEBACK,
    "ERROR: failed to solve",
    "process did not complete successfully",
)

# Lines logged at ERROR: that are expected, self-recovering noise -- not a
# reason to abort the deploy. Checked before _ERROR_MARKERS so they never
# match. Both come from OTel export to a destination (the dashboard's ingest)
# that isn't reachable yet, which is normal on every cold deploy since
# `canyonos serve` hasn't been started at that point: the OpenTelemetry SDK's
# own loggers, and `otlp_exporter/otel_exporter.py`'s "Destination X failed to
# export ..." lines (it runs as a script, so its logger is `__main__`). Both
# retry and recover on their own once the dashboard comes up.
_BENIGN_ERROR_PREFIXES = ("ERROR:opentelemetry.", "ERROR:__main__:Destination ")

# The global controller and the reconciler bracket each failed container's log with
# these (`dump_container_log`). What sits between them is another process's output
# quoted verbatim -- its own ERROR lines and tracebacks -- so `_ERROR_MARKERS`
# must not be applied to it: the deploy's verdict belongs to the summary that
# follows the block, not to a line the block is quoting.
_CONTAINER_LOG_BEGIN = "--- begin container log:"
_CONTAINER_LOG_END = "--- end container log:"

# The global controller logs this once, when the workflow is up.
UP_MARKER = "Global controller started, polling every"

# The global controller's verdict when a replica never came up. Its own words
# only name the agent; the reason is in the container log quoted before it.
_READINESS_FAILED = "failed to become healthy"
# Its verdict when a replica's launch failed, e.g. an EC2 replica that never answered.
_LAUNCH_FAILED = "could not start:"

# uv's own explanation inside a buildx step, e.g. `#22 0.419 error: No solution found`.
_STEP_DETAIL = re.compile(r"#(\d+) [\d.]+\s+((?:error|cause|hint): .*)")

# A buildx step opening (`#22 [agent 5/9] RUN ...`) and closing (`#22 DONE 0.3s`).
_STEP_OPEN = re.compile(r"#(\d+) (\[[^\]]+\] .+)")
_STEP_CLOSE = re.compile(r"#(\d+) (?:DONE|CACHED|ERROR|CANCELED)\b")

# The last line of a Python traceback, e.g. `RuntimeError: boom`.
_EXCEPTION_LINE = re.compile(
    r"[A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt)\b(?::.*)?"
)

# Strict, so buildx's `ERROR: failed to solve: ...` is not read as a log line.
_LOG_LINE = re.compile(r"[A-Z]+:[^\s:]+:(.*)")


def _log_message(line):
    """The message of a `LEVEL:logger:message` line, or "" for anything else.

    Sentinels count only at the start of the message: every quoted payload line
    is indented, so text that merely mentions one can never open or close a
    block.
    """
    log = _LOG_LINE.match(line)
    return log.group(1) if log else ""


# (substring, spinner message, completed message). A None spinner message keeps
# whatever the spinner already shows; a None completed message prints nothing.
# Matched by substring against the raw line, so a phase that never runs is simply
# never matched -- nothing here assumes a phase happens, or happens in order.
_PHASES = (
    ("Generating stub:", "Generating stubs and Docker contexts...", None),
    ("Compiling gRPC proto:", "Generating stubs and Docker contexts...", None),
    ("Generating Docker context", "Generating stubs and Docker contexts...", None),
    ("No Docker images to build.", None, "No images to build"),
    ("Build complete.", None, "Build complete"),
    ("Deploying /", "Starting deploy...", None),
    ("Checking for stale containers", "Removing stale containers...", None),
    ("Redis launched on", None, "Redis ready"),
    ("Docker container(s) across", "Starting agents...", None),
)


class PhaseTracker:
    """Turns the container's log lines into the handful of events worth showing.

    `parse_line()` returns (spinner_message, completed_message, is_error) -- any of
    which may be None -- so the caller owns all printing.
    """

    def __init__(self):
        self.spinner = None
        self.replicas_total = 0
        self.replicas_ready = set()
        self.open_steps = {}
        # The controller starts while images build; its steps must not hide the build.
        self.building = False
        self.in_container_log = False
        self.step_details = {}
        self.agent_errors = []
        self._quoted_agent = None
        self._quoted_error = None
        self._quoted_exception = None

    def _agent_progress(self):
        if self.replicas_total:
            return f"Starting agents ({len(self.replicas_ready)}/{self.replicas_total} ready)..."
        return "Starting agents..."

    def parse_line(self, line):
        """Read one deploy log line and return the progress message `canyonos deploy`
        should show in the terminal for it, if any."""
        # A quoted container log is data, not this deploy's own output: nothing
        # inside the block decides anything. The caller still prints and buffers
        # every line of it -- that block is the whole point of the dump.
        message = _log_message(line)
        if message.startswith(_CONTAINER_LOG_BEGIN):
            self.in_container_log = True
            self._open_quote(message[len(_CONTAINER_LOG_BEGIN) :])
            return None, None, False
        if message.startswith(_CONTAINER_LOG_END):
            self.in_container_log = False
            self._close_quote()
            return None, None, False
        if self.in_container_log:
            self._quote(message.strip())
            return None, None, False

        detail = _STEP_DETAIL.match(line)
        if detail:
            self.step_details.setdefault(detail.group(1), []).append(detail.group(2))

        if any(prefix in line for prefix in _BENIGN_ERROR_PREFIXES):
            return None, None, False
        if any(marker in line for marker in _ERROR_MARKERS):
            return None, None, True

        opened = _STEP_OPEN.match(line)
        if opened:
            self.open_steps.setdefault(
                opened.group(1), (opened.group(2), time.monotonic())
            )
        closed = _STEP_CLOSE.match(line)
        if closed:
            self.open_steps.pop(closed.group(1), None)
        if "Build complete." in line:
            self.open_steps.clear()
            self.building = False

        count = re.search(r"Building (\d+) Docker image\(s\) via", line)
        if count:
            self.building = True
            self.spinner = f"Building {count.group(1)} images..."
            return self.spinner, None, False

        replicas = re.search(r"Waiting for (\d+) replica\(s\) to become healthy", line)
        if replicas:
            self.replicas_total = int(replicas.group(1))
            self.spinner = self._agent_progress()
            return self.spinner, None, False

        # Matched on the published address, since the name repeats across an agent's replicas.
        ready = re.search(r"Controller (\S+ \([^)]+\)) is ready\.", line)
        if ready:
            self.replicas_ready.add(ready.group(1))
            self.spinner = self._agent_progress()
            return self.spinner, None, False

        for marker, spinner, done in _PHASES:
            if marker in line:
                # Repeats (one `Generating stub:` per agent) collapse: the
                # spinner is only re-emitted when the message actually changes.
                if spinner and spinner != self.spinner and not self.building:
                    self.spinner = spinner
                    return spinner, done, False
                return None, done, False

        return None, None, False

    def oldest_open_step(self):
        """The buildx step that has been running longest, as (name, started), or None.

        buildx builds every image at once and reprints a step's header whenever its
        output resumes, so the last header seen is not the step holding things up.
        """
        return min(self.open_steps.values(), key=lambda step: step[1], default=None)

    def _open_quote(self, header):
        self._quoted_agent = (header.split() or ["agent"])[0]
        self._quoted_error = None
        self._quoted_exception = None

    def _quote(self, payload):
        if payload.startswith("ERROR:") and self._quoted_error is None:
            self._quoted_error = _log_message(payload) or payload
        elif _EXCEPTION_LINE.fullmatch(payload):
            self._quoted_exception = payload

    def _close_quote(self):
        error = self._quoted_error or self._quoted_exception
        if error:
            self.agent_errors.append(f"{self._quoted_agent}: {error}")

    def explain_failure(self, trigger, after):
        """Say why the deploy failed, for the Root Cause line in the terminal.

        A failed build step is explained by uv's own lines for that step, a
        replica that never came up by the error its container logged, and a
        traceback by the exception line that ends it, found in the log lines
        `after` the trigger. Any other failure line explains itself, without its
        log prefix.
        """
        step = re.match(r"#(\d+) ERROR: ", trigger)
        if step and step.group(1) in self.step_details:
            return "\n".join(self.step_details[step.group(1)])
        if self.agent_errors and (
            _READINESS_FAILED in trigger or _LAUNCH_FAILED in trigger
        ):
            return "\n".join(self.agent_errors)
        if _TRACEBACK in trigger:
            for line in after:
                if _EXCEPTION_LINE.fullmatch(line.rstrip()):
                    return line.rstrip()
        return (_log_message(trigger) or trigger).strip()

    def agents_ready_message(self):
        """(message, all_ready). Stays partial-aware because the up-marker can
        arrive with agents still unhealthy on runtimes that only warn about it.
        """
        ready = len(self.replicas_ready)
        if not self.replicas_total:
            return "Workflow ready", True
        if ready < self.replicas_total:
            return (
                f"Workflow up, but only {ready}/{self.replicas_total} agents reported healthy",
                False,
            )
        return f"{ready} agent(s) ready", True


# What the deploy process logs after a SIGHUP, once the reload is done.
_RELOADED = "Config reloaded."
_RELOAD_FAILED = "Reload failed: "

_KEPT_LINES = 20_000


class DeployProgress:
    """One deploy as the server sees it: its process, its last 20,000 output lines (the
    controller log), its phase, and its last reload's outcome. The server's reader
    thread feeds it each line the process prints, then calls `finish` once it exits."""

    def __init__(self, process, deployed):
        self.process = process
        self.tracker = PhaseTracker()
        self.phase = "starting"
        self.message = None
        self.steps = []
        self.error = None
        self.error_code = None
        self.root_cause = None
        self.reload = None
        self.deployed = deployed
        self.lines = deque(maxlen=_KEPT_LINES)
        # Every line added so far, including those `lines` no longer keeps.
        self.line_count = 0
        self.last_output = None
        self.stopping = False
        self.finished = False
        self.reload_answered = False
        # Held while the fields change; notified on each new line and on finish.
        self.changed = threading.Condition()
        self._trigger = None
        self._after = []

    def add_line(self, line):
        """Record one output line and apply it to the phase and reload outcome."""
        with self.changed:
            self.lines.append(line)
            self.line_count += 1
            self.last_output = time.monotonic()
            self._apply(line)
            self.changed.notify_all()

    def _apply(self, line):
        message = _log_message(line)
        if message == _RELOADED:
            self.reload = {"ok": True, "error": None}
            self.reload_answered = True
        elif message.startswith(_RELOAD_FAILED):
            self.reload = {"ok": False, "error": message[len(_RELOAD_FAILED) :]}
            self.reload_answered = True

        if self._trigger is not None:
            self._after.append(line)
            self.root_cause = self.tracker.explain_failure(self._trigger, self._after)
            return
        if self.phase != "starting":
            return
        spinner, done, is_error = self.tracker.parse_line(line)
        if is_error:
            self.phase, self.error, self._trigger = "failed", "Deploy failed.", line
            self.error_code = "deploy_failed"
            self.root_cause = self.tracker.explain_failure(line, self._after)
            return
        if done:
            self.steps.append(done)
        if spinner:
            self.message = spinner
        if UP_MARKER in line and not self.tracker.in_container_log:
            summary, all_ready = self.tracker.agents_ready_message()
            if all_ready:
                self.phase, self.message = "up", None
                self.steps.append(summary)
            else:
                self.phase = "failed"
                self.error = f"Deploy is incomplete: {summary.lower()}."
                self.error_code = "deploy_incomplete"

    def finish(self, returncode):
        """Settle the phase once the deploy process has exited with `returncode`."""
        with self.changed:
            if self.stopping and self.phase != "failed":
                self.phase = "stopped"
            elif self.phase == "starting":
                self.phase = "failed"
                self.error = "The deploy stopped before the workflow came up."
                self.error_code = "deploy_stopped_early"
            elif self.phase == "up":
                self.phase = "failed"
                self.error = f"The Global Controller exited with code {returncode}."
                self.error_code = "controller_exited"
            self.finished = True
            self.changed.notify_all()

    def report(self):
        """Return the deploy's fields of
        `GET /v1/workflow-groups/<workflow_group_id>`."""
        with self.changed:
            now = time.monotonic()
            oldest = self.tracker.oldest_open_step()
            return {
                "running": not self.finished,
                "phase": self.phase,
                "message": self.message,
                "steps": list(self.steps),
                "slowest_step": (
                    {"name": oldest[0], "seconds": round(now - oldest[1], 1)}
                    if oldest
                    else None
                ),
                "idle_seconds": (
                    round(now - self.last_output, 1)
                    if self.last_output is not None
                    else None
                ),
                "error": self.error,
                "error_code": self.error_code,
                "root_cause": self.root_cause,
            }
