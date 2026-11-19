# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The job worker the CanyonOS API's `core` sidecar runs on Kubernetes
(`canyonos_core.cli job-worker --queue /workspace/.canyonos/jobs`): it runs the
`canyonos_core.cli` commands the API asks for, each against one workflow group's folder
in the workspace shared with the API, the current folder (`/workspace`). The API and
this worker share only files, so no exec rights, network listener or cluster rights
are needed.

A request is a JSON file `<id>.json` in the queue folder, `<id>` made of letters,
digits, `-` and `_`. The API writes it under another name (for example
`<id>.json.tmp`) and renames it, so the worker never reads half of one:

    {"id": "<id>", "workflow_group_id": "<uuid>", "timeout_seconds": 300,
     "command": ["put-workflow", "hello",
                 "--archive", "/workspace/.canyonos/uploads/<id>.tar.gz"]}

- `id`: optional; when given, it must be the file's `<id>`.
- `workflow_group_id`: the group's uuid (8-4-4-4-12 hex digits). The command runs with
  `/workspace/<workflow_group_id>` as its current folder, created when missing.
- `command`: the subcommand and its arguments: `put-workflow`, `remove-workflows`,
  `kubernetes-plan` or `bundle-workspace`. Paths outside the group's folder, such as
  uploads and bundles, are given absolute.
- `timeout_seconds`: optional, default 300. The command is killed after that long.

The answer is `<id>.out.json` in the same folder, written as `<id>.out.json.tmp` and
renamed, after which the request is removed:

    {"exit_code": 0, "stdout": {...}, "stderr_tail": "..."}

- `exit_code`: the command's exit code; 124 when it timed out, 128 + N when signal N
  killed it, 1 for a bad request.
- `stdout`: the one JSON object the command shows on stdout. When there is none (a bad
  request, a timeout, a crash), `{"error": <why>, "code": "bad_request" | "timeout" |
  "no_output"}`.
- `stderr_tail`: the last 8000 characters of the command's log.

