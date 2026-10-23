# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

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

    def test_the_default_applies_when_nothing_is_declared(self):
        path = self._config({"agents": [{"name": "A"}]})
        self.assertEqual(local_redis_port(path), 6379)

    def test_the_top_level_redis_port_is_used(self):
        path = self._config({"agents": [], "redis": {"port": 6391}})
        self.assertEqual(local_redis_port(path), 6391)

    def test_an_unreadable_config_falls_back_to_the_default(self):
        self.assertEqual(local_redis_port("/nonexistent/global_controller.yaml"), 6379)

    def test_a_malformed_config_falls_back_to_the_default(self):
        for config in (
            {"redis": {"port": "abc"}},
            {"redis": {"port": "${REDIS_PORT}"}},
            {"redis": {"port": None}},
            {"redis": {"port": 70000}},
            {"redis": {"port": True}},
            {"agents": [], "redis": "not-a-mapping"},
            ["not", "a", "mapping"],
        ):
            with self.subTest(config=config):
                self.assertEqual(local_redis_port(self._config(config)), 6379)


if __name__ == "__main__":
    unittest.main()
