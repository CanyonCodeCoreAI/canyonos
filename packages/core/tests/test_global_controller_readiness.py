import logging
import os
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.controller.global_controller import GlobalController
from canyonos_core.controller.instance_manager import InstanceManager


class _FakeRedis:
    def __init__(self, statuses):
        self.statuses = statuses

    def get(self, key):
        return self.statuses.get(key)


class _FakeInstanceManager(InstanceManager):
    """The real provider dispatch, over a fixed list of instance records."""

    def __init__(self, controller, instances):
        super().__init__(controller)
        self.instances = instances

    def list_instances(self, agent_name=None):
        return list(self.instances)

    def _routing_endpoint_for(self, instance):
        return instance["endpoint"]


def _local_instance(name="ResearchAgent", host="localhost", port="8000", **extra):
    """A local replica record as InstanceManager writes it."""
    record = {
        "agent_name": name,
        "provider": "local",
        "replica_index": "0",
        "host": host,
        "host_port": port,
        "endpoint": f"{host}:{port}",
        "runtime_id": f"canyonos-{name.lower()}-0",
    }
    record.update(extra)
    return record


def _ec2_instance(name="WriterAgent", host="10.0.0.7", instance_id="i-0abc123def"):
    """An EC2 replica record as InstanceManager writes it.

    Deliberately shaped like the real thing: the runtime id carries the EC2
    instance id so the host can be terminated, and there is no `user` -- the EC2
    runtime reads the ssh user from the deploy config on every call.
    """
    return {
        "agent_name": name,
        "provider": "EC2",
        "instance_type": "t3.medium",
        "replica_index": "0",
        "host": host,
        "host_port": "50051",
        "endpoint": f"{host}:50051",
        "runtime_id": f"canyonos-{name.lower()}-0--{instance_id}",
    }


def _controller(statuses, instances=None, config=None, **result):
    """A GlobalController with only the readiness path wired up.

    `calls` records the teardown and `docker logs` calls in the order they were
    made, so a test can pin the log dump to before the containers are removed.
    """
    controller = GlobalController.__new__(GlobalController)
    controller.redis = _FakeRedis(statuses)
    controller.node_redis = {}
    controller.config = config if config is not None else {}
    controller.instance_manager = _FakeInstanceManager(
        controller, instances if instances is not None else [_local_instance()]
    )
    controller._last_status = {}

    calls = MagicMock()
    calls.run_cmd.return_value = SimpleNamespace(
        returncode=result.get("returncode", 0),
        stdout=result.get("stdout", ""),
        stderr=result.get("stderr", ""),
    )
    controller._run_cmd = calls.run_cmd
    controller.stop = calls.stop
    controller.calls = calls
    return controller


def _messages(logs):
    return [record.getMessage() for record in logs.records]


