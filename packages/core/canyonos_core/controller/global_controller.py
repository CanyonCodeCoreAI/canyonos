# Global Controller
# Daemon process that maintains a routing table in Redis for multiple local controllers.
# Periodically polls Redis to check controller health and updates the routing table.

import atexit
import json
import logging
import os
import signal
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import yaml
from canyonos_core.controller.controller_context import (
    ControllerContext,
    _is_local_host,
    _redis_connect_host,
)
from canyonos_core.controller.utils import otel_writer, pricing_refresh, schema
from canyonos_core.controller.utils.otel_writer import send_telemetry
from canyonos_core.controller.utils.container_names import (
    container_name as agent_container_name,
    redis_container_name,
)
from canyonos_core.instances.endpoints import routing_endpoint_for
from canyonos_core.instances.records import instance_id, list_instances
from canyonos_core.reconciler import state
from canyonos_core.controller.utils.config_specs import write_config_specs
from canyonos_core.controller.utils.env_file import resolve_env_file
from canyonos_core.controller.utils.process_supervisor import ProcessSupervisor
from canyonos_core.controller.utils.port_utils import is_port_conflict
from canyonos_core.controller.utils.redis_utils import _wait_for_redis
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

# Teardown waits this long for the reconciler to remove every instance; any left
# over keep Redis up so the next startup can reconcile their records.
DRAIN_TIMEOUT_SECONDS = 30

