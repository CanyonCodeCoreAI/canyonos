# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Actions that change the running deploy. A scaling policy through the dashboard
API adds replicas the controller starts, the new replicas take calls, and a second
policy at the starting count drains them away again. `docker stop` on a replica in
the middle of a call drains it as the reconciler would: the call finishes, the
container exits 0, and the reconciler starts a replica in its place.

Deleting a policy does not lower replicas: the controller keeps the last count
it was given until a restart or reload, so the cases scale back with a policy
first and only then delete it, or put back the project's own policy. The
policy is project-wide, so a port whose agents start at different counts is
brought back to one replica each, not to its exact starting counts."""

from concurrent.futures import ThreadPoolExecutor

import pytest

from ..fleet import (
    agent_status,
    calls_of,
    replica_containers,
    root_future,
    routed_replicas,
    store,
)
from ..harness import docker, finished, manifest, poll, submit

SCALE_TIMEOUT = 240
POLICY = {
    "min_replicas": 2,
    "max_replicas": 2,
    "metric": "queue_length_total",
    "scale_up_above": 10,
    "scale_down_below": 1,
}
# Enough queries that two replicas picked at random each get one, but for a
# chance of 2**-15.
MAX_QUERIES = 16
# The reconciler's drain timeout, which `docker stop` waits before it kills.
DRAIN_TIMEOUT = 180
# Below the 3 missed heartbeats after which the reconciler replaces a held replica.
HOLD_LIMIT = 12


def _agents(deployed):
    path = f"/projects/{deployed.project_id}/scaling/agents"
    return deployed.api.get(path).json()["agents"]


def _all_at(deployed, count):
    """The scaling agents when every one runs `count` replicas, else None."""
    agents = _agents(deployed)
    settled = all(
        a["replicas_expected"] == count and a["replicas_running"] == count
        for a in agents
    )
    return agents if settled else None


def _containers_at(recorder, deployed, count):
    """True once every agent has exactly `count` replica containers, so a drained
    replica's container is gone before the next case picks one."""
    return all(
        len(replica_containers(recorder, deployed, agent)) == count
        for agent in deployed.agents
    )


def _restore(recorder, deployed, path, start, count, *, check):
    """Pin the fleet back to `count` replicas, wait until the extra replicas'
    containers are gone, then leave the stored policy as the project had it: its
    own policy put back, or none (an invalid stored policy is deleted, since the
    API does not return it). With `check` off it is cleanup after a failure: it
    still waits, so the policy is not removed before the controller has acted on
    it, but raises nothing."""
    pinned = {**POLICY, "min_replicas": count, "max_replicas": count}
    deployed.api.put(path, json=pinned, check=check)
    try:
        poll(
            lambda: _all_at(deployed, count),
            timeout=SCALE_TIMEOUT,
            what=f"every agent back to {count} replicas",
        )
        poll(
            lambda: _containers_at(recorder, deployed, count),
            timeout=SCALE_TIMEOUT,
            what=f"every agent down to {count} replica containers",
        )
    except AssertionError:
        if check:
            raise
    if start["status"] == "applied":
        deployed.api.put(path, json=start["policy"], check=check)
    else:
        deployed.api.delete(path, check=check)
    if check:
        expected = "applied" if start["status"] == "applied" else "none"
        assert deployed.api.get(path).json()["status"] == expected


@pytest.mark.trait("quick")
def test_a_scaling_policy_adds_replicas_that_take_queries(recorder, deployed, check):
    """A policy pinning every agent at two replicas starts a second container of
    each. The endpoint picks the endpoint agent's replica at random for each
    request, so the one the reconciler added is routed to and runs the call."""
    path = f"/projects/{deployed.project_id}/scaling"
    start = deployed.api.get(path).json()
    counts = {a["replicas_expected"] for a in _agents(deployed)}
    starting_count = counts.pop() if len(counts) == 1 else 1
    endpoint_agent = manifest(deployed.dir)["endpoint"]["agent"]
    redis_client = store(recorder, deployed)

    def two_routed():
        ids = {r.replica_id for r in routed_replicas(redis_client, endpoint_agent)}
        return ids if len(ids) == 2 else None

    passed = False
    try:
        deployed.api.put(path, json=POLICY)
        assert deployed.api.get(path).json()["status"] == "applied"
        poll(
            lambda: _all_at(deployed, 2),
            timeout=SCALE_TIMEOUT,
            what="every agent at two replicas",
        )
        running = {
            agent: sorted(
                name
                for name, state in replica_containers(recorder, deployed, agent).items()
                if state == "running"
            )
            for agent in deployed.agents
        }
        assert all(len(names) == 2 for names in running.values()), running
        routed = poll(
            two_routed,
            timeout=SCALE_TIMEOUT,
            what=f"two routed replicas of {endpoint_agent}",
        )
        served = set()
        for _ in range(MAX_QUERIES):
            request_id = submit(recorder, deployed.endpoint, deployed.query)
            status = finished(
                recorder,
                deployed.endpoint,
                request_id,
                timeout=deployed.project.timeout,
            )
            assert status["status"] == "done", status
            problems = list(
                check.problems(
                    status["result"], query=deployed.query, request_id=request_id
                )
            )
            assert not problems, "\n".join(problems)
            replica = poll(
                lambda: root_future(redis_client, request_id).get("agent"),
                timeout=30,
                interval=1,
                what=f"the replica that ran request {request_id}",
            )
            served.add(replica)
            if served >= routed:
                break
        assert served == routed, f"routed to {sorted(routed)}, ran on {sorted(served)}"
        passed = True
    finally:
        _restore(recorder, deployed, path, start, starting_count, check=passed)


