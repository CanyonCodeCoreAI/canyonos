# Global Controller
# Daemon process that maintains a routing table in Redis for multiple local controllers.
# Periodically polls Redis to check controller health and updates the routing table.

import atexit
import json
import logging
import os
import shlex
import signal
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import yaml
from canyonos_core.OTLP_Exporter import db as otel_db
from canyonos_core.controller.controller_context import (
    ControllerContext,
    _is_local_host,
)
from canyonos_core.controller.utils.container_names import (
    container_name as agent_container_name,
)
from canyonos_core.instances.endpoints import routing_endpoint_for
from canyonos_core.instances.records import instance_id, list_instances
from canyonos_core.reconciler import state
from canyonos_core.controller.utils.config_specs import write_config_specs
from canyonos_core.controller.utils.env_file import resolve_env_file
from canyonos_core.controller.utils.process_supervisor import ProcessSupervisor
from canyonos_core.controller.utils.redis_utils import _wait_for_redis
from canyonos_core.controller.utils.telemetry_logging import (
    assign_project_id,
    pull_runtime_information,
    resolve_database_url,
    send_runtime_information,
    send_agent_information,
)
from canyonos_core.controller.utils.redis_client import RedisClient
from canyonos_core.controller.utils.grpc_options import GRPC_CHANNEL_OPTIONS

# Add generated grpc_stubs from the local project to the path. Projects using
# the .car artifact layout keep grpc_stubs under .car/; older/plain layouts
# keep it at the project root.
_artifact_prefix = ".car" if os.path.isdir(".car") else ""
sys.path.insert(0, os.path.abspath(os.path.join(_artifact_prefix, "grpc_stubs")))
import local_controler_pb2
import local_controler_pb2_grpc
import grpc

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Teardown waits this long for the reconciler to remove every instance before
# falling back to stopping them directly.
DRAIN_TIMEOUT_SECONDS = 30

LOCAL_NETWORK = "canyonos-local"


