import contextlib
import fnmatch
import os
import sys
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


class _FakeRedis:
    """In-memory subset of RedisClient shared by the test suite."""

    def __init__(self, *, strings=None, sets=None, hashes=None):
        # Callers may hold a reference to what they passed, so keep it, don't copy.
        self.strings = strings if strings is not None else {}
        self.store = self.strings
        self.sets = sets if sets is not None else {}
        self.hashes = hashes if hashes is not None else {}
        self.lists = {}
        self.ttls = {}
        self.client = self

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.strings:
            return None
        self.strings[key] = str(value)
        if ex is not None:
            self.ttls[key] = ex
        return True

    def setnx(self, key, value):
        if key in self.strings:
            return False
        self.strings[key] = value
        return True

    def get(self, key):
        if key in self.strings:
            return self.strings[key]
        return self.hashes.get(key)

    def delete(self, *keys):
        for key in keys:
            self.strings.pop(key, None)
            self.hashes.pop(key, None)
            self.sets.pop(key, None)
            self.lists.pop(key, None)
            self.ttls.pop(key, None)

    def lock(self, name, timeout):
        return contextlib.nullcontext()

    def expire(self, key, seconds, nx=False):
        if not self._key_exists(key) or (nx and key in self.ttls):
            return False
        self.ttls[key] = seconds
        return True

    def lpush(self, key, *values):
        self.lists.setdefault(key, [])[:0] = [str(value) for value in values]

    def rpop(self, key):
        values = self.lists.get(key)
        if not values:
            return None
        return values.pop()

    def brpop(self, key, timeout=0):
        """Return the tail immediately; timeout is intentionally ignored."""
        return self.rpop(key)

    def hset(self, name, field, value):
        self.hashes.setdefault(name, {})[field] = value

    def hset_multiple(self, name, mapping):
        self.hashes.setdefault(name, {}).update(mapping)

    def set_with_hash(self, key, value, name, mapping):
        self.set(key, value)
        self.hset_multiple(name, mapping)

    def hget(self, name, field):
        return self.hashes.get(name, {}).get(field)

    def hgetall(self, name):
        return dict(self.hashes.get(name, {}))

    def hincrby(self, name, field, amount=1):
        bucket = self.hashes.setdefault(name, {})
        bucket[field] = int(bucket.get(field, 0)) + amount
        return bucket[field]

    def hdel(self, name, *fields):
        bucket = self.hashes.setdefault(name, {})
        for field in fields:
            bucket.pop(field, None)

    def sadd(self, name, *values):
        self.sets.setdefault(name, set()).update(values)

    def srem(self, name, *values):
        self.sets.get(name, set()).difference_update(values)

    def smembers(self, name):
        return set(self.sets.get(name, set()))

    def scan_keys(self, pattern):
        keys = set(self.strings) | set(self.hashes) | set(self.sets) | set(self.lists)
        return [key for key in sorted(keys) if fnmatch.fnmatch(key, pattern)]

    def _key_exists(self, key):
        return any(
            key in collection
            for collection in (self.strings, self.hashes, self.sets, self.lists)
        )


def _instance(agent_name, replica_index, created_at=None, host_port=None):
    """An agent_instance:* record as the Provisioner writes it."""
    return {
        "agent_name": agent_name,
        "provider": "local",
        "runtime_id": f"canyonos-{agent_name.lower()}-{replica_index}",
        "container_port": "50051",
        "replica_index": str(replica_index),
        "host": "localhost",
        "host_port": str(host_port or 8000 + replica_index),
        "created_at": str(created_at if created_at is not None else time.time()),
    }


class _FakeProvisioner:
    """Records what the reconciler asked for without touching Docker."""

    def __init__(self, instances=None, raise_for=None, remove_raises=False):
        self.instances = instances or {}
        self.raise_for = raise_for
        self.remove_raises = remove_raises
        self.removed = []
        self.ensure_calls = []

    def remove_instance(self, instance_id):
        if self.remove_raises:
            raise RuntimeError("terminate failed")
        self.removed.append(instance_id)

    def ensure_instances(self, agent_specs):
        self.ensure_calls.append(agent_specs)
        return []


def _seed_instance_records(redis, provisioner):
    """Write the fake provisioner's instances into Redis, where the reconciler reads them."""
    for agent_name, records in getattr(provisioner, "instances", {}).items():
        for record in records:
            instance_id = f"{record['provider']}:{agent_name}:{record['replica_index']}"
            redis.hset_multiple(f"agent_instance:{instance_id}", record)
            redis.sadd(f"agent:{agent_name}:instances", instance_id)
    raise_for = getattr(provisioner, "raise_for", None)
    if raise_for:
        smembers = redis.smembers

        def failing_smembers(name):
            if name == f"agent:{raise_for}:instances":
                raise RuntimeError("boom")
            return smembers(name)

        redis.smembers = failing_smembers


def _bare_reconciler(context, provisioner, **overrides):
    """Build a Reconciler without running its __init__ (no config, no Docker, no Redis)."""
    from canyonos_core.reconciler.reconciler import Reconciler

    _seed_instance_records(context.redis, provisioner)
    reconciler = Reconciler.__new__(Reconciler)
    reconciler.context = context
    reconciler.provisioner = provisioner
    reconciler.sweep_interval = 5
    reconciler.stale_after = 15
    reconciler.startup_grace = 30
    reconciler._seen_healthy = set()
    for key, value in overrides.items():
        setattr(reconciler, key, value)
    return reconciler
