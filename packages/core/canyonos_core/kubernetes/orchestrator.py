# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""`KubernetesOrchestrator`: the Global Controller's orchestrator on Kubernetes, where
the operator and Kubernetes run the pods (see controller/orchestrator.py for what an
orchestrator owes the Global Controller)."""

import logging
import os

from canyonos_core.controller.utils import otel_writer
from canyonos_core.controller.utils.redis_client import RedisClient
from canyonos_core.kubernetes.api import (
    KubernetesApi,
    KubernetesError,
    pod_machine_rows,
)

logger = logging.getLogger(__name__)


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
