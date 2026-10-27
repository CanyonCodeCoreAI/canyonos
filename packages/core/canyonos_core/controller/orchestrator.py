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

`KubernetesOrchestrator` is Kubernetes: the operator and Kubernetes run the pods, and
the Global Controller only sets each CanyonAgent's replica count.

`orchestrator_for` picks the implementation once, from CANYONOS_TARGET; unset means
the reconciler.

The methods are only half of what an orchestrator owes the Global Controller. The
other half is in the project's Redis, which the Global Controller reads directly
(`state.get_desired`, `list_replicas`), so every orchestrator must keep these up to
date in the reconciler's format:

- `agent:<agent>:desired_replicas`: each agent's desired replica count.
- `agent_instance:<agent>-<slot>`: one hash per running replica, with at least
  `agent_name`, `replica_index`, `private_host`, `host_port` and `address`. `address`
  is written last: a record without it is a replica still starting.

On Docker and EC2 the reconciler writes them; on Kubernetes the operator does.
"""

import logging
import os
import sys

from canyonos_core.controller.controller_context import replica_id
from canyonos_core.controller.kubernetes_api import (
    KubernetesApi,
    KubernetesError,
    pod_machine_rows,
)
from canyonos_core.controller.utils import otel_writer
from canyonos_core.controller.utils.redis_client import RedisClient
from canyonos_core.reconciler import replicas, state

logger = logging.getLogger(__name__)

TARGET_ENV = "CANYONOS_TARGET"


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

    def apply_configured_replicas(self, counts):
        """Reset each agent to its configured replica count, {agent: count}: the YAML
        is authoritative and overwrites any runtime scale."""
        for agent_name, count in counts.items():
            self.gc._set_replicas(agent_name, count)

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


class KubernetesOrchestrator:
    """Kubernetes: the operator turns each CanyonAgent into a StatefulSet and Kubernetes
    keeps its pods running. The Global Controller only changes replica counts, through
    each CanyonAgent's /scale subresource. It starts nothing and removes nothing: when
    it stops the agents keep running, and removing a project is the operator's job."""

    def __init__(self, gc, api=None):
        self.gc = gc
        self.api = api if api is not None else KubernetesApi.from_environment()
        self._metrics_unavailable = False

    def remove_stale_containers(self):
        """Nothing: Kubernetes removes what the operator no longer wants."""

    def start_support_services(self):
        """Use the project's Redis, which the operator runs and names in
        CANYONOS_REDIS_HOST / CANYONOS_REDIS_PORT."""
        host = os.environ.get("CANYONOS_REDIS_HOST")
        if not host:
            raise RuntimeError(
                "CANYONOS_REDIS_HOST is unset: on Kubernetes the operator names the "
                "project's Redis."
            )
        port = int(os.environ.get("CANYONOS_REDIS_PORT") or 6379)
        self.gc.redis = RedisClient(host=host, port=port)
        self.gc._redis_addr = (host, port)

    def register_background_processes(self, supervisor):
        """Nothing: there is no reconciler; Kubernetes keeps each count."""

    def undo_support_services(self):
        """Nothing was started."""

    def set_replicas(self, agent_name, count):
        """Patch the agent's CanyonAgent /scale; the operator mirrors it into Redis."""
        count = max(0, int(count))
        self.api.scale_canyon_agent(agent_name, count)
        return count

    def apply_configured_replicas(self, counts):
        """Nothing: each CanyonAgent already carries its configured count (the CLI
        applies it from the same file), and resetting it here would undo live scaling
        on every restart and fight GitOps tools."""

    def replace_replica(self, agent_name, replica_index):
        """Nothing: Kubernetes replaces a failed pod by itself."""
        logger.info(
            "Not replacing %s replica %s: Kubernetes replaces failed pods itself.",
            agent_name,
            replica_index,
        )
        return None

    def forget_removed_agents(self, removed):
        """Nothing: the CLI removes CanyonAgents that are no longer configured."""

    def poll_machine_metrics(self):
        """Persist each project pod's usage, as a share of its limits, for telemetry.
        Without the metrics API (metrics-server is an add-on on some clusters), warn
        once and record none until it answers again."""
        try:
            rows = pod_machine_rows(
                self.api.project_pods(),
                self.api.pod_metrics(),
                self.gc.config.get("project_id"),
            )
        except KubernetesError as e:
            if not self._metrics_unavailable:
                logger.warning("Machine metrics unavailable (non-fatal): %s", e)
                self._metrics_unavailable = True
            return
        self._metrics_unavailable = False
        if rows:
            otel_writer.metric_write_rows(rows)

    def machine_redis_for_replica(self, replica):
        """Every replica reports to the one project Redis."""
        return self.gc.redis

    def replica_log_tail(self, replica, lines):
        raise RuntimeError("On Kubernetes, read a replica's logs with `kubectl logs`.")

    def remove_all_replicas(self):
        """Nothing to remove: the agents keep running when the Global Controller stops."""
        return True

    def stop_support_services(self, clean):
        """Nothing was started."""
        return []


def orchestrator_for(gc):
    """The orchestrator for this process, from CANYONOS_TARGET (unset: the reconciler)."""
    target = os.environ.get(TARGET_ENV, "")
    if target == "":
        return CanyonOrchestrator(gc)
    if target == "kubernetes":
        return KubernetesOrchestrator(gc)
    raise ValueError(
        f"Unknown {TARGET_ENV} {target!r}: use kubernetes, or leave it unset for "
        "Docker and EC2."
    )
