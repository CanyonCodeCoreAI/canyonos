"""The dashboard reaches Redis through the host gateway, so it needs the published port."""

import tempfile
import unittest
from pathlib import Path

import yaml

from canyonos.constants import local_redis_port


class LocalRedisPortTests(unittest.TestCase):
    def _config(self, config):
        path = Path(tempfile.mkdtemp()) / "global_controller.yaml"
        path.write_text(yaml.safe_dump(config), encoding="utf-8")
        return str(path)

    def test_a_localhost_agents_declared_port_is_used(self):
        path = self._config({"agents": [{"name": "A", "redis_port": 6390}]})
        self.assertEqual(local_redis_port(path), 6390)

    def test_the_default_applies_when_nothing_is_declared(self):
        path = self._config({"agents": [{"name": "A"}]})
        self.assertEqual(local_redis_port(path), 6379)

    def test_a_remote_agents_port_is_ignored(self):
        """That Redis runs on the remote node, not the one the dashboard talks to."""
        path = self._config(
            {"agents": [{"name": "A", "host": "10.0.0.5", "redis_port": 6390}]}
        )
        self.assertEqual(local_redis_port(path), 6379)

    def test_the_top_level_redis_section_is_the_fallback(self):
        path = self._config({"agents": [], "redis": {"port": 6391}})
        self.assertEqual(local_redis_port(path), 6391)

    def test_an_unreadable_config_falls_back_to_the_default(self):
        self.assertEqual(local_redis_port("/nonexistent/global_controller.yaml"), 6379)


if __name__ == "__main__":
    unittest.main()
