# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The Global Controller: deploys a project's agents, runs the reconciler and OTel
exporter beside it, and tracks controller health in Redis."""
# Global Controller
# Daemon process that maintains a routing table in Redis for multiple local controllers.
# Periodically polls Redis to check controller health and updates the routing table.

import atexit
import json
import logging
import os
import re
import signal
import sys
import threading
import time
import uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from functools import cached_property

import yaml
from canyonos_core.controller.controller_context import (
    ControllerContext,
    _redis_connect_host,
    replica_id_from_record,
    list_replicas,
)
from canyonos_core.controller import scaling
from canyonos_core.controller.orchestrator import TARGET_ENV, orchestrator_for
from canyonos_core.endpoint import ADDRESS_KEY, endpoint_record
from canyonos_core.scaling import contract
from canyonos_core.controller.utils import otel_writer, pricing_refresh, schema
from canyonos_core.controller.utils.otel_writer import send_telemetry
from canyonos_core.controller.utils.container_log import dump_container_log
from canyonos_core.controller.utils.container_names import (
    CONTROLLER_IMAGE,
    metrics_container_name,
    project_label_args,
    redis_container_name,
)
from canyonos_core.llm_gateway import pricing
from canyonos_core.reconciler import state
from canyonos_core.controller.utils.config_specs import write_config_specs
from canyonos_core.controller.utils.env_file import resolve_env_file
from canyonos_core.controller.utils.process_supervisor import ProcessSupervisor
from canyonos_core.controller.utils.port_utils import is_port_conflict
from canyonos_core.controller.utils.redis_utils import _wait_for_redis
from canyonos_core.reconciler.providers.shared_utils.resource_limits import (
    resource_limit_args,
)
from canyonos_core.controller.utils.redis_client import RedisClient
from canyonos_core.controller.utils.grpc_options import GRPC_CHANNEL_OPTIONS
from canyonos_core.schema import SchemaError, check_project, load_manifest
from canyonos_core.schema.yaml_lines import load_yaml_lines

# Add generated grpc_stubs from the local project to the path. Projects using
# the .canyon artifact layout keep grpc_stubs under .canyon/; older/plain layouts
# keep it at the project root.
_artifact_prefix = ".canyon" if os.path.isdir(".canyon") else ""
sys.path.insert(0, os.path.abspath(os.path.join(_artifact_prefix, "grpc_stubs")))
import local_controller_pb2
import local_controller_pb2_grpc
import grpc

logging.basicConfig(level=logging.INFO)
# How long before the GC tells every replica again to clean up a request it already
# told them about, should a Cleanup have been lost.
CLEANUP_RESEND_SECONDS = 30

logger = logging.getLogger(__name__)

# Teardown waits this long for the reconciler to drain every replica and terminate every
# machine: the 180-second drain plus removal; any left over keep Redis up for the next startup.
STOP_TIMEOUT_SECONDS = 240

LOCAL_NETWORK = "canyonos-local"
# Docker Desktop's name for the host machine; it means nothing inside a cluster.
DOCKER_HOST = "host.docker.internal"
GLOBAL_CONTROLLER_LOG_SOURCE = "Global Controller"

# How long a replica may stay short of "healthy" before the deploy is called dead; covers the slowest cold start.
CONTROLLER_READY_TIMEOUT_SECONDS = 360

# Statuses a container publishes on its way out. Nothing republishes over them, so
# waiting on one can only ever time out.
_TERMINAL_STATUSES = frozenset({"failed", "stopped"})


def _live_first(version):
    """Decides which version of a prompt agents get: the one marked `live: true`, otherwise the one with the highest `-v<n>`, and if those tie, the most recently updated."""
    n = re.search(r"-v(\d+)$", str(version.get("version", "")))
    return (
        version.get("live") is True,
        int(n.group(1)) if n else 0,
        version.get("updated_at") or "",
    )


def _live_prompts(document):
    """Checks that prompts.yaml is well formed and returns the version agents should get for each prompt, raising an error that names the problem if the file is malformed."""
    prompts = (document.get("prompts") or {}) if isinstance(document, dict) else None
    if not isinstance(prompts, dict):
        raise ValueError("prompts.yaml must have a `prompts:` mapping of prompt names")
    live = {}
    for name, versions in prompts.items():
        if not isinstance(versions, list) or not all(
            isinstance(version, dict) for version in versions
        ):
            raise ValueError(
                f"prompts.yaml: prompt {name!r} must be a list of versions, each with `version` and `content`"
            )
        if versions:
            live[name] = max(versions, key=_live_first)
    return live


class GlobalController(ControllerContext):
    """
    Daemon that manages a routing table across the local controllers of multiple replicas.

    At startup it reads a YAML config file listing known agents, writes the
    initial routing table to Redis, then enters a polling loop that periodically
    checks controller health and refreshes the table.

    Designed to be subclassed — override the _on_* hooks to extend behavior.
    """

    POLICY_RULES_KEY = "policy:rules"
    IDENTITY_KEY = "controller:identity"  # has the controller's current project_id
    OTEL_DESTINATIONS_KEY = "otel:destinations"  # otel_exporter subprocess polls this to pick up config changes
    # Redis keys of the config files last published, so a removed file's key is cleared.
    CONFIG_FILES_KEY = "config:files"

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
        self._lc_stubs = {}  # address -> gRPC stub
        # Clean up anything a previous run left behind
        self.orchestrator.remove_stale_containers()

        self.process_supervisor = ProcessSupervisor()
        try:
            # Start what the replicas need, then write routing table and policies
            self.orchestrator.start_support_services()
            # Fetched before any replica starts, so every gateway finds them in Redis at startup.
            self.llm_prices = pricing_refresh.litellm_prices()
            pricing.add_prices(self.llm_prices)
            self._apply_config(
                self._read_config_folder(), load_manifest(self.config_path)
            )
            # A stop killed midway leaves the flag set; clear it or the fleet stays at zero.
            state.clear_stopping(self.redis)
            logger.info(
                "Global controller initialized with %d controller(s).",
                len(self.agent_specs),
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
            if self.config.get("logs", True):
                logging.getLogger().addHandler(
                    otel_writer.ProcessLogHandler(
                        GLOBAL_CONTROLLER_LOG_SOURCE, self.config.get("project_id")
                    )
                )
            self.orchestrator.register_background_processes(self.process_supervisor)
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
            self.orchestrator.undo_support_services()
            raise

    @cached_property
    def orchestrator(self):
        """Who runs this project's replicas (controller/orchestrator.py), picked on first use."""
        return orchestrator_for(self)

    # ------------------------------------------------------------------ #
    #  Stale container removal                                             #
    # ------------------------------------------------------------------ #

    def _remove_stale_containers(self):
        """Remove this machine's Redis and metrics containers left stopped by previous runs."""
        logger.info("Checking for stale containers from previous runs...")
        for container_name in (
            redis_container_name("localhost"),
            metrics_container_name("localhost"),
        ):
            try:
                inspect = self._run_cmd(
                    ["docker", "inspect", "-f", "{{.State.Running}}", container_name],
                    "localhost",
                )
                if inspect.returncode == 0 and inspect.stdout.strip() == "true":
                    continue  # already running -- reused, not stale
                self._run_cmd(["docker", "rm", "-f", container_name], "localhost")
            except Exception:
                pass  # Container didn't exist, that's fine

        logger.info("Stale container removal complete.")

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
        """Generate a project_id and write it to the config file so it stays stable across reloads/restarts.

        A `project_id:` already in the file with no value is replaced in place;
        appending a second one would make the file a duplicate-key error.
        """
        project_id = str(uuid.uuid4())
        entry = f'project_id: "{project_id}"\n'
        document = load_yaml_lines(config_path)
        with open(config_path, "r") as f:
            lines = f.readlines()
        if isinstance(document, dict) and "project_id" in document:
            lines[document.key_lines["project_id"] - 1] = entry
        else:
            if lines and not lines[-1].endswith("\n"):
                lines[-1] += "\n"
            lines.append(entry)
        with open(config_path, "w") as f:
            f.writelines(lines)
        return project_id

    @staticmethod
    def _otel_destinations(otel_cfg):
        """Resolve otel.destinations (${ENV_VAR} refs expanded), or None if absent.

        On Kubernetes, destinations on host.docker.internal (Docker Desktop's way back
        to the laptop, which no cluster has) are skipped, and None is returned when
        nothing is left: the exporter then flushes instead of exporting."""
        if "destinations" not in otel_cfg:
            return None
        destinations = ControllerContext._expand_env_value(otel_cfg["destinations"])
        if os.environ.get(TARGET_ENV) != "kubernetes":
            return destinations
        kept = []
        for destination in destinations or []:
            if DOCKER_HOST in str(destination.get("endpoint", "")):
                logger.info(
                    "Skipping OTel destination %s on Kubernetes: %s is unreachable "
                    "in a cluster.",
                    destination.get("name"),
                    DOCKER_HOST,
                )
            else:
                kept.append(destination)
        return kept or None

    def _write_otel_destinations(self, destinations):
        try:
            payload = json.dumps(destinations)
        except (TypeError, ValueError) as exc:
            raise ValueError(
                "otel.destinations must contain JSON-serializable values"
            ) from exc
        self.redis.set(self.OTEL_DESTINATIONS_KEY, payload)

    def reload_config(self):
        """Re-read the config, republish the spec, and let the reconciler converge.
        Raises SchemaError, changing nothing, when the edited config is invalid."""
        logger.info("Reloading config from %s", self.config_path)
        manifest, violations = check_project(self.config_path)
        if violations:
            raise SchemaError(violations)
        # Parse every file before writing anything, so a broken one leaves Redis untouched.
        config_files = self._read_config_folder()
        self.config = self._load_config(self.config_path)
        self.env_file_path = resolve_env_file(self.config)
        previous = set(self.agent_specs_by_name)
        self._set_agent_specs(self.config.get("agents", []))
        self.poll_interval = self.config.get("poll_interval", 5)
        self._apply_config(config_files, manifest)
        self.orchestrator.forget_removed_agents(
            previous - set(self.agent_specs_by_name)
        )

        # Only meaningful if the exporter was already running.
        destinations = self._otel_destinations(self.config.get("otel", {}))
        if destinations is not None and self.process_supervisor.is_registered(
            "otel_exporter"
        ):
            self._write_otel_destinations(destinations)

    def _apply_config(self, config_files, manifest):
        """Publish the loaded config to Redis: agent specs, replica counts, policies,
        identity, and where callers reach the endpoint, read from the validated
        `manifest`."""
        write_config_specs(self.agent_specs, self.redis)
        # The YAML is authoritative, so this overwrites any runtime scale.
        self._apply_configured_replicas()
        # Overwrites any dashboard edits, except prompts: the dashboard API owns prompts:config.
        self._write_policies(*config_files)
        self._write_identity()
        record = endpoint_record(manifest)
        self.redis.hset_multiple(
            ADDRESS_KEY, {**record, "arguments": json.dumps(record["arguments"])}
        )

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

    def _read_config_folder(self):
        """Parse policy rules and every YAML file in the config folder; returns (rules, payloads by Redis key, prompts.yaml's live versions or None)."""
        rules = self._load_policy_rules()
        config_dir = os.path.dirname(os.path.abspath(self.config_path))
        payloads = {}
        live_prompts = None
        for filename in sorted(os.listdir(config_dir)):
            name, extension = os.path.splitext(filename)
            if extension in (".yaml", ".yml"):
                with open(os.path.join(config_dir, filename), "r") as f:
                    # prompts.yaml only seeds the prompts the dashboard API stores and publishes.
                    key = "prompts:yaml" if name == "prompts" else f"{name}:config"
                    payloads[key] = json.dumps(yaml.safe_load(f) or {}, default=str)
                if name == "prompts":
                    live_prompts = _live_prompts(json.loads(payloads[key]))
        return rules, payloads, live_prompts

    def _write_policies(self, rules, payloads, live_prompts):
        """Publish policy rules, LiteLLM's prices, and each config file under its key, to every host Redis."""
        targets = list(self.machine_redis.values()) or [self.redis]
        rules_json = json.dumps(rules)
        prices_json = json.dumps(self.llm_prices)
        for redis_client in targets:
            redis_client.set(self.POLICY_RULES_KEY, rules_json)
            redis_client.set(pricing.LLM_PRICES_KEY, prices_json)
            # A file removed since the last publish must not leave its old config behind.
            for stale in set(redis_client.smembers(self.CONFIG_FILES_KEY)) - set(
                payloads
            ):
                redis_client.delete(stale)
            for key, payload in payloads.items():
                redis_client.set(key, payload)
            redis_client.delete(self.CONFIG_FILES_KEY)
            redis_client.sadd(self.CONFIG_FILES_KEY, *payloads)
        # Only an empty prompts:config: once the dashboard has published, its prompts are kept.
        if live_prompts is not None:
            self.redis.set(
                "prompts:config", json.dumps({"prompts": live_prompts}), nx=True
            )

        logger.info(
            "Policy rules and %d config file(s) written to %d Redis instance(s): %d rule(s)",
            len(payloads),
            len(targets),
            len(rules),
        )

    # Only relevant for demo purposes
    def _write_identity(self):
        """Publish the current project identity to every machine's Redis."""
        payload = {
            "project_id": str(self.config.get("project_id")),
            "project_name": os.environ.get("CANYONOS_PROJECT_NAME", ""),
        }
        targets = list(self.machine_redis.values()) or [self.redis]
        for redis_client in targets:
            redis_client.hset_multiple(self.IDENTITY_KEY, payload)

        logger.info(
            "Identity (project %s) published to %d Redis instance(s).",
            payload["project_id"],
            len(targets),
        )

    # The reconciler publishes the routing table; these keys are read-only here:
    # - self.redis.hgetall(self.ROUTING_ADDRESSES_KEY)
    # - self.redis.hget(self.ROUTING_ADDRESSES_KEY, service_name)

    def get_machine_redis(self, host):
        """Get the RedisClient for a specific machine."""
        return self.machine_redis.get(host)

    # ------------------------------------------------------------------ #
    #  Redis container management                                         #
    # ------------------------------------------------------------------ #

    def _redis_container_running(self, container_name, host):
        """Whether a Redis container by this name exists and is running."""
        inspect = self._run_cmd(
            ["docker", "inspect", "-f", "{{.State.Running}}", container_name],
            host,
        )
        return inspect.returncode == 0 and inspect.stdout.strip() == "true"

    def _redis_container_serves_port(self, container_name, host, redis_port):
        """Whether the Redis container is serving this port."""
        result = self._run_cmd(
            ["docker", "port", container_name, f"{redis_port}/tcp"], host
        )
        return result.returncode == 0

    def _redis_responds(self, host, connect_host, redis_port):
        """Check whether a Redis on this machine is already up and answering."""
        try:
            probe = RedisClient(host=connect_host, port=redis_port)
            _wait_for_redis(probe, host, redis_port, timeout=5, interval=1)
            return True
        except TimeoutError:
            return False

    def _launch_redis_containers(self):
        """Launch this machine's Redis container, reusing one that's already healthy.
        A machine in the pool gets its Redis when the reconciler starts it."""
        host = "localhost"
        redis_port = self.config.get("redis", {}).get("port", 6379)
        container_name = redis_container_name(host)
        connect_host = _redis_connect_host(host)

        running = self._redis_container_running(container_name, host)
        # Without this the ping below could be answered by an unrelated Redis
        # on that port, and the GC would adopt it as its own.
        if running and not self._redis_container_serves_port(
            container_name, host, redis_port
        ):
            logger.critical(
                "Redis container %s on %s is not serving port %d. Remove it "
                "with `docker rm -f %s`, or change `redis.port` in "
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
            self._run_cmd(["docker", "network", "create", LOCAL_NETWORK], host)

            # Redis listens on the declared port inside the container too, so
            # agents reaching it by container name over the local network use
            # the same number the host does.
            cmd = [
                "docker",
                "run",
                "-d",
                *project_label_args(),
                "--name",
                container_name,
                "--network",
                LOCAL_NETWORK,
                *resource_limit_args(),
                "-p",
                f"{redis_port}:{redis_port}",
                "redis:alpine",
                "redis-server",
                "--port",
                str(redis_port),
            ]
            try:
                result = self._run_cmd(cmd, host)
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
                    self._run_cmd(["docker", "rm", "-f", container_name], host)
                    logger.critical(
                        "Redis port %d on %s is already in use. Free it or change "
                        "`redis.port` in global_controller.yaml.",
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

        # Create a RedisClient for this machine
        redis_client = RedisClient(host=connect_host, port=redis_port)
        try:
            _wait_for_redis(redis_client, host, redis_port)
        except TimeoutError as e:
            logger.critical("%s", e)
            sys.exit(1)
        self.machine_redis[host] = redis_client
        self._redis_addr = (connect_host, redis_port)
        # Update the primary redis client to the local machine's Redis
        self.redis = redis_client

        logger.info(
            "Redis ready on %d machine(s); %d owned by this controller.",
            len(self.machine_redis),
            len(self.redis_containers),
        )

    def _launch_metrics_collectors(self):
        """Start this machine's metrics collector as a sibling container, launched the
        same way as Redis and the agents.

        Best-effort and idempotent, mirroring _launch_redis_containers: a collector
        already running is reused; a launch failure is logged, not fatal.
        """
        if not CONTROLLER_IMAGE:
            logger.error(
                "CANYONOS_CONTROLLER_IMAGE is unset, so no machine metrics collector "
                "can be started; machine-level metrics will be missing."
            )
            return

        host = "localhost"
        # --gpus fails `docker run` on a machine without the nvidia container runtime.
        wants_gpu = any(
            agent_spec.get("resources", {}).get("gpu")
            for agent_spec in self.agent_specs
        )
        container_name = metrics_container_name(host)
        try:
            inspect = self._run_cmd(
                ["docker", "inspect", "-f", "{{.State.Running}}", container_name],
                host,
            )
            if inspect.returncode == 0 and inspect.stdout.strip() == "true":
                logger.info("Metrics collector already running on %s; reusing.", host)
                self._metrics_collectors[host] = container_name
                return
            # Clear any stale (stopped) container of the same name before recreating.
            self._run_cmd(["docker", "rm", "-f", container_name], host)

            cmd = [
                "docker",
                "run",
                "-d",
                *project_label_args(),
                "--name",
                container_name,
                "--restart",
                "unless-stopped",
                "--pid=host",
                "--network=host",
                "-v",
                "/:/host:ro",
            ]
            if wants_gpu:
                cmd += ["--gpus", "all"]
            cmd += [
                # With --network=host the collector reaches the host's published Redis
                # port on loopback.
                "-e",
                "CANYONOS_REDIS_HOST=localhost",
                "-e",
                f"CANYONOS_REDIS_PORT={self.config.get('redis', {}).get('port', 6379)}",
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
            result = self._run_cmd(cmd, host)
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
        """Stop and remove the machine metrics collector container."""
        for host, container_name in self._metrics_collectors.items():
            try:
                self._run_cmd(["docker", "rm", "-f", container_name], host)
            except Exception as e:
                logger.warning("Failed to stop metrics collector on %s: %s", host, e)
        self._metrics_collectors.clear()

    def _stop_redis_containers(self):
        """Stop and remove all Redis containers owned by this controller."""
        failures = []
        for host, container_name in list(self.redis_containers.items()):
            errors = []
            for action in ("stop", "rm"):
                try:
                    result = self._run_cmd(["docker", action, container_name], host)
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
                self.machine_redis.pop(host, None)
                logger.info("Stopped Redis %s on %s", container_name, host)
        return failures

    # ------------------------------------------------------------------ #
    #  Startup health check                                               #
    # ------------------------------------------------------------------ #

    def _wait_for_healthy(self, timeout=CONTROLLER_READY_TIMEOUT_SECONDS, interval=2):
        """
        Block until all controllers report healthy in Redis, or fail the deploy.

        A replica that exists but never reports healthy is fatal, as is one left
        with no record at all because its launch failed, and one that
        reports a terminal status ("failed", "stopped") is fatal at once: the
        rest of the timeout would be dead time before a verdict already decided,
        during which the reconciler may replace the container holding the cause.

        Args:
            timeout:  Maximum seconds to wait.
            interval: Seconds between checks.
        """
        expected = {
            agent_spec["name"]: state.get_desired(
                self.redis, agent_spec["name"], configured
            )
            for agent_spec in self.agent_specs
            if (configured := state.replica_count(agent_spec)) is not None
        }
        total = sum(expected.values())
        if not total and self.agent_specs:
            logger.critical(
                "No agent declares an integer replica count; nothing will be "
                "provisioned. Check `replicas` in %s.",
                self.config_path,
            )
            return

        started = time.time()
        deadline = started + timeout
        ready = set()
        pending = []
        healthy = {}

        logger.info(
            "Waiting for %d replica(s) to become healthy (timeout=%ds)...",
            total,
            timeout,
        )

        while True:
            replicas = list_replicas(self.redis)
            pending = []
            healthy = {}
            for replica in replicas:
                name = replica["agent_name"]
                host = replica["private_host"]
                port = replica["host_port"]
                machine_redis = self.orchestrator.machine_redis_for_replica(replica)
                address = replica["address"]
                status = machine_redis.get(f"controller:{address}:status")
                if status == "healthy":
                    healthy[name] = healthy.get(name, 0) + 1
                    replica_key = (name, host, port)
                    if replica_key not in ready:
                        logger.info("Controller %s (%s:%s) is ready.", name, host, port)
                        self._last_status[(host, port)] = "healthy"
                        ready.add(replica_key)
                else:
                    pending.append((replica, status))

            if all(healthy.get(name, 0) >= want for name, want in expected.items()):
                return
            terminal = [
                (replica, status)
                for replica, status in pending
                if status in _TERMINAL_STATUSES
            ]
            if terminal or time.time() >= deadline:
                break
            time.sleep(interval)

        waited = int(time.time() - started)
        for replica, status in pending:
            logger.warning(
                "Controller %s (%s:%s) is %s after %ds.",
                replica["agent_name"],
                replica["private_host"],
                replica["host_port"],
                status or "not ready",
                waited,
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
                waited,
            )
        # A replica with no record at all failed to launch; an unfinished record may still be launching.
        recorded = Counter(
            self.redis.hgetall(key).get("agent_name")
            for key in self.redis.scan_keys("agent_instance:*")
        )
        failing = {replica["agent_name"] for replica, _ in pending}
        failed = {
            name: (have, want)
            for name, (have, want) in short.items()
            if name in failing or recorded[name] < want
        }
        if not failed:
            return

        # The cause (e.g. an adapter's ModuleNotFoundError) exists only inside the
        # container, which teardown removes. After a terminal status the others' logs
        # hold nothing yet; a timeout shows every laggard.
        for replica, status in terminal or pending:
            if replica["agent_name"] in failed:
                dump_container_log(replica, status, self.orchestrator.replica_log_tail)

        summary = ", ".join(
            f"{name} {have}/{want}" for name, (have, want) in failed.items()
        )
        raise RuntimeError(
            f"Agent replica(s) failed to become healthy within {waited}s: {summary}"
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
                try:
                    self._sync_prompts()
                except Exception as e:
                    logger.warning("Prompt sync encountered an error: %s", e)
                try:
                    self._apply_scaling()
                except Exception as e:
                    logger.warning("Scaling policy encountered an error: %s", e)
                self._cleanup_ready.set()
                time.sleep(self.poll_interval)
        except KeyboardInterrupt:
            self.stop()

    def _sync_prompts(self):
        """Copy dashboard edits to prompts:config from this Redis to the other machines' Redis."""
        payload = self.redis.get("prompts:config")
        if payload is None:
            return
        for redis_client in self.machine_redis.values():
            # Writing the snapshot back to its source would clobber an edit saved since the read.
            if redis_client is self.redis:
                continue
            redis_client.set("prompts:config", payload)

    def _poll_controllers(self):
        """
        Check the health of each registered controller replica via its machine's Redis.
        Also retrieves the request calls made in each replica.
        """
        # Prevents a process from restarting if a deliberate kill-cmd happens
        if self.running:
            self.process_supervisor.check_and_respawn()

        # Polled in parallel, one replica's slow Redis round-trip no longer
        # gates every other replica's poll.
        replicas = list_replicas(self.redis)
        self.remove_unused_redis_clients(replicas)
        replica_samples = []
        if replicas:
            with ThreadPoolExecutor(max_workers=len(replicas)) as executor:
                replica_samples = list(executor.map(self._poll_one_replica, replicas))

        self._send_telemetry_per_host()

        # Machine-level metrics are per-host, so they're read once per host here rather
        # than inside the per-replica loop above (N replicas on a box would otherwise
        # re-read and re-write the same machine sample N times).
        self.orchestrator.poll_machine_metrics()
        # A draining replica is on its way out, so it must not count towards scaling.
        self._record_agent_samples(
            [
                sample
                for replica, sample in zip(replicas, replica_samples)
                if sample and "draining_at" not in replica
            ]
        )

    def _send_telemetry_per_host(self):
        """Queue the futures' telemetry from each machine's Redis, once per poll.

        Telemetry lives in the machine's Redis, not in a replica: polled per replica,
        every replica on a machine would scan and queue the same futures again. Hosts
        are read in parallel, like _poll_machine_metrics, so a slow one does not hold
        up the others.
        """
        hosts = dict(self.machine_redis)
        # Futures already queued finished, per host, so a poll reads only those still
        # running or new. One set per host: the threads share nothing.
        finished = self.__dict__.setdefault("_finished_futures", {})
        for host in list(finished):
            if host not in hosts:
                del finished[host]
        for host in hosts:
            finished.setdefault(host, set())
        if not hosts:
            return

        def send(host):
            try:
                send_telemetry(
                    hosts[host],
                    self.config.get("project_id"),
                    finished=finished[host],
                )
            except Exception as e:
                logger.warning(
                    "Failed to queue telemetry for host %s (non-fatal): %s", host, e
                )

        with ThreadPoolExecutor(max_workers=len(hosts)) as executor:
            list(executor.map(send, hosts))

    def _poll_machine_metrics(self):
        """Read this machine's metrics hash (written by its collector, see
        _launch_metrics_collectors) and persist it as one time-series row in
        metrics_waiting. Best-effort: a hash not written yet or an unreachable Redis is
        skipped, never fatal.
        """
        try:
            metrics = self.redis.hgetall("machine:localhost:metrics")
            if metrics:
                otel_writer.metric_write_rows(
                    [
                        {
                            "kind": "machine",
                            "host": "localhost",
                            "project_id": self.config.get("project_id"),
                            "metrics": metrics,
                        }
                    ]
                )
        except Exception as e:
            logger.warning("Failed to record machine metrics (non-fatal): %s", e)

    def _poll_one_replica(self, replica):
        """Poll and persist one replica's runtime/metrics/health data and return its scaling sample; never raises."""
        try:
            name = replica["agent_name"]
            host = replica["private_host"]
            port = replica["host_port"]
            machine_redis = self.orchestrator.machine_redis_for_replica(replica)
        except Exception as e:
            logger.warning("Failed to poll replica %s: %s", replica, e)
            return

        address = replica["address"]
        status_key = f"controller:{address}:status"
        metrics_key = f"controller:{address}:metrics"

        # Getting metrics from local controllers
        # See LocalController._execute_locally
        metrics = None
        try:
            metrics = machine_redis.hgetall(metrics_key)
            if metrics:
                # Persist the replica's hash verbatim; all per-metric logic lives in
                # metric_convert. Counters are cumulative and never reset, so they
                # export as monotonic Sums.
                try:
                    otel_writer.metric_write_rows(
                        [
                            {
                                "kind": "agent",
                                "agent_id": replica_id_from_record(replica),
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
                        "Failed to write replica metrics row for %s (%s:%s) "
                        "(non-fatal): %s",
                        name,
                        host,
                        port,
                        e,
                    )

        except Exception as e:
            logger.warning(
                "Failed to poll metrics for replica %s (%s:%s): %s",
                name,
                host,
                port,
                e,
            )

        sample = None
        if metrics:
            try:
                sample = self._record_replica_sample(replica, metrics)
            except Exception as e:
                logger.warning(
                    "Failed to record scaling sample for replica %s (%s:%s) "
                    "(non-fatal): %s",
                    name,
                    host,
                    port,
                    e,
                )

        try:
            status = machine_redis.get(status_key) or "unknown"
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
                "Failed to poll status for replica %s (%s:%s): %s",
                name,
                host,
                port,
                e,
            )
        return sample

    def _record_replica_sample(self, replica, metrics):
        """Record one replica's load for the scaling policy and return the sample."""
        key = contract.replica_key(replica_id_from_record(replica))
        previous = contract.latest(self.redis, key)
        observed_at = contract.now()
        counters = {
            field: int(metrics.get(field, 0))
            for field in (
                "requests_served",
                "full_failures",
                "requests_completed",
                "queue_time_ms_total",
                "execution_ms_total",
            )
        }
        sample = contract.replica_sample(
            agent_name=replica["agent_name"],
            queue_length=int(metrics.get("queue_length", 0)),
            **counters,
            requests_per_minute=contract.per_minute(
                previous,
                "requests_completed",
                counters["requests_completed"],
                observed_at,
            ),
            failures_per_minute=contract.per_minute(
                previous, "full_failures", counters["full_failures"], observed_at
            ),
            avg_queue_time_ms=contract.mean_since(
                previous, counters, "queue_time_ms_total", "requests_completed"
            ),
            avg_execution_ms=contract.mean_since(
                previous, counters, "execution_ms_total", "requests_completed"
            ),
            observed_at=observed_at,
        )
        contract.push(self.redis, key, sample)
        return sample

    def _record_agent_samples(self, replica_samples):
        """Roll this poll's replica samples up into one scaling sample per agent."""
        by_agent = {agent_name: [] for agent_name in self.agent_specs_by_name}
        for sample in replica_samples:
            if sample["agent_name"] in by_agent:
                by_agent[sample["agent_name"]].append(sample)

        observed_at = contract.now()
        for agent_name, samples in by_agent.items():
            running = len(samples)
            requests_per_minute = sum(s["requests_per_minute"] for s in samples)
            contract.push(
                self.redis,
                contract.agent_key(agent_name),
                contract.agent_sample(
                    replicas_running=running,
                    replicas_expected=state.get_desired(self.redis, agent_name),
                    queue_length_total=sum(s["queue_length"] for s in samples),
                    requests_per_minute_total=requests_per_minute,
                    requests_per_minute_per_replica=(
                        requests_per_minute / running if running else 0.0
                    ),
                    failures_per_minute=sum(s["failures_per_minute"] for s in samples),
                    avg_queue_time_ms=contract.average(samples, "avg_queue_time_ms"),
                    avg_execution_ms=contract.average(samples, "avg_execution_ms"),
                    observed_at=observed_at,
                ),
            )

    def _set_replicas(self, agent_name, count):
        """Change one agent's replica count without touching the others; the entry point for scaling."""
        if agent_name not in self.agent_specs_by_name:
            logger.warning("Cannot scale unknown agent %s", agent_name)
            return None
        return self.orchestrator.set_replicas(agent_name, count)

    def _apply_scaling(self):
        """Apply the scaling policy's replica changes to each agent's desired count."""
        for agent_name, delta in scaling.scale(self):
            current = state.get_desired(self.redis, agent_name)
            self._set_replicas(agent_name, current + delta)

    def _apply_configured_replicas(self):
        """Reset every agent's replica count to what the YAML says, at startup and on reload."""
        counts = {}
        for agent_spec in self.agent_specs:
            count = state.replica_count(agent_spec)
            if count is None:
                logger.warning(
                    "Agent %s declares a non-integer replicas value (%r); "
                    "reconciliation needs a count, skipping it.",
                    agent_spec["name"],
                    agent_spec.get("replicas"),
                )
                continue
            counts[agent_spec["name"]] = count
        self.orchestrator.apply_configured_replicas(counts)

    def _replace_replica(self, agent_name, replica_index):
        """Remove one replica; the desired count is unchanged, so the slot is refilled."""
        if agent_name not in self.agent_specs_by_name:
            logger.warning("Cannot replace a replica of unknown agent %s", agent_name)
            return None
        return self.orchestrator.replace_replica(agent_name, replica_index)

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

    def _get_lc_stub(self, address):
        """Get or create a cached gRPC stub for a local controller address."""
        if address not in self._lc_stubs:
            channel = grpc.insecure_channel(address, options=GRPC_CHANNEL_OPTIONS)
            self._lc_stubs[address] = local_controller_pb2_grpc.LocalControllerStub(
                channel
            )
        return self._lc_stubs[address]

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
        """Drain completed requests whose futures are gone, and broadcast a batched Cleanup gRPC to all replicas for every delivered one, gathered from every machine's Redis."""
        # Falls back to self.redis alone if machine_redis is unset/empty.
        machine_redis_map = getattr(self, "machine_redis", None) or {}
        redis_clients = list(machine_redis_map.values()) or [self.redis]

        completed_by_client = {}
        all_completed = set()
        for client in redis_clients:
            completed = client.smembers("request:completed")
            if completed:
                completed_by_client[client] = completed
                all_completed.update(completed)

        if not all_completed:
            return

        delivered, gone = otel_writer.deliver_completed_requests(
            redis_clients,
            all_completed,
            getattr(self, "config", {}).get("project_id"),
        )
        # A request leaves "request:completed" only once its futures are gone on every
        # machine. A Cleanup that fails or never arrives leaves them in place, so the
        # request stays delivered and is sent again next cycle.
        for client, completed in completed_by_client.items():
            to_remove = completed & gone
            if to_remove:
                client.srem("request:completed", *to_remove)
        if gone:
            logger.info("Drained %d cleaned-up request(s)", len(gone))

        # Requests every replica was told about recently stay delivered until their
        # keys expire; telling them again each cycle only repeats the work. They are
        # sent again after CLEANUP_RESEND_SECONDS, in case a Cleanup was lost.
        sent_at = self.__dict__.setdefault("_cleanup_sent", {})
        now = time.monotonic()
        for request_id in list(sent_at):
            if request_id not in delivered:
                del sent_at[request_id]
        delivered = {
            request_id
            for request_id in delivered
            if now - sent_at.get(request_id, -CLEANUP_RESEND_SECONDS)
            >= CLEANUP_RESEND_SECONDS
        }
        if not delivered:
            return

        payload = json.dumps({"request_ids": list(delivered)})

        def _send(replica):
            # Not replica["published_address"]: the GC container can't reach a host-published port.
            address = replica["address"]
            try:
                stub = self._get_lc_stub(address)
                stub.Cleanup(local_controller_pb2.JsonResponse(response=payload))
                logger.debug(
                    "Sent Cleanup batch of %d request(s) to %s",
                    len(delivered),
                    address,
                )
                return True
            except Exception as e:
                logger.warning("Failed to trigger cleanup on %s: %s", address, e)
                return False

        replicas = list_replicas(self.redis)
        if not replicas:
            logger.warning(
                "No replicas to broadcast cleanup to; %d delivered request(s) wait "
                "for the next cycle.",
                len(delivered),
            )
            return

        with ThreadPoolExecutor(max_workers=len(replicas)) as executor:
            sent = sum(executor.map(_send, replicas))
        if sent == len(replicas):
            sent_at.update(dict.fromkeys(delivered, now))
        logger.info(
            "Sent cleanup for %d delivered request(s) to %d of %d replica(s)",
            len(delivered),
            sent,
            len(replicas),
        )

    # ------------------------------------------------------------------ #
    #  Replica launching                                                  #
    # ------------------------------------------------------------------ #

    # ------------------------------------------------------------------ #
    #  Shutdown                                                           #
    # ------------------------------------------------------------------ #

    def cleanup(self):
        """Full cleanup — stop all containers and Redis, called on exit."""
        logger.info("Cleaning up all resources...")
        return self.stop()

    def _remove_all_replicas(self, timeout=STOP_TIMEOUT_SECONDS, interval=1):
        """Have the reconciler remove every replica and then terminate every machine, then
        forget the endpoint's address. True once none are left."""
        state.set_stopping(self.redis)
        state.request_reconcile(self.redis)
        deadline = time.time() + timeout

        while True:
            try:
                # Unfinished launches too; machines go only once every replica has.
                remaining = self.redis.scan_keys(
                    "agent_instance:*"
                ) + self.redis.scan_keys("machine_record:*")
            except Exception as e:
                logger.warning("Failed to read records while stopping: %s", e)
                return False
            if not remaining:
                self.redis.delete(ADDRESS_KEY)
                logger.info("All agent replicas and machines removed.")
                return True
            if time.time() >= deadline:
                logger.warning(
                    "Records still in Redis after %ds: %s; the next startup's "
                    "reconcile removes whichever replicas are unhealthy or unfinished, "
                    "and the next stop terminates the machines.",
                    timeout,
                    ", ".join(sorted(remaining)),
                )
                return False
            time.sleep(interval)
            state.set_stopping(self.redis)

    def stop(self):
        """Gracefully shut down the daemon and all agent processes.

        Returns what it could not remove rather than raising: this runs from a
        signal handler and again from atexit, where an exception would skip the
        handler's own exit and then repeat on the way out.
        """
        # A second signal arriving mid-stop must not start a second teardown.
        if self._stopping:
            return []
        self._stopping = True
        self.running = False

        failures = []
        removed = False
        try:
            removed = self.orchestrator.remove_all_replicas()
        except Exception as e:
            failures.append(f"replica removal: {e}")
        # Whatever removes the replicas has to outlive `remove_all_replicas`, so the
        # supervised processes stop only now, and the support services after them.
        try:
            self.process_supervisor.terminate_all()
        except Exception as e:
            failures.append(f"supervised processes: {e}")
        failures += self.orchestrator.stop_support_services(removed and not failures)
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
            logger.warning(
                "Reload Failed, A configuration file change is invalid: %s", e
            )

    signal.signal(signal.SIGHUP, _reload_handler)
    atexit.register(controller.cleanup)

    controller._wait_for_healthy()
    controller.run()
