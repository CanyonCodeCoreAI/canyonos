import unittest
import urllib.error
from unittest.mock import MagicMock, patch

from canyonos_core.controller.local_controller import LocalController


class StartLlmProxyTests(unittest.TestCase):
    def _start_with_health_check_failing(self, error):
        proxy_process = MagicMock()
        proxy_process.poll.return_value = None
        fake_time = MagicMock()
        fake_time.time.side_effect = [0, 0, 11]
        with (
            patch("socket.socket"),
            patch("subprocess.Popen", return_value=proxy_process),
            patch("urllib.request.urlopen", side_effect=error),
            patch("canyonos_core.controller.local_controller.time", fake_time),
            self.assertRaises(RuntimeError) as raised,
        ):
            LocalController._start_llm_proxy(MagicMock(), "localhost", 6379)
        proxy_process.kill.assert_called_once()
        return str(raised.exception)

    def test_the_timeout_names_the_last_health_check_failure(self):
        message = self._start_with_health_check_failing(
            urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))
        )
        self.assertIn("did not become healthy on 127.0.0.1:8081 within 10s", message)
        self.assertIn(
            "(last health check: <urlopen error [Errno 111] Connection refused>)",
            message,
        )

    def test_a_timed_out_health_check_is_named_too(self):
        message = self._start_with_health_check_failing(TimeoutError("timed out"))
        self.assertIn("(last health check: timed out)", message)


if __name__ == "__main__":
    unittest.main()
