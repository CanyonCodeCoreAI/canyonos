# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import contextlib
import fnmatch
import os
import shutil
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import grpc
from botocore.exceptions import ClientError

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from canyonos_core.reconciler import providers


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

    def push_capped(self, key, value, max_length):
        self.lpush(key, value)
        del self.lists[key][max_length:]

    def lrange(self, key, start=0, end=-1):
        values = self.lists.get(key, [])
        return values[start:] if end == -1 else values[start : end + 1]

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


def _replica(agent_name, replica_index, created_at=None, host_port=None):
    """An agent_instance:* record as the Provisioner writes it."""
    host_port = str(host_port or 8000 + replica_index)
    return {
        "agent_name": agent_name,
        "provider": "local",
        "container_name": f"canyonos-{agent_name.lower()}-{replica_index}",
        "container_port": "50051",
        "replica_index": str(replica_index),
        "private_host": "localhost",
        "public_host": "localhost",
        "host_port": host_port,
        "published_address": f"localhost:{host_port}",
        "address": f"canyonos-{agent_name.lower()}-{replica_index}:50051",
        "created_at": str(created_at if created_at is not None else time.time()),
    }


class _FakeProvisioner:
    """Records what the reconciler asked for without touching Docker."""

    def __init__(self, replicas=None, raise_for=None, remove_raises=False):
        self.replicas = replicas or {}
        self.raise_for = raise_for
        self.remove_raises = remove_raises
        self.removed = []
        self.ensure_calls = []
        self.ensure_only = []
        self.unfinished_removals = 0

    def remove_replica(self, replica_id):
        if self.remove_raises:
            raise RuntimeError("terminate failed")
        self.removed.append(replica_id)

    def ensure_replicas(self, agent_specs, only=None):
        self.ensure_calls.append(agent_specs)
        self.ensure_only.append(only)
        return []

    def remove_unfinished(self):
        self.unfinished_removals += 1


def _seed_replica_records(redis, provisioner):
    """Write the fake provisioner's replicas into Redis, where the reconciler reads them."""
    for agent_name, records in getattr(provisioner, "replicas", {}).items():
        for record in records:
            replica_id = f"{agent_name}-{record['replica_index']}"
            redis.hset_multiple(f"agent_instance:{replica_id}", record)
            redis.sadd(f"agent:{agent_name}:instances", replica_id)
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

    _seed_replica_records(context.redis, provisioner)
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


def _fake_controller():
    """Return a fake controller, bound to the providers, whose `_run_cmd` pretends to be
    Docker: `docker run` adds the container to `running`, `docker rm -f` removes it,
    and `docker inspect` reports it running while it is there."""
    redis = _FakeRedis()
    running = set()

    def fake_run_cmd(cmd, host, user=None):
        if cmd[:2] == ["docker", "inspect"]:
            return SimpleNamespace(
                returncode=0 if cmd[-1] in running else 1,
                stdout="true\n" if cmd[-1] in running else "",
                stderr="" if cmd[-1] in running else f"No such object: {cmd[-1]}",
            )
        if cmd[:2] == ["docker", "run"]:
            running.add(cmd[cmd.index("--name") + 1])
        elif cmd[:3] == ["docker", "rm", "-f"]:
            if cmd[-1] not in running:
                return SimpleNamespace(
                    returncode=1,
                    stdout="",
                    stderr=f"Error response from daemon: No such container: {cmd[-1]}",
                )
            running.discard(cmd[-1])
        return SimpleNamespace(returncode=0, stdout="")

    controller = SimpleNamespace(
        redis=redis,
        machine_redis={},
        redis_containers={},
        redis_ports={},
        running=running,
        config={"poll_interval": 5},
        _run_cmd=MagicMock(side_effect=fake_run_cmd),
        remove_unused_redis_clients=MagicMock(),
    )
    controller.machine_redis_for_replica = lambda replica: controller.machine_redis.get(
        replica["private_host"], redis
    )
    providers.bind(controller)
    return controller


class _FakeWaiter:
    def __init__(self):
        self.calls = []

    def wait(self, InstanceIds):
        self.calls.append(list(InstanceIds))


