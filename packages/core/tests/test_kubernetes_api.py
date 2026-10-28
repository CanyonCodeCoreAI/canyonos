# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import json
import os
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from canyonos_core.kubernetes import api as kubernetes_api
from canyonos_core.kubernetes.api import (
    KubernetesApi,
    KubernetesError,
    resource_name,
)


class _ApiServer:
    """A local HTTP server that records each request and answers with `status`."""

    def __init__(self, status=200, body=b"{}"):
        self.requests = []
        recorder = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self):
                length = int(self.headers.get("Content-Length") or 0)
                recorder.requests.append(
                    {
                        "method": self.command,
                        "path": self.path,
                        "headers": dict(self.headers),
                        "body": self.rfile.read(length).decode() if length else None,
                    }
                )
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_GET = do_PATCH = _answer

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()


def _service_account(token="token-1", namespace="acme"):
    directory = tempfile.TemporaryDirectory()
    for name, value in (("token", token), ("namespace", namespace), ("ca.crt", "")):
        with open(os.path.join(directory.name, name), "w") as f:
            f.write(value)
    return directory


class ResourceNameTests(unittest.TestCase):
    def test_agent_names_become_dns_labels(self):
        self.assertEqual(resource_name("HelloAgent"), "helloagent")
        self.assertEqual(resource_name("Portfolio_Agent"), "portfolio-agent")
        self.assertEqual(resource_name("x" * 70), "x" * 63)

    def test_a_name_without_letters_or_digits_is_refused(self):
        with self.assertRaises(ValueError):
            resource_name("__")


class FromEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.service_account = _service_account()
        self.addCleanup(self.service_account.cleanup)

    def _api(self, environment):
        return KubernetesApi.from_environment(environment, self.service_account.name)

    def test_inside_a_pod_it_calls_the_cluster_api_as_its_service_account(self):
        api = self._api({"KUBERNETES_SERVICE_HOST": "10.96.0.1"})
        self.assertEqual(api.base_url, "https://10.96.0.1:443")
        self.assertEqual(api.namespace, "acme")
        self.assertEqual(api._bearer_token(), "token-1")

    def test_an_ipv6_api_server_address_is_bracketed(self):
        api = self._api(
            {"KUBERNETES_SERVICE_HOST": "fd00::1", "KUBERNETES_SERVICE_PORT": "6443"}
        )
        self.assertEqual(api.base_url, "https://[fd00::1]:6443")

    def test_an_override_reaches_another_server_without_a_token(self):
        api = self._api(
            {"CANYONOS_K8S_API": "http://127.0.0.1:8001/", "CANYONOS_NAMESPACE": "dev"}
        )
        self.assertEqual(
            (api.base_url, api.namespace, api._bearer_token()),
            ("http://127.0.0.1:8001", "dev", None),
        )

    def test_outside_a_pod_without_an_override_it_says_how_to_fix_it(self):
        with self.assertRaisesRegex(KubernetesError, "CANYONOS_K8S_API"):
            self._api({})

    def test_no_namespace_anywhere_is_an_error(self):
        empty = tempfile.TemporaryDirectory()
        self.addCleanup(empty.cleanup)
        with self.assertRaisesRegex(KubernetesError, "namespace"):
            KubernetesApi.from_environment({"CANYONOS_K8S_API": "http://x"}, empty.name)


class RequestTests(unittest.TestCase):
    def _serve(self, **kwargs):
        server = _ApiServer(**kwargs)
        self.addCleanup(server.close)
        return server

    def test_scaling_patches_the_canyonagent_scale_subresource(self):
        server = self._serve()
        service_account = _service_account()
        self.addCleanup(service_account.cleanup)
        api = KubernetesApi(
            server.url,
            "acme",
            token_path=os.path.join(service_account.name, "token"),
        )

        api.scale_canyon_agent("HelloAgent", 3)

        (sent,) = server.requests
        self.assertEqual(sent["method"], "PATCH")
        self.assertEqual(
            sent["path"],
            "/apis/canyonos.canyoncode.ai/v1alpha1/namespaces/acme"
            "/canyonagents/helloagent/scale",
        )
        self.assertEqual(
            sent["headers"]["Content-Type"], "application/merge-patch+json"
        )
        self.assertEqual(sent["headers"]["Authorization"], "Bearer token-1")
        self.assertEqual(json.loads(sent["body"]), {"spec": {"replicas": 3}})

    def test_it_reads_only_the_projects_pods_and_their_metrics(self):
        server = self._serve(body=b'{"items": [{"metadata": {"name": "a-0"}}]}')
        api = KubernetesApi(server.url, "acme")

        self.assertEqual(api.project_pods(), [{"metadata": {"name": "a-0"}}])
        self.assertEqual(len(api.pod_metrics()), 1)

        self.assertEqual(
            [(r["method"], r["path"]) for r in server.requests],
            [
                (
                    "GET",
                    "/api/v1/namespaces/acme/pods"
                    "?labelSelector=app.kubernetes.io/managed-by%3Dcanyonos-operator",
                ),
                ("GET", "/apis/metrics.k8s.io/v1beta1/namespaces/acme/pods"),
            ],
        )

    def test_an_error_answer_raises_with_its_status(self):
        server = self._serve(status=403, body=b'{"reason":"Forbidden"}')
        api = KubernetesApi(server.url, "acme")
        with self.assertRaisesRegex(KubernetesError, "403"):
            api.scale_canyon_agent("HelloAgent", 1)

    def test_an_unreachable_server_raises_a_kubernetes_error(self):
        api = KubernetesApi("http://127.0.0.1:9", "acme")
        with self.assertRaises(KubernetesError):
            api.scale_canyon_agent("HelloAgent", 1)