The API reads and removes the answer. When it gives up on a request, it removes the
request: a job still running then writes no answer. The oldest requests run first, up
to three at once; the API runs one job at a time per workflow group. Requests left in
the queue when the worker stopped are run again when it starts (every command may be
run twice). On start the worker writes this core's version to
`/workspace/.canyonos/core-version`, which the API reports as the deploy's version. On
SIGTERM it stops its running commands and exits, leaving their requests for the next
start."""

import json
import logging
import os
import re
import signal
import subprocess
import sys
import threading
import time
from importlib import metadata

logger = logging.getLogger(__name__)

POLL_SECONDS = 0.1
MAX_JOBS = 3
DEFAULT_TIMEOUT_SECONDS = 300
TIMEOUT_EXIT_CODE = 124
STDERR_TAIL_CHARS = 8000
# How long running commands get to exit on SIGTERM before they are killed.
STOP_GRACE_SECONDS = 5
# The commands the CanyonOS API runs through this worker on Kubernetes.
COMMANDS = ("put-workflow", "remove-workflows", "kubernetes-plan", "bundle-workspace")
REQUEST_SUFFIX = ".json"
ANSWER_SUFFIX = ".out.json"
REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
WORKFLOW_GROUP_ID = re.compile(r"[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")
VERSION_FILE = os.path.join(".canyonos", "core-version")


class BadRequest(Exception):
    """A request the worker cannot run; its message says why, in the answer."""


def _write_file(path, text):
    """Write `text` to `path` all at once: a reader sees the old file or the new one."""
    with open(f"{path}.tmp", "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(f"{path}.tmp", path)


def _read_request(path, request_id):
    """Return the workflow group id, command and timeout of the request at `path`; raise
    BadRequest when it is not one the worker can run."""
    if not REQUEST_ID.fullmatch(request_id):
        raise BadRequest(f"{request_id!r} is not a job id.")
    try:
        with open(path, encoding="utf-8") as f:
            request = json.load(f)
    except FileNotFoundError:
        raise
    except (OSError, ValueError) as e:
        raise BadRequest(f"Could not read the job request: {e}") from None
    if not isinstance(request, dict):
        raise BadRequest("The job request is not a JSON object.")
    if request.get("id", request_id) != request_id:
        raise BadRequest(f"The job request's id is not {request_id!r}.")
    workflow_group_id = request.get("workflow_group_id")
    if not isinstance(workflow_group_id, str) or not WORKFLOW_GROUP_ID.fullmatch(
        workflow_group_id
    ):
        raise BadRequest("The job request's workflow_group_id is not a uuid.")
    command = request.get("command")
    if (
        not isinstance(command, list)
        or not command
        or not all(isinstance(argument, str) for argument in command)
    ):
        raise BadRequest("The job request's command is not a list of strings.")
    if command[0] not in COMMANDS:
        raise BadRequest(
            f"{command[0]!r} is not a command the worker runs: {', '.join(COMMANDS)}."
        )
    timeout = request.get("timeout_seconds", DEFAULT_TIMEOUT_SECONDS)
    if timeout is None:
        timeout = DEFAULT_TIMEOUT_SECONDS
    if (
        isinstance(timeout, bool)
        or not isinstance(timeout, (int, float))
        or timeout <= 0
    ):
        raise BadRequest("The job request's timeout_seconds is not a positive number.")
    return workflow_group_id, command, timeout


def _failed(exit_code, error, code, stderr_tail=""):
    """The answer to a job that showed no result of its own."""
    return {
        "exit_code": exit_code,
        "stdout": {"error": error, "code": code},
        "stderr_tail": stderr_tail,
    }


def _shown_object(stdout):
    """Return the JSON object the command showed on stdout, its last line, or None."""
    lines = stdout.decode("utf-8", "replace").strip().splitlines()
    try:
        shown = json.loads(lines[-1]) if lines else None
    except ValueError:
        return None
    return shown if isinstance(shown, dict) else None


class JobWorker:
    """Runs the requests in the queue folder `queue`, each in its workflow group's
    folder under `workspace`, until `stop` is called."""

    def __init__(self, workspace, queue):
        self.workspace, self.queue = workspace, queue
        self._stopping = threading.Event()
        self._lock = threading.Lock()
        # Running jobs by request id, and their command once it started.
        self._threads = {}
        self._processes = {}
        # Requests whose answer could not be written or which could not be removed:
        # not run again until the worker restarts, so one never loops.
        self._abandoned = set()

    def run(self):
        """Write the core version, then run requests until `stop`; stop the running
        commands then, leaving their requests in the queue."""
        os.makedirs(self.queue, exist_ok=True)
        version_path = os.path.join(self.workspace, VERSION_FILE)
        os.makedirs(os.path.dirname(version_path), exist_ok=True)
        _write_file(version_path, metadata.version("canyonos-core"))
        logger.info("Running the jobs in %s", self.queue)
        while not self._stopping.is_set():
            try:
                self._start_waiting_jobs()
            except OSError as e:
                logger.error("Could not read the job queue %s: %s", self.queue, e)
            self._stopping.wait(POLL_SECONDS)
        self._stop_jobs()

    def stop(self):
        """Have `run` stop its commands and return."""
        self._stopping.set()

    def _waiting_requests(self):
        """The ids of the requests in the queue, oldest first."""
        requests = []
        with os.scandir(self.queue) as entries:
            for entry in entries:
                name = entry.name
                if (
                    not name.endswith(REQUEST_SUFFIX)
                    or name.endswith(ANSWER_SUFFIX)
                    or name.startswith(".")
                ):
                    continue
                try:
                    requests.append((entry.stat().st_mtime_ns, name))
                except FileNotFoundError:
                    continue
        return [name[: -len(REQUEST_SUFFIX)] for _, name in sorted(requests)]

    def _start_waiting_jobs(self):
        """Start a job for each waiting request, while fewer than MAX_JOBS run."""
        for request_id in self._waiting_requests():
            with self._lock:
                if len(self._threads) >= MAX_JOBS:
                    return
                if request_id in self._threads or request_id in self._abandoned:
                    continue
                thread = threading.Thread(
                    target=self._run_job,
                    args=(request_id,),
                    name=f"job-{request_id}",
                    daemon=True,
                )
                self._threads[request_id] = thread
            thread.start()

    def _run_job(self, request_id):
        """Run request `request_id` and answer it, unless the worker is stopping or the
        API gave up on it; runs on the job's own thread."""
        request_path = os.path.join(self.queue, request_id + REQUEST_SUFFIX)
        try:
            answer = self._answer(request_id, request_path)
            if answer is not None:
                _write_file(
                    os.path.join(self.queue, request_id + ANSWER_SUFFIX),
                    json.dumps(answer),
                )
                try:
                    os.remove(request_path)
                except FileNotFoundError:
                    pass
        except Exception:
            logger.exception("Could not answer job %s; it is not run again", request_id)
            with self._lock:
                self._abandoned.add(request_id)
        finally:
            with self._lock:
                self._threads.pop(request_id, None)
                self._processes.pop(request_id, None)

    def _answer(self, request_id, request_path):
        """Run the request and return its answer, or None when there is none to give:
        the API removed the request, or a stop interrupted its command."""
        try:
            workflow_group_id, command, timeout = _read_request(
                request_path, request_id
            )
        except FileNotFoundError:
            return None
        except BadRequest as e:
            logger.warning("Job %s is a bad request: %s", request_id, e)
            return _failed(1, str(e), "bad_request")
        folder = os.path.join(self.workspace, workflow_group_id)
        try:
            os.makedirs(folder, exist_ok=True)
        except OSError as e:
            return _failed(1, f"Could not create {folder}: {e}", "bad_request")
        logger.info("Job %s: %s for %s", request_id, command[0], workflow_group_id)
        started = time.monotonic()
        process = subprocess.Popen(
            [sys.executable, "-m", "canyonos_core.cli", *command],
            cwd=folder,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        with self._lock:
            self._processes[request_id] = process
        # A stop that came while it started has not seen it: stop it here.
        if self._stopping.is_set():
            process.terminate()
        try:
            stdout, stderr = process.communicate(timeout=timeout)
            timed_out = False
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, stderr = process.communicate()
            timed_out = True
        logger.info(
            "Job %s exited %s after %.1f s",
            request_id,
            process.returncode,
            time.monotonic() - started,
        )
        if self._stopping.is_set() and process.returncode < 0:
            return None
        if not os.path.exists(request_path):
            return None
        stderr_tail = stderr.decode("utf-8", "replace")[-STDERR_TAIL_CHARS:]
        if timed_out:
            return _failed(
                TIMEOUT_EXIT_CODE,
                f"{command[0]} did not finish within {timeout} seconds.",
                "timeout",
                stderr_tail,
            )
        exit_code = process.returncode
        if exit_code < 0:
            exit_code = 128 - exit_code
        shown = _shown_object(stdout)
        if shown is None:
            return _failed(
                exit_code or 1,
                f"{command[0]} exited {exit_code} without showing a result.",
                "no_output",
                stderr_tail,
            )
        return {"exit_code": exit_code, "stdout": shown, "stderr_tail": stderr_tail}

    def _stop_jobs(self):
        """Stop every running command, killing those still running after
        STOP_GRACE_SECONDS, and wait for their jobs to end."""
        with self._lock:
            threads = list(self._threads.values())
            processes = list(self._processes.values())
        for process in processes:
            process.terminate()
        deadline = time.monotonic() + STOP_GRACE_SECONDS
        for thread in threads:
            thread.join(max(0, deadline - time.monotonic()))
        with self._lock:
            # With any a job started after the stop, which stopped it itself.
            processes = list(self._processes.values())
        for process in processes:
            if process.poll() is None:
                process.kill()
        for thread in threads:
            thread.join()


def run(workspace, queue):
    """Run the jobs in the queue folder `queue` against the workspace `workspace` until
    SIGTERM or SIGINT; return the exit code, 0."""
    worker = JobWorker(workspace, queue)

    def _stop(sig, frame):
        logger.info("Received %s, stopping the jobs", signal.Signals(sig).name)
        worker.stop()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    worker.run()
    logger.info("Stopped.")
    return 0
