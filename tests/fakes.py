import fnmatch


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
        self.counters = {}
        self.client = self

    def set(self, key, value):
        self.strings[key] = str(value)

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

    def expire(self, key, seconds):
        if not self._key_exists(key):
            return False
        self.ttls[key] = seconds
        return True

    def incr(self, key):
        return self.incrby(key)

    def incrby(self, key, amount=1):
        new_value = int(self.strings.get(key, 0)) + int(amount)
        self.strings[key] = str(new_value)
        self.counters[key] = new_value
        return new_value

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
