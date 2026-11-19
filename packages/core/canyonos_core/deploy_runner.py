# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`run-deploy`, the Global Controller container's main process on Docker: run the
deploy in a child process, copy its output to the container's log, and keep its
progress in a file the CanyonOS API reads from the container. Imports only the
standard library and `deploy_progress`, so it starts before anything else can fail."""

import importlib.metadata
import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time

from canyonos_core.deploy_progress import DeployProgress

logger = logging.getLogger("canyonos_core.deploy_runner")

# In the container's own filesystem: written from the first line on, kept after it
# exits, and read by the CanyonOS API with Docker's archive API.
PROGRESS_FILE = "/var/lib/canyonos/progress.json"
STARTUP_TIMEOUT_SECONDS = 30 * 60
# A failed deploy usually stops itself; waited out so its log and root cause are complete.
SELF_STOP_SECONDS = 30
# How often the file is rewritten at most while only new lines arrive.
WRITE_INTERVAL_SECONDS = 0.5
# How long the output of the deploy's own children is still read after it exited.
DRAIN_SECONDS = 5
# Signals passed on to the deploy: SIGTERM and SIGINT stop it, SIGHUP reloads its config.
_STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT)


class _Runner:
    """One run of the deploy: its child process, its progress, whether it was asked to
    stop, and what was last written to the progress file."""

    def __init__(self, workspace, progress_file):
        self.workspace = workspace
        self.progress_file = progress_file
        self.progress = DeployProgress(None, None)
        self.version = importlib.metadata.version("canyonos-core")
        self.started_at = time.time()
        self.started = time.monotonic()
        self.process = None
        self.asked_to_stop = False
        # Set once this runner sent the deploy a SIGTERM of its own or passed one on.
        self.stop_sent = False
        self.failed_since = None
        self.exit_code = None
        self.written = None
        self.written_lines = -1
        self.written_at = 0.0

    def run(self):
        """Run the deploy to its end and return the exit code for this process."""
        os.makedirs(os.path.dirname(self.progress_file), exist_ok=True)
        for sig in (*_STOP_SIGNALS, signal.SIGHUP):
            signal.signal(sig, self._forward)
        self._write()
        # Build then launch the Global Controller, with cwd as the workspace so build
        # outputs land beside the workflows; unbuffered, so each line comes as printed.
        self.process = subprocess.Popen(
            [sys.executable, "-m", "canyonos_core.cli", "deploy"],
            cwd=self.workspace,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            errors="replace",
        )
        self.progress.process = self.process
        if self.asked_to_stop:
            self._send(signal.SIGTERM)
        reader = threading.Thread(
            target=self._read_output,
            args=(self.process.stdout,),
            name="deploy-output",
            daemon=True,
        )
        reader.start()
        while self.process.poll() is None:
            with self.progress.changed:
                self.progress.changed.wait(WRITE_INTERVAL_SECONDS)
            self._watch()
            self._write_if_due()
        # The deploy's own children can hold its output open after it exited.
        reader.join(DRAIN_SECONDS)
        returncode = self.process.returncode
        # A death by signal N is reported as 128 + N, as a shell does.
        child_code = 128 - returncode if returncode < 0 else returncode
        self.exit_code = 0 if self.asked_to_stop else child_code
        self.progress.finish(self.exit_code)
        self._write()
        return self.exit_code

    def _forward(self, sig, frame):
        """Pass a signal this process got on to the deploy; SIGTERM and SIGINT also
        mark it as asked to stop, so the deploy that ends then counts as stopped."""
        if sig in _STOP_SIGNALS:
            self.asked_to_stop = True
            with self.progress.changed:
                self.progress.stopping = True
                self.progress.changed.notify_all()
        self._send(sig)

    def _send(self, sig):
        """Send `sig` to the deploy once it was started, recording a stop signal as
        sent."""
        if self.process is None:
            return
        if sig in _STOP_SIGNALS:
            self.stop_sent = True
        self.process.send_signal(sig)

    def _read_output(self, output):
        """Copy each line the deploy prints on `output` to this process's stdout, the
        container's log, and into its progress. Runs on its own thread."""
        for line in output:
            sys.stdout.write(line)
            sys.stdout.flush()
            self.progress.add_line(line)

    def _watch(self):
        """Fail the deploy when it is not up within 30 minutes, and stop it once it has
        failed and has not stopped itself within 30 seconds."""
        if self.stop_sent:
            return
        progress, now = self.progress, time.monotonic()
        with progress.changed:
            if (
                progress.phase == "starting"
                and now > self.started + STARTUP_TIMEOUT_SECONDS
            ):
                progress.phase, progress.error_code = "failed", "deploy_timeout"
                progress.error = (
                    f"The deploy was not up within {STARTUP_TIMEOUT_SECONDS // 60} "
                    "minutes."
                )
            elif progress.phase == "failed":
                if self.failed_since is None:
                    self.failed_since = now
                if now < self.failed_since + SELF_STOP_SECONDS:
                    return
            else:
                return
            progress.stopping = True
        logger.warning("%s Stopping it.", progress.error)
        self._send(signal.SIGTERM)

    def _record(self):
        """Return the progress file's content (the deploy's phase, progress and verdict,
        its last reload's outcome, and whether it was stopped and has ended) and the
        number of lines the deploy printed so far."""
        progress = self.progress
        with progress.changed:
            oldest = progress.tracker.oldest_open_step()
            reload = progress.reload or {"ok": None, "error": None}
            return {
                "version": self.version,
                "started_at": self.started_at,
                "phase": progress.phase,
                "message": progress.message,
                "steps": list(progress.steps),
                "slowest_step": (
                    {"name": oldest[0], "started_at": oldest[1]} if oldest else None
                ),
                "last_output_at": progress.last_output,
                "error": progress.error,
                "error_code": progress.error_code,
                "root_cause": progress.root_cause,
                "reload": {
                    "seq": progress.reload_seq,
                    "ok": reload["ok"],
                    "error": reload["error"],
                },
                "stopping": progress.stopping,
                "finished": progress.finished,
                "exit_code": self.exit_code if progress.finished else None,
            }, progress.line_count

    def _write_if_due(self):
        """Rewrite the progress file when anything but the output changed, or when new
        lines came and it was not written in the last half second."""
        record, line_count = self._record()
        if _settled(record) != self.written or (
            line_count != self.written_lines
            and time.monotonic() >= self.written_at + WRITE_INTERVAL_SECONDS
        ):
            self._write(record, line_count)

    def _write(self, record=None, line_count=None):
        """Replace the progress file with the deploy's current record, all at once, so a
        reader never sees half of one."""
        if record is None:
            record, line_count = self._record()
        temporary = f"{self.progress_file}.tmp"
        with open(temporary, "w", encoding="utf-8") as f:
            json.dump({**record, "updated_at": time.time()}, f)
        os.replace(temporary, self.progress_file)
        self.written = _settled(record)
        self.written_lines, self.written_at = line_count, time.monotonic()


def _settled(record):
    """`record` without the fields that change with every output line, whose change
    alone waits for the write interval."""
    return {
        key: value
        for key, value in record.items()
        if key not in ("slowest_step", "last_output_at")
    }


def run(workspace=None, progress_file=PROGRESS_FILE):
    """Run the deploy of the workflow group in `workspace` (the current folder by
    default), keeping its progress in `progress_file`, and return the exit code: 0 when
    this process was asked to stop and the deploy ended, else the deploy's own."""
    return _Runner(workspace or os.getcwd(), progress_file).run()
