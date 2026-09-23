# Level-triggered process converging running instances onto desired replica counts in Redis.

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
)
from canyonos_core.instances.endpoints import routing_endpoint_for
from canyonos_core.instances.records import instance_id_from_record
from canyonos_core.reconciler import state
from canyonos_core.reconciler.provisioner import Provisioner

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Wake-queue block: bounds how long shutdown waits, not the sweep cadence.
WAKE_TIMEOUT_SECONDS = 1

TCP_PROBE_TIMEOUT_SECONDS = 2

_running = True


def _handle_shutdown(signum, frame):
    global _running
    _running = False


class Reconciler(object):
    """Converges observed instances onto the desired replica counts in Redis."""

    def __init__(self, config_path, sweep_interval=None):
        self.context = ControllerContext(config_path)
        self.context.attach_local_node_redis()
        self.provisioner = Provisioner(self.context)
        self.sweep_interval = sweep_interval or self.context.poll_interval

        # A replica reports on GlobalController's poll cadence; allow a couple of misses.
        self.stale_after = 3 * self.context.poll_interval

        # An instance that has never reported yet is still starting, not unhealthy.
        self.startup_grace = max(30, 3 * self.context.poll_interval)

        self._seen_healthy = set()  # instance_id, once it has answered at least once

    def _accepts_connections(self, instance):
        host = instance.get("host")
        port = instance.get("host_port")
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

    def _reports_are_fresh(self, instance):
        """Whether the instance's metrics heartbeat is recent."""
        node_redis = self.context.node_redis_for_instance(instance)
        # The agent writes this key from its own env, under its routing endpoint.
        key = f"controller:{routing_endpoint_for(instance)}:metrics"
        try:
            metrics = node_redis.hgetall(key)
        except Exception as e:
            logger.warning("Failed to read metrics for %s: %s", key, e)
            return True  # a Redis blip is not evidence the instance is unhealthy

        observed_at = metrics.get("observed_at")
        if not observed_at:
            return False
        try:
            return time.time() - float(observed_at) <= self.stale_after
        except (TypeError, ValueError):
            return False

    def _is_healthy(self, instance, instance_id):
        # A stock database image has no controller to write the metrics heartbeat.
        is_database = (
            self.context.agent_specs.get(instance["agent_name"], {}).get("type")
            == "database"
        )
        if self._accepts_connections(instance) and (
            is_database or self._reports_are_fresh(instance)
        ):
            self._seen_healthy.add(instance_id)
            return True
        if instance_id not in self._seen_healthy and self._within_startup_grace(
            instance
        ):
            return True
        return False

    def _within_startup_grace(self, instance):
        created_at = instance.get("created_at")
        if not created_at:
            return False
        try:
            return time.time() - float(created_at) <= self.startup_grace
        except (TypeError, ValueError):
            return False

    def reconcile(self, agent_name=None):
        """Converge one agent, or every configured agent when agent_name is None."""
        if self.context.refresh_controllers_from_redis():
            logger.info(
                "Adopted %d published agent spec(s).", len(self.context.controllers)
            )
        draining = state.is_draining(self.context.redis)

        names = (
            [agent_name] if agent_name is not None else list(self.context.agent_specs)
        )
        reaped = False
        for name in names:
            try:
                reaped |= self._reap(name, draining)
            except Exception as e:
                logger.warning("Failed to reap agent %s: %s", name, e)
        if agent_name is None:
            try:
                self._reap_removed_agents()
            except Exception as e:
                logger.warning("Failed to reap instances of removed agents: %s", e)

        # desired_agent_specs falls back to the configured count, so a fill would undo the drain.
        if draining:
            return
        # A named agent that could not be reaped has nothing to fill into.
        if agent_name is not None and not reaped:
            return
        try:
            # The whole spec list: ensure_instances republishes routing from what it is handed.
            self.provisioner.ensure_instances(
                state.desired_agent_specs(self.context.redis, self.context.controllers)
            )
        except Exception as e:
            logger.warning("Failed to provision missing instances: %s", e)

    def _reap(self, agent_name, draining=False):
        """Remove an agent's surplus, unhealthy and replaced instances."""
        spec = self.context.agent_specs.get(agent_name)
        if spec is None:
            logger.warning(
                "Wake signal for unknown agent %s; it is not in %s",
                agent_name,
                self.context.config_path,
            )
            return False

        redis_client = self.context.redis
        configured = state.replica_count(spec)
        if draining:
            desired = 0
        elif configured is None:
            logger.warning(
                "Agent %s has a non-integer replicas value; skipping.", agent_name
            )
            return False
        else:
            desired = state.get_desired(redis_client, agent_name, configured)
        reap_requested = state.reap_requests(redis_client, agent_name)

        instances = self.provisioner.list_instances(agent_name)
        for instance in instances:
            # Routing republishes fan out to node_redis, so every node needs a client first.
            self.context.node_redis_for_instance(instance)

        # A request for an instance that no longer exists has nothing left to do.
        existing_ids = {instance_id_from_record(instance) for instance in instances}
        state.clear_reap_requests(redis_client, *(reap_requested - existing_ids))

        for instance in instances:
            instance_id = instance_id_from_record(instance)
            reason = self._removal_reason(
                instance, instance_id, desired, reap_requested
            )
            if reason is None:
                continue
            self._remove(instance_id, reason)
            if instance_id in reap_requested:
                state.clear_reap_requests(redis_client, instance_id)
        return True

    def _remove(self, instance_id, reason):
        logger.info("Removing instance %s (%s)", instance_id, reason)
        self._seen_healthy.discard(instance_id)
        self.provisioner.remove_instance(instance_id)

    def _reap_removed_agents(self):
        """Remove instances of agents that are no longer in the published specs."""
        for instance in self.provisioner.list_instances():
            if instance["agent_name"] in self.context.agent_specs:
                continue
            self.context.node_redis_for_instance(instance)
            self._remove(instance_id_from_record(instance), "agent removed from config")

    def _removal_reason(self, instance, instance_id, desired, reap_requested):
        if instance_id in reap_requested:
            return "replacement requested"
        if int(instance["replica_index"]) >= desired:
            return f"surplus to desired count {desired}"
        if not self._is_healthy(instance, instance_id):
            return "unhealthy"
        return None

    # ------------------------------------------------------------------ #
    #  Loop                                                              #
    # ------------------------------------------------------------------ #

    def run(self):
        logger.info(
            "Reconciler started for %d agent(s), sweeping every %ds.",
            len(self.context.agent_specs),
            self.sweep_interval,
        )
        self.reconcile()
        last_sweep = time.time()

        while _running:
            try:
                signals = state.drain(self.context.redis, timeout=WAKE_TIMEOUT_SECONDS)
            except Exception as e:
                logger.warning("Failed to read the wake queue: %s", e)
                time.sleep(WAKE_TIMEOUT_SECONDS)
                continue

            if state.WAKE_ALL in signals:
                # A config reload wakes all; new replicas need the reloaded env file.
                self.context.refresh_env_file()
                self.reconcile()
                last_sweep = time.time()
                signals.discard(state.WAKE_ALL)

            for agent_name in sorted(signals):
                try:
                    self.reconcile(agent_name)
                except Exception as e:
                    logger.warning("Failed to reconcile agent %s: %s", agent_name, e)

            if time.time() - last_sweep >= self.sweep_interval:
                self.reconcile()
                last_sweep = time.time()

        logger.info("Reconciler exiting.")


def main(argv=None):
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
