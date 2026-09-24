"""Create and destroy agent runtime instances; the controller imports nothing from here."""

import logging
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

from canyonos_core.controller.controller_context import (
    instance_id as _instance_id,
    instance_key as _instance_key,
    routing_endpoint_for,
)
from canyonos_core.reconciler.routing import publish_routing_snapshot
from canyonos_core.reconciler.providers.Local import (
    _runtime as local_runtime,
)

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
        return self.controller.redis

    def _provider_runtime(self, provider):
        """The provider's runtime module, bound to this process's controller."""
        normalized = provider.casefold()
        if normalized == "ec2":
            from canyonos_core.reconciler.providers.EC2 import (
                _runtime as runtime,
            )
        elif normalized == "local":
            runtime = local_runtime
        else:
            raise RuntimeError(
                f"Unsupported provider {provider!r}; use `local` or `EC2`."
            )
        runtime._controller = self.controller
        return runtime

    def ensure_instances(self, agent_specs, only=None):
        """Start missing replicas of the agents in only (all when None) and republish routing for every agent."""
        self._agent_specs = []
        for original in agent_specs:
            agent_spec = dict(original)
            provider = agent_spec.get("provider", "local")
            if not isinstance(provider, str) or provider.casefold() not in {
                "local",
                "ec2",
            }:
                raise RuntimeError(
                    f"Agent {agent_spec.get('name', '<unnamed>')} has unsupported "
                    f"provider {provider!r}; use `local` or `EC2`."
                )
            agent_spec["provider"] = "EC2" if provider.casefold() == "ec2" else "local"
            self._agent_specs.append(agent_spec)
        self._prune_stale_port_claims()
        instances = []
        existing = []
        jobs = []

        for agent_spec in self._agent_specs:
            agent_name = agent_spec["name"]
            if only is not None and agent_name not in only:
                continue
            provider = agent_spec.get("provider", "local")
            runtime = self._provider_runtime(provider)
            self.controller.containers.setdefault(agent_name, [])

            validate = getattr(runtime, "validate_config", None)
            if validate:
                validate()

            for replica_index in range(int(agent_spec.get("replicas", 1))):
                instance_id = _instance_id(provider, agent_name, replica_index)
                key = _instance_key(provider, agent_name, replica_index)
                instance = self.redis.hgetall(key)

                if instance and instance.get("runtime_id"):
                    if self._runtime_is_running(instance):
                        existing.append((agent_name, instance_id, instance))
                        continue
                    self._destroy_runtime(instance)
                    self._discard_instance_record(instance_id, instance)

                claimed_port = None
                if provider == "local":
                    host = agent_spec.get("host", local_runtime.DEFAULT_HOST)
                    claimed_port = self._claim_host_port(
                        host, key, agent_name, provider, replica_index
                    )

                jobs.append(
                    {
                        "agent_name": agent_name,
                        "agent_spec": agent_spec,
                        "runtime": runtime,
                        "replica_index": replica_index,
                        "instance_id": instance_id,
                        "claimed_port": claimed_port,
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
                        failures.append(e)
                        continue
                    provisioned.append(
                        (job["agent_name"], job["instance_id"], instance)
                    )

        for agent_name, instance_id, instance in existing + provisioned:
            self._add_instance_to_agent(agent_name, instance_id)
            self._track_runtime(agent_name, instance["runtime_id"])
            instances.append(instance)

        publish_routing_snapshot(
            self._agent_specs, self.redis, self.controller.node_redis
        )
        if failures:
            for extra in failures[1:]:
                logger.warning("Another replica also failed to provision: %s", extra)
            raise failures[0]
        return instances

    def _provision_one(self, job):
        runtime = job["runtime"]
        agent_spec = job["agent_spec"]
        replica_index = job["replica_index"]
        claimed_port = job["claimed_port"]

        def next_host_port(_host):
            return claimed_port

        instance = None
        runtime_id = None
        try:
            instance = runtime.provision_instance(
                agent_spec, replica_index, next_host_port
            )
            runtime_id = instance.get("runtime_id")
            if runtime_id:
                self._track_runtime(job["agent_name"], runtime_id)

            agent_id = uuid.uuid4().hex
            instance = runtime.bootstrap_instance(
                instance, agent_spec, replica_index, agent_id
            )
            instance["agent_id"] = agent_id
            self._write_instance(instance)
            return instance
        except Exception:
            if instance is not None:
                try:
                    runtime.terminate_instance(instance)
                except Exception as cleanup_error:
                    logger.warning(
                        "Failed to clean up runtime %s after provisioning failed: %s",
                        runtime_id,
                        cleanup_error,
                    )
                else:
                    self._untrack_runtime(job["agent_name"], runtime_id)
            try:
                self.redis.delete(f"agent_instance:{job['instance_id']}")
                self.redis.srem(
                    f"agent:{job['agent_name']}:instances", job["instance_id"]
                )
            except Exception as cleanup_error:
                logger.warning(
                    "Failed to remove the partial instance record for %s: %s",
                    job["instance_id"],
                    cleanup_error,
                )
            raise

    def _write_instance(self, instance):
        key = _instance_key(
            instance["provider"], instance["agent_name"], int(instance["replica_index"])
        )
        mapping = {
            "agent_id": instance["agent_id"],
            "agent_name": instance["agent_name"],
            "provider": instance["provider"],
            "replica_index": str(instance["replica_index"]),
            "host": instance["host"],
            "host_port": str(instance["host_port"]),
            "container_port": str(instance["container_port"]),
            "endpoint": instance["endpoint"],
            "redis_host": instance["redis_host"],
            "redis_port": str(instance["redis_port"]),
            "runtime_id": instance["runtime_id"],
            # Lets the reconciler tell a starting replica from one that stopped answering.
            "created_at": str(time.time()),
        }
        # public_host: set by providers whose `host` isn't reachable from outside
        # the deployment's network. api_port: workflow replicas only.
        for field in ("user", "instance_type", "public_host", "api_port"):
            if instance.get(field):
                mapping[field] = str(instance[field])
        self.redis.hset_multiple(key, mapping)

        node_redis = self.controller.node_redis.get(instance["host"]) or self.redis

        endpoint = routing_endpoint_for(instance)
        node_redis.set(f"controller:{endpoint}:agent_id", instance["agent_id"])

        # Direct agent_id -> instance_type lookup so cost computation can look up
        # hourly pricing from just the agent_id already stamped on each future.
        if instance.get("instance_type"):
            node_redis.set(
                f"agent:{instance['agent_id']}:instance_type", instance["instance_type"]
            )

    def _add_instance_to_agent(self, agent_name, instance_id):
        self.redis.sadd(f"agent:{agent_name}:instances", instance_id)

    def remove_instance(self, instance_id):
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
        self.controller.containers[instance["agent_name"]] = [
            runtime_id
            for runtime_id in self.controller.containers.get(instance["agent_name"], [])
            if runtime_id != instance["runtime_id"]
        ]
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
                self.controller.node_redis.get(instance.get("host")) or self.redis
            )
            node_redis.delete(f"controller:{routing_endpoint_for(instance)}:status")
        except Exception as e:
            logger.warning(
                "Could not clear the status of %s: %s", instance.get("runtime_id"), e
            )

    def _destroy_runtime(self, instance):
        runtime = self._provider_runtime(instance.get("provider", "local"))
        runtime.terminate_instance(instance)

    def _track_runtime(self, agent_name, runtime_id):
        containers = self.controller.containers.setdefault(agent_name, [])
        if runtime_id not in containers:
            containers.append(runtime_id)

    def _untrack_runtime(self, agent_name, runtime_id):
        self.controller.containers[agent_name] = [
            tracked
            for tracked in self.controller.containers.get(agent_name, [])
            if tracked != runtime_id
        ]

    def _runtime_is_running(self, instance):
        runtime_id = instance.get("runtime_id")
        host = instance.get("host")
        if not runtime_id or not host:
            return False

        provider = instance.get("provider", "local")
        user = instance.get("user")
        if provider.casefold() == "ec2":
            runtime_id = runtime_id.rsplit("--", 1)[0]
            user = user or self.controller.config.get("ec2", {}).get("ssh_user")

        try:
            result = self.controller._run_cmd(
                ["docker", "inspect", "-f", "{{.State.Running}}", runtime_id],
                host,
                user,
            )
        except RuntimeError as e:
            # _run_cmd raises when the host can't be reached at all. This
            # answers whether a record is reusable, and an unreachable host
            # isn't; let the re-provision that follows report the real failure.
            logger.warning("Could not inspect %s on %s: %s", runtime_id, host, e)
            return False
        return result.returncode == 0 and result.stdout.strip() == "true"

    def _discard_instance_record(self, instance_id, instance):
        self.redis.delete(f"agent_instance:{instance_id}")
        self.redis.srem(f"agent:{instance['agent_name']}:instances", instance_id)
        self._untrack_runtime(instance["agent_name"], instance["runtime_id"])

    def _prune_stale_port_claims(self):
        """Delete port claims left for replica slots no agent wants anymore."""
        wanted = {
            _instance_key(spec["provider"], spec["name"], replica_index)
            for spec in self._agent_specs or []
            for replica_index in range(int(spec.get("replicas", 1)))
        }
        for key in self.redis.scan_keys("agent_instance:*"):
            if key in wanted:
                continue
            record = self.redis.hgetall(key)
            if record and not record.get("runtime_id"):
                logger.info("Removing stale port claim %s", key)
                self.redis.delete(key)

    def _claim_host_port(self, host, key, agent_name, provider, replica_index):
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
                if instance.get("host") == host and instance.get("host_port")
            }
            port = DEFAULT_HOST_PORT_START
            while port in used:
                port += 1

            self.redis.hset_multiple(
                key,
                {
                    "agent_name": agent_name,
                    "provider": provider,
                    "replica_index": str(replica_index),
                    "host": host,
                    "host_port": str(port),
                },
            )
        return port
