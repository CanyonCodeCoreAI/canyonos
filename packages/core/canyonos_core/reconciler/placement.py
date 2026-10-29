# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Choose the machine each new replica runs on."""


def place(machines, provider_name, replica):
    """Put a replica on the least loaded machine of its provider, where a machine's
    load is the larger of its CPU and memory fill. A machine started for one agent
    (its record has `agent_name`) takes one replica of that agent, so a replica whose
    own machine failed to start waits for the replacement instead of sharing. A pool
    never refuses: replicas rarely use their full limits, so a full pool is shared
    evenly. None when its provider has no machine for it."""
    agent_name = replica["agent_spec"]["name"]
    candidates = [
        m
        for m in machines
        if m["provider"] == provider_name
        and (
            m["record"].get("agent_name") is None
            or (m["record"]["agent_name"] == agent_name and not m["used"]["replicas"])
        )
    ]
    if not candidates:
        return None
    machine = min(
        candidates,
        key=lambda m: (
            max(
                m["used"]["cpu"] / m["capacity"]["cpu"],
                m["used"]["memory"] / m["capacity"]["memory"],
            )
            if m["capacity"]
            else 0
        ),
    )
    machine["used"]["cpu"] += replica["cpu"]
    machine["used"]["memory"] += replica["memory"]
    machine["used"]["replicas"] += 1
    machine["replicas"].append(replica)
    return machine
