"""Create and destroy agent runtime instances; the controller imports nothing from here."""

import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

from canyonos_core.instances.endpoints import routing_endpoint_for
from canyonos_core.instances.records import (
    instance_id as _instance_id,
    instance_key as _instance_key,
    list_instances,
)
from canyonos_core.instances.routing import publish_routing_snapshot
from canyonos_core.reconciler.providers.Local import (
    _runtime as local_runtime,
)

DEFAULT_HOST_PORT_START = 8000


class Provisioner(object):
    """Makes the running instances match the specs it is handed."""

    def __init__(self, controller):
        self.controller = controller
        self._agent_specs = None

    @property
    def redis(self):
        return self.controller.redis

    def list_instances(self, agent_name=None):
        return list_instances(self.redis, agent_name)

    def _provider_runtime(self, provider):
        """The provider's runtime module, bound to this process's controller."""
        if provider.upper() == "EC2":
            from canyonos_core.reconciler.providers.EC2 import (
                _runtime as runtime,
            )
        else:
            runtime = local_runtime
        runtime._controller = self.controller
        return runtime

    def ensure_instances(self, agent_specs):
        self._agent_specs = list(agent_specs)
        instances = []
        existing = []
        jobs = []

        for agent_spec in self._agent_specs:
            agent_name = agent_spec["name"]
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
                    existing.append((agent_name, instance_id, instance))
                    continue

                reserved_port = None
                if provider == "local":
                    host = agent_spec.get("host", local_runtime.DEFAULT_HOST)
                    reserved_port = self._next_host_port(
                        host, key, agent_name, provider, replica_index
                    )

                jobs.append(
                    {
                        "agent_name": agent_name,
                        "agent_spec": agent_spec,
                        "runtime": runtime,
                        "replica_index": replica_index,
                        "instance_id": instance_id,
                        "reserved_port": reserved_port,
                    }
                )

        max_workers = min(len(jobs), (os.cpu_count() or 1) * 100)
        provisioned = []
        if jobs:
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                future_to_job = {
                    executor.submit(self._provision_one, job): job for job in jobs
                }
                for future in as_completed(future_to_job):
                    job = future_to_job[future]
                    instance = future.result()
                    provisioned.append(
                        (job["agent_name"], job["instance_id"], instance)
                    )

        for agent_name, instance_id, instance in existing + provisioned:
            self._add_instance_to_agent(agent_name, instance_id)
            self._track_runtime(agent_name, instance["runtime_id"])
            instances.append(instance)

        self._publish_routing(self._agent_specs)
        return instances

    def _provision_one(self, job):
        runtime = job["runtime"]
        agent_spec = job["agent_spec"]
        replica_index = job["replica_index"]
        reserved_port = job["reserved_port"]

        def next_host_port(_host):
            return reserved_port

        provisioned = runtime.provision_instance(
            agent_spec, replica_index, next_host_port
        )
        agent_id = uuid.uuid4().hex
        instance = runtime.bootstrap_instance(
            provisioned, agent_spec, replica_index, agent_id
        )
        instance["agent_id"] = agent_id
        self._write_instance(instance)
        return instance

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

        self._destroy_runtime(instance)
        self.redis.delete(key)
        self.redis.srem(f"agent:{instance['agent_name']}:instances", instance_id)
        self.controller.containers[instance["agent_name"]] = [
            runtime_id
            for runtime_id in self.controller.containers.get(instance["agent_name"], [])
            if runtime_id != instance["runtime_id"]
        ]
        self._publish_routing(
            self.controller.controllers
            if self._agent_specs is None
            else self._agent_specs
        )

    def _destroy_runtime(self, instance):
        runtime = self._provider_runtime(instance.get("provider", "local"))
        runtime.terminate_instance(instance)

    def _track_runtime(self, agent_name, runtime_id):
        containers = self.controller.containers.setdefault(agent_name, [])
        if runtime_id not in containers:
            containers.append(runtime_id)

    def _next_host_port(self, host, key, agent_name, provider, replica_index):
        used = {
            int(instance["host_port"])
            for instance in self.list_instances()
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

    def _publish_routing(self, agent_specs):
        publish_routing_snapshot(agent_specs, self.redis, self.controller.node_redis)
