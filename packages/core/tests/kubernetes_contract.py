# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""What core and the Kubernetes operator must agree on, generated from the Python side
as JSON for the operator's Go tests. The Redis records and environment the operator
must produce:

    uv run python packages/core/tests/kubernetes_contract.py \
        > packages/operator/internal/redisstate/testdata/contract.json

and the CanyonProject and CanyonAgent objects core renders, which the operator's types
must take as they are (api/v1alpha1/rendered_test.go):

    uv run python packages/core/tests/kubernetes_contract.py rendered \
        > packages/operator/api/v1alpha1/testdata/rendered.json

Records follow the fields the Docker and EC2 provisioner writes; the routing table comes
from running reconciler/routing.py's publish_routing_snapshot over those records, so its
exact bytes (JSON spacing included) are what Python writes; the LLM gateway variables
come from shared_utils/llm_gateway_env.py; the objects from kubernetes/manifests.py's
render() over sample projects that use every setting it reads.
test_kubernetes_contract.py fails when a committed file is stale. A test tool: nothing
here ships in the core image.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from canyonos_core.controller.controller_context import (  # noqa: E402
    list_replicas,
    replica_id,
    replica_key,
)
from canyonos_core.kubernetes import manifests  # noqa: E402
from canyonos_core.kubernetes.api import resource_name  # noqa: E402
from canyonos_core.reconciler import routing, state  # noqa: E402
from canyonos_core.reconciler.providers.shared_utils.llm_gateway_env import (  # noqa: E402
    _llm_gateway_env_vars,
)
from canyonos_core.schema._checks import _Collector  # noqa: E402
from canyonos_core.schema.kubernetes_block import parse_kubernetes  # noqa: E402
from fakes import _FakeRedis  # noqa: E402

# The provider name in a Kubernetes replica's record and key.
PROVIDER = "kubernetes"
# Every replica's LocalController serves gRPC here (container_names.CONTAINER_PORT).
REPLICA_PORT = 50051

NAMESPACE = "acme"
REDIS_HOST = "canyonos-redis.acme.svc"
REDIS_PORT = 6379
CREATED_AT = 1791993600.0


def replica_record(
    agent_name,
    replica_index,
    pod_name,
    pod_uid,
    namespace,
    redis_host,
    redis_port,
    created_at,
):
    """The replica record the operator writes for one ready pod, in the fields the
    Docker and EC2 provisioner writes (reconciler/replica_provisioner.py _write_replica), so the
    global controller reads both alike. Its address is the pod's stable DNS name, which
    is also the replica's CANYONOS_AGENT_HOST; its container is the pod. `pod_uid` tells
    a replaced pod from the one before it."""
    host = f"{pod_name}.{resource_name(agent_name)}.{namespace}.svc"
    address = f"{host}:{REPLICA_PORT}"
    return {
        "agent_name": agent_name,
        "provider": PROVIDER,
        "replica_index": str(replica_index),
        "private_host": host,
        "public_host": host,
        "host_port": str(REPLICA_PORT),
        "container_port": str(REPLICA_PORT),
        "published_address": address,
        "address": address,
        "redis_host": redis_host,
        "redis_port": str(redis_port),
        "container_name": pod_name,
        "created_at": str(created_at),
        "pod_uid": pod_uid,
    }


def _replica(agent_name, replica_index):
    pod = f"{resource_name(agent_name)}-{replica_index}"
    return replica_record(
        agent_name,
        replica_index,
        pod,
        f"uid-{pod}",
        NAMESPACE,
        REDIS_HOST,
        REDIS_PORT,
        CREATED_AT,
    )


def contract():
    """The contract as a JSON-ready dict."""
    replicas = [
        _replica("HelloAgent", 1),
        _replica("HelloAgent", 0),
        _replica("Workflow", 0),
    ]
    redis = _FakeRedis()
    for record in replicas:
        name, index = record["agent_name"], int(record["replica_index"])
        redis.hset_multiple(replica_key(name, index), record)
        redis.sadd(f"agent:{name}:instances", replica_id(name, index))

    agent_specs = [{"name": "HelloAgent", "stateful": True}, {"name": "Workflow"}]
    routing.publish_routing_snapshot(agent_specs, redis)
    # What the reading side sees: list_replicas drops nothing the operator wrote.
    assert len(kubernetes_records := list_replicas(redis)) == len(replicas)

    return {
        "provider": PROVIDER,
        "replica_port": REPLICA_PORT,
        "example": {
            "namespace": NAMESPACE,
            "redis_host": REDIS_HOST,
            "redis_port": REDIS_PORT,
            "created_at": str(CREATED_AT),
        },
        "records": {
            replica_key(r["agent_name"], int(r["replica_index"])): r
            for r in kubernetes_records
        },
        "replica_sets": {key: sorted(members) for key, members in redis.sets.items()},
        # Where a replica finds its ID, as the provisioner writes it.
        "replica_id": {
            "key": f"controller:{replicas[0]['address']}:replica_id",
            "value": replica_id(
                replicas[0]["agent_name"], int(replicas[0]["replica_index"])
            ),
        },
        "desired_replicas_key": state.desired_key("HelloAgent"),
        "routing": {
            "agents_key": routing.AGENTS_SET_KEY,
            "addresses_key": routing.ROUTING_ADDRESSES_KEY,
            "stateful_key": routing.ROUTING_STATEFUL_KEY,
            "addresses": redis.hashes[routing.ROUTING_ADDRESSES_KEY],
            "stateful": redis.hashes.get(routing.ROUTING_STATEFUL_KEY, {}),
        },
        "llm_gateway_env": _llm_gateway_env_vars(),
    }