LOCAL_NETWORK = "canyonos-local"
# Set by the CLI to the image the GC itself runs. No default: guessing one means
# silently running a stale image that need not hold the code this GC was built from.
CONTROLLER_IMAGE = os.environ.get("CANYONOS_CONTROLLER_IMAGE")


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
    IDENTITY_KEY = "controller:identity"  # has the controller's current project_id
    OTEL_DESTINATIONS_KEY = "otel:destinations"  # otel_exporter subprocess polls this to pick up config changes

    def __init__(self, config_path):
        super().__init__(config_path)

        redis_cfg = self.config.get("redis", {})
        # Kept in step with self.redis, including the reassignment in
        # _launch_redis_containers -- the otel_exporter subprocess is handed these.
        self._redis_addr = (
            _redis_connect_host(redis_cfg.get("host", "localhost")),
            redis_cfg.get("port", 6379),
        )

        self.cleanup_interval = self.config.get("cleanup_interval", 10)
        self.running = False
        self._stopping = False
        self._metrics_collectors = {}  # host -> collector container name (one per host)
        self._last_status = {}  # (host, port) -> last known status
        self._lc_stubs = {}  # endpoint -> gRPC stub
        # Clean up any stale containers from previous runs
        self._cleanup_stale_containers()

        self.process_supervisor = ProcessSupervisor()
        try:
            # Launch Redis on each unique node, then write routing table and policies
            self._launch_redis_containers()
            # One machine-level metrics collector per host (best-effort, local hosts only).
            self._launch_metrics_collectors()
            self._apply_config()
            # A teardown killed mid-drain leaves the flag set; clear it or the fleet stays at zero.
            state.clear_draining(self.redis)
            logger.info(
                "Global controller initialized with %d controller(s).",
                len(self.controllers),
            )

            # Spawn the OTLP exporter as a separate process,
            # supervised so it gets restarted if it ever exits unexpectedly.
            otel_exporter_dir = os.path.join(
                os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                "otlp_exporter",
            )
            otel_exporter_script = os.path.join(otel_exporter_dir, "otel_exporter.py")

            # Exporter polls self.OTEL_DESTINATIONS_KEY in Redis each cycle instead of
            # reading env once, so reload_config() can update it without a restart.
            destinations = self._otel_destinations(self.config.get("otel", {}))
            if destinations is not None:
                self._write_otel_destinations(destinations)
            else:
                logger.info(
                    "otel.destinations not configured -- the exporter will flush queued "
                    "telemetry each poll instead of exporting it."
                )
            # Always start the exporter: with destinations it exports; without, it flushes the
            # queue each poll so waiting/metrics_waiting can't grow unbounded.
            self.process_supervisor.register(
                "otel_exporter",
                [sys.executable, otel_exporter_script],
                env={
                    "CANYONOS_OTEL_REDIS_HOST": str(self._redis_addr[0]),
                    "CANYONOS_OTEL_REDIS_PORT": str(self._redis_addr[1]),
                },
            )

            # Initialize the waiting table synchronously before either the GC or
            # exporter process can access it. GC owns schema creation; because GC spawns the
            # exporter, the tables always exist before the exporter reads them.
            schema.init_db()
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

            self._cleanup_ready = threading.Event()
            self._cleanup_thread = threading.Thread(
                target=self._cleanup_loop, daemon=True
            )
            self._cleanup_thread.start()
        except Exception:
            try:
                self.process_supervisor.terminate_all()
            except Exception as cleanup_error:
                logger.warning(
                    "Failed to stop supervised processes after initialization failure: %s",
                    cleanup_error,
                )
            self._stop_metrics_collectors()
            try:
                redis_failures = self._stop_redis_containers()
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
            raise

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
                host_containers[host][1].add(redis_container_name(host))
                host_containers[host][1].add(
                    f"canyonos-metrics-{host.replace('.', '-')}"
                )
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
        previous = set(self.agent_specs)
        self._set_controllers(self.config.get("agents", []))
        for name in previous - set(self.agent_specs):
            self.redis.delete(state.desired_key(name))
        self.poll_interval = self.config.get("poll_interval", 5)
        self._apply_config()
        self._request_reconcile(state.WAKE_ALL)

        # Only meaningful if the exporter was already running.
        destinations = self._otel_destinations(self.config.get("otel", {}))
        if destinations is not None and self.process_supervisor.is_registered(
            "otel_exporter"
        ):
            self._write_otel_destinations(destinations)

    def _apply_config(self):
        """Publish the loaded config to Redis: agent specs, replica counts, policies, identity."""
        write_config_specs(self.controllers, self.redis)
        # The YAML is authoritative, so this overwrites any runtime scale.
        self._apply_configured_replicas()
        self._load_and_write_policies()
        self._write_identity()

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
        """Publish the current project identity to every node's Redis."""
        payload = {
            "project_id": str(self.config.get("project_id")),
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

    def _redis_container_running(self, container_name, host, user):
        """Whether a Redis container by this name exists and is running."""
        inspect = self._run_cmd(
            ["docker", "inspect", "-f", "{{.State.Running}}", container_name],
            host,
            user,
        )
        return inspect.returncode == 0 and inspect.stdout.strip() == "true"

    def _redis_container_serves_port(self, container_name, host, user, redis_port):
        """Whether the Redis container is serving this port."""
        result = self._run_cmd(
            ["docker", "port", container_name, f"{redis_port}/tcp"], host, user
        )
        return result.returncode == 0

    def _redis_responds(self, host, connect_host, redis_port):
        """Check whether a Redis on this node is already up and answering."""
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
            redis_port = int(ctrl.get("redis_port", 6379))
            for host, _port in self._get_replica_placements(ctrl):
                claimed = nodes.setdefault(
                    host,
                    {
                        "user": user,
                        "redis_port": redis_port,
                        "agent": ctrl.get("name"),
                    },
                )
                if claimed["redis_port"] != redis_port:
                    logger.critical(
                        "Agents %s and %s are both placed on %s but declare "
                        "different redis_port values (%d and %d). One Redis runs "
                        "per host -- give them the same `redis_port` in "
                        "global_controller.yaml.",
                        claimed["agent"],
                        ctrl.get("name"),
                        host,
                        claimed["redis_port"],
                        redis_port,
                    )
                    sys.exit(1)

        for host, node_cfg in nodes.items():
            redis_port = node_cfg["redis_port"]
            user = node_cfg["user"]
            container_name = redis_container_name(host)
            connect_host = _redis_connect_host(host)

            running = self._redis_container_running(container_name, host, user)
            # Without this the ping below could be answered by an unrelated Redis
            # on that port, and the GC would adopt it as its own.
            if running and not self._redis_container_serves_port(
                container_name, host, user, redis_port
            ):
                logger.critical(
                    "Redis container %s on %s is not serving port %d. Remove it "
                    "with `docker rm -f %s`, or change `redis_port` in "
                    "global_controller.yaml.",
                    container_name,
                    host,
                    redis_port,
                    container_name,
                )
                sys.exit(1)

            if running:
                if not self._redis_responds(host, connect_host, redis_port):
                    logger.critical(
                        "Redis container %s on %s is running but not answering on "
                        "port %d. Remove it with `docker rm -f %s` and redeploy.",
                        container_name,
                        host,
                        redis_port,
                        container_name,
                    )
                    sys.exit(1)
                logger.info(
                    "Reusing existing Redis container %s on %s", container_name, host
                )
                self.redis_ports[host] = redis_port
            else:
                if _is_local_host(host):
                    self._run_cmd(
                        ["docker", "network", "create", LOCAL_NETWORK], host, user
                    )
                network_args = (
                    ["--network", LOCAL_NETWORK] if _is_local_host(host) else []
                )

                # Redis listens on the declared port inside the container too, so
                # agents reaching it by container name over the local network use
                # the same number the host does.
                cmd = [
                    "docker",
                    "run",
                    "-d",
                    "--name",
                    container_name,
                    *network_args,
                    "-p",
                    f"{redis_port}:{redis_port}",
                    "redis:alpine",
                    "redis-server",
                    "--port",
                    str(redis_port),
                ]
                try:
                    result = self._run_cmd(cmd, host, user)
                except FileNotFoundError:
                    logger.critical(
                        "Docker is not installed or not in PATH. Cannot launch Redis."
                    )
                    self._stop_redis_containers()
                    sys.exit(1)
                except Exception as e:
                    logger.critical("Failed to launch Redis on %s: %s", host, e)
                    self._stop_redis_containers()
                    sys.exit(1)

                if result.returncode != 0:
                    if is_port_conflict(result.stderr):
                        # A publish failure leaves the fixed-name container in
                        # `Created` state -- remove it, or the next deploy fails
                        # on the name instead of reporting the real problem.
                        self._run_cmd(
                            ["docker", "rm", "-f", container_name], host, user
                        )
                        logger.critical(
                            "Redis port %d on %s is already in use. Free it or change "
                            "`redis_port` in global_controller.yaml.",
                            redis_port,
                            host,
                        )
                    else:
                        logger.critical(
                            "Failed to launch Redis on %s: %s",
                            host,
                            result.stderr.strip(),
                        )
                    self._stop_redis_containers()
                    sys.exit(1)

                self.redis_containers[host] = container_name
                self.redis_ports[host] = redis_port
                logger.info(
                    "Launched Redis container %s on %s:%d",
                    container_name,
                    host,
                    redis_port,
                )

            # Create a RedisClient for this node
            redis_client = RedisClient(host=connect_host, port=redis_port)
            try:
                _wait_for_redis(redis_client, host, redis_port)
            except TimeoutError as e:
                logger.critical("%s", e)
                sys.exit(1)
            self.node_redis[host] = redis_client
            if host == "localhost":
                self._redis_addr = (connect_host, redis_port)

        # Update the primary redis client to the local node's Redis
        if "localhost" in self.node_redis:
            self.redis = self.node_redis["localhost"]

        logger.info(
            "Redis ready on %d node(s); %d owned by this controller.",
            len(self.node_redis),
            len(self.redis_containers),
        )

    def _launch_metrics_collectors(self):
        """Start one machine-level metrics collector per unique host, as a sibling
        container -- launched the same way as Redis and the agents (`docker run` via
        _run_cmd, i.e. the local docker socket or remote SSH).

        Best-effort and idempotent, mirroring _launch_redis_containers: a collector
        already running on a host is reused; a launch failure is logged, not fatal.
        """
        if not CONTROLLER_IMAGE:
            logger.error(
                "CANYONOS_CONTROLLER_IMAGE is unset, so no machine metrics collector "
                "can be started; machine-level metrics will be missing."
            )
            return

        # Unique-host dedup (like _launch_redis_containers), tracking per host whether any
        # agent placed there requests a GPU -- so --gpus is only added where it's wanted
        # (it fails `docker run` on hosts without the nvidia container runtime).
        nodes = {}
        for ctrl in self.controllers:
            user = ctrl.get("user")
            redis_port = ctrl.get("redis_port", 6379)
            wants_gpu = bool(ctrl.get("resources", {}).get("gpu"))
            for host, _port in self._get_replica_placements(ctrl):
                node = nodes.setdefault(
                    host, {"user": user, "redis_port": redis_port, "gpu": False}
                )
                node["gpu"] = node["gpu"] or wants_gpu

        for host, node_cfg in nodes.items():
            user = node_cfg["user"]
            container_name = f"canyonos-metrics-{host.replace('.', '-')}"
            try:
                inspect = self._run_cmd(
                    ["docker", "inspect", "-f", "{{.State.Running}}", container_name],
                    host,
                    user,
                )
                if inspect.returncode == 0 and inspect.stdout.strip() == "true":
                    logger.info(
                        "Metrics collector already running on %s; reusing.", host
                    )
                    self._metrics_collectors[host] = container_name
                    continue
                # Clear any stale (stopped) container of the same name before recreating.
                self._run_cmd(["docker", "rm", "-f", container_name], host, user)

                cmd = [
                    "docker",
                    "run",
                    "-d",
                    "--name",
                    container_name,
                    "--restart",
                    "unless-stopped",
                    "--pid=host",
                    "--network=host",
                    "-v",
                    "/:/host:ro",
                ]
                if node_cfg["gpu"]:
                    cmd += ["--gpus", "all"]
                cmd += [
                    # With --network=host the collector reaches the host's published Redis
                    # port on loopback.
                    "-e",
                    "CANYONOS_REDIS_HOST=localhost",
                    "-e",
                    f"CANYONOS_REDIS_PORT={node_cfg['redis_port']}",
                    "-e",
                    f"CANYONOS_METRICS_KEY=machine:{host}:metrics",
                    "-e",
                    f"CANYONOS_POLL_INTERVAL={self.config.get('poll_interval', 5)}",
                    # The controller image's entrypoint launches the GC; override it to run
                    # the collector instead.
                    "--entrypoint",
                    "python",
                    CONTROLLER_IMAGE,
                    "-m",
                    "canyonos_core.machine_metrics_poller",
                ]
                result = self._run_cmd(cmd, host, user)
                if result.returncode == 0:
                    self._metrics_collectors[host] = container_name
                    logger.info(
                        "Started machine metrics collector %s on %s (key=machine:%s:metrics).",
                        container_name,
                        host,
                        host,
                    )
                else:
                    logger.warning(
                        "Failed to start metrics collector on %s: %s",
                        host,
                        (result.stderr or "").strip(),
                    )
            except Exception as e:
                logger.warning("Failed to start metrics collector on %s: %s", host, e)

    def _stop_metrics_collectors(self):
        """Stop and remove the machine metrics collector container on each host."""
        users = {}
        for ctrl in self.controllers:
            user = ctrl.get("user")
            for host, _port in self._get_replica_placements(ctrl):
                users.setdefault(host, user)
        for host, container_name in self._metrics_collectors.items():
            try:
                self._run_cmd(
                    ["docker", "rm", "-f", container_name], host, users.get(host)
                )
            except Exception as e:
                logger.warning("Failed to stop metrics collector on %s: %s", host, e)
        self._metrics_collectors.clear()

    def _stop_redis_containers(self):
        """Stop and remove all Redis containers owned by this controller."""
        failures = []
        nodes = {}
        for ctrl in self.controllers:
            if ctrl.get("provider", "local").upper() == "EC2":
                continue
            user = ctrl.get("user")
            redis_port = ctrl.get("redis_port", 6379)
            for host, _port in self._get_replica_placements(ctrl):
                nodes.setdefault(host, {"user": user, "redis_port": redis_port})
        for host, container_name in list(self.redis_containers.items()):
            user = nodes.get(host, {}).get("user")
            errors = []
            for action in ("stop", "rm"):
                try:
                    result = self._run_cmd(
                        ["docker", action, container_name], host, user
                    )
                    if (
                        result.returncode != 0
                        and "no such container" not in (result.stderr or "").lower()
                    ):
                        errors.append(
                            f"docker {action} exited with code {result.returncode}: {(result.stderr or '').strip()}"
                        )
                except Exception as e:
                    errors.append(f"docker {action}: {e}")
            if errors:
                detail = f"Redis {container_name} on {host}: " + "; ".join(errors)
                failures.append(detail)
                logger.warning("Failed to fully stop %s", detail)
            else:
                self.redis_containers.pop(host, None)
                self.node_redis.pop(host, None)
                logger.info("Stopped Redis %s on %s", container_name, host)
        return failures

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
        expected = {
            spec["name"]: state.get_desired(self.redis, spec["name"], configured)
            for spec in self.controllers
            if (configured := state.replica_count(spec)) is not None
        }
        total = sum(expected.values())
        if not total and self.controllers:
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
        healthy = {}

        logger.info(
            "Waiting for %d replica(s) to become healthy (timeout=%ds)...",
            total,
            timeout,
        )

        while True:
            instances = list_instances(self.redis)
            any_instances_appeared = any_instances_appeared or bool(instances)
            pending = []
            healthy = {}
            for instance in instances:
                name = instance["agent_name"]
                host = instance["host"]
                port = instance["host_port"]
                node_redis = self.node_redis_for_instance(instance)
                endpoint = routing_endpoint_for(instance)
                status = node_redis.get(f"controller:{endpoint}:status")
                if status == "healthy":
                    healthy[name] = healthy.get(name, 0) + 1
                    instance_key = (name, host, port)
                    if instance_key not in ready:
                        logger.info("Controller %s (%s:%s) is ready.", name, host, port)
                        self._last_status[(host, port)] = "healthy"
                        ready.add(instance_key)
                else:
                    pending.append(instance)

            if all(healthy.get(name, 0) >= want for name, want in expected.items()):
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
            return

        for instance in pending:
            logger.warning(
                "Controller %s (%s:%s) not ready after %ds.",
                instance["agent_name"],
                instance["host"],
                instance["host_port"],
                timeout,
            )

        short = {
            name: (healthy.get(name, 0), want)
            for name, want in expected.items()
            if healthy.get(name, 0) < want
        }
        for name, (have, want) in short.items():
            logger.warning(
                "Agent %s has %d/%d healthy replica(s) after %ds.",
                name,
                have,
                want,
                timeout,
            )
        # An existing unhealthy replica fails startup; a missing one may still be provisioning.
        failing = {instance["agent_name"] for instance in pending}
        failed = {name: counts for name, counts in short.items() if name in failing}
        if not failed:
            return
        summary = ", ".join(
            f"{name} {have}/{want}" for name, (have, want) in failed.items()
        )
        raise RuntimeError(
            f"Agent replica(s) failed to become healthy within {timeout}s: {summary}"
        )

    # ------------------------------------------------------------------ #
    #  Polling loop                                                       #
    # ------------------------------------------------------------------ #

    def run(self):
        """Start the daemon polling loop."""
        pricing_refresh.refresh_llm_prices()
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

    def _poll_controllers(self):
        """
        Check the health of each registered controller replica via its node's Redis.
        Also retrieves the request calls made in each instance.
        """
        # Prevents a process from restarting if a deliberate kill-cmd happens
        if self.running:
            self.process_supervisor.check_and_respawn()

        # Polled in parallel, one instance's slow Redis round-trip no longer
        # gates every other instance's poll.
        instances = list_instances(self.redis)
        if instances:
            with ThreadPoolExecutor(max_workers=len(instances)) as executor:
                list(executor.map(self._poll_one_instance, instances))

        # Machine-level metrics are per-host, so they're read once per host here rather
        # than inside the per-instance loop above (N replicas on a box would otherwise
        # re-read and re-write the same machine sample N times).
        self._poll_machine_metrics()

    def _poll_machine_metrics(self):
        """Read each host's machine-level metrics hash (written by the per-machine
        collector, see _launch_metrics_collectors) and persist one time-series row per
        host into metrics_waiting. Best-effort: a host that hasn't reported yet or whose
        Redis is unreachable is skipped, never fatal.
        """
        project_id = self.config.get("project_id")
        hosts = {
            host
            for ctrl in self.controllers
            for host, _port in self._get_replica_placements(ctrl)
        }
        if not hosts:
            return

        def _read_host_metrics(host):
            try:
                metrics = self._get_node_redis_for(host).hgetall(
                    f"machine:{host}:metrics"
                )
                if metrics:
                    return {
                        "kind": "machine",
                        "host": host,
                        "project_id": project_id,
                        "metrics": metrics,
                    }
            except Exception as e:
                logger.warning(
                    "Failed to read machine metrics for host %s (non-fatal): %s",
                    host,
                    e,
                )
            return None

        # Read hosts in parallel, mirroring the per-instance poll above, so one host's
        # slow Redis round-trip doesn't gate the others.
        with ThreadPoolExecutor(max_workers=len(hosts)) as executor:
            rows = [row for row in executor.map(_read_host_metrics, hosts) if row]
        if rows:
            try:
                otel_writer.metric_write_rows(rows)
            except Exception as e:
                logger.warning(
                    "Failed to write machine metrics rows (non-fatal): %s", e
                )

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

        try:
            send_telemetry(node_redis, self.config.get("project_id"))
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
                # New OTel path: just poll the instance's hash and persist it verbatim --
                # no per-metric logic here (counter interpretation, rates, etc. all live in
                # the exporter's metric_convert). Counters are cumulative and never reset,
                # so the exporter can emit them as monotonic Sums.
                try:
                    otel_writer.metric_write_rows(
                        [
                            {
                                "kind": "agent",
                                "agent_id": instance.get("agent_id"),
                                "agent_name": name,
                                "host": host,
                                "port": port,
                                "project_id": self.config.get("project_id"),
                                "metrics": metrics,
                            }
                        ]
                    )
                except Exception as e:
                    logger.warning(
                        "Failed to write instance metrics row for %s (%s:%s) "
                        "(non-fatal): %s",
                        name,
                        host,
                        port,
                        e,
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

    def _apply_configured_replicas(self):
        """Set every agent's desired replica count to its configured value."""
        for spec in self.controllers:
            count = state.replica_count(spec)
            if count is None:
                logger.warning(
                    "Agent %s declares a non-integer replicas value (%r); "
                    "reconciliation needs a count, skipping it.",
                    spec["name"],
                    spec.get("replicas"),
                )
                continue
            self.set_replicas(spec["name"], count)

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
            # Container-reachable address (runtime_id:CONTAINER_PORT), not
            # instance["endpoint"] -- that's the host-published port
            # (e.g. localhost:8001), which the GC container can't reach.
            endpoint = routing_endpoint_for(instance)
            try:
                stub = self._get_lc_stub(endpoint)
                stub.Cleanup(local_controler_pb2.JsonResponse(resonse=payload))
                logger.debug(
                    "Sent Cleanup batch of %d request(s) to %s",
                    len(all_completed),
                    endpoint,
                )
                return True
            except Exception as e:
                logger.warning("Failed to trigger cleanup on %s: %s", endpoint, e)
                return False

        instances = list_instances(self.redis)
        if not instances:
            logger.warning(
                "No instances to broadcast cleanup to; leaving %d request(s) queued.",
                len(all_completed),
            )
            return

        with ThreadPoolExecutor(max_workers=len(instances)) as executor:
            if not all(executor.map(_send, instances)):
                logger.warning(
                    "Cleanup broadcast failed for at least one instance; leaving %d "
                    "request(s) queued for retry on the next cycle.",
                    len(all_completed),
                )
                return

        logger.info(
            "Triggered cleanup for %d completed request(s) across %d node(s)",
            len(all_completed),
            len(completed_by_client),
        )
        for client, completed in completed_by_client.items():
            client.srem("request:completed", *completed)

    # ------------------------------------------------------------------ #
    #  Runtime launching                                                  #
    # ------------------------------------------------------------------ #

    # ------------------------------------------------------------------ #
    #  Shutdown                                                           #
    # ------------------------------------------------------------------ #

    def cleanup(self):
        """Full cleanup — stop all containers and Redis, called on exit."""
        logger.info("Cleaning up all resources...")
        return self.stop()

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
        """Gracefully shut down the daemon and all agent processes.

        Returns what it could not remove rather than raising: this runs from a
        signal handler and again from atexit, where an exception would skip the
        handler's own exit and then repeat on the way out.
        """
        # A second signal arriving mid-drain must not start a second teardown.
        if self._stopping:
            return []
        self._stopping = True
        self.running = False

        failures = []
        drained = False
        try:
            drained = self._drain_instances()
        except Exception as e:
            failures.append(f"instance drain: {e}")
        # The reconciler does the removing, so it has to outlive the drain; clearing
        # the flag before it dies would have it refill everything just removed.
        try:
            self.process_supervisor.terminate_all()
        except Exception as e:
            failures.append(f"supervised processes: {e}")
        try:
            state.clear_draining(self.redis)
        except Exception as e:
            failures.append(f"draining flag: {e}")
        self._stop_metrics_collectors()
        # Instance records live in Redis; removing it with instances left would orphan them.
        if drained and not failures:
            failures += self._stop_redis_containers() or []
        else:
            failures.append("redis: kept for the next startup to reconcile")
        if failures:
            logger.error("Cleanup incomplete:\n- %s", "\n- ".join(failures))
        else:
            logger.info("Global controller shut down.")
        return failures


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
