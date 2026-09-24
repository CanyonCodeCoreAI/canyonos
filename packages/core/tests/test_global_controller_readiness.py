import logging
from types import SimpleNamespace

import pytest

from canyonos_core.controller.global_controller import GlobalController


class _Redis:
    def get(self, _key):
        return None


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
    monkeypatch.setattr(
        "canyonos_core.controller.global_controller.routing_endpoint_for",
        lambda instance: f"{instance['host']}:{instance['host_port']}",
    )
    controller.controllers = [
        {"name": name, "replicas": 1}
        for name in dict.fromkeys(instance["agent_name"] for instance in instances)
    ]
    controller.node_redis = {"127.0.0.1": node_redis}
    controller.redis = _Redis()
    controller.config = {}
    controller._last_status = {}
    controller._run_cmd = run_cmd
    return controller


def _replica(agent_name, host_port, runtime_id=None, provider="local"):
    return {
        "agent_name": agent_name,
        "provider": provider,
        "runtime_id": runtime_id or f"canyonos-{agent_name.lower()}-0",
        "host": "127.0.0.1",
        "host_port": host_port,
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


def test_a_replica_not_created_yet_does_not_fail_startup(monkeypatch):
    controller = _controller(monkeypatch, _alpha_pair(), _StatusRedis())
    controller.controllers = [
        {"name": "Alpha", "replicas": 1},
        {"name": "Beta", "replicas": 1},
    ]

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


def test_a_failed_replicas_log_is_shown_between_sentinels(monkeypatch, caplog):
    commands = []

    def run_cmd(cmd, host, user=None):
        commands.append((cmd, host, user))
        return SimpleNamespace(
            returncode=0,
            stdout="Traceback (most recent call last):\nModuleNotFoundError: No module named 'langchain'\n",
            stderr="",
        )

    controller = _controller(
        monkeypatch,
        [_replica("Broken", 50051)],
        _StatusRedis({"controller:127.0.0.1:50051:status": "failed"}),
        run_cmd=run_cmd,
    )

    with caplog.at_level(logging.WARNING), pytest.raises(RuntimeError):
        controller._wait_for_healthy(timeout=0, interval=0)

    assert commands == [
        (["docker", "logs", "--tail", "40", "canyonos-broken-0"], "127.0.0.1", None)
    ]
    messages = [record.getMessage() for record in caplog.records]
    begin = messages.index(
        "--- begin container log: Broken (127.0.0.1:50051) status=failed ---"
    )
    end = messages.index("--- end container log: Broken ---")
    assert messages[begin + 1 : end] == [
        "  Traceback (most recent call last):",
        "  ModuleNotFoundError: No module named 'langchain'",
    ]


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


def test_an_ec2_replicas_log_is_read_by_its_container_name_over_ssh(monkeypatch):
    commands = []

    def run_cmd(cmd, host, user=None):
        commands.append((cmd, host, user))
        return _no_output()

    controller = _controller(
        monkeypatch,
        [_replica("Broken", 50051, "canyonos-broken-0--i-0abc", provider="EC2")],
        _StatusRedis({"controller:127.0.0.1:50051:status": "failed"}),
        run_cmd=run_cmd,
    )
    controller.config = {"ec2": {"ssh_user": "ubuntu"}}

    with pytest.raises(RuntimeError):
        controller._wait_for_healthy(timeout=0, interval=0)

    assert commands == [
        (["docker", "logs", "--tail", "40", "canyonos-broken-0"], "127.0.0.1", "ubuntu")
    ]
