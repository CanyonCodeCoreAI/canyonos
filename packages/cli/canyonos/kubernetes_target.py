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

import yaml

from canyonos import ui
from canyonos.constants import DEFAULT_API_PORT, deployment_config_path, read_config
from canyonos.deployment import deployment_name
from canyonos.forwards import DASHBOARD, close_forward, open_forward
from canyonos.api import delete_workflow_group

# The project's endpoint inside its namespace (builders.EndpointName and its API port).
ENDPOINT_SERVICE = "svc/canyonos-endpoint"
ENDPOINT_PORT = 8080
# Where the chart installs the cluster's CanyonOS API (the dashboard's, with the web app
# beside it): its dashboard.namespace default.
DASHBOARD_NAMESPACE = "canyonos-dashboard"
API_FORWARD = "api"
API_SERVICE = "svc/canyonos-dashboard-api"
API_PORT = 3000
DASHBOARD_SERVICE = "svc/canyonos-dashboard-web"
DASHBOARD_PORT = 8080
# Where this machine's forwards look for a free port first: not the API's 3000, which
# the Docker dashboard's API takes here, and the dashboard's 8081, as Docker does.
LOCAL_API_PORT = 8000
LOCAL_DASHBOARD_PORT = 8081
# The cluster-admin ServiceAccount the CLI signs in as on a cluster it made.
ADMIN_ACCOUNT = "canyonos-admin"
# The fix when the cluster has no CanyonOS API there, or an older chart's.
UPGRADE_CHART = (
    "Upgrade the CanyonOS operator chart: this CLI needs the CanyonOS API it installs"
)
# kubectl's options that take the next argument as their value, left out of the step a
# failure names.
_VALUED_OPTIONS = {
    "--context", "-n", "--namespace", "-o", "--output", "-p", "--patch", "-f",
    "--filename", "--type", "-l", "--selector", "-c", "--container", "--kubeconfig",
}  # fmt: skip


class CanyonOSMissingError(RuntimeError):
    """The cluster has no CanyonOS API: CanyonOS isn't installed there, or an older chart
    without it is. `--json` names it `canyonos_missing`."""

    error_code = "canyonos_missing"


def describe_kubectl(args):
    """The kubectl step `args` take, as a failure names it: its words without the options,
    such as `rollout status deployment/metrics-server`."""
    words, value_next = [], False
    for arg in args:
        if value_next:
            value_next = False
        elif arg in _VALUED_OPTIONS:
            value_next = True
        elif not arg.startswith("-"):
            words.append(arg)
    return " ".join(words[:3]) or " ".join(args[:3])


# The cluster's dashboard is every workflow group's, and each one's routes take its key.
KUBERNETES_DASHBOARD_KEY = (
    "The cluster's dashboard is shared by every workflow group: each one's workflows "
    "open with that workflow group's own API key (`canyonos deploy --api-key` sets it)."
)


def kubectl(args, *, input_text=None, check=True, timeout=120):
    """Run kubectl with the current context and return the finished process. It gets
    `input_text` as its input, else none: never this process's own stdin, which may be
    a channel such as the MCP server's (on Windows a child given a pipe another thread
    is reading from can hang)."""
    try:
        result = subprocess.run(
            ["kubectl", *args],
            **(
                {"input": input_text}
                if input_text is not None
                else {"stdin": subprocess.DEVNULL}
            ),
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
            f"kubectl {describe_kubectl(args)} failed: "
            f"{(result.stderr or result.stdout).strip()}"
        )
    return result


def sign_in_as_admin_account(user):
    """Give the cluster of the current context an admin ServiceAccount, and have the
    kubeconfig user `user` sign in with its token, which canyonos can send and which
    lasts ten years, in place of the credentials the cluster was made with."""
    account = {
        "apiVersion": "v1",
        "kind": "ServiceAccount",
        "metadata": {"name": ADMIN_ACCOUNT, "namespace": "kube-system"},
    }
    binding = {
        "apiVersion": "rbac.authorization.k8s.io/v1",
        "kind": "ClusterRoleBinding",
        "metadata": {"name": ADMIN_ACCOUNT},
        "roleRef": {
            "apiGroup": "rbac.authorization.k8s.io",
            "kind": "ClusterRole",
            "name": "cluster-admin",
        },
        "subjects": [{"kind": "ServiceAccount", **account["metadata"]}],
    }
    kubectl(["apply", "-f", "-"], input_text=yaml.safe_dump_all([account, binding]))
    token = kubectl(
        ["-n", "kube-system", "create", "token", ADMIN_ACCOUNT, "--duration=87600h"]
    ).stdout.strip()
    kubectl(["config", "delete-user", user])
    kubectl(["config", "set-credentials", user, f"--token={token}"])


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


