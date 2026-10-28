# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The operator writes replica records and routing in Go; these tests keep that format
tied to the Python that reads it."""

import json
import os
import unittest
from types import SimpleNamespace

import kubernetes_contract
from canyonos_core.reconciler.replica_provisioner import ReplicaProvisioner
from fakes import _FakeRedis

CONTRACT_PATH = os.path.join(
    os.path.dirname(__file__),
    "..",
    "..",
    "operator",
    "internal",
    "redisstate",
    "testdata",
    "contract.json",
)
REGENERATE = (
    "uv run python packages/core/tests/kubernetes_contract.py "
    "> packages/operator/internal/redisstate/testdata/contract.json"
)
RENDERED_PATH = os.path.join(
    os.path.dirname(__file__),
    "..",
    "..",
    "operator",
    "api",
    "v1alpha1",
    "testdata",
    "rendered.json",
)
REGENERATE_RENDERED = (
    "uv run python packages/core/tests/kubernetes_contract.py rendered "
    "> packages/operator/api/v1alpha1/testdata/rendered.json"
)


def _provisioner_record_fields():
    """The fields the Docker/EC2 provisioner writes into a replica's record."""
    redis = _FakeRedis()
    controller = SimpleNamespace(
        redis=redis, machine_redis_for_replica=lambda _r: _FakeRedis()
    )
    replica = {
        field: "x"
        for field in (
            "agent_name",
            "provider",
            "private_host",
            "public_host",
            "host_port",
            "container_port",
            "published_address",
            "address",
            "redis_host",
            "redis_port",
            "container_name",
        )
    }
    replica.update(provider="local", agent_name="Alpha", replica_index=0)
    ReplicaProvisioner(controller)._write_replica(replica, 0.0)
    (record,) = redis.hashes.values()
    return set(record)


class ContractTests(unittest.TestCase):
    def test_the_committed_contract_matches_the_code(self):
        with open(CONTRACT_PATH, encoding="utf-8") as f:
            committed = f.read()
        self.assertEqual(
            committed,
            kubernetes_contract.render(),
            f"Stale contract; regenerate it: {REGENERATE}",
        )

    def test_the_committed_rendered_objects_match_the_code(self):
        # The operator's Go types decode these strictly (api/v1alpha1/rendered_test.go).
        with open(RENDERED_PATH, encoding="utf-8") as f:
            committed = f.read()
        self.assertEqual(
            committed,
            kubernetes_contract.render_rendered(),
            f"Stale rendered objects; regenerate them: {REGENERATE_RENDERED}",
        )

    def test_a_kubernetes_record_has_every_field_the_provisioner_writes(self):
        record = kubernetes_contract.replica_record(
            "HelloAgent",
            0,
            "helloagent-0",
            "uid",
            "acme",
            "canyonos-redis.acme.svc",
            6379,
            1.0,
        )
        self.assertEqual(set(record) - {"pod_uid"}, _provisioner_record_fields())

    def test_the_routing_table_is_what_python_itself_publishes(self):
        routing = kubernetes_contract.contract()["routing"]
        # Replicas in index order, JSON with Python's ", " separators.
        addresses = routing["addresses"]["HelloAgent"]
        self.assertEqual(
            addresses,
            '["helloagent-0.helloagent.acme.svc:50051", "helloagent-1.helloagent.acme.svc:50051"]',
        )
        self.assertEqual(
            json.loads(routing["addresses"]["Workflow"]),
            ["workflow-0.workflow.acme.svc:50051"],
        )
        self.assertEqual(routing["stateful"], {"HelloAgent": "true"})

    def test_the_replica_address_is_the_pods_dns_name(self):
        record = kubernetes_contract.replica_record(
            "Portfolio_Agent", 2, "portfolio-agent-2", "uid", "acme", "r", 6379, 1.0
        )
        self.assertEqual(
            record["address"], "portfolio-agent-2.portfolio-agent.acme.svc:50051"
        )
        self.assertEqual(record["container_name"], "portfolio-agent-2")


if __name__ == "__main__":
    unittest.main()