class GlobalControllerReadinessTests(unittest.TestCase):
    def test_healthy_controllers_complete_readiness(self):
        controller = _controller({"controller:localhost:8000:status": "healthy"})

        with self.assertLogs(
            "canyonos_core.controller.global_controller", level="INFO"
        ) as logs:
            controller._wait_for_healthy(timeout=0, interval=0)

        self.assertEqual(controller._last_status[("localhost", "8000")], "healthy")
        self.assertIn(
            "Controller ResearchAgent (localhost:8000) is ready.", logs.output[-1]
        )
        controller.calls.stop.assert_not_called()

    def test_a_failed_controller_aborts_without_waiting_out_the_timeout(self):
        # The status was only ever re-read on a timer, so a container that had
        # already died still cost the deploy its whole readiness timeout.
        controller = _controller({"controller:localhost:8000:status": "failed"})

        with (
            patch("canyonos_core.controller.global_controller.time.sleep") as sleep,
            self.assertLogs(
                "canyonos_core.controller.global_controller", level="INFO"
            ) as logs,
        ):
            with self.assertRaises(SystemExit) as caught:
                controller._wait_for_healthy(timeout=600, interval=2)

        self.assertEqual(caught.exception.code, 1)
        sleep.assert_not_called()
        self.assertEqual(
            logs.records[-1].getMessage(),
            "Controller readiness failed: ResearchAgent (localhost:8000)=failed",
        )

    def test_a_stopped_controller_also_ends_the_wait_immediately(self):
        # Nothing republishes over "stopped" either, so waiting on it can only
        # ever time out.
        controller = _controller({"controller:localhost:8000:status": "stopped"})

        with (
            patch("canyonos_core.controller.global_controller.time.sleep") as sleep,
            self.assertLogs("canyonos_core.controller.global_controller") as logs,
        ):
            with self.assertRaises(SystemExit):
                controller._wait_for_healthy(timeout=600, interval=2)

        sleep.assert_not_called()
        self.assertEqual(
            logs.records[-1].getMessage(),
            "Controller readiness failed: ResearchAgent (localhost:8000)=stopped",
        )

    def test_a_status_nobody_wrote_is_reported_as_unknown_and_is_fatal(self):
        controller = _controller({})

        with self.assertLogs(
            "canyonos_core.controller.global_controller", level="INFO"
        ) as logs:
            with self.assertRaises(SystemExit):
                controller._wait_for_healthy(timeout=0, interval=0)

        self.assertEqual(
            logs.records[-1].getMessage(),
            "Controller readiness failed: ResearchAgent (localhost:8000)=unknown",
        )

    def test_the_summary_names_every_controller_that_did_not_come_up(self):
        controller = _controller(
            {
                "controller:localhost:8000:status": "healthy",
                "controller:127.0.0.1:8001:status": "failed",
            },
            instances=[
                _local_instance(),
                _local_instance(name="WriterAgent", host="127.0.0.1", port="8001"),
                _local_instance(name="EditorAgent", host="127.0.0.1", port="8002"),
            ],
        )

        with self.assertLogs(
            "canyonos_core.controller.global_controller", level="INFO"
        ) as logs:
            with self.assertRaises(SystemExit):
                controller._wait_for_healthy(timeout=0, interval=0)

        self.assertEqual(
            logs.records[-1].getMessage(),
            "Controller readiness failed: WriterAgent (127.0.0.1:8001)=failed, "
            "EditorAgent (127.0.0.1:8002)=unknown",
        )
        self.assertEqual(logs.records[-1].levelno, logging.CRITICAL)

    def test_a_failed_container_s_own_log_is_dumped_between_sentinels(self):
        # The cause only exists inside the container. The sentinels are what let
        # the deploy CLI print the quoted ERROR lines and traceback instead of
        # reading them as its own failure and cutting the transcript short.
        controller = _controller(
            {"controller:localhost:8000:status": "failed"},
            stdout="ERROR:local_controller:Failed to load agent RagAgent\n",
            stderr="ModuleNotFoundError: No module named 'llama_index'\n",
        )

        with self.assertLogs(
            "canyonos_core.controller.global_controller", level="INFO"
        ) as logs:
            with self.assertRaises(SystemExit):
                controller._wait_for_healthy(timeout=0, interval=0)

        controller.calls.run_cmd.assert_called_once_with(
            ["docker", "logs", "--tail", "40", "canyonos-researchagent-0"],
            "localhost",
            None,
        )
        messages = _messages(logs)
        begin = messages.index(
            "--- begin container log: ResearchAgent (localhost:8000) status=failed ---"
        )
        end = messages.index("--- end container log: ResearchAgent ---")
        quoted = messages[begin + 1 : end]
        self.assertEqual(
            quoted,
            [
                "  ERROR:local_controller:Failed to load agent RagAgent",
                "  ModuleNotFoundError: No module named 'llama_index'",
            ],
        )
        self.assertEqual(logs.records[-1].levelno, logging.CRITICAL)

    def test_an_ec2_container_is_read_by_its_docker_name_and_the_configured_user(self):
        # The runtime id is `<container name>--<ec2 instance id>`; only the part
        # before the separator was ever passed to `docker run --name`. And the
        # record has no user of its own, so the deploy config supplies it.
        controller = _controller(
            {},
            instances=[_ec2_instance()],
            config={"ec2": {"ssh_user": "ubuntu", "region": "us-west-2"}},
        )

        with self.assertRaises(SystemExit):
            with self.assertLogs("canyonos_core.controller.global_controller"):
                controller._wait_for_healthy(timeout=0, interval=0)

        controller.calls.run_cmd.assert_called_once_with(
            ["docker", "logs", "--tail", "40", "canyonos-writeragent-0"],
            "10.0.0.7",
            "ubuntu",
        )

    def test_a_records_own_user_wins_over_the_ec2_config(self):
        controller = _controller(
            {},
            instances=[_local_instance(host="10.0.0.9", user="deployer")],
            config={"ec2": {"ssh_user": "ubuntu"}},
        )

        with self.assertRaises(SystemExit):
            with self.assertLogs("canyonos_core.controller.global_controller"):
                controller._wait_for_healthy(timeout=0, interval=0)

        self.assertEqual(controller.calls.run_cmd.call_args[0][2], "deployer")

    def test_the_log_is_read_before_anything_is_torn_down(self):
        # cleanup() is registered atexit and runs `docker rm -f`, so a dump that
        # waited until teardown would have nothing left to read.
        controller = _controller({"controller:localhost:8000:status": "failed"})

        with self.assertRaises(SystemExit):
            with self.assertLogs("canyonos_core.controller.global_controller"):
                controller._wait_for_healthy(timeout=0, interval=0)

        self.assertEqual(
            [name for name, _, _ in controller.calls.mock_calls],
            ["run_cmd", "stop"],
        )

    def test_the_teardown_is_the_full_stop_not_just_the_containers(self):
        # `_stop_docker_agents()` alone leaves the supervised processes running,
        # and the atexit cleanup() returns early once nothing is tracked.
        controller = _controller({"controller:localhost:8000:status": "failed"})

        with self.assertRaises(SystemExit):
            with self.assertLogs("canyonos_core.controller.global_controller"):
                controller._wait_for_healthy(timeout=0, interval=0)

        controller.calls.stop.assert_called_once_with()

    def test_stop_is_safe_before_the_polling_loop_ever_started(self):
        # `_fail_unhealthy` calls it from inside the readiness wait, long before
        # run() sets anything up.
        controller = _controller({}, instances=[])
        del controller.stop
        controller.controllers = []
        controller.containers = {}
        controller.redis_containers = {}
        controller._metrics_collectors = {}
        controller.process_supervisor = MagicMock()

        with self.assertLogs("canyonos_core.controller.global_controller"):
            controller.stop()

        self.assertFalse(controller.running)
        controller.process_supervisor.terminate_all.assert_called_once_with()

    def test_docker_refusing_the_log_is_reported_as_one_line(self):
        # stderr from a non-zero `docker logs` is docker's complaint, not the
        # agent's output, and must not be dumped as though it were.
        controller = _controller(
            {"controller:localhost:8000:status": "failed"},
            returncode=1,
            stderr="Error: No such container: canyonos-researchagent-0\n",
        )

        with self.assertLogs(
            "canyonos_core.controller.global_controller", level="INFO"
        ) as logs:
            with self.assertRaises(SystemExit):
                controller._wait_for_healthy(timeout=0, interval=0)

        messages = _messages(logs)
        begin = messages.index(
            "--- begin container log: ResearchAgent (localhost:8000) status=failed ---"
        )
        end = messages.index("--- end container log: ResearchAgent ---")
        self.assertEqual(
            messages[begin + 1 : end],
            [
                "  could not read the log of ResearchAgent: "
                "Error: No such container: canyonos-researchagent-0"
            ],
        )

    def test_an_ec2_block_with_no_settings_under_it_is_not_a_crash(self):
        # A bare `ec2:` key in the YAML parses to None, not {}.
        controller = _controller({}, instances=[_ec2_instance()], config={"ec2": None})

        with self.assertRaises(SystemExit):
            with self.assertLogs("canyonos_core.controller.global_controller"):
                controller._wait_for_healthy(timeout=0, interval=0)

        self.assertIsNone(controller.calls.run_cmd.call_args[0][2])

    def test_an_unreadable_log_still_closes_its_block_and_fails(self):
        controller = _controller({"controller:localhost:8000:status": "failed"})
        controller.calls.run_cmd.side_effect = OSError("docker is gone")

        with self.assertLogs(
            "canyonos_core.controller.global_controller", level="INFO"
        ) as logs:
            with self.assertRaises(SystemExit):
                controller._wait_for_healthy(timeout=0, interval=0)

        messages = _messages(logs)
        self.assertIn(
            "  could not read the log of ResearchAgent: docker is gone", messages
        )
        self.assertIn("--- end container log: ResearchAgent ---", messages)
        self.assertEqual(logs.records[-1].levelno, logging.CRITICAL)


class _Redis:
    def get(self, _key):
        return None


def test_unhealthy_replicas_fail_startup_without_entering_the_run_loop():
    # From main, where the wait raised RuntimeError; readiness failure is now
    # the one CRITICAL summary and exit 1.
    controller = GlobalController.__new__(GlobalController)
    controller.instance_manager = SimpleNamespace(
        list_instances=lambda: [
            {
                "agent_name": "BrokenAgent",
                "host": "127.0.0.1",
                "host_port": 50051,
            }
        ],
        _routing_endpoint_for=lambda instance: (
            f"{instance['host']}:{instance['host_port']}"
        ),
    )
    controller.node_redis = {}
    controller.redis = _Redis()
    controller.config = {}
    controller._last_status = {}
    controller.stop = lambda: []
    controller.run = lambda: pytest.fail("the run loop must not start")

    with pytest.raises(SystemExit) as caught:
        controller._wait_for_healthy(timeout=0, interval=0)

    assert caught.value.code == 1


if __name__ == "__main__":
    unittest.main()