def render():
    """The contract as the committed file's exact text."""
    return json.dumps(contract(), indent=2, sort_keys=True) + "\n"


def _agent(name, **settings):
    return {
        "name": name,
        "entrypoint": f"agents/{name.lower()}.py",
        "functions": [{"name": "main", "arguments": [{"name": "query"}]}],
        **settings,
    }


# Between them, every setting render() reads: an internal Redis with its disk, an
# Ingress with TLS, placement, a ServiceAccount, a pull Secret, a database, a GPU, env,
# a live replica count; and an external Redis with a password and an endpoint URL.
SAMPLE_PROJECTS = {
    "internal_redis": {
        "config": {
            "agents": [
                _agent("HelloAgent", replicas=2, stateful=True, env={"GREETING": "hi"}),
                _agent("Workflow", resources={"cpu": 2, "memory": 1024, "gpu": 1}),
                {
                    "name": "StateDB",
                    "type": "database",
                    "image": "postgres:16-alpine",
                    "volume_path": "/var/lib/postgresql/data",
                    "db_port": 5432,
                    "resources": {"cpu": 1, "memory": 512},
                },
            ],
            "endpoint": {"agent": "Workflow", "method": "main"},
            "poll_interval": 5,
            "kubernetes": {
                "namespace": NAMESPACE,
                "registry": "registry.example.com/acme",
                "service_account": "agents",
                "image_pull_secret": "registry-pull",
                "node_selector": {"pool": "agents"},
                "redis": {"storage": "2Gi", "storage_class": "gp3"},
                "endpoint": {
                    "host": "agents.example.com",
                    "ingress_class": "nginx",
                    "tls_secret": "agents-tls",
                },
                "databases": {
                    "StateDB": {
                        "run_as_user": 70,
                        "fs_group": 70,
                        "storage": "5Gi",
                        "storage_class": "gp3",
                    }
                },
            },
        },
        "env_secret": "demo-env",
        "live_replicas": {"helloagent": 3},
    },
    "external_redis": {
        "config": {
            "agents": [_agent("Workflow")],
            "endpoint": {"agent": "Workflow", "method": "main"},
            "logs": False,
            "kubernetes": {
                "namespace": NAMESPACE,
                "registry": "registry.example.com/acme",
                "redis": {
                    "host": "redis.example.com",
                    "port": 6380,
                    "tls": True,
                    "password_secret": "redis-auth",
                },
                "endpoint": {"url": "https://agents.example.com"},
            },
        },
        "env_secret": None,
        "live_replicas": {},
    },
}


def rendered():
    """Each sample project's objects, as render() makes them: {sample: [objects]}."""
    samples = {}
    for name, sample in SAMPLE_PROJECTS.items():
        config = sample["config"]
        collector = _Collector("global_controller.yaml")
        spec = parse_kubernetes(collector, config)
        assert not collector.violations, collector.violations
        code_agents = [
            agent["name"]
            for agent in config["agents"]
            if agent.get("type") != "database"
        ]
        samples[name], _ = manifests.render(
            config,
            spec,
            project_name="Demo_Project",
            project_id="4eeed6f3-1c2b-4c1d-9d8e-0a1b2c3d4e5f",
            config_files={"global_controller.yaml": "agents: []\n"},
            images={
                agent: f"registry.example.com/acme/canyonos-{agent.lower()}@sha256:"
                + "a" * 64
                for agent in code_agents
            },
            controller_image="registry.example.com/canyonos-core@sha256:" + "c" * 64,
            env_secret=sample["env_secret"],
            live_replicas=sample["live_replicas"],
        )
    return samples


def render_rendered():
    """The rendered objects as the committed file's exact text."""
    return json.dumps(rendered(), indent=2, sort_keys=True) + "\n"


if __name__ == "__main__":
    sys.stdout.write(render_rendered() if sys.argv[1:] == ["rendered"] else render())
