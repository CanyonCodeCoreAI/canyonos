"""The scaling policy reads `scaling:config` and the per-agent samples the GC records each poll."""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller import scaling
from canyonos_core.controller.global_controller import GlobalController
from canyonos_core.reconciler import state
from canyonos_core.scaling import contract
from fakes import _FakeRedis

POLICY = {
    "min_replicas": 1,
    "max_replicas": 3,
    "metric": "requests_per_minute_per_replica",
    "scale_up_above": 10,
    "scale_down_below": 1,
}
INSTANCE = {
    "provider": "local",
    "agent_name": "Alpha",
    "replica_index": 0,
    "host": "localhost",
}


def _controller(policies):
    controller = GlobalController.__new__(GlobalController)
    controller.redis = _FakeRedis()
    controller.agent_specs = {"Alpha": {"name": "Alpha"}}
    controller.redis.set("scaling:config", json.dumps({"scaling": policies}))
    return controller


def _fill_window(controller, replicas, requests_per_minute_per_replica, count=None):
    for _ in range(count or contract.WINDOW_LENGTH):
        contract.push(
            controller.redis,
            contract.agent_key("Alpha"),
            {
                "replicas_expected": replicas,
                "replicas_running": replicas,
                "requests_per_minute_per_replica": requests_per_minute_per_replica,
            },
        )


def _push_history(controller, replicas, values):
    """Record one sample per value, oldest first, so the last value is the newest sample."""
    for value in values:
        _fill_window(controller, replicas, value, count=1)


def _poll(controller, polls):
    """Run the GC's real record-then-scale loop with no running replicas and return each desired count."""
    counts = []
    for _ in range(polls):
        controller._record_agent_samples([])
        controller._apply_scaling()
        counts.append(state.get_desired(controller.redis, "Alpha"))
    return counts


class _ScalingTestCase(unittest.TestCase):
    def setUp(self):
        scaling._warned.clear()


class ApplyScalingTests(_ScalingTestCase):
    def test_a_sustained_breach_adds_one_replica(self):
        controller = _controller({"Alpha": POLICY})
        state.set_desired(controller.redis, "Alpha", 1)
        _fill_window(controller, 1, 20)

        controller._apply_scaling()

        self.assertEqual(state.get_desired(controller.redis, "Alpha"), 2)

    def test_sustained_idle_removes_one_replica(self):
        controller = _controller({"Alpha": POLICY})
        state.set_desired(controller.redis, "Alpha", 3)
        _fill_window(controller, 3, 0)

        controller._apply_scaling()

        self.assertEqual(state.get_desired(controller.redis, "Alpha"), 2)

    def test_a_partial_window_waits(self):
        controller = _controller({"Alpha": POLICY})
        state.set_desired(controller.redis, "Alpha", 1)
        _fill_window(controller, 1, 20, count=contract.WINDOW_LENGTH - 1)

        controller._apply_scaling()

        self.assertEqual(state.get_desired(controller.redis, "Alpha"), 1)

    def test_a_count_outside_the_bounds_is_pulled_back_at_once(self):
        controller = _controller({"Alpha": POLICY})
        state.set_desired(controller.redis, "Alpha", 6)
        _fill_window(controller, 6, 5, count=1)

        controller._apply_scaling()

        self.assertEqual(state.get_desired(controller.redis, "Alpha"), 3)

    def test_a_single_spike_in_an_idle_window_waits(self):
        controller = _controller({"Alpha": POLICY})
        state.set_desired(controller.redis, "Alpha", 1)
        _push_history(controller, 1, [0, 0, 0, 0, 200, 0, 0, 0, 0, 0])

        controller._apply_scaling()

        self.assertEqual(state.get_desired(controller.redis, "Alpha"), 1)

    def test_load_that_stopped_in_the_newest_samples_does_not_scale_up(self):
        controller = _controller({"Alpha": POLICY})
        state.set_desired(controller.redis, "Alpha", 1)
        _push_history(controller, 1, [40] * 8 + [0, 0])

        controller._apply_scaling()

        self.assertEqual(state.get_desired(controller.redis, "Alpha"), 1)

    def test_a_single_busy_sample_in_an_idle_window_does_not_scale_down(self):
        controller = _controller({"Alpha": POLICY})
        state.set_desired(controller.redis, "Alpha", 3)
        _push_history(controller, 3, [0] * 9 + [5])

        controller._apply_scaling()

        self.assertEqual(state.get_desired(controller.redis, "Alpha"), 3)

    def test_a_window_between_the_thresholds_holds(self):
        controller = _controller({"Alpha": POLICY})
        state.set_desired(controller.redis, "Alpha", 2)
        _push_history(controller, 2, [30, 2, 30, 2, 30, 2, 30, 2, 30, 2])

        controller._apply_scaling()

        self.assertEqual(state.get_desired(controller.redis, "Alpha"), 2)

    def test_a_sample_missing_the_metric_holds(self):
        controller = _controller({"Alpha": POLICY})
        state.set_desired(controller.redis, "Alpha", 1)
        _fill_window(controller, 1, 20, count=contract.WINDOW_LENGTH - 1)
        _fill_window(controller, 1, None, count=1)

        controller._apply_scaling()

        self.assertEqual(state.get_desired(controller.redis, "Alpha"), 1)

    def test_an_agent_without_a_policy_is_left_alone(self):
        controller = _controller({})
        state.set_desired(controller.redis, "Alpha", 1)
        _fill_window(controller, 1, 20)

        controller._apply_scaling()

        self.assertEqual(state.get_desired(controller.redis, "Alpha"), 1)


