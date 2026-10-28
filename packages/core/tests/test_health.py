# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import os
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

from canyonos_core.controller.health import (
    PORT_ENV,
    _Handler,
    start_health_server,
    stop_health_server,
)


def _get(server, path):
    url = f"http://127.0.0.1:{server.server_address[1]}{path}"
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            return response.status, response.read().decode().strip()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode().strip()


class HealthServerTests(unittest.TestCase):
    def _serve(self, checks):
        server = start_health_server(checks, port=0)
        self.addCleanup(stop_health_server, server)
        return server

    def test_no_port_means_no_server(self):
        with patch.dict(os.environ):
            os.environ.pop(PORT_ENV, None)
            self.assertIsNone(start_health_server({}))
        with patch.dict(os.environ, {PORT_ENV: ""}):
            self.assertIsNone(start_health_server({}))

    def test_a_passing_check_answers_200_and_a_failing_one_503(self):
        server = self._serve(
            {"/readyz": lambda: (True, "ready"), "/livez": lambda: (False, "stuck")}
        )
        self.assertEqual(_get(server, "/readyz"), (200, "ready"))
        self.assertEqual(_get(server, "/livez"), (503, "stuck"))

    def test_a_check_that_raises_answers_503(self):
        def broken():
            raise RuntimeError("boom")

        server = self._serve({"/livez": broken})
        self.assertEqual(_get(server, "/livez"), (503, "check failed: boom"))

    def test_an_unknown_path_answers_404(self):
        server = self._serve({})
        self.assertEqual(_get(server, "/nope")[0], 404)

    def test_a_port_that_is_not_a_number_fails_naming_the_setting(self):
        with self.assertRaisesRegex(RuntimeError, "CANYONOS_HEALTH_PORT='http'"):
            start_health_server({}, port="http")

    def test_a_port_in_use_fails_naming_the_setting(self):
        port = self._serve({}).server_address[1]
        with self.assertRaisesRegex(RuntimeError, f"CANYONOS_HEALTH_PORT={port}"):
            start_health_server({}, port=port)

    def test_stopping_releases_the_port(self):
        server = start_health_server({}, port=0)
        port = server.server_address[1]
        stop_health_server(server)
        stop_health_server(start_health_server({}, port=port))
        stop_health_server(None)

    def test_a_prober_that_hung_up_gets_no_answer_and_no_error(self):
        class HungUp:
            def write(self, data):
                raise BrokenPipeError

        handler = _Handler.__new__(_Handler)
        handler.request_version = "HTTP/1.1"
        handler.requestline = "GET /readyz HTTP/1.1"
        handler.wfile = HungUp()
        handler._reply(200, "ready")


if __name__ == "__main__":
    unittest.main()
