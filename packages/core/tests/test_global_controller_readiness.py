import logging
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from canyonos_core.controller.global_controller import GlobalController
from canyonos_core.reconciler import providers


class _Redis:
    """No status keys, and one instance record per entry of `records`."""

    def __init__(self, records=()):
        self.records = {
            f"agent_instance:{index}": record for index, record in enumerate(records)
        }

    def get(self, _key):
        return None

    def scan_keys(self, _pattern):
        return list(self.records)

    def hgetall(self, key):
        return self.records[key]


class _StatusRedis:
    """Every status key answers "healthy" unless `statuses` says otherwise."""

    def __init__(self, statuses=()):
        self.statuses = (
            statuses if isinstance(statuses, dict) else dict.fromkeys(statuses)
        )

    def get(self, key):
        return self.statuses.get(key, "healthy")


def _no_output(*_args, **_kwargs):
    return SimpleNamespace(returncode=0, stdout="", stderr="")


def _controller(monkeypatch, instances, node_redis, run_cmd=_no_output):
    controller = GlobalController.__new__(GlobalController)
    monkeypatch.setattr(
        "canyonos_core.controller.global_controller.list_instances",
        lambda _redis: instances,
    )
    controller.controllers = [
        {"name": name, "replicas": 1}
        for name in dict.fromkeys(instance["agent_name"] for instance in instances)
    ]
    controller.node_redis = {"127.0.0.1": node_redis}
    controller.redis = _Redis(instances)
    controller.config = {}
    controller._last_status = {}
    controller._run_cmd = run_cmd
    providers.bind(controller)
    return controller


def _replica(agent_name, host_port):
    return {
        "agent_name": agent_name,
        "provider": "local",
        "runtime_id": f"canyonos-{agent_name.lower()}-0",
        "private_host": "127.0.0.1",
        "public_host": "127.0.0.1",
        "host_port": host_port,
        "routing_endpoint": f"127.0.0.1:{host_port}",
    }


def _alpha_pair():
    return [_replica("Alpha", port) for port in (50051, 50052)]


def test_unhealthy_replicas_fail_startup_without_entering_the_run_loop(monkeypatch):
    controller = _controller(monkeypatch, [_replica("BrokenAgent", 50051)], _Redis())

    with pytest.raises(RuntimeError, match="failed to become healthy.*BrokenAgent"):
        controller._wait_for_healthy(timeout=0, interval=0)


def test_surplus_replicas_of_one_agent_do_not_cover_another(monkeypatch):
    controller = _controller(
        monkeypatch,
        _alpha_pair() + [_replica("Beta", 50053)],
        _StatusRedis({"controller:127.0.0.1:50053:status"}),
    )
    controller.controllers = [
        {"name": "Alpha", "replicas": 1},
        {"name": "Beta", "replicas": 1},
    ]

    with pytest.raises(RuntimeError, match="Beta 0/1"):
        controller._wait_for_healthy(timeout=0, interval=0)


def test_a_replica_still_launching_does_not_fail_startup(monkeypatch):
    controller = _controller(monkeypatch, _alpha_pair(), _StatusRedis())
    controller.controllers = [
        {"name": "Alpha", "replicas": 1},
        {"name": "Beta", "replicas": 1},
    ]
    controller.redis = _Redis(_alpha_pair() + [{"agent_name": "Beta"}])

    controller._wait_for_healthy(timeout=0, interval=0)


def test_a_replica_whose_launch_failed_fails_startup(monkeypatch):
    """No record at all: the reconciler removed the failed launch, or never made one."""
    controller = _controller(monkeypatch, _alpha_pair(), _StatusRedis())
    controller.controllers = [
        {"name": "Alpha", "replicas": 1},
        {"name": "Beta", "replicas": 1},
    ]

    with pytest.raises(RuntimeError, match="Beta 0/1"):
        controller._wait_for_healthy(timeout=0, interval=0)


def test_a_terminal_status_fails_the_deploy_before_the_timeout(monkeypatch):
    """A container that reported "failed" will not change its mind, and the
    reconciler replaces it after its startup grace -- waiting out a long timeout
    would lose the container holding the cause.
    """
    controller = _controller(
        monkeypatch,
        [_replica("Broken", 50051)],
        _StatusRedis({"controller:127.0.0.1:50051:status": "failed"}),
    )
    monkeypatch.setattr(
        "canyonos_core.controller.global_controller.time.sleep",
        lambda _s: pytest.fail("slept instead of failing at once"),
    )

    with pytest.raises(RuntimeError, match="Broken 0/1"):
        controller._wait_for_healthy(timeout=600, interval=1)