def _pod(name, *limits):
    """A pod with one container per (cpu, memory) limit pair; None means no limit."""
    containers = []
    for cpu, memory in limits:
        resource_limits = {}
        if cpu is not None:
            resource_limits["cpu"] = cpu
        if memory is not None:
            resource_limits["memory"] = memory
        containers.append({"name": "c", "resources": {"limits": resource_limits}})
    return {"metadata": {"name": name}, "spec": {"containers": containers}}


def _usage(name, *containers, timestamp="2026-10-14T20:00:00Z"):
    return {
        "metadata": {"name": name},
        "timestamp": timestamp,
        "containers": [{"usage": {"cpu": c, "memory": m}} for c, m in containers],
    }


class QuantityTests(unittest.TestCase):
    def test_cpu(self):
        for quantity, cores in (("2", 2), ("250m", 0.25), ("1500u", 0.0015)):
            self.assertAlmostEqual(kubernetes_api.parse_cpu(quantity), cores)
        self.assertAlmostEqual(kubernetes_api.parse_cpu("123456789n"), 0.123456789)

    def test_memory(self):
        for quantity, size in (("512Mi", 512 * 2**20), ("1Gi", 2**30), ("1000k", 1e6)):
            self.assertEqual(kubernetes_api.parse_bytes(quantity), size)


class PodMachineRowsTests(unittest.TestCase):
    def test_usage_as_a_share_of_the_pods_limits(self):
        (row,) = kubernetes_api.pod_machine_rows(
            [_pod("helloagent-0", ("500m", "512Mi"))],
            [_usage("helloagent-0", ("250m", "128Mi"))],
            project_id="p1",
        )
        metrics = row["metrics"]
        self.assertEqual(
            (row["kind"], row["host"], row["project_id"]),
            ("machine", "helloagent-0", "p1"),
        )
        self.assertAlmostEqual(float(metrics["cpu_percent"]), 50.0)
        self.assertAlmostEqual(float(metrics["cpu_available_percent"]), 50.0)
        self.assertAlmostEqual(float(metrics["memory_percent"]), 25.0)
        self.assertEqual(int(metrics["memory_used_bytes"]), 128 * 2**20)
        self.assertEqual(int(metrics["memory_available_bytes"]), 384 * 2**20)
        self.assertEqual(
            json.loads(metrics["machine_capacity"]),
            {"cpu_count": 0.5, "memory_total_bytes": 512 * 2**20},
        )
        self.assertEqual(
            float(metrics["observed_at"]),
            datetime(2026, 10, 14, 20, tzinfo=timezone.utc).timestamp(),
        )

    def test_containers_add_up(self):
        (row,) = kubernetes_api.pod_machine_rows(
            [_pod("p", ("500m", "256Mi"), ("500m", "256Mi"))],
            [_usage("p", ("250m", "128Mi"), ("250m", "128Mi"))],
        )
        self.assertAlmostEqual(float(row["metrics"]["cpu_percent"]), 50.0)
        self.assertAlmostEqual(float(row["metrics"]["memory_percent"]), 50.0)

    def test_without_a_limit_on_every_container_only_used_memory_is_known(self):
        (row,) = kubernetes_api.pod_machine_rows(
            [_pod("p", ("500m", "256Mi"), (None, None))],
            [_usage("p", ("100m", "10Mi"), ("100m", "10Mi"))],
        )
        self.assertEqual(sorted(row["metrics"]), ["memory_used_bytes", "observed_at"])

    def test_a_pod_not_yet_sampled_is_skipped(self):
        self.assertEqual(
            kubernetes_api.pod_machine_rows([_pod("new-0", ("1", "1Gi"))], []), []
        )


class TokenRotationTests(unittest.TestCase):
    def test_the_token_file_is_read_again_once_a_minute(self):
        service_account = _service_account(token="old")
        self.addCleanup(service_account.cleanup)
        token_path = os.path.join(service_account.name, "token")
        api = KubernetesApi("http://x", "acme", token_path=token_path)
        now = [1000.0]

        with patch.object(kubernetes_api.time, "monotonic", lambda: now[0]):
            self.assertEqual(api._bearer_token(), "old")
            with open(token_path, "w") as f:
                f.write("rotated")
            now[0] += kubernetes_api.TOKEN_REFRESH_SECONDS - 1
            self.assertEqual(api._bearer_token(), "old")
            now[0] += 1
            self.assertEqual(api._bearer_token(), "rotated")


if __name__ == "__main__":
    unittest.main()
