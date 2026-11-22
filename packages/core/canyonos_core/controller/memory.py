"""Agent memory that outlives a request: JSON values grouped by namespace, kept in the
Redis of the machine the agent runs on. Agent code imports it as `from memory import
Store`."""

import json
import os

try:
    from canyonos_core.controller.utils.redis_client import RedisClient
except ImportError:
    from redis_client import RedisClient

KEY_PREFIX = "memory"


class Store(object):
    """Read and write an agent's memories. Each namespace, such as ("users", "u1"), is
    one Redis hash under `memory:`, so request cleanup never touches it."""

    def __init__(self, client=None):
        """Use the given Redis client, or connect to the Redis this container's Local
        Controller uses, so every agent on the machine shares one memory."""
        if client is None:
            client = RedisClient(
                host=os.environ.get("CANYONOS_REDIS_HOST", "localhost"),
                port=int(os.environ.get("CANYONOS_REDIS_PORT", 6379)),
            )
        self.client = client

    def put(self, namespace, key, value):
        """Save a dict under key in the namespace, replacing any value already there."""
        if not isinstance(value, dict):
            raise TypeError(f"Memory values must be dicts, got {type(value).__name__}")
        self.client.hset(_redis_key(namespace), _field(key), json.dumps(value))

    def get(self, namespace, key):
        """Return the dict saved under key in the namespace, or None if there is none."""
        raw = self.client.hget(_redis_key(namespace), _field(key))
        return json.loads(raw) if raw is not None else None

    def search(self, namespace, limit=None):
        """Return every memory in the namespace as {"key", "value"} dicts sorted by key,
        for an agent that knows whose memories it needs but not their keys."""
        items = sorted(self.client.hgetall(_redis_key(namespace)).items())
        return [{"key": k, "value": json.loads(v)} for k, v in items[:limit]]

    def delete(self, namespace, key):
        """Remove key from the namespace. Removing a key that isn't there does nothing."""
        self.client.hdel(_redis_key(namespace), _field(key))


def _redis_key(namespace):
    """Turn a namespace tuple into its Redis key. Labels must be non-empty strings
    without ':', so two different namespaces never map to the same key."""
    if not isinstance(namespace, tuple) or not namespace:
        raise ValueError(f"Namespace must be a non-empty tuple, got {namespace!r}")
    for label in namespace:
        if not isinstance(label, str) or not label or ":" in label:
            raise ValueError(
                f"Namespace labels must be non-empty strings without ':', got {label!r}"
            )
    return ":".join((KEY_PREFIX, *namespace))


def _field(key):
    """Check that a memory key is a non-empty string. Redis would store 1 and "1" as
    the same field, and a bytes key that isn't UTF-8 would break every search."""
    if not isinstance(key, str) or not key:
        raise ValueError(f"Memory keys must be non-empty strings, got {key!r}")
    return key
