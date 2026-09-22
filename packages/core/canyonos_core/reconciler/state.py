# Reconciler State
# The durable reconciliation schema in Redis, and the fire-and-forget API that
# writes to it. Plain functions over a RedisClient so any process can call them.

import logging

logger = logging.getLogger(__name__)

WAKE_QUEUE_KEY = "reconciler:wake"
REAP_SET_KEY = "reconciler:reap"
DRAINING_KEY = "reconciler:draining"
WAKE_ALL = "*"

# Expires so a hard-killed controller's orphaned reconciler resumes refilling rather
# than holding the fleet at zero forever.
DRAINING_TTL_SECONDS = 60

# One drain must not spin forever on a queue being written to concurrently.
_DRAIN_LIMIT = 1000


def desired_key(agent_name):
    return f"agent:{agent_name}:desired_replicas"


# ---------------------------------------------------------------------- #
#  Desired state                                                         #
# ---------------------------------------------------------------------- #


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


def seed_desired(redis_client, agent_specs):
    """Record each agent's configured replica count, leaving any existing value alone.

    Redis is authoritative once written, so a runtime scale survives a controller restart.
    """
    for spec in agent_specs:
        name = spec["name"]
        replicas = replica_count(spec)
        if replicas is None:
            logger.warning(
                "Agent %s declares a non-integer replicas value (%r); "
                "reconciliation needs a count, skipping it.",
                name,
                spec.get("replicas"),
            )
            continue
        if redis_client.get(desired_key(name)) is None:
            set_desired(redis_client, name, replicas)


def scale(redis_client, agent_name, delta):
    """Move an agent's desired replica count by delta. Returns the new count."""
    new_count = redis_client.incrby(desired_key(agent_name), int(delta))
    if new_count < 0:
        return set_desired(redis_client, agent_name, 0)
    return new_count


def desired_agent_specs(redis_client, agent_specs):
    """The full agent spec list with each spec's replicas replaced by its desired count.

    Always the whole list: ensure_instances drops every service missing from what it is handed.
    """
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


# ---------------------------------------------------------------------- #
#  Teardown                                                              #
# ---------------------------------------------------------------------- #


def set_draining(redis_client):
    """Hold every agent at zero replicas while the controller tears the fleet down."""
    redis_client.set(DRAINING_KEY, 1)
    redis_client.expire(DRAINING_KEY, DRAINING_TTL_SECONDS)


def clear_draining(redis_client):
    """Stop holding agents at zero, letting desired state drive the loop again."""
    redis_client.delete(DRAINING_KEY)


def is_draining(redis_client):
    return redis_client.get(DRAINING_KEY) is not None


# ---------------------------------------------------------------------- #
#  Wake queue                                                            #
# ---------------------------------------------------------------------- #


def request_reconcile(redis_client, agent_name=WAKE_ALL):
    """Ask the reconciler to converge an agent (or everything) as soon as it can."""
    redis_client.lpush(WAKE_QUEUE_KEY, agent_name)


def drain(redis_client, timeout=1):
    """
    Wait for wake signals and collect every one currently queued.

    Blocks up to timeout seconds for the first signal, then takes the rest without
    blocking, so a burst of identical signals collapses into a single pass.
    """
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


# ---------------------------------------------------------------------- #
#  Targeted replacement                                                  #
# ---------------------------------------------------------------------- #


def request_replace(redis_client, instance_id):
    """Mark one instance to be destroyed; the loop refills its slot afterwards."""
    redis_client.sadd(REAP_SET_KEY, instance_id)


def take_reap_requests(redis_client, agent_name):
    """Claim the pending reap requests belonging to an agent.

    Ids are removed up front, so a crash mid-pass loses the request rather than replaying it forever.
    """
    prefix = f":{agent_name}:"
    claimed = {
        instance_id
        for instance_id in redis_client.smembers(REAP_SET_KEY)
        if prefix in instance_id
    }
    if claimed:
        redis_client.srem(REAP_SET_KEY, *claimed)
    return claimed
