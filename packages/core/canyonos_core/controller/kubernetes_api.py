# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""A small client for the few Kubernetes API calls the Global Controller makes, as its
pod's service account: set a CanyonAgent's replica count, and read the project's pods
and their usage for machine metrics. Built on `requests` rather than the official client
library, which would add its dependencies to the core image for a handful of calls.

The service account token is read again at most once a minute: Kubernetes rotates the
projected token file, and a token kept from startup stops being valid.
CANYONOS_K8S_API points the client at another server instead, such as `kubectl proxy`
when the Global Controller runs outside the cluster during development.
"""

import json
import os
import re
import threading
import time
from datetime import datetime

import requests

SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount"
API_GROUP = "canyonos.canyoncode.ai"
API_VERSION = "v1alpha1"
# The standard label the operator puts on every pod it creates.
MANAGED_BY_LABEL = "app.kubernetes.io/managed-by"
MANAGED_BY = "canyonos-operator"
TOKEN_REFRESH_SECONDS = 60
REQUEST_TIMEOUT_SECONDS = 10


class KubernetesError(RuntimeError):
    """A Kubernetes API call failed, or the API server could not be found."""


def resource_name(agent_name):
    """The Kubernetes object name for an agent: lowercase, with anything but letters,
    digits and hyphens turned into hyphens (`Portfolio_Agent` becomes
    `portfolio-agent`). The CLI and the operator use the same rule."""
    name = re.sub(r"[^a-z0-9-]+", "-", agent_name.lower()).strip("-")
    if not name:
        raise ValueError(f"Agent name {agent_name!r} has no letters or digits to use")
    return name[:63].rstrip("-")


class KubernetesApi:
    """Calls one namespace's Kubernetes API objects."""

    def __init__(self, base_url, namespace, token_path=None, ca_file=None):
        self.base_url = base_url.rstrip("/")
        self.namespace = namespace
        self._token_path = token_path
        self._token = None
        self._token_read_at = None
        self._token_lock = threading.Lock()
        self._session = requests.Session()
        self._session.verify = ca_file or True

    @classmethod
    def from_environment(cls, environ=None, service_account_dir=SERVICE_ACCOUNT_DIR):
        """The API server this pod reaches, as its service account, in its namespace
        (CANYONOS_NAMESPACE, else the service account's own)."""
        env = os.environ if environ is None else environ
        namespace = env.get("CANYONOS_NAMESPACE") or _read(
            os.path.join(service_account_dir, "namespace")
        )
        if not namespace:
            raise KubernetesError(
                "No namespace: set CANYONOS_NAMESPACE or run in a pod with a service "
                "account."
            )
        override = env.get("CANYONOS_K8S_API")
        if override:
            return cls(override, namespace)
        host = env.get("KUBERNETES_SERVICE_HOST")
        if not host:
            raise KubernetesError(
                "Not inside a Kubernetes pod (KUBERNETES_SERVICE_HOST is unset); set "
                "CANYONOS_K8S_API to reach the API server another way."
            )
        if ":" in host:  # IPv6
            host = f"[{host}]"
        port = env.get("KUBERNETES_SERVICE_PORT", "443")
        return cls(
            f"https://{host}:{port}",
            namespace,
            token_path=os.path.join(service_account_dir, "token"),
            ca_file=os.path.join(service_account_dir, "ca.crt"),
        )

    def _bearer_token(self):
        if self._token_path is None:
            return None
        with self._token_lock:
            stale = (
                self._token_read_at is None
                or time.monotonic() - self._token_read_at >= TOKEN_REFRESH_SECONDS
            )
            if stale:
                self._token = _read(self._token_path)
                self._token_read_at = time.monotonic()
            return self._token

    def request(self, method, path, body=None, content_type="application/json"):
        """Call the API; returns the decoded JSON body. Raises KubernetesError."""
        headers = {"Accept": "application/json"}
        token = self._bearer_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        data = None
        if body is not None:
            headers["Content-Type"] = content_type
            data = json.dumps(body)
        try:
            response = self._session.request(
                method,
                f"{self.base_url}{path}",
                data=data,
                headers=headers,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        except requests.RequestException as e:
            raise KubernetesError(f"Kubernetes API {method} {path} failed: {e}") from e
        if response.status_code >= 400:
            raise KubernetesError(
                f"Kubernetes API {method} {path} failed with {response.status_code}: "
                f"{response.text[:300]}"
            )
        return response.json() if response.content else {}

    def scale_canyon_agent(self, agent_name, replicas):
        """Set a CanyonAgent's replica count through its /scale subresource, the change
        `kubectl scale canyonagent` makes; the operator does the rest."""
        return self.request(
            "PATCH",
            f"/apis/{API_GROUP}/{API_VERSION}/namespaces/{self.namespace}"
            f"/canyonagents/{resource_name(agent_name)}/scale",
            {"spec": {"replicas": int(replicas)}},
            content_type="application/merge-patch+json",
        )

    def project_pods(self):
        """The pods the operator runs for this namespace's project."""
        return self.request(
            "GET",
            f"/api/v1/namespaces/{self.namespace}/pods"
            f"?labelSelector={MANAGED_BY_LABEL}%3D{MANAGED_BY}",
        ).get("items", [])

    def pod_metrics(self):
        """CPU and memory usage of every pod in the namespace, from the metrics API."""
        return self.request(
            "GET", f"/apis/metrics.k8s.io/v1beta1/namespaces/{self.namespace}/pods"
        ).get("items", [])


def parse_cpu(quantity):
    """CPU in cores from a Kubernetes quantity: `2`, `250m`, `1500u`, `123456789n`."""
    text = str(quantity).strip()
    for suffix, scale in (("n", 1e-9), ("u", 1e-6), ("m", 1e-3)):
        if text.endswith(suffix):
            return float(text[: -len(suffix)]) * scale
    return float(text)


_BYTE_SUFFIXES = {
    "Ki": 1024,
    "Mi": 1024**2,
    "Gi": 1024**3,
    "Ti": 1024**4,
    "Pi": 1024**5,
    "Ei": 1024**6,
    "k": 1e3,
    "M": 1e6,
    "G": 1e9,
    "T": 1e12,
    "P": 1e15,
    "E": 1e18,
}


def parse_bytes(quantity):
    """Bytes from a Kubernetes quantity: `512Mi`, `1Gi`, `1000k`, `123456`."""
    text = str(quantity).strip()
    for suffix in sorted(_BYTE_SUFFIXES, key=len, reverse=True):
        if text.endswith(suffix):
            return float(text[: -len(suffix)]) * _BYTE_SUFFIXES[suffix]
    return float(text)


def pod_machine_rows(pods, usages, project_id=None):
    """One "machine" metrics row per project pod, in the fields the Docker metrics
    collector writes: memory used always; CPU and memory as a share of the pod's limits
    when every container has one. On Kubernetes a replica's machine is its pod."""
    usage_by_pod = {item["metadata"]["name"]: item for item in usages}
    rows = []
    for pod in pods:
        name = pod["metadata"]["name"]
        usage = usage_by_pod.get(name)
        if usage is None:
            continue  # metrics-server has not sampled a new pod yet
        containers = usage.get("containers", [])
        cpu_used = sum(parse_cpu(c["usage"].get("cpu", 0)) for c in containers)
        memory_used = sum(parse_bytes(c["usage"].get("memory", 0)) for c in containers)
        metrics = {
            "memory_used_bytes": str(int(memory_used)),
            "observed_at": str(_epoch(usage.get("timestamp"))),
        }
        capacity = {}
        cpu_limit = _pod_limit(pod, "cpu", parse_cpu)
        if cpu_limit:
            utilization = 100.0 * cpu_used / cpu_limit
            metrics["cpu_percent"] = str(utilization)
            metrics["cpu_available_percent"] = str(max(100.0 - utilization, 0.0))
            capacity["cpu_count"] = cpu_limit
        memory_limit = _pod_limit(pod, "memory", parse_bytes)
        if memory_limit:
            metrics["memory_percent"] = str(100.0 * memory_used / memory_limit)
            metrics["memory_available_bytes"] = str(
                int(max(memory_limit - memory_used, 0))
            )
            capacity["memory_total_bytes"] = int(memory_limit)
        if capacity:
            metrics["machine_capacity"] = json.dumps(capacity)
        rows.append(
            {
                "kind": "machine",
                "host": name,
                "project_id": project_id,
                "metrics": metrics,
            }
        )
    return rows


def _pod_limit(pod, resource, parse):
    """The pod's total limit for `resource`, or None if any container has none."""
    total = 0.0
    for container in pod.get("spec", {}).get("containers", []):
        limit = container.get("resources", {}).get("limits", {}).get(resource)
        if limit is None:
            return None
        total += parse(limit)
    return total or None


def _epoch(timestamp):
    """Seconds since the epoch from the metrics API's RFC 3339 time (now if missing)."""
    if not timestamp:
        return time.time()
    return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp()


def _read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None