class InvalidPolicyTests(_ScalingTestCase):
    def _assert_skipped(self, policy):
        """Above every max in these policies and idle, so neither the clamp nor a step may fire."""
        controller = _controller({"Alpha": policy})
        state.set_desired(controller.redis, "Alpha", 5)
        _fill_window(controller, 5, 0)

        controller._apply_scaling()

        self.assertEqual(state.get_desired(controller.redis, "Alpha"), 5)

    def test_a_policy_with_min_above_max_is_skipped_across_polls(self):
        controller = _controller(
            {"Alpha": {**POLICY, "min_replicas": 4, "max_replicas": 2}}
        )
        state.set_desired(controller.redis, "Alpha", 3)

        self.assertEqual(_poll(controller, 4), [3, 3, 3, 3])

    def test_a_policy_with_min_zero_never_scales_to_zero(self):
        controller = _controller({"Alpha": {**POLICY, "min_replicas": 0}})
        state.set_desired(controller.redis, "Alpha", 1)
        _fill_window(controller, 1, 0)

        controller._apply_scaling()

        self.assertEqual(state.get_desired(controller.redis, "Alpha"), 1)

    def test_each_rule_violation_is_skipped(self):
        cases = {
            "float min_replicas": {**POLICY, "min_replicas": 1.5},
            "string max_replicas": {**POLICY, "max_replicas": "3"},
            "bool min_replicas": {**POLICY, "min_replicas": True},
            "missing max_replicas": {
                k: v for k, v in POLICY.items() if k != "max_replicas"
            },
            "unknown metric": {**POLICY, "metric": "cpu"},
            "down equal to up": {**POLICY, "scale_down_below": 10},
            "down above up": {**POLICY, "scale_down_below": 20},
            "negative threshold": {
                **POLICY,
                "scale_down_below": -5,
                "scale_up_above": -1,
            },
            "bool threshold": {**POLICY, "scale_down_below": False},
            "string threshold": {**POLICY, "scale_up_above": "10"},
            "not a mapping": ["min_replicas", 1],
        }
        for name, policy in cases.items():
            with self.subTest(name):
                self._assert_skipped(policy)
                self.assertIsNotNone(scaling.policy_error(policy))

    def test_whole_float_replica_counts_are_valid_and_stay_integers(self):
        with self.subTest("1.0 and 3.0 step an int count"):
            controller = _controller(
                {"Alpha": {**POLICY, "min_replicas": 1.0, "max_replicas": 3.0}}
            )
            state.set_desired(controller.redis, "Alpha", 1)
            _fill_window(controller, 1, 20)

            controller._apply_scaling()

            desired = state.get_desired(controller.redis, "Alpha")
            self.assertEqual(desired, 2)
            self.assertIsInstance(desired, int)
        with self.subTest("clamp to 3.0 stays int"):
            controller = _controller({"Alpha": {**POLICY, "max_replicas": 3.0}})
            state.set_desired(controller.redis, "Alpha", 6)
            _fill_window(controller, 6, 5, count=1)

            controller._apply_scaling()

            desired = state.get_desired(controller.redis, "Alpha")
            self.assertEqual(desired, 3)
            self.assertIsInstance(desired, int)
        with self.subTest("2.5 stays invalid"):
            self.assertIsNotNone(scaling.policy_error({**POLICY, "max_replicas": 2.5}))

    def test_the_api_rules_accept_a_valid_policy(self):
        self.assertIsNone(scaling.policy_error(POLICY))
        self.assertIsNone(
            scaling.policy_error({**POLICY, "scale_up_above": 2.5, "min_replicas": 3})
        )

    def test_a_scaling_value_that_is_not_a_mapping_is_ignored(self):
        for document in ({"scaling": ["Alpha"]}, {"scaling": "Alpha"}, ["Alpha"]):
            with self.subTest(document=document):
                controller = _controller({})
                controller.redis.set("scaling:config", json.dumps(document))
                state.set_desired(controller.redis, "Alpha", 2)
                _fill_window(controller, 2, 0)

                controller._apply_scaling()

                self.assertEqual(state.get_desired(controller.redis, "Alpha"), 2)

    def test_a_config_that_is_not_json_is_ignored(self):
        controller = _controller({})
        controller.redis.set("scaling:config", "{not json")
        state.set_desired(controller.redis, "Alpha", 2)

        controller._apply_scaling()

        self.assertEqual(state.get_desired(controller.redis, "Alpha"), 2)

    def test_an_invalid_policy_is_warned_once_until_it_changes(self):
        controller = _controller(
            {"Alpha": {**POLICY, "min_replicas": 4, "max_replicas": 2}}
        )
        state.set_desired(controller.redis, "Alpha", 3)

        with self.assertLogs(scaling.logger, "WARNING") as logs:
            _poll(controller, 3)
            controller.redis.set(
                "scaling:config",
                json.dumps({"scaling": {"Alpha": {**POLICY, "metric": "cpu"}}}),
            )
            _poll(controller, 3)

        self.assertEqual(len(logs.records), 2)
        self.assertIn("min_replicas", logs.records[0].getMessage())
        self.assertIn("metric", logs.records[1].getMessage())

    def test_a_bad_scaling_value_is_warned_once(self):
        controller = _controller({})
        controller.redis.set("scaling:config", json.dumps({"scaling": ["Alpha"]}))
        state.set_desired(controller.redis, "Alpha", 2)

        with self.assertLogs(scaling.logger, "WARNING") as logs:
            _poll(controller, 3)

        self.assertEqual(len(logs.records), 1)


