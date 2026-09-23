import pytest

from canyonos_core.controller.global_controller import GlobalController


class _Redis:
    def get(self, _key):
        return None


def test_unhealthy_replicas_fail_startup_without_entering_the_run_loop(monkeypatch):
    controller = GlobalController.__new__(GlobalController)
    instances = [
        {
            "agent_name": "BrokenAgent",
            "host": "127.0.0.1",
            "host_port": 50051,
        }
    ]
    monkeypatch.setattr(
        "canyonos_core.controller.global_controller.list_instances",
        lambda _redis: instances,
    )
    monkeypatch.setattr(
        "canyonos_core.controller.global_controller.routing_endpoint_for",
        lambda instance: f"{instance['host']}:{instance['host_port']}",
    )
    controller.controllers = [{"name": "BrokenAgent", "replicas": 1}]
    controller.node_redis = {"127.0.0.1": _Redis()}
    controller.redis = _Redis()
    controller._last_status = {}

    with pytest.raises(RuntimeError, match="failed to become healthy.*BrokenAgent"):
        controller._wait_for_healthy(timeout=0, interval=0)


class _HealthyRedis:
    def __init__(self, unhealthy=()):
        self.unhealthy = set(unhealthy)

    def get(self, key):
        return None if key in self.unhealthy else "healthy"


def _two_agent_controller(monkeypatch, instances, unhealthy=()):
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
        {"name": "Alpha", "replicas": 1},
        {"name": "Beta", "replicas": 1},
    ]
    controller.node_redis = {"127.0.0.1": _HealthyRedis(unhealthy)}
    controller.redis = _Redis()
    controller._last_status = {}
    return controller


def _alpha_pair():
    return [
        {"agent_name": "Alpha", "host": "127.0.0.1", "host_port": port}
        for port in (50051, 50052)
    ]


def test_surplus_replicas_of_one_agent_do_not_cover_another(monkeypatch):
    beta = {"agent_name": "Beta", "host": "127.0.0.1", "host_port": 50053}
    controller = _two_agent_controller(
        monkeypatch,
        _alpha_pair() + [beta],
        unhealthy={"controller:127.0.0.1:50053:status"},
    )

    with pytest.raises(RuntimeError, match="Beta 0/1"):
        controller._wait_for_healthy(timeout=0, interval=0)


def test_a_replica_not_created_yet_does_not_fail_startup(monkeypatch):
    controller = _two_agent_controller(monkeypatch, _alpha_pair())

    controller._wait_for_healthy(timeout=0, interval=0)
