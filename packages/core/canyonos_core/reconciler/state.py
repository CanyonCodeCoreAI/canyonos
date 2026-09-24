# The durable reconciliation schema in Redis: plain functions over a RedisClient.

import logging

logger = logging.getLogger(__name__)

WAKE_QUEUE_KEY = "reconciler:wake"
WAKE_ALL = "*"
# One drain must not spin forever on a queue being written to concurrently.
_DRAIN_LIMIT = 1000

REPLACE_SET_KEY = "reconciler:replace"

DRAINING_KEY = "reconciler:draining"
# Expires so a hard-killed controller cannot hold the fleet at zero forever.
DRAINING_TTL_SECONDS = 60


# ------------------------------------------------------------------ #
#  Desired replica counts                                            #
# ------------------------------------------------------------------ #


def desired_key(agent_name):
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


def replica_count(spec):
    """An agent spec's configured replica count, or None when it is not a count."""
    replicas = spec.get("replicas", 1)
    return replicas if isinstance(replicas, int) else None


def desired_agent_specs(redis_client, agent_specs):
    """The full spec list with each spec's replicas replaced by its desired count."""
    specs = []
    for spec in agent_specs:
        configured = replica_count(spec)
        if configured is None:
            specs.append(spec)
            continue
        specs.append(
            {**spec, "replicas": get_desired(redis_client, spec["name"], configured)}
        )
    return specs


# ------------------------------------------------------------------ #
#  Wake queue                                                        #
# ------------------------------------------------------------------ #


def request_reconcile(redis_client, agent_name=WAKE_ALL):
    """Ask the reconciler to converge an agent (or everything) as soon as it can."""
    redis_client.lpush(WAKE_QUEUE_KEY, agent_name)


def drain(redis_client, timeout=1):
    """Block for the first wake signal, then take the rest so a burst collapses into one pass."""
    first = redis_client.brpop(WAKE_QUEUE_KEY, timeout=timeout)
    if first is None:
        return set()

    signals = {first}
    for _ in range(_DRAIN_LIMIT):
        signal = redis_client.rpop(WAKE_QUEUE_KEY)
        if signal is None:
            break
        signals.add(signal)
    return signals


# ------------------------------------------------------------------ #
#  Replacement requests                                              #
# ------------------------------------------------------------------ #


def request_replace(redis_client, instance_id):
    """Mark one instance to be destroyed; the loop refills its slot afterwards."""
    redis_client.sadd(REPLACE_SET_KEY, instance_id)


def replace_requests(redis_client, agent_name):
    """An agent's pending replace requests; they stay pending until cleared."""
    prefix = f":{agent_name}:"
    return {
        instance_id
        for instance_id in redis_client.smembers(REPLACE_SET_KEY)
        if prefix in instance_id
    }


def clear_replace_requests(redis_client, *instance_ids):
    """Mark replace requests as done."""
    if instance_ids:
        redis_client.srem(REPLACE_SET_KEY, *instance_ids)


# ------------------------------------------------------------------ #
#  Draining                                                          #
# ------------------------------------------------------------------ #


def set_draining(redis_client):
    """Hold every agent at zero replicas while the controller tears the fleet down."""
    redis_client.set(DRAINING_KEY, 1)
    redis_client.expire(DRAINING_KEY, DRAINING_TTL_SECONDS)


def clear_draining(redis_client):
    """Stop holding agents at zero, letting desired state drive the loop again."""
    redis_client.delete(DRAINING_KEY)


def is_draining(redis_client):
    return redis_client.get(DRAINING_KEY) is not None
