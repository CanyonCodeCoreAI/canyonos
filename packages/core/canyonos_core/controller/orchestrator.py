# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The orchestrator: what starts, replaces and removes a project's replicas, behind
the one object the Global Controller asks.

The Global Controller decides: config, policies, how many replicas each agent should
have, cleanup, telemetry. Running those replicas -- starting them, replacing them,
reading their machines, removing them on teardown -- goes through `gc.orchestrator`, so no
other Global Controller code needs to know where it runs.

`CanyonOrchestrator` is CanyonOS running them itself, on Docker and EC2: Redis and
machine-metrics containers, and the reconciler process with its providers. The
methods it calls stay on GlobalController, unchanged.
"""

import logging
import os
import sys

from canyonos_core.controller.controller_context import replica_id
from canyonos_core.reconciler import replicas, state

logger = logging.getLogger(__name__)


class CanyonOrchestrator:
    """Docker and EC2: the Global Controller starts the replicas' Redis and collectors,
    and its reconciler process keeps each agent at its desired count."""

    def __init__(self, gc):
        self.gc = gc

    def remove_stale_containers(self):
        """Remove Redis and metrics containers a previous run left behind."""
        self.gc._remove_stale_containers()

    def start_support_services(self):
        """Start what the replicas need before the config is published: one Redis per
        machine, then one machine-metrics collector per machine."""
        self.gc._launch_redis_containers()
        self.gc._launch_metrics_collectors()

    def register_background_processes(self, supervisor):
        """Register the reconciler with the Global Controller's process supervisor."""
        supervisor.register(
            "reconciler",
            [
                sys.executable,
                "-m",
                "canyonos_core.reconciler",
                "--config",
                os.path.abspath(self.gc.config_path),
            ],
        )

    def undo_support_services(self):
        """Undo `start_support_services` after initialization failed."""
        self.gc._stop_metrics_collectors()
        try:
            redis_failures = self.gc._stop_redis_containers()
            if redis_failures:
                logger.warning(
                    "Redis cleanup after initialization failure was incomplete: %s",
                    "; ".join(redis_failures),
                )
        except Exception as cleanup_error:
            logger.warning(
                "Failed to clean up Redis after initialization failure: %s",
                cleanup_error,
            )

    def set_replicas(self, agent_name, count):
        """Make `count` the agent's desired replica count; the reconciler converges."""
        desired = state.set_desired(self.gc.redis, agent_name, count)
        self.gc._request_reconcile(agent_name)
        return desired

    def replace_replica(self, agent_name, replica_index):
        """Destroy one replica; its slot is refilled since the desired count stays."""
        target = replica_id(agent_name, int(replica_index))
        state.request_replace(self.gc.redis, target)
        self.gc._request_reconcile(agent_name)
        return target

    def forget_removed_agents(self, removed):
        """After a config reload: forget removed agents and converge everything."""
        for name in removed:
            self.gc.redis.delete(state.desired_key(name))
        self.gc._request_reconcile(state.WAKE_ALL)

    def poll_machine_metrics(self):
        """Persist each machine's collector sample for telemetry."""
        self.gc._poll_machine_metrics()

    def machine_redis_for_replica(self, replica):
        """The Redis a replica reports its status and metrics to: its machine's."""
        return self.gc.machine_redis_for_replica(replica)

    def replica_log_tail(self, replica, lines):
        """The last lines of the replica container's output, read on its machine."""
        return replicas.log_tail(self.gc, replica, lines)

    def remove_all_replicas(self):
        """At teardown, have the reconciler remove every replica. True once none are
        left."""
        return self.gc._remove_all_replicas()

    def stop_support_services(self, clean):
        """After the supervised processes stopped: clear the teardown flag and remove
        the collectors, and Redis too when `clean` (every replica is gone and nothing
        failed). Returns what it could not remove."""
        failures = []
        # The reconciler did the removing, so it had to outlive `remove_all_replicas`;
        # clearing the flag before it died would have it refill everything just removed.
        try:
            state.clear_stopping(self.gc.redis)
        except Exception as e:
            failures.append(f"stopping flag: {e}")
        self.gc._stop_metrics_collectors()
        # Replica records live in Redis; removing it with replicas left would orphan them.
        if clean and not failures:
            failures += self.gc._stop_redis_containers() or []
        else:
            failures.append("redis: kept for the next startup to reconcile")
        return failures
