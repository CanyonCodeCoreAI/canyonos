"""Every YAML file in the config folder is published to every node's Redis as `<name>:config`."""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller.global_controller import GlobalController
from fakes import _FakeRedis


def _controller(config_dir, node_redis):
    controller = GlobalController.__new__(GlobalController)
    controller.config_path = os.path.join(config_dir, "global_controller.yaml")
    controller.redis = _FakeRedis()
    controller.node_redis = node_redis
    return controller


def _write(config_dir, filename, text):
    with open(os.path.join(config_dir, filename), "w") as f:
        f.write(text)


class PublishConfigFilesTests(unittest.TestCase):
    def test_publishes_every_yaml_file_to_every_node(self):
        with tempfile.TemporaryDirectory() as config_dir:
            _write(config_dir, "llms.yaml", "routes:\n  - agent: IntentAgent\n")
            _write(config_dir, "global_controller.yaml", "poll_interval: 5\n")
            _write(config_dir, "intent_agent.yml", "agent:\n  name: IntentAgent\n")
            nodes = {"localhost": _FakeRedis(), "172.31.0.5": _FakeRedis()}

            controller = _controller(config_dir, nodes)
            controller._write_policies(*controller._read_config_folder())

        for node in nodes.values():
            self.assertEqual(
                json.loads(node.get("llms:config")),
                {"routes": [{"agent": "IntentAgent"}]},
            )
            self.assertEqual(
                json.loads(node.get("global_controller:config")), {"poll_interval": 5}
            )
            self.assertEqual(
                json.loads(node.get("intent_agent:config")),
                {"agent": {"name": "IntentAgent"}},
            )

    def test_files_that_are_not_yaml_are_left_out(self):
        with tempfile.TemporaryDirectory() as config_dir:
            _write(config_dir, "notes.txt", "not config\n")
            node = _FakeRedis()

            controller = _controller(config_dir, {"localhost": node})
            controller._write_policies(*controller._read_config_folder())

        self.assertIsNone(node.get("notes:config"))

    def test_a_date_is_published_as_a_string(self):
        with tempfile.TemporaryDirectory() as config_dir:
            _write(config_dir, "release.yaml", "released: 2026-01-01\n")
            node = _FakeRedis()

            controller = _controller(config_dir, {"localhost": node})
            controller._write_policies(*controller._read_config_folder())

        self.assertEqual(
            json.loads(node.get("release:config")), {"released": "2026-01-01"}
        )

    def test_a_removed_file_clears_its_key(self):
        with tempfile.TemporaryDirectory() as config_dir:
            _write(config_dir, "prompts.yaml", "prompts: {}\n")
            node = _FakeRedis()
            controller = _controller(config_dir, {"localhost": node})
            controller._write_policies(*controller._read_config_folder())
            os.remove(os.path.join(config_dir, "prompts.yaml"))

            controller._write_policies(*controller._read_config_folder())

        self.assertIsNone(node.get("prompts:yaml"))

    def test_prompts_yaml_is_published_without_touching_prompts_config(self):
        with tempfile.TemporaryDirectory() as config_dir:
            _write(config_dir, "prompts.yaml", "prompts: {}\n")
            node = _FakeRedis(strings={"prompts:config": "dashboard"})

            controller = _controller(config_dir, {"localhost": node})
            controller._write_policies(*controller._read_config_folder())

        self.assertEqual(json.loads(node.get("prompts:yaml")), {"prompts": {}})
        self.assertEqual(node.get("prompts:config"), "dashboard")

    def test_falls_back_to_its_own_redis_without_nodes(self):
        with tempfile.TemporaryDirectory() as config_dir:
            _write(config_dir, "notes.yaml", "database: StateDB\n")
            controller = _controller(config_dir, {})

            controller._write_policies(*controller._read_config_folder())

        self.assertEqual(
            json.loads(controller.redis.get("notes:config")),
            {"database": "StateDB"},
        )


class _WriteCountingRedis(_FakeRedis):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.writes = 0

    def set(self, key, value, **kwargs):
        self.writes += 1
        return super().set(key, value, **kwargs)


_PROMPTS_YAML = {
    "prompts": {
        "a": [
            {"version": "a-v1", "content": "one", "live": True},
            {"version": "a-v2", "content": "two"},
        ],
        "b": [
            {"version": "b-v1", "content": "one"},
            {"version": "b-v2", "content": "two"},
        ],
    }
}


def _seed(controller, config_dir, text):
    _write(config_dir, "prompts.yaml", text)
    controller._write_policies(*controller._read_config_folder())


class SeedPromptsTests(unittest.TestCase):
    def test_publishes_each_live_version_when_nothing_is_published(self):
        with tempfile.TemporaryDirectory() as config_dir:
            controller = _controller(config_dir, {})
            _seed(controller, config_dir, json.dumps(_PROMPTS_YAML))

        self.assertEqual(
            json.loads(controller.redis.get("prompts:config")),
            {
                "prompts": {
                    "a": {"version": "a-v1", "content": "one", "live": True},
                    "b": {"version": "b-v2", "content": "two"},
                }
            },
        )

    def test_keeps_prompts_the_dashboard_published(self):
        with tempfile.TemporaryDirectory() as config_dir:
            controller = _controller(config_dir, {})
            controller.redis = _FakeRedis(strings={"prompts:config": "dashboard"})
            _seed(controller, config_dir, json.dumps(_PROMPTS_YAML))

        self.assertEqual(controller.redis.get("prompts:config"), "dashboard")

    def test_a_prompt_that_is_not_a_list_of_versions_names_the_prompt(self):
        with tempfile.TemporaryDirectory() as config_dir:
            controller = _controller(config_dir, {})
            with self.assertRaisesRegex(
                ValueError, "prompt 'a' must be a list of versions"
            ):
                _seed(controller, config_dir, "prompts:\n  a: some text\n")

        self.assertIsNone(controller.redis.get("prompts:config"))

    def test_a_file_without_a_prompts_mapping_is_rejected(self):
        with tempfile.TemporaryDirectory() as config_dir:
            controller = _controller(config_dir, {})
            with self.assertRaisesRegex(ValueError, "must have a `prompts:` mapping"):
                _seed(controller, config_dir, "- a\n")


class SyncPromptsTests(unittest.TestCase):
    def test_copies_a_dashboard_edit_to_the_other_nodes(self):
        local = _FakeRedis(strings={"prompts:config": '{"prompts": {"a": {}}}'})
        remote = _FakeRedis(strings={"prompts:config": "{}"})
        controller = _controller("/unused", {"localhost": local, "172.31.0.5": remote})
        controller.redis = local

        controller._sync_prompts()

        self.assertEqual(remote.get("prompts:config"), '{"prompts": {"a": {}}}')

    def test_never_writes_the_snapshot_back_to_its_source(self):
        local = _WriteCountingRedis(
            strings={"prompts:config": '{"prompts": {"a": {}}}'}
        )
        remote = _FakeRedis(strings={"prompts:config": "{}"})
        controller = _controller("/unused", {"localhost": local, "172.31.0.5": remote})
        controller.redis = local

        controller._sync_prompts()

        self.assertEqual(local.writes, 0)
        self.assertEqual(remote.get("prompts:config"), '{"prompts": {"a": {}}}')

    def test_skips_a_missing_key(self):
        local = _FakeRedis()
        remote = _FakeRedis(strings={"prompts:config": "{}"})
        controller = _controller("/unused", {"localhost": local, "172.31.0.5": remote})
        controller.redis = local

        controller._sync_prompts()

        self.assertEqual(remote.get("prompts:config"), "{}")


if __name__ == "__main__":
    unittest.main()
