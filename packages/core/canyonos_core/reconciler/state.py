# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The reconciler's state in Redis: what each agent should be running, and the signals
that drive it."""
# The durable reconciliation schema in Redis: plain functions over a RedisClient.

import logging

logger = logging.getLogger(__name__)

WAKE_QUEUE_KEY = "reconciler:wake"
WAKE_ALL = "*"
# One read must not spin forever on a queue being written to concurrently.
_WAKE_SIGNAL_LIMIT = 1000

REPLACE_SET_KEY = "reconciler:replace"

STOPPING_KEY = "reconciler:stopping"
# Expires so a hard-killed controller cannot hold the fleet at zero forever.
STOPPING_TTL_SECONDS = 60

# Agent name -> why its last launch failed; a launch that succeeds clears it.
LAUNCH_ERRORS_KEY = "reconciler:launch_errors"

# Machine type -> why its last start failed; a later start of that type clears it.
MACHINE_ERRORS_KEY = "reconciler:machine_errors"

IMAGES_READY_KEY = "reconciler:images_ready"


# ------------------------------------------------------------------ #
#  Desired replica counts                                            #
# ------------------------------------------------------------------ #


def desired_key(agent_name):
    """Return the Redis key holding an agent's desired replica count."""
    return f"agent:{agent_name}:desired_replicas"


def get_desired(redis_client, agent_name, default=0):
    """Desired replica count for an agent, or default if it was never recorded."""
    raw = redis_client.get(desired_key(agent_name))
    if raw is None:
        return default
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        logger.warning(
            "Ignoring non-integer desired_replicas %r for agent %s", raw, agent_name
        )
        return default


def set_desired(redis_client, agent_name, count):
    """Set an agent's desired replica count outright."""
    count = max(0, int(count))
    redis_client.set(desired_key(agent_name), count)
    return count


def replica_count(agent_spec):
    """An agent spec's configured replica count, or None when it is not a count."""
    replicas = agent_spec.get("replicas", 1)
    return replicas if isinstance(replicas, int) else None


def desired_agent_specs(redis_client, agent_specs):
    """The full spec list with each spec's replicas replaced by its desired count."""
    desired_specs = []
    for agent_spec in agent_specs:
        configured = replica_count(agent_spec)
        if configured is None:
            desired_specs.append(agent_spec)
            continue
        desired_specs.append(
            {
                **agent_spec,
                "replicas": get_desired(redis_client, agent_spec["name"], configured),
            }
        )
    return desired_specs


# ------------------------------------------------------------------ #
#  Wake queue                                                        #
# ------------------------------------------------------------------ #


def request_reconcile(redis_client, agent_name=WAKE_ALL):
    """Ask the reconciler to converge an agent (or everything) as soon as it can."""
    redis_client.lpush(WAKE_QUEUE_KEY, agent_name)


def wait_for_wake_signals(redis_client, timeout=1):
    """Block for the first wake signal, then take the rest so a burst collapses into one pass."""
    first = redis_client.brpop(WAKE_QUEUE_KEY, timeout=timeout)
    if first is None:
        return set()

    signals = {first}
    for _ in range(_WAKE_SIGNAL_LIMIT):
        signal = redis_client.rpop(WAKE_QUEUE_KEY)
        if signal is None:
            break
        signals.add(signal)
    return signals


# ------------------------------------------------------------------ #
#  Replacement requests                                              #
# ------------------------------------------------------------------ #


def request_replace(redis_client, replica_id):
    """Mark one replica to be removed; the loop refills its slot afterwards."""
    redis_client.sadd(REPLACE_SET_KEY, replica_id)


def replace_requests(redis_client, agent_name):
    """An agent's pending replace requests; they stay pending until cleared."""
    return {
        replica_id
        for replica_id in redis_client.smembers(REPLACE_SET_KEY)
        if replica_id.rsplit("-", 1)[0] == agent_name
    }


def clear_replace_requests(redis_client, *replica_ids):
    """Mark replace requests as done."""
    if replica_ids:
        redis_client.srem(REPLACE_SET_KEY, *replica_ids)


# ------------------------------------------------------------------ #
#  Stopping                                                          #
# ------------------------------------------------------------------ #


def set_stopping(redis_client):
    """Hold every agent at zero replicas while the controller tears the fleet down."""
    redis_client.set(STOPPING_KEY, 1)
    redis_client.expire(STOPPING_KEY, STOPPING_TTL_SECONDS)


def clear_stopping(redis_client):
    """Stop holding agents at zero, letting desired state drive the loop again."""
    redis_client.delete(STOPPING_KEY)


def is_stopping(redis_client):
    """Return True while the Global Controller is tearing the fleet down, during which
    every agent is held at zero replicas."""
    return redis_client.get(STOPPING_KEY) is not None


# ------------------------------------------------------------------ #
#  Images                                                            #
# ------------------------------------------------------------------ #


def set_images_ready(redis_client):
    """Let launches start their containers: this deploy's images are built."""
    redis_client.set(IMAGES_READY_KEY, 1)


def clear_images_ready(redis_client):
    """Hold launches until this deploy's images are built."""
    redis_client.delete(IMAGES_READY_KEY)


def images_ready(redis_client):
    """Return True once this deploy's images are built."""
    return redis_client.get(IMAGES_READY_KEY) is not None