def _mid_call(redis_client, request_id):
    """True once the endpoint agent's call of the request is running and has called
    another agent, whose answer it now waits for."""
    root = root_future(redis_client, request_id)
    if not root or root.get("result") or root.get("failed") == "1":
        return False
    return any(call.parent == root["id"] for call in calls_of(redis_client, request_id))


@pytest.mark.trait("quick")
def test_docker_stop_drains_a_replica_mid_call(recorder, deployed, check):
    """Every other agent's replica is paused, so the endpoint agent's call is held
    waiting on the one it calls; `docker stop` lands then. The pause ends as soon as
    the replica's heartbeat reports it draining, well before the reconciler would
    replace a paused replica. Exit code 0 means it drained: Docker's kill at the end
    of the grace period exits 137. Once `canyonos status` reports the replacement, a
    request sent then must be answered, not lost on the replica that is gone."""
    endpoint_agent = manifest(deployed.dir)["endpoint"]["agent"]
    redis_client = store(recorder, deployed)
    desired, _, _ = agent_status(recorder, deployed, endpoint_agent)
    replicas = routed_replicas(redis_client, endpoint_agent)
    assert len(replicas) == 1, f"the query must land on one replica: {replicas}"
    stopped = replicas[0]
    heartbeat = f"controller:{stopped.address}:metrics"
    held = [
        replica.container
        for agent in deployed.agents
        if agent != endpoint_agent
        for replica in routed_replicas(redis_client, agent)
    ]
    assert held, f"{endpoint_agent} calls no other agent to hold the call on"

    with ThreadPoolExecutor(max_workers=2) as pool:
        docker(recorder, ["pause", *held])
        try:
            request_id = submit(recorder, deployed.endpoint, deployed.query)
            poll(
                lambda: _mid_call(redis_client, request_id),
                timeout=HOLD_LIMIT / 2,
                interval=0.5,
                what=f"{endpoint_agent} to be in the middle of request {request_id}",
            )
            exit_code = pool.submit(
                docker,
                recorder,
                ["wait", stopped.container],
                timeout=DRAIN_TIMEOUT + 60,
            )
            stop = pool.submit(
                docker,
                recorder,
                ["stop", stopped.container],
                timeout=DRAIN_TIMEOUT + 60,
            )
            poll(
                lambda: redis_client.hget(heartbeat, "draining") == "1",
                timeout=HOLD_LIMIT / 2,
                interval=0.5,
                what=f"{stopped.container} to start draining",
            )
        finally:
            docker(recorder, ["unpause", *held], check=False)
        stop.result()
        code = exit_code.result().output.strip()

    status = finished(
        recorder, deployed.endpoint, request_id, timeout=deployed.project.timeout
    )
    assert status["status"] == "done", status
    problems = list(
        check.problems(status["result"], query=deployed.query, request_id=request_id)
    )
    assert not problems, "\n".join(problems)
    logs = docker(recorder, ["logs", "--tail", "50", stopped.container], check=False)
    assert code == "0", f"{stopped.container} exited {code}\n{logs.output}"

    poll(
        lambda: (
            agent_status(recorder, deployed, endpoint_agent) == (desired, desired, None)
            and stopped.replica_id
            not in {r.replica_id for r in routed_replicas(redis_client, endpoint_agent)}
            and len(routed_replicas(redis_client, endpoint_agent)) == desired
            and stopped.container
            not in replica_containers(recorder, deployed, endpoint_agent)
        ),
        timeout=SCALE_TIMEOUT,
        what=f"{endpoint_agent} back at {desired} replicas without {stopped.replica_id}",
    )
    request_id = submit(recorder, deployed.endpoint, deployed.query)
    status = finished(
        recorder, deployed.endpoint, request_id, timeout=deployed.project.timeout
    )
    assert status["status"] == "done", (
        f"a request sent once status reported the replacement failed: {status}"
    )