def _token_file_token(path):
    """The token in the kubeconfig's `tokenFile` at `path`, as kubectl reads it: read on
    each use, since a pod's ServiceAccount token there is rotated in place. kubectl
    prints the path absolute, resolved against the kubeconfig that names it."""
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError as error:
        raise RuntimeError(
            f"Could not read the token file the current kubectl context names, {path}: "
            f"{error.strerror}"
        ) from None


def kubernetes_state():
    """This folder's workflow group as `canyonos.api` takes it on Kubernetes: the local
    URL of a forward to the cluster's CanyonOS API (the chart's
    `canyonos-dashboard-api`), its workflow_group_id, and the user's kubectl login, a
    token, a token file (a pod's ServiceAccount) or a token from its login plugin, in
    the headers every request sends."""
    user = json.loads(
        kubectl(["config", "view", "--raw", "--minify", "-o", "json"]).stdout
    )["users"][0]["user"]
    token = user.get("token")
    if not token and user.get("tokenFile"):
        token = _token_file_token(user["tokenFile"])
    if not token and "exec" in user:
        token = _exec_plugin_token(user["exec"])
    if not token:
        raise RuntimeError(
            "The current kubectl context signs in without a token (with a client "
            "certificate, say), and canyonos can only send the cluster a token. Switch "
            "to a context that signs in with a token, a token file or a login plugin: "
            "kubectl config use-context <name>"
        )
    try:
        port = open_forward(
            API_FORWARD,
            DASHBOARD_NAMESPACE,
            API_SERVICE,
            API_PORT,
            LOCAL_API_PORT,
            context=current_context(),
        )
    except RuntimeError as error:
        # An older chart has no CanyonOS API there, unless its dashboard was installed.
        if "(NotFound)" not in str(error):
            raise
        raise CanyonOSMissingError(
            f"CanyonOS isn't installed on the cluster {current_context() or ''}: it has "
            f"no {API_SERVICE} in {DASHBOARD_NAMESPACE}. {UPGRADE_CHART} (canyonos "
            f"cluster up, on a local cluster). ({error})"
        ) from None
    return {
        "api_url": f"http://127.0.0.1:{port}",
        "workflow_group_id": read_config(deployment_config_path()).get(
            "workflow_group_id"
        ),
        "api_headers": {"Authorization": f"Bearer {token}"},
    }


def run_kubernetes_stop():
    """Run `canyonos stop` or `canyonos clean` on Kubernetes: delete this folder's
    workflow group through the cluster's CanyonOS API, then close the forwards into the
    cluster, also when that fails. Returns True once it is deleted."""
    name = deployment_name()
    ui.json_result["workflow_groups"] = [name]
    try:
        with ui.status(f"Stopping {name} (agents drain first)..."):
            delete_workflow_group(kubernetes_state())
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
    Only who may port-forward into its namespace can open it, and each workflow group's
    workflows there open with that workflow group's API key. Returns the exit code."""
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
            "it is not installed (the operator's chart installs it unless "
            "dashboard.enabled=false; see docs/guides/KUBERNETES.md) or you may not "
            "open it there "
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
    """The workflow group's `endpoint`, as its status gives it, as reached through a forward
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
    """Keep the workflow group's `endpoint` on this machine in the background until
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
    """The workflow group's `endpoint`, as its status gives it, reached here through a
    port-forward while in use."""
    forward = PortForward(
        read_config(deployment_config_path())["kubernetes"]["namespace"]
    )
    try:
        yield _local_endpoint(endpoint, forward.port)
    finally:
        forward.close()
