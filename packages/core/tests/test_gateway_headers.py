"""Unit tests for automatic future-id injection into httpx requests."""

import contextvars
import os
import sys
import unittest
from unittest import mock

import pytest

httpx = pytest.importorskip("httpx")

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import canyonos_core.controller.canyonos_context as canyonos_context
from canyonos_core.controller import gateway_headers
from canyonos_core.llm_gateway.hooks import FUNCTION_HEADER, FUTURE_ID_HEADER


class HttpxHeaderInjectionTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        gateway_headers.install(
            canyonos_context.get_current_future_id,
            canyonos_context.get_current_function,
        )

    def run(self, result=None):
        return contextvars.Context().run(super().run, result)

    def test_header_injected_for_openai_gateway_path(self):
        canyonos_context.set_current_future_id("future-sync")
        canyonos_context.set_current_function("summarize")
        seen_headers = {}

        def handler(request):
            seen_headers.update(request.headers)
            return httpx.Response(200)

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            client.get("http://proxy.test/openai/v1/chat/completions")

        self.assertEqual(seen_headers[FUTURE_ID_HEADER], "future-sync")
        self.assertEqual(seen_headers["x-canyonos-function"], "summarize")

    async def test_header_injected_for_anthropic_gateway_path_async(self):
        canyonos_context.set_current_future_id("future-async")
        seen_headers = {}

        async def handler(request):
            seen_headers.update(request.headers)
            return httpx.Response(200)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await client.get("http://proxy.test/anthropic/v1/messages")

        self.assertEqual(seen_headers[FUTURE_ID_HEADER], "future-async")

    def test_function_header_rides_along_when_a_function_is_running(self):
        canyonos_context.set_current_future_id("future-fn")
        canyonos_context.set_current_function("parse")
        seen_headers = {}

        def handler(request):
            seen_headers.update(request.headers)
            return httpx.Response(200)

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            client.get("http://proxy.test/openai/v1/chat/completions")

        self.assertEqual(seen_headers[FUNCTION_HEADER], "parse")

    def test_header_not_injected_for_non_gateway_path(self):
        canyonos_context.set_current_future_id("future-direct")
        seen_headers = {}

        def handler(request):
            seen_headers.update(request.headers)
            return httpx.Response(200)

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            client.get("https://api.anthropic.com/v1/messages")

        self.assertNotIn(FUTURE_ID_HEADER, seen_headers)

    def test_header_not_injected_without_future_id(self):
        seen_headers = {}

        def handler(request):
            seen_headers.update(request.headers)
            return httpx.Response(200)

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            client.get("http://proxy.test/openai/v1/responses")

        self.assertNotIn(FUTURE_ID_HEADER, seen_headers)

    def test_second_install_does_not_double_patch(self):
        sync_send = httpx.Client.send
        async_send = httpx.AsyncClient.send

        gateway_headers.install(
            canyonos_context.get_current_future_id,
            canyonos_context.get_current_function,
        )

        self.assertIs(httpx.Client.send, sync_send)
        self.assertIs(httpx.AsyncClient.send, async_send)

    def test_httpx_patched_when_boto3_is_missing(self):
        patched_sync = httpx.Client.send
        patched_async = httpx.AsyncClient.send
        httpx.Client.send = patched_sync.__wrapped__
        httpx.AsyncClient.send = patched_async.__wrapped__
        try:
            with mock.patch.dict(sys.modules, {"boto3": None}):
                gateway_headers.install(
                    canyonos_context.get_current_future_id,
                    canyonos_context.get_current_function,
                )

            self.assertTrue(getattr(httpx.Client.send, gateway_headers._PATCH_MARKER))
            self.assertTrue(
                getattr(httpx.AsyncClient.send, gateway_headers._PATCH_MARKER)
            )
        finally:
            httpx.Client.send = patched_sync
            httpx.AsyncClient.send = patched_async


if __name__ == "__main__":
    unittest.main()
