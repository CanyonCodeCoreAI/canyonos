# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Start, list, check and terminate the deployment's pool of machines. The steps here
are common to every provider; the commands specific to one provider live in providers/.
Touches only machine records, providers and each machine's Redis; the replicas on the
machines are the replica provisioner's."""

import logging
import threading
import time
import uuid
from functools import partial

from canyonos_core.reconciler import providers, replicas, state
from canyonos_core.reconciler.parallel import run_in_parallel

logger = logging.getLogger(__name__)

# How long replicas wait for a starting machine; a start usually takes 1 to 2 minutes.
START_WAIT_SECONDS = 180


class MachineProvisioner(object):
    """Keeps the pool of machines the config declares running, from deploy to stop."""

    def __init__(self, controller):
        self.controller = controller
        # Launch ids of the machines whose start is still running in the background.
        self._starting = set()

    @property
    def redis(self):
        """The Global Controller's Redis client."""
        return self.controller.redis

    def _declared(self, agent_specs):
        """For each machine spec the config declares for the providers the agent specs use:
        its provider name, provider, how many machines of it to run, and the records of
        the machines already started for it."""
        records = [
            self.redis.hgetall(key) for key in self.redis.scan_keys("machine_record:*")
        ]
        for provider_name in dict.fromkeys(
            agent_spec["provider"] for agent_spec in agent_specs
        ):
            schema = providers.SCHEMAS[provider_name]
            section = self.controller.config.get(schema.SECTION) or {}
            shared = {
                key: section[key] for key in schema.MACHINE_KEYS if key in section
            }
            # A provider without machine types has one machine: this one.
            kinds = (
                [
                    ({**shared, schema.MACHINE_TYPES: machine_type}, count)
                    for machine_type, count in section[schema.MACHINE_TYPES].items()
                ]
                if schema.MACHINE_TYPES
                else [(shared, 1)]
            )
            for machine_spec, count in kinds:
                started = [
                    record
                    for record in records
                    if record.get("provider") == provider_name
                    and all(record.get(k) == v for k, v in machine_spec.items())
                ]
                yield (
                    provider_name,
                    providers.get(provider_name),
                    machine_spec,
                    count,
                    started,
                )

    def start_missing(self, agent_specs):
        """Start every machine the config declares for the providers the agent specs use
        that has no record yet, each in the background, so the pass goes on while they
        boot. A record is saved before its machine starts, so it can be terminated whatever
        happens next, and one that never came up still counts until it is, so no more than
        the declared number ever run at once."""
        missing = []
        for provider_name, provider, machine_spec, count, started in self._declared(
            agent_specs
        ):
            if count > len(started):
                capacity = provider.machine_capacity(machine_spec)
                fields = {
                    "provider": provider_name,
                    "hourly_cost": str(provider.hourly_cost(machine_spec)),
                    **machine_spec,
                    **{k: str(v) for k, v in (capacity or {}).items()},
                }
                # A provider without machine types uses its own name.
                machine_type = machine_spec.get(
                    providers.SCHEMAS[provider_name].MACHINE_TYPES, provider_name
                )
                missing += [(provider, machine_spec, fields, machine_type)] * (
                    count - len(started)
                )

        # Saved only after every type is sized and priced, so a failed lookup starts nothing.
        for provider, machine_spec, fields, machine_type in missing:
            launch_id = uuid.uuid4().hex
            self.redis.hset_multiple(
                f"machine_record:{launch_id}",
                {**fields, "launch_id": launch_id, "launched_at": str(time.time())},
            )
            self._starting.add(launch_id)
            threading.Thread(
                target=self._start_machine,
                args=(provider, machine_spec, launch_id, machine_type),
                name=f"start-machine-{launch_id}",
                daemon=True,
            ).start()

    def _start_machine(self, provider, machine_spec, launch_id, machine_type):
        """Start one machine, wait for it and start its Redis, saving what the provider
        returns to its record. Runs in its own thread. A failed start saves its error by
        machine type until every machine of that type is up; find_dead replaces a record
        left without private_host."""
        key = f"machine_record:{launch_id}"
        try:
            machine = provider.start_machine(machine_spec, launch_id)
            self.redis.hset_multiple(
                key, {field: str(value) for field, value in machine.items() if value}
            )
            machine.update(provider.wait_for_machine(machine))
            # Before private_host is saved, so a machine whose Redis never starts is replaced.
            replicas.start_redis(
                self.controller, machine["private_host"], machine.get("user")
            )
            self.redis.hset_multiple(
                key, {field: str(value) for field, value in machine.items() if value}
            )
            records = [
                self.redis.hgetall(record_key)
                for record_key in self.redis.scan_keys("machine_record:*")
            ]
            # Only once no machine of this type is left without a host, so the error of
            # one that failed beside it stays.
            if all(
                record.get("private_host")
                for record in records
                if record.get(
                    providers.SCHEMAS[record["provider"]].MACHINE_TYPES,
                    record["provider"],
                )
                == machine_type
            ):
                self.redis.hdel(state.MACHINE_ERRORS_KEY, machine_type)
        except Exception as e:
            logger.warning("Failed to start machine %s: %r", launch_id, e)
            self.redis.hset(state.MACHINE_ERRORS_KEY, machine_type, str(e))
        finally:
            self._starting.discard(launch_id)

    def machines_for_replicas(self):
        """The machines replicas can be placed on: those up, and those started less than
        START_WAIT_SECONDS ago, whose replicas wait for them. Each has its launch id,
        provider, record, hourly cost, capacity (None means no limit) and whether it is
        up."""
        # Copied first, so a start ending while the records are read isn't taken as failed.
        starting = set(self._starting)
        machines = []
        for key in self.redis.scan_keys("machine_record:*"):
            record = self.redis.hgetall(key)
            up = bool(record.get("private_host"))
            # One that never came up waits for find_dead to replace it.
            if not up and (
                record["launch_id"] not in starting
                or time.time() - float(record["launched_at"]) > START_WAIT_SECONDS
            ):
                continue
            machines.append(
                {
                    "launch_id": record["launch_id"],
                    "provider": record["provider"],
                    "record": record,
                    "hourly_cost": float(record["hourly_cost"]),
                    "capacity": (
                        {"cpu": float(record["cpu"]), "memory": int(record["memory"])}
                        if "cpu" in record
                        else None
                    ),
                    "up": up,
                }
            )
        return machines

    def find_surplus(self, agent_specs):
        """The launch ids of the machines the config no longer wants: of a type, market or
        provider it does not declare, or past their type's count. Machines that never came
        up go first, then the newest. Empty until every machine kept is up, so the replicas
        moved off them always have somewhere to go."""
        kept = set()
        for *_, count, started in self._declared(agent_specs):
            started.sort(
                key=lambda record: (
                    not record.get("private_host"),
                    float(record["launched_at"]),
                )
            )
            if not all(record.get("private_host") for record in started[:count]):
                return []
            kept.update(record["launch_id"] for record in started[:count])
        surplus = []
        for key in self.redis.scan_keys("machine_record:*"):
            launch_id = key.removeprefix("machine_record:")
            if launch_id not in kept:
                logger.info("Machine %s is no longer in the config; draining it", key)
                surplus.append(launch_id)
        return surplus

    def find_dead(self):
        """The launch ids of the machines that never came up, and of the running ones their
        provider says are gone. The running ones are all checked at once; one whose check
        fails counts as alive until the next call. One still starting is neither."""
        # Copied first, so a start ending while the records are read isn't taken as failed.
        starting = set(self._starting)
        dead = []
        checks = {}
        for key in self.redis.scan_keys("machine_record:*"):
            machine = self.redis.hgetall(key)
            if machine["launch_id"] in starting:
                continue
            if not machine.get("private_host"):
                logger.warning("Machine %s never came up; replacing it", key)
                dead.append(machine["launch_id"])
            else:
                checks[machine["launch_id"], machine["private_host"]] = partial(
                    providers.get(machine["provider"]).machine_alive, machine
                )

        for (launch_id, host), alive, error in run_in_parallel(checks):
            if error:
                logger.warning("Could not check machine %s: %s", host, error)
            elif not alive:
                logger.warning(
                    "Machine %s is gone; relaunching its replicas elsewhere", host
                )
                dead.append(launch_id)
        return dead

    def terminate(self, launch_ids=None, keep=()):
        """Terminate these machines, or every machine when launch_ids is None, except the
        ones in keep, all at once, and delete their records. A machine whose termination
        fails, or whose start is still running, keeps its record for the next call."""
        # Its start would write the record back after the delete.
        starting = set(self._starting)
        jobs = {}
        for key in self.redis.scan_keys("machine_record:*"):
            machine = self.redis.hgetall(key)
            launch_id = machine.get("launch_id")
            if (
                launch_id in keep
                or launch_id in starting
                or (launch_ids is not None and launch_id not in launch_ids)
            ):
                continue
            jobs[key] = partial(
                providers.get(machine["provider"]).terminate_machine, machine
            )

        for key, _, error in run_in_parallel(jobs):
            if error:
                logger.warning("Could not terminate machine %s: %s", key, error)
                continue
            self.redis.delete(key)