class RecordSamplesTests(_ScalingTestCase):
    def test_counters_become_per_minute_rates_and_means(self):
        controller = _controller({})
        first = {
            "requests_served": "10",
            "requests_completed": "10",
            "execution_ms_total": "1000",
        }
        second = {
            "requests_served": "40",
            "requests_completed": "20",
            "execution_ms_total": "3000",
        }
        controller._record_instance_sample(INSTANCE, first)
        key = contract.instance_key("local:Alpha:0")
        previous = json.loads(controller.redis.lists[key][0])
        previous["observed_at"] -= 60
        controller.redis.lists[key][0] = json.dumps(previous)

        sample = controller._record_instance_sample(INSTANCE, second)

        self.assertAlmostEqual(sample["requests_per_minute"], 30, places=0)
        self.assertEqual(sample["avg_execution_ms"], 200)

    def test_replicas_roll_up_into_one_agent_sample(self):
        controller = _controller({})
        state.set_desired(controller.redis, "Alpha", 2)
        replica = {
            "agent_name": "Alpha",
            "queue_length": 3,
            "requests_per_minute": 6.0,
            "failures_per_minute": 0.0,
            "avg_queue_time_ms": None,
            "avg_execution_ms": 100,
        }

        controller._record_agent_samples([replica, replica])

        [sample] = contract.read(controller.redis, contract.agent_key("Alpha"))
        self.assertEqual(sample["replicas_running"], 2)
        self.assertEqual(sample["replicas_expected"], 2)
        self.assertEqual(sample["queue_length_total"], 6)
        self.assertEqual(sample["requests_per_minute_per_replica"], 6.0)


if __name__ == "__main__":
    unittest.main()
