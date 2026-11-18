# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The CLI's way into the Kubernetes cluster `kubectl` points at: every command reaches
the cluster's CanyonOS API through a port-forward, signed in with the user's kubectl
login, and `serve` and `test` forward the dashboard and the endpoint to this machine.
"""

import contextlib
import json
import os
import socket
import subprocess
import threading
from urllib.parse import urlsplit

from canyonos import ui
from canyonos.constants import DEFAULT_API_PORT, deployment_config_path, read_config
from canyonos.deployment import deployment_name
from canyonos.forwards import DASHBOARD, close_forward, open_forward
from canyonos.gc import delete_deployment

# The project's endpoint inside its namespace (builders.EndpointName and its API port).
ENDPOINT_SERVICE = "svc/canyonos-endpoint"
ENDPOINT_PORT = 8080
# Where the chart installs the operator, and the CanyonOS API it serves beside it.
OPERATOR_NAMESPACE = "canyonos-system"
API_FORWARD = "api"
API_SERVICE = "svc/canyonos-api"
API_PORT = 8000
DASHBOARD_NAMESPACE = "canyonos-dashboard"
DASHBOARD_SERVICE = "svc/canyonos-dashboard-web"
DASHBOARD_PORT = 8080
# Where this machine's forwards look for a free port first, as Docker does.
LOCAL_DASHBOARD_PORT = 8081
# The cluster's dashboard is every project's: its key is its chart's.
KUBERNETES_DASHBOARD_KEY = (
    "The cluster's dashboard is shared by every project: it checks the key its chart "
    "sets (dashboard.apiKeyHash), not this machine's."
)


def kubectl(args, *, input_text=None, check=True, timeout=120):
    """Run kubectl with the current context and return the finished process."""
    try:
        result = subprocess.run(
            ["kubectl", *args],
            input=input_text,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except FileNotFoundError:
        raise RuntimeError(
            "kubectl is not installed or not on PATH: https://kubernetes.io/docs/tasks/tools/"
        ) from None
    if check and result.returncode:
        raise RuntimeError(
            f"kubectl {' '.join(args[:3])} failed: {(result.stderr or result.stdout).strip()}"
        )
    return result


def current_context():
    """The kubectl context commands use, or None when there is none."""
    found = kubectl(["config", "current-context"], check=False)
    if found.returncode:
        return None
    return found.stdout.strip() or None


def _exec_plugin_token(plugin):
    """Run the kubeconfig's login plugin `plugin` as kubectl does and return the token
    it prints, or None when it gives a client certificate instead."""
    info = {
        "apiVersion": plugin["apiVersion"],
        "kind": "ExecCredential",
        "spec": {"interactive": False},
    }
    result = subprocess.run(
        [plugin["command"], *(plugin["args"] or [])],
        env={
            **os.environ,
            **{var["name"]: var["value"] for var in plugin["env"] or []},
            "KUBERNETES_EXEC_INFO": json.dumps(info),
        },
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        text=True,
    )
    if result.returncode:
        raise RuntimeError(
            f"kubectl's login plugin {plugin['command']} failed with exit code "
            f"{result.returncode}"
        )
    return json.loads(result.stdout)["status"].get("token")


def kubernetes_state():
    """This folder's deployment as gc.py takes it on Kubernetes: the local port of a
    forward to the cluster's CanyonOS API, its deployment_id, and the user's kubectl
    login, a token or one from its login plugin, in the headers every request sends."""
    user = json.loads(
        kubectl(["config", "view", "--raw", "--minify", "-o", "json"]).stdout
    )["users"][0]["user"]
    token = user.get("token")
    if not token and "exec" in user:
        token = _exec_plugin_token(user["exec"])
    if not token:
        raise RuntimeError(
            "The current kubectl context signs in with a client certificate, and "
            "canyonos can only send the cluster a token. Switch to a context that "
            "signs in with a token or a login plugin: kubectl config use-context <name>"
        )
    port = open_forward(
        API_FORWARD,
        OPERATOR_NAMESPACE,
        API_SERVICE,
        API_PORT,
        API_PORT,
        context=current_context(),
    )
    return {
        "port": port,
        "deployment_id": read_config(deployment_config_path()).get("deployment_id"),
        "headers": {"Authorization": f"Bearer {token}"},
    }


def run_kubernetes_stop():
    """Run `canyonos stop` or `canyonos clean` on Kubernetes: delete this folder's
    deployment through the cluster's CanyonOS API, then close the forwards into the
    cluster, also when that fails. Returns True once it is deleted."""
    name = deployment_name()
    ui.json_result["deployments"] = [name]
    try:
        with ui.status(f"Stopping {name} (agents drain first)..."):
            delete_deployment(kubernetes_state())
        ui.ok(f"Stopped {name}")
    finally:
        # Also when the cluster can't be reached: the forwards would retry until then.
        close_forward(API_FORWARD)
        namespace = read_config(deployment_config_path())["kubernetes"]["namespace"]
        close_forward(f"endpoint-{namespace}")
        close_forward(DASHBOARD)
    return True


def run_kubernetes_serve(port=None):
    """Run `canyonos serve` on Kubernetes: keep the cluster's dashboard on
    127.0.0.1 here through a port-forward in the background, on `port`, else the
    project's `dashboard_port`, else 8081 or the next free one, until `canyonos stop`.
    Only who may port-forward into its namespace can open it, and its API key is its
    chart's (`dashboard.apiKeyHash`), never this machine's. Returns the exit code."""
    ui.hint(KUBERNETES_DASHBOARD_KEY)
    port = _open_dashboard(port)
    ui.ok(f"Dashboard: http://127.0.0.1:{port} (until canyonos stop)")
    return 0


def _open_dashboard(port=None):
    """Forward the cluster's dashboard as `canyonos serve` does; returns the local port."""
    found = kubectl(["get", DASHBOARD_SERVICE, "-n", DASHBOARD_NAMESPACE], check=False)
    if found.returncode:
        raise RuntimeError(
            f"No CanyonOS dashboard you can reach in namespace {DASHBOARD_NAMESPACE}: "
            "it is not installed (the operator's chart, --set dashboard.enabled=true; "
            "see docs/guides/KUBERNETES.md) or you may not open it there "
            f"({found.stderr.strip()})"
        )
    if port is None:
        port = read_config(deployment_config_path()).get("dashboard_port")
    return open_forward(
        DASHBOARD,
        DASHBOARD_NAMESPACE,
        DASHBOARD_SERVICE,
        DASHBOARD_PORT,
        port or LOCAL_DASHBOARD_PORT,
        context=current_context(),
        fixed=bool(port),
        shared=True,
    )


