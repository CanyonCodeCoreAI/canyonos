# The scaling sample schema in Redis: plain functions over a RedisClient.

import json
import time

WINDOW_LENGTH = 4


# ------------------------------------------------------------------ #
#  Keys                                                              #
# ------------------------------------------------------------------ #


def instance_key(instance_id):
    return f"{instance_id}:samples"


def agent_key(agent_name):
    return f"agent:{agent_name}:samples"


# ------------------------------------------------------------------ #
#  Samples                                                           #
# ------------------------------------------------------------------ #


def instance_sample(
    agent_name,
    queue_length,
    requests_served,
    full_failures,
    requests_completed,
    queue_time_ms_total,
    execution_ms_total,
    requests_per_minute,
    failures_per_minute,
    avg_queue_time_ms,
    avg_execution_ms,
    observed_at,
):
    """One container's load at a point in time; the counters are running totals."""
    return {
        "agent_name": agent_name,
        "queue_length": queue_length,
        "requests_served": requests_served,
        "full_failures": full_failures,
        "requests_completed": requests_completed,
        "queue_time_ms_total": queue_time_ms_total,
        "execution_ms_total": execution_ms_total,
        "requests_per_minute": requests_per_minute,
        "failures_per_minute": failures_per_minute,
        "avg_queue_time_ms": avg_queue_time_ms,
        "avg_execution_ms": avg_execution_ms,
        "observed_at": observed_at,
    }


def agent_sample(
    replicas_running,
    replicas_expected,
    queue_length_total,
    requests_per_minute_total,
    requests_per_minute_per_replica,
    failures_per_minute,
    avg_queue_time_ms,
    avg_execution_ms,
    observed_at,
):
    """One agent's load at a point in time; the only sample a scaling policy reads."""
    # Queue time rising means more replicas would help; execution time rising alone means they would not.
    return {
        "replicas_running": replicas_running,
        "replicas_expected": replicas_expected,
        "queue_length_total": queue_length_total,
        "requests_per_minute_total": requests_per_minute_total,
        "requests_per_minute_per_replica": requests_per_minute_per_replica,
        "failures_per_minute": failures_per_minute,
        "avg_queue_time_ms": avg_queue_time_ms,
        "avg_execution_ms": avg_execution_ms,
        "observed_at": observed_at,
    }


def now():
    return time.time()


# ------------------------------------------------------------------ #
#  Read and write                                                    #
# ------------------------------------------------------------------ #


def push(redis_client, key, sample, length=WINDOW_LENGTH):
    """Record one sample, keeping only the newest `length` of them."""
    redis_client.push_capped(key, json.dumps(sample), length)


def read(redis_client, key, count=-1):
    """Every recorded sample for a key, newest first."""
    return [json.loads(raw) for raw in redis_client.lrange(key, 0, count)]


def latest(redis_client, key):
    """The most recent sample for a key, or None if nothing has been recorded."""
    samples = read(redis_client, key, count=0)
    return samples[0] if samples else None


def average(samples, field):
    """The mean of one field across samples, ignoring those missing it."""
    values = [s[field] for s in samples if isinstance(s.get(field), (int, float))]
    if not values:
        return None
    return sum(values) / len(values)


def per_minute(previous, field, current, observed_at):
    """How fast a running total grew per minute since the previous sample; 0 without one or after a restart."""
    if not previous:
        return 0.0
    elapsed = observed_at - previous["observed_at"]
    grown = current - previous.get(field, 0)
    if elapsed <= 0 or grown < 0:
        return 0.0
    return grown * 60 / elapsed


def mean_since(previous, counters, total_field, count_field):
    """Average of a running total per counted item since the previous sample; None if nothing was counted."""
    if not previous:
        return None
    counted = counters[count_field] - previous.get(count_field, 0)
    spent = counters[total_field] - previous.get(total_field, 0)
    if counted <= 0 or spent < 0:
        return None
    return spent / counted
