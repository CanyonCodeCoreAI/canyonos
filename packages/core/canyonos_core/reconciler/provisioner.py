# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Create and destroy agent runtime instances; the controller imports nothing from here."""

import logging
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

from canyonos_core.controller.controller_context import (
    instance_id as _instance_id,
    instance_key as _instance_key,
    list_instances,
)
from canyonos_core.controller.utils.container_names import ForeignContainerError
from canyonos_core.reconciler import providers
from canyonos_core.reconciler.routing import publish_routing_snapshot

DEFAULT_HOST_PORT_START = 8000
PORT_CLAIM_LOCK_SECONDS = 10
logger = logging.getLogger(__name__)


class Provisioner(object):
    """Makes the running instances match the specs it is handed."""

    def __init__(self, controller):
        self.controller = controller
        self._agent_specs = None

    @property
    def redis(self):
        """The Global Controller's Redis client."""
        return self.controller.redis

    def ensure_instances(self, agent_specs, only=None):
        """Start missing replicas of the agents in only (all when None) and republish routing for every agent."""
        self._agent_specs = agent_specs
        instances = []
        existing = []
        jobs = []

        for agent_spec in self._agent_specs:
            agent_name = agent_spec["name"]
            if only is not None and agent_name not in only:
                continue
            provider = agent_spec["provider"]
            runtime = providers.get(provider)

            for replica_index in range(int(agent_spec.get("replicas", 1))):
                instance_id = _instance_id(provider, agent_name, replica_index)
                key = _instance_key(provider, agent_name, replica_index)
                instance = self.redis.hgetall(key)

                if instance:
                    # An unfinished launch whose removal failed; remove_unfinished retries it.
                    if not instance.get("routing_endpoint"):
                        continue
                    if runtime.is_running(instance):
                        existing.append((agent_name, instance_id, instance))
                        continue
                    logger.warning(
                        "Replacing %s: its runtime %s is not running",
                        instance_id,
                        instance["runtime_id"],
                    )
                    self._destroy_runtime(instance)
                    self._discard_instance_record(instance_id, instance)

                launch_id = uuid.uuid4().hex
                self.redis.hset_multiple(
                    key,
                    {
                        "agent_name": agent_name,
                        "provider": provider,
                        "replica_index": str(replica_index),
                        "launch_id": launch_id,
                        "launched_at": str(time.time()),
                    },
                )
                claimed_port = None
                host = runtime.port_claim_host(agent_spec)
                if host:
                    claimed_port = self._claim_host_port(host, key)

                jobs.append(
                    {
                        "agent_name": agent_name,
                        "agent_spec": agent_spec,
                        "runtime": runtime,
                        "replica_index": replica_index,
                        "instance_id": instance_id,
                        "claimed_port": claimed_port,
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
                        instance = future.result()
                    except Exception as e:
                        logger.warning(
                            "Failed to provision %s: %r", job["instance_id"], e
                        )
                        failures.append(e)
                        continue
                    provisioned.append(
                        (job["agent_name"], job["instance_id"], instance)
                    )

        for agent_name, instance_id, instance in existing + provisioned:
            self._add_instance_to_agent(agent_name, instance_id)
            instances.append(instance)

        self.controller.prune_node_redis(list_instances(self.redis))
        publish_routing_snapshot(
            self._agent_specs, self.redis, self.controller.node_redis
        )
        if failures:
            # All launches have ended, so this removes failed ones, not ones in progress.
            try:
                self.remove_unfinished()
            except Exception as e:
                logger.warning("Failed to remove unfinished launches: %s", e)
            raise failures[0]
        return instances

    def _provision_one(self, job):
        """Create and start one replica, then save its record. A failed launch leaves its
        record unfinished, for remove_unfinished to clean up."""
        runtime = job["runtime"]
        agent_spec = job["agent_spec"]
        replica_index = job["replica_index"]
        claimed_port = job["claimed_port"]

        def next_host_port(_host):
            return claimed_port

        # Priced first, so a failed price lookup never takes down a replica that started.
        hourly_cost = runtime.hourly_cost(agent_spec)
        instance = runtime.provision_instance(
            agent_spec, replica_index, next_host_port, job["launch_id"]
        )
        self.redis.hset_multiple(
            f"agent_instance:{job['instance_id']}",
            {
                field: str(instance[field])
                for field in ("runtime_id", "user")
                if instance.get(field)
            },
        )

        agent_id = f"{job['agent_name']}-{replica_index}"
        try:
            instance = runtime.bootstrap_instance(
                instance, agent_spec, replica_index, agent_id
            )
        except ForeignContainerError:
            # The container under this name is another project's: left in the
            # record, remove_unfinished would terminate theirs as ours.
            self._discard_instance_record(
                job["instance_id"], {"agent_name": job["agent_name"]}
            )
            raise
        instance["agent_id"] = agent_id
        self._write_instance(instance, hourly_cost)
        return instance

    def _write_instance(self, instance, hourly_cost):
        """Save a new replica's record to Redis, plus the keys that route requests to it
        and price its runtime."""
        key = _instance_key(
            instance["provider"], instance["agent_name"], int(instance["replica_index"])
        )
        mapping = {
            "agent_id": instance["agent_id"],
            "agent_name": instance["agent_name"],
            "provider": instance["provider"],
            "replica_index": str(instance["replica_index"]),
            "private_host": instance["private_host"],
            "public_host": instance["public_host"],
            "host_port": str(instance["host_port"]),
            "container_port": str(instance["container_port"]),
            "endpoint": instance["endpoint"],
            "routing_endpoint": instance["routing_endpoint"],
            "redis_host": instance["redis_host"],
            "redis_port": str(instance["redis_port"]),
            "runtime_id": instance["runtime_id"],
            # Lets the reconciler tell a starting replica from one that stopped answering.
            "created_at": str(time.time()),
        }
        if instance.get("user"):
            mapping["user"] = str(instance["user"])

        node_redis = self.controller.node_redis_for_instance(instance)
        node_redis.set(
            f"controller:{instance['routing_endpoint']}:agent_id", instance["agent_id"]
        )
        node_redis.set(f"agent:{instance['agent_id']}:hourly_cost", hourly_cost)
        # Last: routing_endpoint marks the launch finished, so a failed write above leaves it unfinished.
        self.redis.hset_multiple(key, mapping)

    def _add_instance_to_agent(self, agent_name, instance_id):
        self.redis.sadd(f"agent:{agent_name}:instances", instance_id)

    def remove_instance(self, instance_id):
        """Stop a replica's container, delete its record, and republish the routing
        table without it."""
        key = f"agent_instance:{instance_id}"
        instance = self.redis.hgetall(key)
        if not instance:
            return

        # Before the runtime goes: on EC2 that terminates the host this status
        # lives on, and drops the node's Redis client with it.
        self._delete_controller_status(instance)
        self._destroy_runtime(instance)
        self.redis.delete(key)
        self.redis.srem(f"agent:{instance['agent_name']}:instances", instance_id)
        self.controller.prune_node_redis(list_instances(self.redis))
        publish_routing_snapshot(
            self.controller.controllers
            if self._agent_specs is None
            else self._agent_specs,
            self.redis,
            self.controller.node_redis,
        )

    def _delete_controller_status(self, instance):
        """Drop the status key belonging to this instance.

        Hygiene: a status key should not outlive the instance record it belongs
        to. The guarantee that a stale one is never read lives at launch, where
        the local runtime clears the key, fail-closed, right before `docker run`.
        Best effort here: a node whose Redis is already gone must not stop the
        teardown.
        """
        try:
            node_redis = (
                self.controller.node_redis.get(instance.get("private_host"))
                or self.redis
            )
            node_redis.delete(f"controller:{instance['routing_endpoint']}:status")
        except Exception as e:
            logger.warning(
                "Could not clear the status of %s: %s", instance.get("runtime_id"), e
            )

    def _destroy_runtime(self, instance):
        runtime = providers.get(instance["provider"])
        runtime.terminate_instance(instance)

    def _discard_instance_record(self, instance_id, instance):
        self.redis.delete(f"agent_instance:{instance_id}")
        self.redis.srem(f"agent:{instance['agent_name']}:instances", instance_id)

    def remove_unfinished(self):
        """Remove every launch that never finished: whatever it started, then its record.
        A record whose removal fails is kept for the next call. Call only while nothing
        is launching, since a launch in progress looks the same."""
        for key in self.redis.scan_keys("agent_instance:*"):
            record = self.redis.hgetall(key)
            if not record or record.get("routing_endpoint"):
                continue
            logger.info(
                "Removing %s: its launch never finished, or a version without "
                "routing_endpoint saved it",
                key,
            )
            try:
                self._destroy_runtime(record)
            except Exception as e:
                logger.warning("Could not remove the unfinished launch %s: %s", key, e)
                continue
            self.redis.delete(key)

    def _claim_host_port(self, host, key):
        """Claim the lowest free port on a machine for one local replica and record the claim in Redis."""
        # Held across scan and write so two reconcilers can't claim the same port.
        with self.redis.lock(f"port_claim_lock:{host}", PORT_CLAIM_LOCK_SECONDS):
            # Raw scan: port claims from this pass must count as used too.
            records = (
                self.redis.hgetall(record_key)
                for record_key in self.redis.scan_keys("agent_instance:*")
            )
            used = {
                int(instance["host_port"])
                for instance in records
                if instance.get("private_host") == host and instance.get("host_port")
            }
            port = DEFAULT_HOST_PORT_START
            while port in used:
                port += 1

            self.redis.hset_multiple(
                key, {"private_host": host, "host_port": str(port)}
            )
        return port