def _free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class PortForward:
    """A port-forward to a Service (the project's endpoint unless told otherwise) on
    one local port, started again when kubectl ends it (it does when its connection
    to the pod drops, as on a busy laptop, or the pod is replaced), so a long request
    can be polled to the end; until close(). `context` pins the kubectl context."""

    def __init__(
        self,
        namespace,
        port=None,
        service=ENDPOINT_SERVICE,
        remote_port=ENDPOINT_PORT,
        context=None,
    ):
        self.namespace, self.port = namespace, port or _free_port()
        self.service, self.remote_port, self.context = service, remote_port, context
        self._closed = threading.Event()
        # Every kubectl started and not seen to end, under the lock: close() ends them
        # all, also one a restart is still starting, so none outlives the forward.
        self._lock, self._started = threading.Lock(), []
        self._process = self._start()
        threading.Thread(target=self._keep_up, daemon=True).start()

    def _start(self):
        context = ["--context", self.context] if self.context else []
        with self._lock:
            if self._closed.is_set():
                raise RuntimeError("the forward is closed")
            process = subprocess.Popen(
                ["kubectl", *context, "port-forward", "-n", self.namespace,
                 self.service, f"{self.port}:{self.remote_port}"],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                # Started from a forward's detached process on Windows, kubectl would
                # otherwise open a console window of its own.
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )  # fmt: skip
            self._started = [p for p in self._started if p.poll() is None]
            self._started.append(process)
        line = process.stdout.readline()
        # Not just the address: "Unable to listen on port N" names it too.
        if not line.startswith(f"Forwarding from 127.0.0.1:{self.port} "):
            process.terminate()
            raise RuntimeError(
                f"Could not reach {self.service} in {self.namespace}: "
                f"{line.strip() or 'kubectl port-forward stopped'}"
            )
        # kubectl writes a line per connection: read them, or a long poll fills the pipe.
        threading.Thread(target=process.stdout.read, daemon=True).start()
        return process

    def _keep_up(self):
        while not self._closed.wait(1):
            if self._process.poll() is not None and not self._closed.is_set():
                with contextlib.suppress(RuntimeError, OSError):
                    self._process = self._start()

    @property
    def pid(self):
        """The pid of the kubectl forwarding now."""
        return self._process.pid

    def close(self):
        with self._lock:
            self._closed.set()
            for process in self._started:
                process.terminate()
        # So the port is free once close() returns.
        for process in self._started:
            with contextlib.suppress(subprocess.TimeoutExpired):
                process.wait(timeout=5)


def _local_endpoint(endpoint, port):
    """The deployment's `endpoint`, as its status gives it, as reached through a forward
    on 127.0.0.1:`port`: its `public_host`, `api_port` and route URLs are local."""
    return {
        "public_host": "127.0.0.1",
        "api_port": port,
        "routes": [
            {**route, "url": f"http://127.0.0.1:{port}" + urlsplit(route["url"]).path}
            for route in endpoint["routes"]
        ],
    }


def keep_endpoint_forwarded(endpoint):
    """Keep the deployment's `endpoint` on this machine in the background until
    `canyonos stop`, on its `endpoint.api_port` or 8080 or the next free port, as Docker
    publishes it; return it as reached here, or as given when it can't be forwarded."""
    config = read_config(deployment_config_path())
    namespace = config["kubernetes"]["namespace"]
    api_port = (config.get("endpoint") or {}).get("api_port")
    try:
        port = open_forward(
            # One per namespace, like the endpoint.
            f"endpoint-{namespace}",
            namespace,
            ENDPOINT_SERVICE,
            ENDPOINT_PORT,
            api_port or DEFAULT_API_PORT,
            context=current_context(),
            fixed=bool(api_port),
            # Not the dashboard's port: a request would reach the dashboard there.
            dashboard_port=config.get("dashboard_port"),
        )
    except RuntimeError as error:
        ui.warn(f"The endpoint is not forwarded to this machine: {error}")
        return endpoint
    return _local_endpoint(endpoint, port)


@contextlib.contextmanager
def forwarded_endpoint(endpoint):
    """The deployment's `endpoint`, as its status gives it, reached here through a
    port-forward while in use."""
    forward = PortForward(
        read_config(deployment_config_path())["kubernetes"]["namespace"]
    )
    try:
        yield _local_endpoint(endpoint, forward.port)
    finally:
        forward.close()
