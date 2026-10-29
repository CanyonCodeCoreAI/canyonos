# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Where callers reach the endpoint, as the Global Controller publishes it."""

import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from canyonos_core.endpoint import endpoint_record

MANIFEST = SimpleNamespace(
    endpoint=SimpleNamespace(agent="Workflow", method="main", api_port=8080),
    agents=[
        SimpleNamespace(
            name="Workflow",
            functions=[
                SimpleNamespace(name="main", arguments=[SimpleNamespace(name="query")])
            ],
        )
    ],
)


def _record(**environment):
    with patch.dict(os.environ, environment, clear=True):
        return endpoint_record(MANIFEST, 8080)


class EndpointRecordTests(unittest.TestCase):
    def test_the_published_port_on_this_machine(self):
        record = _record()

        self.assertEqual(
            (record["public_host"], record["api_port"], record["url"]),
            ("127.0.0.1", 8080, "http://127.0.0.1:8080/main"),
        )
        self.assertEqual(record["arguments"], ["query"])

    def test_the_public_ip_names_the_host(self):
        record = _record(CANYONOS_PUBLIC_IP="203.0.113.7")

        self.assertEqual(record["url"], "http://203.0.113.7:8080/main")

    def test_an_endpoint_url_replaces_host_port_and_url(self):
        # On Kubernetes the operator sets it: a Route, Ingress or in-cluster Service.
        for url, host, port in (
            ("https://hello.apps.example.com", "hello.apps.example.com", 443),
            ("http://endpoint.acme.svc:8080/", "endpoint.acme.svc", 8080),
        ):
            with self.subTest(url=url):
                record = _record(
                    CANYONOS_ENDPOINT_URL=url, CANYONOS_PUBLIC_IP="203.0.113.7"
                )

                self.assertEqual(
                    (record["public_host"], record["api_port"], record["url"]),
                    (host, port, f"{url.rstrip('/')}/main"),
                )
                self.assertEqual(record["arguments"], ["query"])


if __name__ == "__main__":
    unittest.main()