class GlobalController(ControllerContext):
    """
    Daemon that manages a routing table across multiple local controller instances.

    At startup it reads a YAML config file listing known agents, writes the
    initial routing table to Redis, then enters a polling loop that periodically
    checks controller health and refreshes the table.

    Designed to be subclassed — override the _on_* hooks to extend behavior.
    """

    ROUTING_ENDPOINTS_KEY = "routing_table:endpoints"
    ROUTING_STATEFUL_KEY = "routing_table:stateful"
    SERVICES_SET_KEY = "routing_table:services"
    POLICY_RULES_KEY = "policy:rules"
    IDENTITY_KEY = (
        "controller:identity"  # has controllers current project_id and database_url
    )
    OTEL_DESTINATIONS_KEY = "otel:destinations"  # otel_exporter subprocess polls this to pick up config changes

    def __init__(self, config_path):
        super().__init__(config_path)
        # Validate before launching anything: an agent that boots without its
        # API keys fails deep inside a container, where it is expensive to debug.
        self.env_file_path = resolve_env_file(self.config)

        self.cleanup_interval = self.config.get("cleanup_interval", 10)
        self.running = False
        self._stopping = False
        self._last_status = {}  # (host, port) -> last known status
        self._last_metrics_poll_time = {}  # (host, port) -> time.time() of last metrics read
        self._lc_stubs = {}  # endpoint -> gRPC stub
        assign_project_id(self.config.get("project_id"))
        if self._database_url() is None:
            logger.info(
                "No database configured; telemetry writes are disabled. "
                "Set database.url in %s to record runtime and agent information.",
                config_path,
            )

        # Clean up any stale containers from previous runs
        self._cleanup_stale_containers()

        # Launch Redis on each unique node, then write routing table and policies
        self._launch_redis_containers()
        write_config_specs(self.controllers, self.redis)
        # A teardown killed mid-drain leaves the flag set; clear it or the fleet stays at zero.
        state.clear_draining(self.redis)
        state.seed_desired(self.redis, self.controllers)
        self._load_and_write_policies()
        self._write_identity()
        logger.info(
            "Global controller initialized with %d controller(s).",
            len(self.controllers),
        )

        # Start background cleanup thread
        self._cleanup_ready = threading.Event()
        self._cleanup_thread = threading.Thread(target=self._cleanup_loop, daemon=True)
        self._cleanup_thread.start()

        # Spawn the OTLP exporter as a separate process, supervised so it gets
        # restarted if it ever exits unexpectedly.
        otel_exporter_dir = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "OTLP_Exporter",
        )
        otel_exporter_script = os.path.join(otel_exporter_dir, "otel_exporter.py")
        self.process_supervisor = ProcessSupervisor()

        # Exporter polls self.OTEL_DESTINATIONS_KEY in Redis each cycle instead of
        # reading env once, so reload_config() can update it without a restart.
        destinations = self._otel_destinations(self.config.get("otel", {}))
        if destinations is not None:
            self._write_otel_destinations(destinations)
            self.process_supervisor.register(
                "otel_exporter", [sys.executable, otel_exporter_script]
            )
        else:
            logger.info(
                "otel.destinations not configured -- no OTel metrics collection will happen."
            )

        # Initialize/migrate the waiting table synchronously before either the GC or
        # exporter process can access it.
        self._otel_db = otel_db
        self._otel_db.init_db()
        self.process_supervisor.register(
            "reconciler",
            [
                sys.executable,
                "-m",
                "canyonos_core.reconciler",
                "--config",
                os.path.abspath(self.config_path),
            ],
        )
        self.process_supervisor.start_all()

    # ------------------------------------------------------------------ #
    #  Stale container cleanup                                             #
    # ------------------------------------------------------------------ #

    def _cleanup_stale_containers(self):
        """Remove any containers from previous runs before launching new ones."""
        logger.info("Checking for stale containers from previous runs...")

        # Collect all expected container names and the hosts they run on
        # { host: (user, [container_names]) }
        host_containers = {}

        for ctrl in self.controllers:
            user = ctrl.get("user")
            placements = self._get_replica_placements(ctrl)

            for i, (host, port) in enumerate(placements):
                if host not in host_containers:
                    host_containers[host] = (user, set())
                host_containers[host][1].add(f"canyonos-redis-{host.replace('.', '-')}")
                host_containers[host][1].add(agent_container_name(ctrl["name"], i))

        # Try to remove each one on its respective host
        for host, (user, container_names) in host_containers.items():
            for container_name in container_names:
                try:
                    inspect = self._run_cmd(
                        [
                            "docker",
                            "inspect",
                            "-f",
                            "{{.State.Running}}",
                            container_name,
                        ],
                        host,
                        user,
                    )
                    if inspect.returncode == 0 and inspect.stdout.strip() == "true":
                        continue  # already running -- a live replica, not stale
                    self._run_cmd(["docker", "rm", "-f", container_name], host, user)
                except Exception:
                    pass  # Container didn't exist, that's fine

        logger.info("Stale container cleanup complete.")

    # ------------------------------------------------------------------ #
    #  Config                                                             #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _load_config(config_path):
        """The shared config load, plus minting a project_id when the file omits one."""
        config = ControllerContext._load_config(config_path)
        if not config.get("project_id"):
            config["project_id"] = GlobalController._assign_new_project_id(config_path)
        return config

    @staticmethod
    def _assign_new_project_id(config_path):
        """Generate a project_id and append it to the config file so it stays stable across reloads/restarts."""
        project_id = str(uuid.uuid4())
        with open(config_path, "a") as f:
            f.write(f'project_id: "{project_id}"\n')
        return project_id

    @staticmethod
    def _otel_destinations(otel_cfg):
        """Resolve otel.destinations (${ENV_VAR} refs expanded), or None if absent."""
        if "destinations" not in otel_cfg:
            return None
        return ControllerContext._expand_env_value(otel_cfg["destinations"])

    def _write_otel_destinations(self, destinations):
        try:
            payload = json.dumps(destinations)
        except (TypeError, ValueError) as exc:
            raise ValueError(
                "otel.destinations must contain JSON-serializable values"
            ) from exc
        self.redis.set(self.OTEL_DESTINATIONS_KEY, payload)

    def reload_config(self):
        """Re-read the config, republish the spec, and let the reconciler converge."""
        logger.info("Reloading config from %s", self.config_path)
        self.config = self._load_config(self.config_path)
        self.env_file_path = resolve_env_file(self.config)
        self._set_controllers(self.config.get("agents", []))
        self.poll_interval = self.config.get("poll_interval", 5)
        assign_project_id(self.config.get("project_id"))
        write_config_specs(self.controllers, self.redis)
        # Write-if-absent: seeds an agent the reload added, leaves a runtime scale alone.
        state.seed_desired(self.redis, self.controllers)
        self._write_identity()
        self._request_reconcile(state.WAKE_ALL)

        # Only meaningful if the exporter was already running.
        destinations = self._otel_destinations(self.config.get("otel", {}))
        if destinations is not None and self.process_supervisor.is_registered(
            "otel_exporter"
        ):
            self._write_otel_destinations(destinations)

    def _load_policy_rules(self):
        """Load policy rules from config/policy.yaml."""
        config_dir = os.path.dirname(os.path.abspath(self.config_path))
        policy_path = os.path.join(config_dir, "policy.yaml")

        if not os.path.isfile(policy_path):
            logger.info(
                "No policy file found at %s, skipping policy setup.", policy_path
            )
            return []

        with open(policy_path, "r") as f:
            policy_config = yaml.safe_load(f)

        rules = policy_config.get("rules", [])

        # Sort rules by specificity: most match keys first
        # This way the local controller can iterate and use the first matching rule.
        rules.sort(key=lambda r: len(r.get("match", {})), reverse=True)
        return rules

    def _load_and_write_policies(self):
        """Load policy rules and publish them to every host Redis."""
        rules = self._load_policy_rules()
        targets = list(self.node_redis.values()) or [self.redis]
        rules_json = json.dumps(rules)
        for redis_client in targets:
            redis_client.set("policy:rules", rules_json)

        logger.info(
            "Policy rules written to %d Redis instance(s): %d rule(s)",
            len(targets),
            len(rules),
        )

    # Only relevant for demo purposes
    def _write_identity(self):
        """Publish the current project/database identity to every node's Redis."""
        payload = {
            "project_id": str(self.config.get("project_id")),
            "database_url": self.config.get("database", {}).get("url") or "",
        }
        targets = list(self.node_redis.values()) or [self.redis]
        for redis_client in targets:
            redis_client.hset_multiple(self.IDENTITY_KEY, payload)

        logger.info(
            "Identity (project %s) published to %d Redis instance(s).",
            payload["project_id"],
            len(targets),
        )

    # The reconciler publishes the routing table; these keys are read-only here:
    # - self.redis.hgetall(self.ROUTING_ENDPOINTS_KEY)
    # - self.redis.hget(self.ROUTING_ENDPOINTS_KEY, service_name)

    def get_node_redis(self, host):
        """Get the RedisClient for a specific node."""
        return self.node_redis.get(host)

    # ------------------------------------------------------------------ #
    #  Redis container management                                         #
    # ------------------------------------------------------------------ #

    def _redis_container_healthy(
        self, container_name, host, user, connect_host, redis_port
    ):
        """Check whether an existing Redis container is already up and answering."""
        inspect = self._run_cmd(
            ["docker", "inspect", "-f", "{{.State.Running}}", container_name],
            host,
            user,
        )
        if inspect.returncode != 0 or inspect.stdout.strip() != "true":
            return False
        try:
            probe = RedisClient(host=connect_host, port=redis_port)
            _wait_for_redis(probe, host, redis_port, timeout=5, interval=1)
            return True
        except TimeoutError:
            return False

    def _launch_redis_containers(self):
        """Launch a Redis container on each unique node, reusing one that's already healthy."""
        # Collect unique nodes from all replica placements
        nodes = {}
        for ctrl in self.controllers:
            user = ctrl.get("user")
            redis_port = ctrl.get("redis_port", 6379)
            for host, _port in self._get_replica_placements(ctrl):
                if host not in nodes:
                    nodes[host] = {
                        "user": user,
                        "redis_port": redis_port,
                    }

        for host, node_cfg in nodes.items():
            redis_port = node_cfg["redis_port"]
            user = node_cfg["user"]
            container_name = f"canyonos-redis-{host.replace('.', '-')}"
            # CANYONOS_REDIS_HOST overrides the localhost case for a containerized GC; host/remote paths unchanged.
            if host in ("localhost", "127.0.0.1"):
                connect_host = os.environ.get("CANYONOS_REDIS_HOST", "localhost")
            else:
                connect_host = host

            if self._redis_container_healthy(
                container_name, host, user, connect_host, redis_port
            ):
                logger.info(
                    "Reusing existing Redis container %s on %s", container_name, host
                )
                self.redis_containers[host] = container_name
            else:
                if _is_local_host(host):
                    self._run_cmd(
                        ["docker", "network", "create", LOCAL_NETWORK], host, user
                    )
                network_args = (
                    ["--network", LOCAL_NETWORK] if _is_local_host(host) else []
                )
                cmd = [
                    "docker",
                    "run",
                    "-d",
                    "--name",
                    container_name,
                    *network_args,
                    "-p",
                    f"{redis_port}:6379",
                    "redis:alpine",
                ]

                try:
                    result = self._run_cmd(cmd, host, user)
                    if result.returncode == 0:
                        self.redis_containers[host] = container_name
                        logger.info(
                            "Launched Redis container %s on %s:%d",
                            container_name,
                            host,
                            redis_port,
                        )
                    else:
                        logger.critical(
                            "Failed to launch Redis on %s: %s",
                            host,
                            result.stderr.strip(),
                        )
                        sys.exit(1)
                except FileNotFoundError:
                    logger.critical(
                        "Docker is not installed or not in PATH. Cannot launch Redis."
                    )
                    sys.exit(1)
                except Exception as e:
                    logger.critical("Failed to launch Redis on %s: %s", host, e)
                    sys.exit(1)

            # Create a RedisClient for this node
            redis_client = RedisClient(host=connect_host, port=redis_port)
            _wait_for_redis(redis_client, host, redis_port)
            self.node_redis[host] = redis_client

        # Update the primary redis client to the local node's Redis
        if "localhost" in self.node_redis:
            self.redis = self.node_redis["localhost"]

        logger.info("Redis launched on %d node(s).", len(self.redis_containers))

    def _stop_redis_containers(self):
        """Stop and remove all launched Redis containers."""
        nodes = {}
        for ctrl in self.controllers:
            if ctrl.get("provider", "local").upper() == "EC2":
                continue
            user = ctrl.get("user")
            redis_port = ctrl.get("redis_port", 6379)
            for host, _port in self._get_replica_placements(ctrl):
                nodes.setdefault(host, {"user": user, "redis_port": redis_port})
        for host, container_name in self.redis_containers.items():
            user = nodes.get(host, {}).get("user")
            try:
                self._run_cmd(["docker", "stop", container_name], host, user)
                self._run_cmd(["docker", "rm", container_name], host, user)
                logger.info("Stopped Redis %s on %s", container_name, host)
            except Exception as e:
                logger.warning("Failed to stop Redis %s: %s", container_name, e)

        self.redis_containers.clear()
        self.node_redis.clear()

    # ------------------------------------------------------------------ #
    #  Startup health check                                               #
    # ------------------------------------------------------------------ #

    def _wait_for_healthy(self, timeout=30, interval=2):
        """
        Block until all controllers report healthy in Redis, or until timeout.

        Args:
            timeout:  Maximum seconds to wait.
            interval: Seconds between checks.
        """
        expected = sum(
            state.get_desired(self.redis, spec["name"], configured)
            for spec in self.controllers
            if (configured := state.replica_count(spec)) is not None
        )
        if not expected and self.controllers:
            logger.critical(
                "No agent declares an integer replica count; nothing will be "
                "provisioned. Check `replicas` in %s.",
                self.config_path,
            )
            return

        deadline = time.time() + timeout
        ready = set()
        any_instances_appeared = False
        pending = []

        logger.info(
            "Waiting for %d replica(s) to become healthy (timeout=%ds)...",
            expected,
            timeout,
        )

        while True:
            instances = list_instances(self.redis)
            any_instances_appeared = any_instances_appeared or bool(instances)
            pending = []
            ready_count = 0
            for instance in instances:
                name = instance["agent_name"]
                host = instance["host"]
                port = instance["host_port"]
                node_redis = self.node_redis_for_instance(instance)
                endpoint = routing_endpoint_for(instance)
                status = node_redis.get(f"controller:{endpoint}:status")
                if status == "healthy":
                    ready_count += 1
                    instance_key = (name, host, port)
                    if instance_key not in ready:
                        logger.info("Controller %s (%s:%s) is ready.", name, host, port)
                        self._last_status[(host, port)] = "healthy"
                        ready.add(instance_key)
                else:
                    pending.append(instance)

            if ready_count >= expected:
                return
            if time.time() >= deadline:
                break
            time.sleep(interval)

        if not any_instances_appeared:
            logger.critical(
                "No controller instances appeared within %ds; the reconciler may "
                "have failed to provision them.",
                timeout,
            )

        if pending:
            for instance in pending:
                logger.warning(
                    "Controller %s (%s:%s) not ready after %ds.",
                    instance["agent_name"],
                    instance["host"],
                    instance["host_port"],
                    timeout,
                )

    # ------------------------------------------------------------------ #
    #  Polling loop                                                       #
    # ------------------------------------------------------------------ #

    def run(self):
        """Start the daemon polling loop."""
        self.running = True
        logger.info(
            "Global controller started, polling every %ds...", self.poll_interval
        )
        try:
            while self.running:
                try:
                    self._poll_controllers()
                except Exception as e:
                    logger.warning("Polling loop encountered an error: %s", e)
                self._cleanup_ready.set()
                time.sleep(self.poll_interval)
        except KeyboardInterrupt:
            self.stop()

    def _database_url(self):
        """The configured database URL, or None when there is no database to write to.

        Read per call, not cached, so reload_config() can point us at a new database.
        `database:` with nothing under it parses as None, hence the `or {}`.
        """
        return resolve_database_url((self.config.get("database") or {}).get("url"))

    def _poll_controllers(self):
        """
        Check the health of each registered controller replica via its node's Redis.
        Also retrieves the request calls made in each instance.
        """
        # Prevents a process from restarting if a deliberate kill-cmd happens
        if self.running:
            self.process_supervisor.check_and_respawn()

        # Polled in parallel so one instance's slow Redis/Postgres round-trip does not
        # gate every other instance's poll.
        instances = list_instances(self.redis)
        if instances:
            with ThreadPoolExecutor(max_workers=len(instances)) as executor:
                list(executor.map(self._poll_one_instance, instances))

    def _poll_one_instance(self, instance):
        """Poll and persist one instance's runtime/metrics/health data; never raises."""
        try:
            name = instance["agent_name"]
            host = instance["host"]
            port = instance["host_port"]
            node_redis = self.node_redis_for_instance(instance)
        except Exception as e:
            logger.warning("Failed to poll instance %s: %s", instance, e)
            return

        # Without a database the legacy telemetry writes have nowhere to go, so they
        # are skipped instead of failing on every poll; OTel export is independent
        # of that legacy database and always runs.
        database_url = self._database_url()

        try:
            future_rows = pull_runtime_information(node_redis)
            self._otel_db.write_waiting_rows(
                future_rows, node_redis, self.config.get("project_id")
            )
            if database_url:
                # This is now legacy, keeping it for now, but will remove this later
                send_runtime_information(future_rows, node_redis, database_url)
        except Exception as e:
            logger.warning(
                "Failed to write runtime information for instance %s (%s:%s) "
                "(non-fatal): %s",
                name,
                host,
                port,
                e,
            )
        endpoint = routing_endpoint_for(instance)
        status_key = f"controller:{endpoint}:status"
        metrics_key = f"controller:{endpoint}:metrics"

        # Getting metrics from local controllers
        # See LocalController._execute_locally
        try:
            metrics = node_redis.hgetall(metrics_key)
            if metrics:
                now = time.time()
                requests_served = int(float(metrics.get("requests_served") or 0))
                elapsed = now - self._last_metrics_poll_time.get(
                    (host, port), now - self.poll_interval
                )
                throughput = requests_served / elapsed if elapsed > 0 else 0.0
                self._last_metrics_poll_time[(host, port)] = now

                if database_url:
                    try:
                        send_agent_information(
                            [
                                {
                                    **instance,
                                    **metrics,
                                    "requests_served": requests_served,
                                    "throughput": throughput,
                                }
                            ],
                            database_url,
                        )
                    except Exception as e:
                        logger.warning(
                            "Failed to write agent information for instance %s (%s:%s) "
                            "(non-fatal): %s",
                            name,
                            host,
                            port,
                            e,
                        )
                    else:
                        # Only clear the accumulated counters once they've actually been persisted
                        node_redis.hset_multiple(
                            metrics_key,
                            {
                                "full_failures": 0,
                                "error_count": 0,
                                "requests_served": 0,
                            },
                        )
        except Exception as e:
            logger.warning(
                "Failed to poll metrics for instance %s (%s:%s): %s",
                name,
                host,
                port,
                e,
            )

        try:
            status = node_redis.get(status_key) or "unknown"
            prev = self._last_status.get((host, port))

            if status != prev:
                if status == "healthy":
                    logger.info(
                        "Controller %s (%s:%s) is now healthy.", name, host, port
                    )
                    self._on_controller_healthy(name, host, port)
                else:
                    logger.warning(
                        "Controller %s (%s:%s) status changed: %s -> %s",
                        name,
                        host,
                        port,
                        prev or "(none)",
                        status,
                    )
                    self._on_controller_unhealthy(name, host, port)
                self._last_status[(host, port)] = status
            else:
                # No change — healthy stays quiet, unhealthy stays quiet too
                if status == "healthy":
                    self._on_controller_healthy(name, host, port)
                else:
                    self._on_controller_unhealthy(name, host, port)
        except Exception as e:
            logger.warning(
                "Failed to poll status for instance %s (%s:%s): %s",
                name,
                host,
                port,
                e,
            )

    def set_replicas(self, agent_name, count):
        """Set an agent's desired replica count; the reconciler adds or reaps to match."""
        if agent_name not in self.agent_specs:
            logger.warning("Cannot scale unknown agent %s", agent_name)
            return None
        desired = state.set_desired(self.redis, agent_name, count)
        self._request_reconcile(agent_name)
        return desired

    def replace_instance(self, agent_name, replica_index):
        """Destroy one replica; the desired count is unchanged, so the slot is refilled."""
        if agent_name not in self.agent_specs:
            logger.warning("Cannot replace an instance of unknown agent %s", agent_name)
            return None
        provider = self.agent_specs[agent_name].get("provider", "local")
        target = instance_id(provider, agent_name, int(replica_index))
        state.request_replace(self.redis, target)
        self._request_reconcile(agent_name)
        return target

    def _request_reconcile(self, agent_name):
        """Wake the reconciler, without letting a Redis failure break the caller."""
        try:
            state.request_reconcile(self.redis, agent_name)
        except Exception as e:
            logger.warning(
                "Failed to queue a reconcile for %s (its periodic sweep still "
                "covers this): %s",
                agent_name,
                e,
            )

    # ------------------------------------------------------------------ #
    #  Extensibility hooks — override in subclasses                       #
    # ------------------------------------------------------------------ #

    def _on_controller_healthy(self, name, host, port):
        """Called when a controller is detected as healthy."""
        pass

    def _on_controller_unhealthy(self, name, host, port):
        """Called when a controller is unreachable or unhealthy."""
        pass

    def _on_routing_table_updated(self, table):
        """Called after the routing table has been written to Redis."""
        pass

    # ------------------------------------------------------------------ #
    #  Cleanup trigger                                                     #
    # ------------------------------------------------------------------ #

    def _get_lc_stub(self, endpoint):
        """Get or create a cached gRPC stub for a local controller endpoint."""
        if endpoint not in self._lc_stubs:
            channel = grpc.insecure_channel(endpoint, options=GRPC_CHANNEL_OPTIONS)
            self._lc_stubs[endpoint] = local_controler_pb2_grpc.LocalControllerStub(
                channel
            )
        return self._lc_stubs[endpoint]

    def _cleanup_loop(self):
        """Background thread: trigger cleanup right after each poll tick, or every cleanup_interval as a fallback."""
        while True:
            self._cleanup_ready.wait(timeout=self.cleanup_interval)
            self._cleanup_ready.clear()
            try:
                self._trigger_cleanup()
            except Exception as e:
                logger.warning("Cleanup loop encountered an error: %s", e)

    def _trigger_cleanup(self):
        """Broadcast a batched Cleanup gRPC to all instances for every completed request, gathered from every node's Redis."""
        # Falls back to self.redis alone if node_redis is unset/empty.
        node_redis_map = getattr(self, "node_redis", None) or {}
        redis_clients = list(node_redis_map.values()) or [self.redis]

        completed_by_client = {}
        all_completed = set()
        for client in redis_clients:
            completed = client.smembers("request:completed")
            if completed:
                completed_by_client[client] = completed
                all_completed.update(completed)

        if not all_completed:
            return

        payload = json.dumps({"request_ids": list(all_completed)})

        def _send(instance):
            endpoint = instance["endpoint"]
            try:
                stub = self._get_lc_stub(endpoint)
                stub.Cleanup(local_controler_pb2.JsonResponse(resonse=payload))
                logger.debug(
                    "Sent Cleanup batch of %d request(s) to %s",
                    len(all_completed),
                    endpoint,
                )
            except Exception as e:
                logger.warning("Failed to trigger cleanup on %s: %s", endpoint, e)

        instances = list_instances(self.redis)
        if instances:
            with ThreadPoolExecutor(max_workers=len(instances)) as executor:
                list(executor.map(_send, instances))

        logger.info(
            "Triggered cleanup for %d completed request(s) across %d node(s)",
            len(all_completed),
            len(completed_by_client),
        )
        # Drain each node's own set from the same client it was read from.
        for client, completed in completed_by_client.items():
            client.srem("request:completed", *completed)

    # ------------------------------------------------------------------ #
    #  Runtime launching                                                  #
    # ------------------------------------------------------------------ #

    def _push_file(self, local_path, remote_path, host, user=None):
        """
        Copy a local file to a remote host over SSH.

        Streams the bytes through `cat` under `umask 077` rather than using
        `scp`, so a secrets file is never briefly world-readable on the far
        side.

        Anything already sitting at the destination is removed first: `umask`
        only governs files the shell creates, and `>` follows symlinks. Without
        the `rm`, a local user on the remote host could pre-create the path
        world-readable, or point it at a file of their own, and collect
        whatever we write there.

        Returns:
            subprocess.CompletedProcess
        """
        quoted = shlex.quote(remote_path)
        remote_cmd = f"umask 077; rm -f {quoted}; cat > {quoted}"
        with open(local_path, "rb") as f:
            result = subprocess.run(
                self._ssh_args(host, user) + [remote_cmd],
                stdin=f,
                capture_output=True,
                text=True,
                timeout=180,
                check=False,
            )
        if result.returncode != 0:
            raise RuntimeError(
                f"Failed to copy {local_path} to {host}:{remote_path}: "
                f"{(result.stderr or result.stdout or '').strip()}"
            )
        return result

    # ------------------------------------------------------------------ #
    #  Shutdown                                                           #
    # ------------------------------------------------------------------ #

    def cleanup(self):
        """Full cleanup — stop all containers and Redis, called on exit."""
        if not self.running and not self.redis_containers:
            return  # Already cleaned up
        logger.info("Cleaning up all resources...")
        self.stop()

    def _drain_instances(self, timeout=DRAIN_TIMEOUT_SECONDS, interval=1):
        """Have the reconciler remove every instance. True once none are left."""
        state.set_draining(self.redis)
        state.request_reconcile(self.redis)
        deadline = time.time() + timeout

        while True:
            try:
                remaining = list_instances(self.redis)
            except Exception as e:
                logger.warning("Failed to read instance records while draining: %s", e)
                return False
            if not remaining:
                logger.info("All agent instances drained.")
                return True
            if time.time() >= deadline:
                logger.warning(
                    "%d instance(s) still running after %ds; the next startup's "
                    "reconcile will reap whichever are no longer healthy.",
                    len(remaining),
                    timeout,
                )
                return False
            time.sleep(interval)
            state.set_draining(self.redis)

    def stop(self):
        """Gracefully shut down the daemon and all agent processes."""
        # A second signal arriving mid-drain must not start a second teardown.
        if self._stopping:
            return
        self._stopping = True
        self.running = False

        self._drain_instances()
        # The reconciler does the removing, so it has to outlive the drain; clearing
        # the flag before it dies would have it refill everything just removed.
        self.process_supervisor.terminate_all()
        state.clear_draining(self.redis)
        self._stop_redis_containers()
        logger.info("Global controller shut down.")


if __name__ == "__main__":
    default_config = os.path.join(_artifact_prefix, "config", "global_controller.yaml")

    import argparse

    parser = argparse.ArgumentParser(description="CanyonOS Global Controller daemon.")
    parser.add_argument(
        "-c",
        "--config",
        default=default_config,
        help=f"Path to the YAML config file (default: {default_config})",
    )
    args = parser.parse_args()

    controller = GlobalController(args.config)

    # Register cleanup on Ctrl+C (SIGINT) and kill (SIGTERM)
    def _signal_handler(sig, frame):
        logger.info("Received signal %s, shutting down...", signal.Signals(sig).name)
        controller.cleanup()
        sys.exit(0)

    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)

    # Register config reload on SIGHUP and reload
    def _reload_handler(sig, frame):
        logger.info("Received SIGHUP, reloading config...")
        try:
            controller.reload_config()
        except Exception as e:
            logger.error("Reload failed: %s", e)

    signal.signal(signal.SIGHUP, _reload_handler)
    atexit.register(controller.cleanup)

    controller._wait_for_healthy()
    controller.run()
