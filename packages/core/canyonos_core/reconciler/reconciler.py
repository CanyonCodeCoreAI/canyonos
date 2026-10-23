# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The reconciler process: starts and removes replicas until each agent runs the count
recorded in Redis."""
# Level-triggered process converging running replicas onto desired replica counts in Redis.

import argparse
import logging
import os
import signal
import socket
import sys
import time

from canyonos_core.controller.controller_context import (
    ControllerContext,
    _redis_connect_host,
    replica_id_from_record,
    list_replicas,
)
from canyonos_core.reconciler import state
from canyonos_core.reconciler.provisioner import Provisioner

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Wake-queue block: bounds how long shutdown waits, not the sweep cadence.
WAKE_TIMEOUT_SECONDS = 1

TCP_PROBE_TIMEOUT_SECONDS = 2

# How long a draining replica may keep running before it is removed anyway.
DRAIN_TIMEOUT_SECONDS = 180

_running = True


def _handle_shutdown(signum, frame):
    global _running
    _running = False


class Reconciler(object):
    """Converges observed replicas onto the desired replica counts in Redis."""

    def __init__(self, config_path, sweep_interval=None):
        self.context = ControllerContext(config_path)
        self.context.attach_local_machine_redis()
        self.provisioner = Provisioner(self.context)
        self.sweep_interval = sweep_interval or self.context.poll_interval

        # A replica reports on GlobalController's poll cadence; allow a couple of misses.
        self.stale_after = 3 * self.context.poll_interval

        # A replica that has never reported yet is still starting, not unhealthy.
        self.startup_grace = max(30, 3 * self.context.poll_interval)

        self._seen_healthy = set()  # replica_id, once it has answered at least once

    # ------------------------------------------------------------------ #
    #  Reconcile                                                         #
    # ------------------------------------------------------------------ #

    def _reconcile(self, agent_names=None):
        """Converge the named agents, or every configured agent when agent_names is None."""
        if self.context.refresh_agent_specs_from_redis():
            logger.info(
                "Adopted %d published agent spec(s).", len(self.context.agent_specs)
            )
        stopping = state.is_stopping(self.context.redis)

        names = (
            agent_names
            if agent_names is not None
            else list(self.context.agent_specs_by_name)
        )
        checked = False
        for name in names:
            try:
                checked |= self._remove_unwanted(name, stopping)
            except Exception as e:
                logger.warning("Failed to remove unwanted replicas of %s: %s", name, e)
        if agent_names is None:
            try:
                self._remove_replicas_of_removed_agents(stopping)
            except Exception as e:
                logger.warning("Failed to remove replicas of removed agents: %s", e)

        try:
            self.provisioner.remove_unfinished()
        except Exception as e:
            logger.warning("Failed to remove unfinished launches: %s", e)

        # desired_agent_specs falls back to the configured count, so a fill would undo the stop.
        if stopping:
            return
        # A named agent that could not be checked has nothing to fill into.
        if agent_names is not None and not checked:
            return
        try:
            # The whole spec list: ensure_replicas republishes routing from what it is handed.
            self.provisioner.ensure_replicas(
                state.desired_agent_specs(self.context.redis, self.context.agent_specs),
                only=agent_names,
            )
        except Exception as e:
            logger.warning("Failed to provision missing replicas: %s", e)

    # ------------------------------------------------------------------ #
    #  Removal                                                           #
    # ------------------------------------------------------------------ #

    def _remove_unwanted(self, agent_name, stopping=False):
        """Remove an agent's unhealthy replicas and drain its surplus and replaced ones."""
        agent_spec = self.context.agent_specs_by_name.get(agent_name)
        if agent_spec is None:
            logger.warning(
                "Wake signal for unknown agent %s; it is not in %s",
                agent_name,
                self.context.config_path,
            )
            return False

        redis_client = self.context.redis
        configured = state.replica_count(agent_spec)
        if stopping:
            desired = 0
        elif configured is None:
            logger.warning(
                "Agent %s has a non-integer replicas value; skipping.", agent_name
            )
            return False
        else:
            desired = state.get_desired(redis_client, agent_name, configured)
        replace_requested = state.replace_requests(redis_client, agent_name)

        replicas = list_replicas(redis_client, agent_name)
        for replica in replicas:
            # Routing republishes fan out to machine_redis, so every machine needs a client first.
            self.context.machine_redis_for_replica(replica)

        # A request for a replica that no longer exists has nothing left to do.
        existing_ids = {replica_id_from_record(replica) for replica in replicas}
        state.clear_replace_requests(redis_client, *(replace_requested - existing_ids))

        for replica in replicas:
            replica_id = replica_id_from_record(replica)
            reason = self._removal_reason(
                replica, replica_id, desired, replace_requested
            )
            if reason is None:
                continue
            if reason == "unhealthy":
                self._remove_replica(replica_id, reason)
            # Still draining: a replace request stays pending until the replica is gone.
            elif not self._drain_replica(replica_id, replica, reason, stopping):
                continue
            if replica_id in replace_requested:
                state.clear_replace_requests(redis_client, replica_id)
        return True

    def _removal_reason(self, replica, replica_id, desired, replace_requested):
        # Once started, a drain runs to the end even if the replica is wanted again.
        if "draining_at" in replica:
            return "drain in progress"
        if replica_id in replace_requested:
            return "replacement requested"
        if int(replica["replica_index"]) >= desired:
            return f"surplus to desired count {desired}"
        if not self._is_healthy(replica, replica_id):
            return "unhealthy"
        return None

    def _remove_replica(self, replica_id, reason):
        logger.info("Removing replica %s (%s)", replica_id, reason)
        self._seen_healthy.discard(replica_id)
        self.provisioner.remove_replica(replica_id)

    def _remove_replicas_of_removed_agents(self, stopping):
        """Drain replicas of agents that are no longer in the published specs."""
        for replica in list_replicas(self.context.redis):
            if replica["agent_name"] in self.context.agent_specs_by_name:
                continue
            self.context.machine_redis_for_replica(replica)
            self._drain_replica(
                replica_id_from_record(replica),
                replica,
                "agent removed from config",
                stopping,
            )

    # ------------------------------------------------------------------ #
    #  Draining                                                          #
    # ------------------------------------------------------------------ #

    def _drain_replica(self, replica_id, replica, reason, stopping):
        """Advance one step towards removing a replica: tell it to take no new requests,
        then remove it once it reports idle or after DRAIN_TIMEOUT_SECONDS. It is removed
        at once while the fleet is stopping or once it stops answering. Returns True
        once removed."""
        if stopping:
            self._remove_replica(replica_id, reason)
            return True
        # One that stopped answering has no requests left to finish.
        if not self._is_healthy(replica, replica_id):
            self._remove_replica(replica_id, "unhealthy")
            return True

        draining_at = replica.get("draining_at")
        if draining_at is None:
            logger.info("Draining replica %s (%s)", replica_id, reason)
            draining_at = str(time.time())
            self.context.redis.hset(
                f"agent_instance:{replica_id}", "draining_at", draining_at
            )
        # The removal time, written every pass so a failed write is retried.
        self.context.machine_redis_for_replica(replica).set(
            f"controller:{replica['address']}:draining",
            str(float(draining_at) + DRAIN_TIMEOUT_SECONDS),
        )
        if (
            self._is_idle(replica)
            or time.time() - float(draining_at) >= DRAIN_TIMEOUT_SECONDS
        ):
            self._remove_replica(replica_id, "drained")
            return True
        return False

    def _is_idle(self, replica):
        """Whether the replica has seen its drain flag and has nothing queued, running,
        still bound to it, or still to send on."""
        metrics = self.context.machine_redis_for_replica(replica).hgetall(
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

    # ------------------------------------------------------------------ #
    #  Health checks                                                     #
    # ------------------------------------------------------------------ #

    def _is_healthy(self, replica, replica_id):
        # A stock database image has no controller to write the metrics heartbeat.
        """Return True if the replica answers on its port and reports fresh metrics, or
        has not answered yet but may still be starting."""
        is_database = (
            self.context.agent_specs_by_name.get(replica["agent_name"], {}).get("type")
            == "database"
        )
        if self._port_is_open(replica) and (
            is_database or self._reports_are_fresh(replica)
        ):
            self._seen_healthy.add(replica_id)
            return True
        if replica_id not in self._seen_healthy and self._may_still_be_booting(replica):
            return True
        return False

    def _port_is_open(self, replica):
        """Whether something is listening on the replica's port."""
        host = replica.get("private_host")
        port = replica.get("host_port")
        if not host or not port:
            return False
        try:
            # A containerized reconciler reaches host-published ports via host.docker.internal.
            with socket.create_connection(
                (_redis_connect_host(host), int(port)),
                timeout=TCP_PROBE_TIMEOUT_SECONDS,
            ):
                return True
        except (OSError, ValueError):
            return False

    def _reports_are_fresh(self, replica):
        """Whether the replica's metrics heartbeat is recent."""
        machine_redis = self.context.machine_redis_for_replica(replica)
        # The agent writes this key from its own env, under its address.
        key = f"controller:{replica['address']}:metrics"
        try:
            metrics = machine_redis.hgetall(key)
        except Exception as e:
            logger.warning("Failed to read metrics for %s: %s", key, e)
            return True  # a Redis blip is not evidence the replica is unhealthy

        observed_at = metrics.get("observed_at")
        if not observed_at:
            return False
        try:
            return time.time() - float(observed_at) <= self.stale_after
        except (TypeError, ValueError):
            return False

    def _may_still_be_booting(self, replica):
        """Whether the replica was created within the startup grace period."""
        created_at = replica.get("created_at")
        if not created_at:
            return False
        try:
            return time.time() - float(created_at) <= self.startup_grace
        except (TypeError, ValueError):
            return False

    # ------------------------------------------------------------------ #
    #  Loop                                                              #
    # ------------------------------------------------------------------ #

    def run(self):
        """Reconcile at startup, then whenever the Global Controller signals a change,
        and on a fixed interval, until stopped."""
        logger.info(
            "Reconciler started for %d agent(s), sweeping every %ds.",
            len(self.context.agent_specs_by_name),
            self.sweep_interval,
        )
        self._reconcile()
        last_sweep = time.time()

        while _running:
            try:
                signals = state.drain(self.context.redis, timeout=WAKE_TIMEOUT_SECONDS)
            except Exception as e:
                logger.warning("Failed to read the wake queue: %s", e)
                time.sleep(WAKE_TIMEOUT_SECONDS)
                continue

            if state.WAKE_ALL in signals:
                # A config reload wakes all; new replicas need the reloaded config.
                self.context.refresh_config()
                try:
                    self._reconcile()
                except Exception as e:
                    logger.warning("Failed to reconcile all agents: %s", e)
                last_sweep = time.time()
            elif signals:
                try:
                    self._reconcile(sorted(signals))
                except Exception as e:
                    logger.warning("Failed to reconcile %s: %s", sorted(signals), e)

            if time.time() - last_sweep >= self.sweep_interval:
                try:
                    self._reconcile()
                except Exception as e:
                    logger.warning("Failed to sweep all agents: %s", e)
                last_sweep = time.time()

        logger.info("Reconciler exiting.")


def main(argv=None):
    """Start the reconciler for the given config; it keeps each agent running its
    desired number of replicas. Returns 1 if the config file is missing."""
    signal.signal(signal.SIGTERM, _handle_shutdown)
    signal.signal(signal.SIGINT, _handle_shutdown)

    parser = argparse.ArgumentParser(description="CanyonOS reconciliation loop.")
    parser.add_argument(
        "-c", "--config", required=True, help="Path to the YAML config file."
    )
    args = parser.parse_args(argv)

    if not os.path.isfile(args.config):
        logger.critical("Config file not found at %s", args.config)
        return 1

    Reconciler(args.config).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
