# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Launch, drain and remove agent replicas on the machines the machine provisioner keeps
up. Touches only replica records, routing and containers; the controller imports nothing
from here."""

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from functools import partial

from canyonos_core.controller.controller_context import (
    _is_local_host,
    replica_id as _replica_id,
    replica_key as _replica_key,
    list_replicas,
)
from canyonos_core.controller.utils.container_names import (
    CONTAINER_PORT,
    ForeignContainerError,
    container_name,
    image_name,
)
from canyonos_core.reconciler import placement, replicas
from canyonos_core.reconciler.parallel import run_in_parallel
from canyonos_core.reconciler.providers.shared_utils.image_transfer import (
    transfer_image,
)
from canyonos_core.reconciler.providers.shared_utils.resource_limits import (
    DEFAULT_CPU,
    DEFAULT_MEMORY_MB,
)
from canyonos_core.reconciler.routing import publish_routing_snapshot

PORT_CLAIM_LOCK_SECONDS = 10
# How long a draining replica may keep running before it is removed anyway.
DRAIN_TIMEOUT_SECONDS = 180
logger = logging.getLogger(__name__)


class ReplicaProvisioner(object):
    """Makes the running replicas match the specs it is handed."""

    def __init__(self, controller):
        self.controller = controller
        self._agent_specs = None

    @property
    def redis(self):
        """The Global Controller's Redis client."""
        return self.controller.redis

    def ensure_replicas(self, agent_specs, machines, only=None):
        """Start missing replicas of the agents in only (all when None) on the least loaded
        of these machines, and republish routing for every agent. A replica placed on a
        machine still starting waits for it, and launches on a pass once it is up."""
        self._agent_specs = agent_specs
        records = []
        existing = []
        wanted = []

        for agent_spec in self._agent_specs:
            agent_name = agent_spec["name"]
            if only is not None and agent_name not in only:
                continue
            for replica_index in range(int(agent_spec.get("replicas", 1))):
                replica_id = _replica_id(agent_name, replica_index)
                replica = self.redis.hgetall(_replica_key(agent_name, replica_index))

                if replica:
                    # An unfinished launch whose removal failed; remove_unfinished retries it.
                    if not replica.get("address"):
                        continue
                    if replicas.is_running(self.controller, replica):
                        existing.append((agent_name, replica_id, replica))
                        continue
                    logger.warning(
                        "Replacing %s: its container %s is not running",
                        replica_id,
                        replica["container_name"],
                    )
                    try:
                        replicas.remove_container(self.controller, replica)
                    except Exception as e:
                        # A machine that cannot be reached holds its slot until stop, not every launch.
                        logger.warning("Could not remove %s: %s", replica_id, e)
                        continue
                    self._delete_replica_record(replica_id, replica)
                wanted.append((agent_spec, replica_index))

        # How much of each machine its replicas already take, from their records.
        used = {}
        for key in self.redis.scan_keys("agent_instance:*"):
            record = self.redis.hgetall(key)
            if record.get("machine"):
                cpu, memory = used.get(record["machine"], (0.0, 0))
                used[record["machine"]] = (
                    cpu + float(record["cpu"]),
                    memory + int(record["memory"]),
                )
        for machine in machines:
            cpu, memory = used.get(machine["launch_id"], (0.0, 0))
            machine["used"] = {"cpu": cpu, "memory": memory}
            machine["replicas"] = []

        for agent_spec, replica_index in wanted:
            resources = agent_spec.get("resources") or {}
            new_replica = {
                "agent_spec": agent_spec,
                "replica_index": replica_index,
                "replica_id": _replica_id(agent_spec["name"], replica_index),
                "cpu": float(resources.get("cpu") or DEFAULT_CPU),
                "memory": int(resources.get("memory") or DEFAULT_MEMORY_MB),
            }
            machine = placement.place(machines, agent_spec["provider"], new_replica)
            if machine is None:
                logger.warning("No machine for %s", new_replica["replica_id"])
                continue
            # Its place still counts, so the rest spread over the whole pool as it boots.
            if not machine["up"]:
                continue
            self.redis.hset_multiple(
                _replica_key(agent_spec["name"], replica_index),
                {
                    "agent_name": agent_spec["name"],
                    "provider": agent_spec["provider"],
                    "replica_index": str(replica_index),
                    "machine": machine["launch_id"],
                    "cpu": str(new_replica["cpu"]),
                    "memory": str(new_replica["memory"]),
                },
            )

        provisioned = []
        failures = []
        # Each image goes to each machine once; the replicas that need it wait for it.
        sent = {}
        launches = {}
        with ThreadPoolExecutor() as sender:
            for machine in machines:
                if not machine["up"]:
                    continue
                host = machine["record"]["private_host"]
                for new_replica in machine["replicas"]:
                    image = image_name(new_replica["agent_spec"]["name"])
                    if (host, image) not in sent and not _is_local_host(host):
                        sent[host, image] = sender.submit(
                            transfer_image,
                            self.controller,
                            image,
                            host,
                            machine["record"].get("user"),
                        )
                    # A replica pays for its CPU share of the machine.
                    share = (
                        new_replica["cpu"] / machine["capacity"]["cpu"]
                        if machine["capacity"]
                        else 1
                    )
                    launches[new_replica["replica_id"]] = partial(
                        self._launch_replica,
                        machine["record"],
                        new_replica,
                        machine["hourly_cost"] * share,
                        sent.get((host, image)),
                    )
            for replica_id, replica, error in run_in_parallel(launches):
                if error:
                    logger.warning("Failed to provision %s: %r", replica_id, error)
                    failures.append(error)
                    continue
                provisioned.append((replica["agent_name"], replica_id, replica))

        for agent_name, replica_id, replica in existing + provisioned:
            self._add_replica_to_agent(agent_name, replica_id)
            records.append(replica)

        self.controller.remove_unused_redis_clients(list_replicas(self.redis))
        publish_routing_snapshot(
            self._agent_specs, self.redis, self.controller.machine_redis
        )
        if failures:
            # All launches have ended, so this removes failed ones, not ones in progress.
            try:
                self.remove_unfinished()
            except Exception as e:
                logger.warning("Failed to remove unfinished launches: %s", e)
            raise failures[0]
        return records

    def _launch_replica(self, machine, new_replica, hourly_cost, image_sent):
        """Launch one replica's container on its machine, once the image being sent there
        has arrived, and save its record. A failed launch leaves its record unfinished, for
        remove_unfinished to remove."""
        if image_sent:
            image_sent.result()
        agent_name = new_replica["agent_spec"]["name"]
        replica_index = new_replica["replica_index"]
        key = _replica_key(agent_name, replica_index)
        host_port = self._claim_host_port(machine["private_host"], key)
        # Saved before the container exists, so a failed launch can still remove it.
        saved = {
            "container_name": container_name(agent_name, replica_index),
            "user": machine.get("user"),
        }
        self.redis.hset_multiple(
            key, {field: value for field, value in saved.items() if value}
        )

        try:
            replica = replicas.launch(
                self.controller,
                machine,
                new_replica["agent_spec"],
                replica_index,
                host_port,
                new_replica["replica_id"],
            )
        except ForeignContainerError:
            # The container under this name is another project's: left in the
            # record, remove_unfinished would remove theirs as ours.
            self._delete_replica_record(
                new_replica["replica_id"], {"agent_name": agent_name}
            )
            raise
        self._write_replica(replica, hourly_cost)
        return replica

    def _write_replica(self, replica, hourly_cost):
        """Save a new replica's record to Redis, plus the key that prices its compute."""
        replica_id = _replica_id(replica["agent_name"], replica["replica_index"])
        mapping = {
            "agent_name": replica["agent_name"],
            "provider": replica["provider"],
            "replica_index": str(replica["replica_index"]),
            "private_host": replica["private_host"],
            "public_host": replica["public_host"],
            "host_port": str(replica["host_port"]),
            "container_port": str(replica["container_port"]),
            "published_address": replica["published_address"],
            "address": replica["address"],
            "redis_host": replica["redis_host"],
            "redis_port": str(replica["redis_port"]),
            "container_name": replica["container_name"],
            # Lets the reconciler tell a starting replica from one that stopped answering.
            "created_at": str(time.time()),
        }
        if replica.get("user"):
            mapping["user"] = str(replica["user"])

        self.controller.machine_redis_for_replica(replica).set(
            f"agent:{replica_id}:hourly_cost", hourly_cost
        )
        # Last: address marks the launch finished, so a failed write above leaves it unfinished.
        self.redis.hset_multiple(f"agent_instance:{replica_id}", mapping)

    def _add_replica_to_agent(self, agent_name, replica_id):
        self.redis.sadd(f"agent:{agent_name}:instances", replica_id)

    def remove_replica(self, replica_id, drain=True):
        """Remove a replica's container, delete its record, and republish the routing
        table without it; return True once it is gone. With drain, first have it take no
        new requests and, over repeated calls, wait until it reports idle or
        DRAIN_TIMEOUT_SECONDS pass, returning False until then. Its machine is kept."""
        key = f"agent_instance:{replica_id}"
        replica = self.redis.hgetall(key)
        if not replica:
            return True
        if drain and not self._drain(key, replica):
            return False

        self._delete_controller_status(replica)
        replicas.remove_container(self.controller, replica)
        self.redis.delete(key)
        self.redis.srem(f"agent:{replica['agent_name']}:instances", replica_id)
        self.controller.remove_unused_redis_clients(list_replicas(self.redis))
        publish_routing_snapshot(
            self.controller.agent_specs
            if self._agent_specs is None
            else self._agent_specs,
            self.redis,
            self.controller.machine_redis,
        )
        return True

    def _drain(self, key, replica):
        """Mark the replica draining and tell it when it will be removed; True once it
        reports idle or DRAIN_TIMEOUT_SECONDS have passed."""
        draining_at = replica.get("draining_at")
        if draining_at is None:
            draining_at = str(time.time())
            self.redis.hset(key, "draining_at", draining_at)
        # The removal time, written every pass so a failed write is retried.
        self.controller.machine_redis_for_replica(replica).set(
            f"controller:{replica['address']}:draining",
            str(float(draining_at) + DRAIN_TIMEOUT_SECONDS),
        )
        return (
            self._is_idle(replica)
            or time.time() - float(draining_at) >= DRAIN_TIMEOUT_SECONDS
        )

    def _is_idle(self, replica):
        """Whether the replica has seen its drain flag and has nothing queued, running,
        still bound to it, or still to send on."""
        metrics = self.controller.machine_redis_for_replica(replica).hgetall(
            f"controller:{replica['address']}:metrics"
        )
        return (
            metrics.get("draining") == "1"
            and metrics.get("queue_length") == "0"
            and metrics.get("open_requests") == "0"
            and metrics.get("pending_requests") == "0"
            # Served counts calls started here, completed those finished: equal means none running.
            and metrics.get("requests_served") == metrics.get("requests_completed")
        )

    def _delete_controller_status(self, replica):
        """Drop the status key belonging to this replica.

        Hygiene: a status key should not outlive the replica record it belongs
        to. The guarantee that a stale one is never read lives at launch, where
        `replicas.launch` clears the key, fail-closed, right before `docker run`.
        Best effort here: a machine whose Redis is already gone must not stop the
        removal.
        """
        try:
            machine_redis = (
                self.controller.machine_redis.get(replica.get("private_host"))
                or self.redis
            )
            machine_redis.delete(f"controller:{replica['address']}:status")
        except Exception as e:
            logger.warning(
                "Could not clear the status of %s: %s", replica.get("container_name"), e
            )

    def _delete_replica_record(self, replica_id, replica):
        self.redis.delete(f"agent_instance:{replica_id}")
        self.redis.srem(f"agent:{replica['agent_name']}:instances", replica_id)

    def remove_unfinished(self):
        """Remove every launch that never finished: its container, if it started one, then
        its record; its machine is kept until stop. A record whose removal fails is kept for
        the next call. Call only while nothing is launching, since a launch in progress
        looks the same."""
        for key in self.redis.scan_keys("agent_instance:*"):
            record = self.redis.hgetall(key)
            if not record or record.get("address"):
                continue
            logger.info(
                "Removing %s: its launch never finished, or a version without "
                "address saved it",
                key,
            )
            try:
                replicas.remove_container(self.controller, record)
            except Exception as e:
                logger.warning("Could not remove the unfinished launch %s: %s", key, e)
                continue
            self.redis.delete(key)

    def forget_replicas_on(self, launch_ids):
        """Drop the records of every replica on these dead machines and republish routing
        without them at once, so no caller keeps sending to them. Returns the ids of the
        replicas dropped."""
        removed = []
        for key in self.redis.scan_keys("agent_instance:*"):
            replica = self.redis.hgetall(key)
            if replica.get("machine") in launch_ids:
                replica_id = key.removeprefix("agent_instance:")
                self._delete_replica_record(replica_id, replica)
                removed.append(replica_id)
        self.controller.remove_unused_redis_clients(list_replicas(self.redis))
        publish_routing_snapshot(
            self.controller.agent_specs
            if self._agent_specs is None
            else self._agent_specs,
            self.redis,
            self.controller.machine_redis,
        )
        return removed

    def _claim_host_port(self, host, key):
        """Claim the lowest free port on a machine for one replica and record the claim in Redis."""
        # Held across scan and write so two reconcilers can't claim the same port.
        with self.redis.lock(f"port_claim_lock:{host}", PORT_CLAIM_LOCK_SECONDS):
            # Raw scan: port claims from this pass must count as used too.
            records = (
                self.redis.hgetall(record_key)
                for record_key in self.redis.scan_keys("agent_instance:*")
            )
            used = {
                int(replica["host_port"])
                for replica in records
                if replica.get("private_host") == host and replica.get("host_port")
            }
            # From the container port, so a replica alone on a machine publishes the port it listens on.
            port = CONTAINER_PORT
            while port in used:
                port += 1

            self.redis.hset_multiple(
                key, {"private_host": host, "host_port": str(port)}
            )
        return port