def test_a_replica_still_starting_is_waited_for(monkeypatch):
    """Anything short of a terminal status is a container still coming up."""
    redis = _StatusRedis({"controller:127.0.0.1:50051:status": "starting"})
    controller = _controller(monkeypatch, [_replica("Slow", 50051)], redis)
    polls = []

    def become_healthy(_seconds):
        polls.append(1)
        redis.statuses["controller:127.0.0.1:50051:status"] = "healthy"

    monkeypatch.setattr(
        "canyonos_core.controller.global_controller.time.sleep", become_healthy
    )

    controller._wait_for_healthy(timeout=600, interval=1)

    assert polls == [1]


@pytest.mark.parametrize(
    "log_tail, quoted",
    [
        (
            lambda _instance, _lines: [
                "Traceback (most recent call last):",
                "ModuleNotFoundError: No module named 'langchain'",
            ],
            [
                "  Traceback (most recent call last):",
                "  ModuleNotFoundError: No module named 'langchain'",
            ],
        ),
        (lambda _instance, _lines: [], ["  (the container produced no output)"]),
        (
            RuntimeError("no container"),
            ["  could not read the log of Broken: no container"],
        ),
    ],
)
def test_a_failed_replicas_log_tail_is_shown_between_sentinels(
    monkeypatch, caplog, log_tail, quoted
):
    def run_cmd(*_args, **_kwargs):
        pytest.fail("the global controller ran a command itself")

    replica = _replica("Broken", 50051)
    controller = _controller(
        monkeypatch,
        [replica],
        _StatusRedis({"controller:127.0.0.1:50051:status": "failed"}),
        run_cmd=run_cmd,
    )
    provider = SimpleNamespace(log_tail=MagicMock(side_effect=log_tail))
    monkeypatch.setattr(
        "canyonos_core.reconciler.providers.get", lambda _name: provider
    )

    with caplog.at_level(logging.WARNING), pytest.raises(RuntimeError):
        controller._wait_for_healthy(timeout=0, interval=0)

    provider.log_tail.assert_called_once_with(replica, 40)
    messages = [record.getMessage() for record in caplog.records]
    begin = messages.index(
        "--- begin container log: Broken (127.0.0.1:50051) status=failed ---"
    )
    end = messages.index("--- end container log: Broken ---")
    assert messages[begin + 1 : end] == quoted


def test_an_unreadable_log_still_closes_the_block_and_fails(monkeypatch, caplog):
    def run_cmd(cmd, host, user=None):
        raise RuntimeError("docker is gone")

    controller = _controller(
        monkeypatch,
        [_replica("Broken", 50051)],
        _StatusRedis({"controller:127.0.0.1:50051:status": "failed"}),
        run_cmd=run_cmd,
    )

    with caplog.at_level(logging.WARNING), pytest.raises(RuntimeError, match="Broken"):
        controller._wait_for_healthy(timeout=0, interval=0)

    messages = [record.getMessage() for record in caplog.records]
    complaint = "  could not read the log of Broken: docker is gone"
    assert messages.index(complaint) < messages.index(
        "--- end container log: Broken ---"
    )


def test_an_early_exit_dumps_only_the_replicas_that_reported_a_terminal_status(
    monkeypatch, caplog
):
    """The others were still starting when the wait ended: their logs hold
    nothing yet, and dumping them buries the one that actually failed."""
    commands = []

    def run_cmd(cmd, host, user=None):
        commands.append(cmd[-1])
        return _no_output()

    controller = _controller(
        monkeypatch,
        [_replica("Broken", 50051), _replica("Slow", 50052)],
        _StatusRedis(
            {
                "controller:127.0.0.1:50051:status": "failed",
                "controller:127.0.0.1:50052:status": "starting",
            }
        ),
        run_cmd=run_cmd,
    )

    with caplog.at_level(logging.WARNING), pytest.raises(RuntimeError, match="Broken"):
        controller._wait_for_healthy(timeout=600, interval=0)

    assert commands == ["canyonos-broken-0"]
    assert "Controller Slow (127.0.0.1:50052) is starting after 0s." in caplog.messages


def test_a_timeout_dumps_every_replica_still_short(monkeypatch):
    commands = []

    def run_cmd(cmd, host, user=None):
        commands.append(cmd[-1])
        return _no_output()

    controller = _controller(
        monkeypatch,
        [_replica("Stuck", 50051), _replica("Slow", 50052)],
        _StatusRedis(
            {
                "controller:127.0.0.1:50051:status": "starting",
                "controller:127.0.0.1:50052:status": None,
            }
        ),
        run_cmd=run_cmd,
    )

    with pytest.raises(RuntimeError):
        controller._wait_for_healthy(timeout=0, interval=0)

    assert sorted(commands) == ["canyonos-slow-0", "canyonos-stuck-0"]
