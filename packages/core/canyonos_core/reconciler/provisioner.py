# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Create and remove agent replicas; the controller imports nothing from here."""

import logging
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

from canyonos_core.controller.controller_context import (
    replica_id as _replica_id,
    replica_key as _replica_key,
    list_replicas,
)
from canyonos_core.controller.utils.container_names import (
    CONTAINER_PORT,
    ForeignContainerError,
    container_name,
)
from canyonos_core.reconciler import providers, replicas
from canyonos_core.reconciler.routing import publish_routing_snapshot

PORT_CLAIM_LOCK_SECONDS = 10
# How long a draining replica may keep running before it is removed anyway.
DRAIN_TIMEOUT_SECONDS = 180
logger = logging.getLogger(__name__)


class Provisioner(object):
    """Makes the running replicas match the specs it is handed."""

    def __init__(self, controller):
        self.controller = controller
        self._agent_specs = None

    @property
    def redis(self):
        """The Global Controller's Redis client."""
        return self.controller.redis

    def ensure_replicas(self, agent_specs, only=None):
        """Start missing replicas of the agents in only (all when None) and republish routing for every agent."""
        self._agent_specs = agent_specs
        records = []
        existing = []
        jobs = []

        for agent_spec in self._agent_specs:
            agent_name = agent_spec["name"]
            if only is not None and agent_name not in only:
                continue
            provider_name = agent_spec["provider"]
            provider = providers.get(provider_name)
            # The agent's provider keys describe the machine each of its replicas gets.
            machine_spec = {
                key: agent_spec[key]
                for key in providers.SCHEMAS[provider_name].AGENT_KEYS
                if key in agent_spec
            }

            for replica_index in range(int(agent_spec.get("replicas", 1))):
                replica_id = _replica_id(agent_name, replica_index)
                key = _replica_key(agent_name, replica_index)
                replica = self.redis.hgetall(key)

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
                        replicas.remove(self.controller, replica)
                    except Exception as e:
                        # A machine that cannot be reached holds its slot until stop, not every launch.
                        logger.warning("Could not remove %s: %s", replica_id, e)
                        continue
                    self._delete_replica_record(replica_id, replica)

                launch_id = uuid.uuid4().hex
                # Saved before the machine starts, so stop can terminate it whatever happens next.
                self.redis.hset_multiple(
                    f"machine_record:{launch_id}",
                    {
                        "provider": provider_name,
                        "launch_id": launch_id,
                        "launched_at": str(time.time()),
                    },
                )
                self.redis.hset_multiple(
                    key,
                    {
                        "agent_name": agent_name,
                        "provider": provider_name,
                        "replica_index": str(replica_index),
                        "launch_id": launch_id,
                    },
                )
                jobs.append(
                    {
                        "agent_name": agent_name,
                        "agent_spec": agent_spec,
                        "provider": provider,
                        "machine_spec": machine_spec,
                        "replica_index": replica_index,
                        "replica_id": replica_id,
                        "launch_id": launch_id,
                    }
                )

        max_workers = min(len(jobs), (os.cpu_count() or 1) * 100)
        provisioned = []
        failures = []
        if jobs:
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                future_to_job = {
                    executor.submit(self._provision_one, job): job for job in jobs
                }
                for future in as_completed(future_to_job):
                    job = future_to_job[future]
                    try:
                        replica = future.result()
                    except Exception as e:
                        logger.warning(
                            "Failed to provision %s: %r", job["replica_id"], e
                        )
                        failures.append(e)
                        continue
                    provisioned.append((job["agent_name"], job["replica_id"], replica))

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

    def _provision_one(self, job):
        """Start one replica's machine and container, then save its record. A failed launch
        leaves its record unfinished, for remove_unfinished to remove, and its machine
        running until stop."""
        provider = job["provider"]
        machine_spec = job["machine_spec"]
        replica_index = job["replica_index"]
        key = f"agent_instance:{job['replica_id']}"
        machine_key = f"machine_record:{job['launch_id']}"

        # Priced first, so a failed price lookup never takes down a replica that started.
        hourly_cost = provider.hourly_cost(machine_spec)
        machine = provider.start_machine(machine_spec, job["launch_id"])
        self.redis.hset_multiple(
            machine_key,
            {field: str(value) for field, value in machine.items() if value},
        )
        machine.update(provider.wait_for_machine(machine))
        self.redis.hset_multiple(
            machine_key,
            {field: str(value) for field, value in machine.items() if value},
        )
        host_port = self._claim_host_port(machine["private_host"], key)
        # Saved before the container exists, so a failed launch can still remove it.
        saved = {
            "container_name": container_name(job["agent_name"], replica_index),
            "user": machine.get("user"),
        }
        self.redis.hset_multiple(
            key, {field: value for field, value in saved.items() if value}
        )

        try:
            replica = replicas.launch(
                self.controller,
                machine,
                job["agent_spec"],
                replica_index,
                host_port,
                job["replica_id"],
            )
        except ForeignContainerError:
            # The container under this name is another project's: left in the
            # record, remove_unfinished would remove theirs as ours.
            self._delete_replica_record(
                job["replica_id"], {"agent_name": job["agent_name"]}
            )
            raise
        self._write_replica(replica, hourly_cost)
        return replica

    def _write_replica(self, replica, hourly_cost):
        """Save a new replica's record to Redis, plus the keys that route requests to it
        and price its compute."""
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

        machine_redis = self.controller.machine_redis_for_replica(replica)
        machine_redis.set(f"controller:{replica['address']}:replica_id", replica_id)
        machine_redis.set(f"agent:{replica_id}:hourly_cost", hourly_cost)
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
        if drain and not self._drained(key, replica):
            return False

        self._delete_controller_status(replica)
        replicas.remove(self.controller, replica)
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

    def _drained(self, key, replica):
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
                replicas.remove(self.controller, record)
            except Exception as e:
                logger.warning("Could not remove the unfinished launch %s: %s", key, e)
                continue
            self.redis.delete(key)

    def terminate_machines(self):
        """At stop, once no replica record is left, terminate every machine this
        deployment started and delete its record. A machine whose termination fails keeps
        its record for the next call."""
        if self.redis.scan_keys("agent_instance:*"):
            return
        for key in self.redis.scan_keys("machine_record:*"):
            machine = self.redis.hgetall(key)
            try:
                providers.get(machine["provider"]).terminate_machine(machine)
            except Exception as e:
                logger.warning("Could not terminate machine %s: %s", key, e)
                continue
            self.redis.delete(key)

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
