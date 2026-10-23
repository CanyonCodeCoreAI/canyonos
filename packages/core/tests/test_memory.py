import json
import os
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import canyonos_core.controller.memory as memory_module
from canyonos_core.controller.memory import Store
from canyonos_core.stub_generator import AGENT_FLAT_MODULES, WORKFLOW_FLAT_MODULES
from fakes import _FakeRedis


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.redis = _FakeRedis()
        self.store = Store(client=self.redis)

    def test_get_returns_what_put_stored(self):
        self.store.put(("users", "u1"), "diet", {"value": "vegetarian"})

        self.assertEqual(
            self.store.get(("users", "u1"), "diet"), {"value": "vegetarian"}
        )

    def test_get_missing_key_returns_none(self):
        self.assertIsNone(self.store.get(("users", "u1"), "diet"))

    def test_put_overwrites_existing_key(self):
        self.store.put(("users", "u1"), "diet", {"value": "vegan"})
        self.store.put(("users", "u1"), "diet", {"value": "vegetarian"})

        self.assertEqual(
            self.store.get(("users", "u1"), "diet"), {"value": "vegetarian"}
        )

    def test_search_returns_every_item_in_namespace(self):
        self.store.put(("users", "u1"), "location", {"value": "Austin"})
        self.store.put(("users", "u1"), "diet", {"value": "vegetarian"})

        self.assertEqual(
            self.store.search(("users", "u1")),
            [
                {"key": "diet", "value": {"value": "vegetarian"}},
                {"key": "location", "value": {"value": "Austin"}},
            ],
        )

    def test_search_empty_namespace_returns_empty_list(self):
        self.assertEqual(self.store.search(("users", "u1")), [])

    def test_search_limit_caps_results(self):
        for key in ("a", "b", "c"):
            self.store.put(("users", "u1"), key, {"n": key})

        self.assertEqual(
            [item["key"] for item in self.store.search(("users", "u1"), limit=2)],
            ["a", "b"],
        )

    def test_delete_removes_key(self):
        self.store.put(("users", "u1"), "diet", {"value": "vegetarian"})

        self.store.delete(("users", "u1"), "diet")

        self.assertIsNone(self.store.get(("users", "u1"), "diet"))

    def test_delete_missing_key_is_a_no_op(self):
        self.store.delete(("users", "u1"), "diet")

    def test_namespaces_are_isolated(self):
        self.store.put(("users", "u1"), "diet", {"value": "vegetarian"})

        self.assertIsNone(self.store.get(("users", "u2"), "diet"))
        self.assertEqual(self.store.search(("users", "u2")), [])

    def test_namespace_is_one_redis_hash_under_memory_prefix(self):
        self.store.put(("users", "u1"), "diet", {"value": "vegetarian"})

        self.assertEqual(
            self.redis.hashes,
            {"memory:users:u1": {"diet": json.dumps({"value": "vegetarian"})}},
        )

    def test_rejects_invalid_namespace(self):
        for namespace in [(), ("users", ""), ("users", "a:b"), ("users", 1), "users"]:
            with self.subTest(namespace=namespace):
                with self.assertRaises(ValueError):
                    self.store.put(namespace, "diet", {"value": "vegetarian"})

    def test_rejects_non_string_or_empty_key(self):
        namespace = ("users", "u1")
        calls = {
            "put": lambda key: self.store.put(namespace, key, {"value": "x"}),
            "get": lambda key: self.store.get(namespace, key),
            "delete": lambda key: self.store.delete(namespace, key),
        }
        for name, call in calls.items():
            for key in ["", 1, b"diet", None]:
                with self.subTest(method=name, key=key):
                    with self.assertRaises(ValueError):
                        call(key)
        self.assertEqual(self.redis.hashes, {})

    def test_rejects_non_dict_value(self):
        with self.assertRaises(TypeError):
            self.store.put(("users", "u1"), "diet", "vegetarian")

    def test_default_client_uses_container_redis_address(self):
        env = {
            "CANYONOS_REDIS_HOST": "canyonos-redis-localhost",
            "CANYONOS_REDIS_PORT": "6380",
        }
        with (
            patch.dict(os.environ, env),
            patch.object(memory_module, "RedisClient") as redis_client,
        ):
            Store()

        redis_client.assert_called_once_with(host="canyonos-redis-localhost", port=6380)

    def test_ships_in_agent_and_workflow_images(self):
        self.assertIn("memory.py", AGENT_FLAT_MODULES)
        self.assertIn("memory.py", WORKFLOW_FLAT_MODULES)


if __name__ == "__main__":
    unittest.main()
