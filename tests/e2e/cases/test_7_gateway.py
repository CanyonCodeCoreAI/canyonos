# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The LLM gateway and proxy inside an agent replica, checked from inside its
container against a fake provider: calls reach the gateway, streams arrive chunk
by chunk, a child process is caught, other calls pass through, published prices
load, and a killed gateway comes back. It kills a gateway, so it runs after the
queries.

The check runs as its own process in the replica, outside the agent's, so it sets
the future-id header itself; that the agent's own calls carry it is shown by the
tokens the query's model calls record (test_3, `llm` trait)."""

from pathlib import Path

from ..fleet import routed_replicas, store
from ..harness import docker, manifest

GATEWAY_CHECK = Path(__file__).parent.parent / "gateway_check.py"
IN_REPLICA = "/tmp/gateway_check.py"


def test_gateway_inside_a_replica(recorder, deployed):
    endpoint_agent = manifest(deployed.dir)["endpoint"]["agent"]
    agent = next(name for name in deployed.agents if name != endpoint_agent)
    routed = routed_replicas(store(recorder, deployed), agent)
    assert routed, f"{agent} has no routed replica"
    replica = routed[0].container
    state = docker(recorder, ["inspect", "-f", "{{.State.Status}}", replica]).output
    assert state.strip() == "running", f"{replica} is {state.strip()}"
    docker(recorder, ["cp", str(GATEWAY_CHECK), f"{replica}:{IN_REPLICA}"])
    try:
        docker(recorder, ["exec", replica, "python", IN_REPLICA], timeout=300)
    finally:
        docker(recorder, ["exec", replica, "rm", "-f", IN_REPLICA], check=False)