class _FakeEC2Client:
    """Stands in for boto3's EC2 client: machines it launches stay listed after they
    are terminated, until a test deletes them from `machines`."""

    def __init__(self, public_ip="54.10.20.30", private_ip="10.0.0.30"):
        self.public_ip = public_ip
        self.private_ip = private_ip
        self.machines = {}
        self.client_calls = []
        self.run_requests = []
        self.terminate_requests = []
        self.import_key_pair_requests = []
        self.waiter = _FakeWaiter()

    def client(self, service_name, region_name=None):
        self.client_calls.append(
            {"service_name": service_name, "region_name": region_name}
        )
        assert service_name == "ec2"
        return self

    def import_key_pair(self, **kwargs):
        self.import_key_pair_requests.append(kwargs)
        return {}

    def run_instances(self, **kwargs):
        self.run_requests.append(kwargs)
        machine_id = f"i-test{len(self.run_requests)}"
        self.machines[machine_id] = {
            "InstanceId": machine_id,
            "ClientToken": kwargs["ClientToken"],
            "State": {"Name": "running"},
            "PrivateIpAddress": self.private_ip,
            "PublicIpAddress": self.public_ip,
        }
        return {"Instances": [{"InstanceId": machine_id}]}

    def get_waiter(self, name):
        assert name == "instance_running"
        return self.waiter

    def describe_instances(self, InstanceIds=(), Filters=()):
        tokens = {value for f in Filters for value in f["Values"]}
        return {
            "Reservations": [
                {"Instances": [machine]}
                for machine_id, machine in self.machines.items()
                if machine_id in InstanceIds or machine["ClientToken"] in tokens
            ]
        }

    def terminate_instances(self, InstanceIds):
        self.terminate_requests.append(list(InstanceIds))
        for machine_id in InstanceIds:
            if machine_id not in self.machines:
                raise ClientError(
                    {
                        "Error": {
                            "Code": "InvalidInstanceID.NotFound",
                            "Message": f"The instance ID '{machine_id}' does not exist",
                        }
                    },
                    "TerminateInstances",
                )
            self.machines[machine_id]["State"] = {"Name": "terminated"}
        return {}


def _bind_fake_ec2(testcase):
    """Bind an EC2 controller, with a fresh SSH key, to the providers and point boto3 at
    a fake EC2 client. Returns the controller and the client; the key and the boto3
    patch are removed when the test ends."""
    key_dir = tempfile.mkdtemp()
    testcase.addCleanup(shutil.rmtree, key_dir)
    key_path = os.path.join(key_dir, "id_ed25519")
    subprocess.run(
        ["ssh-keygen", "-t", "ed25519", "-N", "", "-f", key_path, "-q"], check=True
    )
    fake_client = _FakeEC2Client()
    controller = SimpleNamespace(
        config={
            "redis": {"host": "redis.internal", "port": 6379},
            "ec2": {
                "ami_id": "ami-123456",
                "subnet_id": "subnet-123456",
                "security_group_ids": ["sg-123456"],
                "region": "us-east-1",
                "ssh_user": "ubuntu",
            },
            "ssh_private_key_path": key_path,
        },
        registry_url=None,
        _run_cmd=MagicMock(
            return_value=SimpleNamespace(returncode=0, stderr="", stdout="")
        ),
        _ssh_args=lambda host, user=None: ["ssh", f"{user}@{host}"],
    )
    providers.bind(controller)
    providers.get("EC2")._imported_key_pairs.clear()
    client_patch = patch("boto3.client", side_effect=fake_client.client)
    client_patch.start()
    testcase.addCleanup(client_patch.stop)
    return controller, fake_client


class _RpcError(grpc.RpcError, grpc.Call):
    """A failed gRPC call with the given status code."""

    def __init__(self, code, details=""):
        self._code = code
        self._details = details

    def code(self):
        return self._code

    def details(self):
        return self._details

    def __str__(self):
        return self._details

    initial_metadata = trailing_metadata = is_active = time_remaining = None
    cancel = add_callback = None


class _ForwardedCall:
    """What `stub.Execute.future` returns: done at once, failed with `error` if given."""

    def __init__(self, error=None):
        self.error = error

    def exception(self):
        return self.error

    def add_done_callback(self, callback):
        callback(self)
