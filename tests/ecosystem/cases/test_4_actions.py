# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Actions through the dashboard API change the running deploy: a scaling policy
adds replicas the controller then starts, and a second policy at the starting
count brings them back.

Deleting a policy does not lower replicas: the controller keeps the last count
it was given until a restart or reload, so the case scales back with a policy
first and only then deletes it, or puts back the project's own policy. The
policy is project-wide, so a port whose agents start at different counts is
brought back to one replica each, not to its exact starting counts."""

from ..harness import docker, poll

SCALE_TIMEOUT = 240
POLICY = {
    "min_replicas": 2,
    "max_replicas": 2,
    "metric": "queue_length_total",
    "scale_up_above": 10,
    "scale_down_below": 1,
}


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


def _restore(deployed, path, restore_policy, start, *, check):
    """Pin the fleet back to the starting count, then leave the stored policy as
    the project had it: its own policy put back, or none (an invalid stored policy
    is deleted, since the API does not return it). With `check` off it is cleanup
    after a failure: it still waits for the fleet, so the policy is not removed
    before the controller has acted on it, but raises nothing."""
    count = restore_policy["min_replicas"]
    deployed.api.put(path, json=restore_policy, check=check)
    try:
        poll(
            lambda: _all_at(deployed, count),
            timeout=SCALE_TIMEOUT,
            what=f"every agent back to {count} replicas",
        )
    except AssertionError:
        if check:
            raise
    _put_back(deployed, path, start, check=check)
    if check:
        expected = "applied" if start["status"] == "applied" else "none"
        assert deployed.api.get(path).json()["status"] == expected


def _put_back(deployed, path, start, *, check):
    if start["status"] == "applied":
        deployed.api.put(path, json=start["policy"], check=check)
    else:
        deployed.api.delete(path, check=check)


def test_scaling_policy_applies(recorder, deployed):
    path = f"/projects/{deployed.project_id}/scaling"
    start = deployed.api.get(path).json()
    counts = {a["replicas_expected"] for a in _agents(deployed)}
    starting_count = counts.pop() if len(counts) == 1 else 1
    restore_policy = {
        **POLICY,
        "min_replicas": starting_count,
        "max_replicas": starting_count,
    }
    restored = False
    try:
        deployed.api.put(path, json=POLICY)
        assert deployed.api.get(path).json()["status"] == "applied"
        agents = poll(
            lambda: _all_at(deployed, 2),
            timeout=SCALE_TIMEOUT,
            what="every agent at two replicas",
        )
        names = docker(
            recorder,
            [
                "ps",
                "--filter",
                f"label=com.docker.compose.project=canyonos-{deployed.project.name}",
                "--format",
                "{{.Names}}",
            ],
        ).output.split()
        agent = agents[0]["name"].lower()
        assert f"canyonos-{deployed.project.name}-{agent}-1" in names, names
        _restore(deployed, path, restore_policy, start, check=True)
        restored = True
    finally:
        if not restored:
            _restore(deployed, path, restore_policy, start, check=False)
