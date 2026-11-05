# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Port-forwards that outlive the command that opens them. On Kubernetes, `canyonos
deploy` keeps the project's endpoint and `canyonos serve` the cluster's dashboard on
127.0.0.1 here, as Docker publishes both on this machine, until `canyonos stop`.

Each one runs in a detached `canyonos` process (the CLI started again with
FORWARD_ARGUMENT), which starts `kubectl port-forward` again whenever it ends, as it
does when the pod behind the Service is replaced on a redeploy. Its record,
`~/.canyonos/forwards/<name>.json`, is how it is found and stopped: the process
touches the record while it runs, and ends once the record is gone.
"""

import contextlib
import json
import os
import signal
import socket
import subprocess
import sys
import time

from canyonos.os_support import spawn_detached
from canyonos.port_utils import find_free_port, is_port_free

FORWARD_ARGUMENT = "__port-forward"
DASHBOARD = "dashboard"
HEARTBEAT_SECONDS = 2
# A record its process has not touched for this long belongs to no process.
STALE_SECONDS = 10
READY_TIMEOUT_SECONDS = 30
CLOSE_TIMEOUT_SECONDS = 10
# How long a leftover kubectl may take to exit once ended.
KILL_TIMEOUT_SECONDS = 5


def forwards_dir():
    """The folder under `~/.canyonos` that holds every forward's record."""
    return os.path.join(os.path.expanduser("~/.canyonos"), "forwards")


def endpoint_forward(namespace, project):
    """The name of a project's endpoint forward."""
    return f"endpoint-{namespace}-{project}"


def _record_path(name):
    return os.path.join(forwards_dir(), f"{name}.json")


def _log_path(name):
    return os.path.join(forwards_dir(), f"{name}.log")


def _pid_path(name):
    return os.path.join(forwards_dir(), f"{name}.pid")


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _running(name):
    try:
        return time.time() - os.path.getmtime(_record_path(name)) < STALE_SECONDS
    except OSError:
        return False


def _answers(port):
    with contextlib.suppress(OSError):
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    return False


def forward_port(name):
    """The local port of the forward `name`, or None when it is not running."""
    record = _read(_record_path(name))
    return record["port"] if record and _running(name) else None


def running_forwards(prefix=""):
    """The names of the running forwards whose name starts with `prefix`."""
    with contextlib.suppress(OSError):
        names = [f[: -len(".json")] for f in os.listdir(forwards_dir())]
        return [n for n in names if n.startswith(prefix) and _running(n)]
    return []


def _forward_command(record_path):
    """How to start this same CLI again as a forward's process, as the usage sender
    does (usage/delivery.py): a released binary restarts itself, a Python install
    starts its interpreter on the installed CLI."""
    if "__compiled__" in globals():
        return [os.path.abspath(sys.argv[0]), FORWARD_ARGUMENT, record_path]
    return [sys.executable, "-c", "import cli; cli.main()", FORWARD_ARGUMENT,
            record_path]  # fmt: skip


def open_forward(
    name,
    namespace,
    service,
    remote_port,
    port,
    context=None,
    fixed=False,
    skip=frozenset(),
    shared=False,
):
    """Keep `service`'s `remote_port` in `namespace` on 127.0.0.1 in the background,
    on `port` or, unless `fixed` (a port the config sets), the next free one not in
    `skip`, and return the port. A forward of the same service and port already
    running is kept; a `shared` one (the dashboard every project here uses) is kept on
    its port whatever port is asked, as Docker keeps a running dashboard."""
    wanted = {
        "namespace": namespace,
        "service": service,
        "remote_port": remote_port,
        "context": context,
        "requested": port,
    }
    compared = [k for k in wanted if not (shared and k == "requested")]
    record = _read(_record_path(name))
    if record and _running(name) and all(record.get(k) == wanted[k] for k in compared):
        return record["port"]
    close_forward(name)
    # Free on every interface, not only 127.0.0.1: on macOS a port Docker publishes on
    # 0.0.0.0 still binds on 127.0.0.1, and the forward would shadow it there.
    if fixed and not is_port_free(port):
        raise RuntimeError(f"port {port} is taken; a port the config sets is not moved")
    record = {**wanted, "port": port if fixed else find_free_port(port, skip=skip)}
    os.makedirs(forwards_dir(), exist_ok=True)
    for path in (_log_path(name), _pid_path(name)):
        with contextlib.suppress(OSError):
            os.remove(path)
    with open(_record_path(name), "w", encoding="utf-8") as f:
        json.dump(record, f)
    spawn_detached(_forward_command(_record_path(name)), cwd=forwards_dir())
    # Ready once its own kubectl listens (its pid is written then), not once the port
    # answers: another deploy's forward may have taken the same port meanwhile.
    deadline = time.monotonic() + READY_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if os.path.exists(_pid_path(name)):
            return record["port"]
        time.sleep(0.5)
    error = _last_error(name)
    close_forward(name)
    raise RuntimeError(
        f"Could not keep {service} in {namespace} on 127.0.0.1:{record['port']}: "
        f"{error or 'kubectl port-forward did not start'}"
    )


def close_forward(name):
    """Stop the forward `name`, if any, and wait until its port is free. A kubectl
    its process left behind (one killed outright, such as from Task Manager) is
    ended too, so the port is free for the next deploy."""
    record = _read(_record_path(name))
    running = _running(name)
    with contextlib.suppress(OSError):
        os.remove(_record_path(name))
    if record:
        # Its process removes the pid file once its kubectl has ended. Not the port
        # going quiet: it does also while kubectl restarts, and kubectl comes back.
        deadline = time.monotonic() + (CLOSE_TIMEOUT_SECONDS if running else 0)
        while os.path.exists(_pid_path(name)) and time.monotonic() < deadline:
            time.sleep(0.2)
        if _answers(record["port"]):
            _end_kubectl(name, record["port"])
            deadline = time.monotonic() + KILL_TIMEOUT_SECONDS
            while _answers(record["port"]) and time.monotonic() < deadline:
                time.sleep(0.2)
    with contextlib.suppress(OSError):
        os.remove(_pid_path(name))


def close_forwards_to(context):
    """Stop every forward into the kubectl context `context`, as when its cluster is
    deleted: they would otherwise start kubectl again until this machine restarts."""
    for name in running_forwards():
        if (_read(_record_path(name)) or {}).get("context") == context:
            close_forward(name)


def _end_kubectl(name, port):
    with contextlib.suppress(OSError, ValueError):
        with open(_pid_path(name), encoding="utf-8") as f:
            pid = int(f.read().strip())
        # After a restart the pid may be another process's now.
        if _is_kubectl_forward(pid, port):
            os.kill(pid, signal.SIGTERM)


def _is_kubectl_forward(pid, port):
    """Whether process `pid` is kubectl (on Windows, which lists no arguments) or,
    elsewhere, kubectl port-forwarding `port`."""
    if os.name == "nt":
        listed = _run_quietly(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"])
        return listed.startswith('"kubectl.exe"')
    if os.path.isdir("/proc"):
        # Linux, where a slim image may have no `ps`.
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                listed = f.read().replace(b"\0", b" ").decode(errors="replace")
        except OSError:
            return False
    else:
        listed = _run_quietly(["ps", "-p", str(pid), "-o", "args="])
    return "kubectl" in listed and "port-forward" in listed and f" {port}:" in listed


def _run_quietly(command):
    """The output of `command`, or "" when it can't be run."""
    with contextlib.suppress(OSError, subprocess.SubprocessError):
        return subprocess.run(
            command, capture_output=True, text=True, timeout=10, check=False
        ).stdout
    return ""


def _last_error(name):
    with contextlib.suppress(OSError):
        with open(_log_path(name), encoding="utf-8") as f:
            return f.read().strip().splitlines()[-1]
    return None


def run_forward(record_path):
    """Be the forward recorded at `record_path`: keep kubectl's port-forward up, and
    the record touched, until the record is removed."""
    from canyonos.kubernetes_target import PortForward

    record = _read(record_path)
    if not record:
        return
    base = record_path[: -len(".json")]
    forward, written_pid = None, None
    try:
        while os.path.exists(record_path):
            if forward is None:
                try:
                    forward = PortForward(
                        record["namespace"],
                        port=record["port"],
                        service=record["service"],
                        remote_port=record["remote_port"],
                        context=record["context"],
                    )
                except (RuntimeError, OSError) as error:
                    with contextlib.suppress(OSError):
                        with open(f"{base}.log", "w", encoding="utf-8") as log:
                            log.write(f"{error}\n")
            # kubectl's own pid, for close_forward should this process be killed.
            pid = getattr(forward, "pid", None)
            if pid is not None and pid != written_pid:
                with contextlib.suppress(OSError):
                    with open(f"{base}.pid", "w", encoding="utf-8") as f:
                        f.write(str(pid))
                    written_pid = pid
            with contextlib.suppress(OSError):
                os.utime(record_path)
            time.sleep(HEARTBEAT_SECONDS)
    finally:
        if forward is not None:
            forward.close()
        # Last, as close_forward waits for it; unless a new forward's kubectl is in it.
        with contextlib.suppress(OSError, ValueError):
            with open(f"{base}.pid", encoding="utf-8") as f:
                mine = int(f.read().strip()) == written_pid
            if mine:
                os.remove(f"{base}.pid")
