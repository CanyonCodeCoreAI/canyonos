# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The Local Controller: runs inside each agent replica's container, takes requests from
the queue, and runs them on the agent or forwards them to another controller."""
# Local Controller
# Starts the gRPC frontend server and polls the request queue for incoming requests.
# Routes requests to the correct agent — either locally or by forwarding to another controller.

import json
import logging
import os
import random
import sys
import threading
import time
import importlib.util
from concurrent.futures import ThreadPoolExecutor, wait

import grpc

try:
    from canyonos_core.controller import gateway_headers
    from canyonos_core.controller.local_controller_frontend import start_server
    from canyonos_core.controller.utils.gpu_metrics import read_gpu_percent
    from canyonos_core.controller.utils.redis_client import RedisClient
    from canyonos_core.controller.utils.grpc_options import (
        GRPC_CHANNEL_OPTIONS,
        call_with_retry,
    )
    from canyonos_core.controller.utils.log_handler import LogHandler
    from canyonos_core.controller.utils.log_entry import (
        build_failure_entry,
        append_log_entry,
        error_type_name,
    )
except ImportError:
    import gateway_headers
    from gpu_metrics import read_gpu_percent
    from local_controller_frontend import start_server
    from log_handler import LogHandler
    from redis_client import RedisClient
    from grpc_options import GRPC_CHANNEL_OPTIONS, call_with_retry
    from log_entry import build_failure_entry, append_log_entry, error_type_name

# Add local generated grpc_stubs to path (Docker context copies them directly to /app)
sys.path.insert(0, ".")
sys.path.insert(0, "/app")
sys.path.insert(0, os.path.abspath("grpc_stubs"))

try:
    import canyonos_core.controller.canyonos_context as canyonos_context
except ImportError:
    import canyonos_context

canyonos_context.install()
gateway_headers.install(
    canyonos_context.get_current_future_id, canyonos_context.get_current_function
)

import local_controler_pb2
import local_controler_pb2_grpc

try:
    from canyonos_core.controller.future import Future
except ImportError:
    from future import Future


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

ROUTING_ENDPOINTS_KEY = "routing_table:endpoints"
ROUTING_STATEFUL_KEY = "routing_table:stateful"
POLICY_RULES_KEY = "policy:rules"
EXECUTOR_SHUTDOWN_TIMEOUT_SECONDS = 5
# A replica only queues a request forwarded to it, so one slower than this to
# accept it is stuck.
FORWARD_TIMEOUT_SECONDS = 2
# How long routing skips a replica after forwarding a request to it failed; the
# reconciler replaces it meanwhile.
REPLICA_DOWN_SECONDS = 30
FORWARD_RETRIES = 8
FUTURE_RESULT_TIMEOUT_SECONDS = 300
ENDPOINT_LOG_SOURCE = "Endpoint"


def log_source_name(agent_name):
    """Return the source name a replica's logs report: its agent, or `Endpoint` for the
    endpoint's controller, which has no agent."""
    return agent_name or ENDPOINT_LOG_SOURCE


def _resolved(value):
    """Wait on every Future in `value`, at any depth of dicts, lists and tuples, and
    return a copy with each one replaced by its result."""
    if isinstance(value, Future):
        return value.value(timeout=FUTURE_RESULT_TIMEOUT_SECONDS)
    if isinstance(value, dict):
        return {k: _resolved(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return type(value)(_resolved(v) for v in value)
    return value


class LocalController(object):
    """Manages the gRPC frontend and processes incoming requests from the queue."""

    def __init__(self, port=50051, publish_ready=True):
        self.port = port
        self.agent_host = os.environ.get("CANYONOS_AGENT_HOST", "localhost")
        self.agent_name = os.environ.get("CANYONOS_AGENT_NAME")
        self.agent_file = os.environ.get("CANYONOS_AGENT_FILE")
        # The endpoint's controller runs no agent: it only forwards calls.
        runs_agent = bool(self.agent_name or self.agent_file)

        # Public port is how the routing table and other nodes know us;
        # internally the gRPC server binds to `port` (50051 inside Docker).
        self.public_port = os.environ.get("CANYONOS_AGENT_PORT", str(port))

        self._my_endpoint = f"{self.agent_host}:{self.public_port}"

        self.server, self.servicer = start_server(port, my_endpoint=self._my_endpoint)
        self.request_queue = self.servicer.request_queue
        # Let the gRPC servicer fan a result out to this node's consumers as
        # soon as it arrives via WriteResult (see _fan_out_to_consumers).
        self.servicer.on_result = self._fan_out_to_consumers

        # Connect to Redis. Readiness is published only after a configured
        # agent has loaded successfully.
        redis_host = os.environ.get("CANYONOS_REDIS_HOST", "localhost")
        redis_port = int(os.environ.get("CANYONOS_REDIS_PORT", 6379))
        self.redis = RedisClient(host=redis_host, port=redis_port)
        self._load_routing()
        self._status_key = f"controller:{self.agent_host}:{self.public_port}:status"

        # Agent LLM calls go through the gateway, so it starts before ready.
        if runs_agent:
            try:
                self._gateway_process = self._start_llm_gateway(redis_host, redis_port)
            except Exception:
                # The status key has no TTL, so a stale "healthy" would outlive
                # this container.
                self.redis.set(self._status_key, "failed")
                self.server.stop(0)
                raise

        # Written by the Provisioner; stamps completed requests with the replica that ran them.
        self.agent_id = self.redis.get(
            f"controller:{self.agent_host}:{self.public_port}:agent_id"
        )

        # global_controller.yaml's `logs:` flag, on by default -- set `logs: false` to opt out. Only
        # gates the rich `logs` detail below -- never the cheap `error`/`failed` fields, always written.
        self.logs_enabled = (
            os.environ.get("CANYONOS_LOGS_ENABLED", "true").lower() == "true"
        )
        self._log_handler = None
        if self.logs_enabled:
            self._log_handler = LogHandler(
                self.redis,
                agent_id=self.agent_id,
                agent_name=log_source_name(self.agent_name),
                endpoint=self._my_endpoint,
            )
            logging.getLogger().addHandler(self._log_handler)

        # Periodically publish instance metrics, on the same cadence
        # GlobalController polls with (via CANYONOS_POLL_INTERVAL).
        self._metrics_key = f"controller:{self.agent_host}:{self.public_port}:metrics"
        self._metrics_interval = float(os.environ.get("CANYONOS_POLL_INTERVAL", 5))
        # One transaction, so a reader never sees "initializing" without a heartbeat to judge it by.
        # Cumulative request counters are always increasing, never reset. It is the consumers job to get the delta between polls to get the specific metrics.
        now = str(time.time())
        self.redis.set_with_hash(
            self._status_key,
            "initializing",
            self._metrics_key,
            {
                "started_at": now,
                "observed_at": now,
                "requests_served": 0,
                "full_failures": 0,
                "requests_completed": 0,
                "queue_time_ms_total": 0,
                "execution_ms_total": 0,
            },
        )
        self._metrics_stop_event = threading.Event()
        self._metrics_thread = threading.Thread(target=self._metrics_loop, daemon=True)
        self._ready = threading.Event()
        self._status_lock = threading.Lock()

        # Cache for gRPC stubs to remote controllers
        self._remote_channels = {}  # endpoint -> grpc.Channel
        self._remote_stubs = {}  # endpoint -> LocalControllerStub
        # Result callbacks on executor and gRPC threads create stubs too, not just
        # the loop that forwards requests.
        self._remote_stubs_lock = threading.Lock()

        # Policy rules cache (loaded lazily from Redis)
        self._policy_rules = None

        # Thread pool for executing agent methods concurrently.
        # This prevents deadlocks when an agent method creates nested Futures
        # that need to be routed through the same controller's request queue.
        max_instances = int(os.environ.get("CANYONOS_MAX_AGENT_INSTANCES", 16))
        self._executor = ThreadPoolExecutor(max_workers=max_instances)
        self._executor_futures = {}
        self._executor_futures_lock = threading.Lock()
        # endpoint -> time.monotonic() until which new picks skip it
        self._down_until = {}

        # Heartbeat through the agent load, so a slow constructor is not mistaken for a dead replica.
        self._metrics_thread.start()

        # Machine-level metrics come from a per-machine collector GlobalController
        # launches, since a container can't see the host (esp. the GPU). This keeps only
        # in-process metrics: queue length, counters, and health heartbeat.

        # After the gateway, which an agent constructor may call.
        self.agent = self._load_agent()
        if runs_agent and self.agent is None:
            self._metrics_stop_event.set()
            self._metrics_thread.join(timeout=2)
            self.mark_failed()
            self.server.stop(0)
            # Otherwise the gateway keeps the container alive, answering every
            # request with "No agent loaded" long after the cause has scrolled by.
            self._gateway_process.kill()
            raise RuntimeError(
                f"Failed to load configured agent {self.agent_name or self.agent_file}."
            )

        if publish_ready:
            self.mark_ready()

        logger.info(
            "Local controller initialized at %s (max_agent_instances=%d); %s.",
            self._my_endpoint,
            max_instances,
            "reported healthy to Redis"
            if publish_ready
            else "readiness left to the launcher",
        )

    def mark_ready(self):
        """Set this replica's status in Redis to `healthy`, which the Global Controller
        waits for before routing to it."""
        with self._status_lock:
            self._ready.set()
            self.redis.set(self._status_key, "healthy")

    def mark_failed(self):
        """Set this replica's status in Redis to `failed`, so the Global Controller no
        longer counts it as healthy."""
        with self._status_lock:
            self._ready.clear()
            self.redis.set(self._status_key, "failed")

    def mark_stopped(self):
        with self._status_lock:
            self._ready.clear()
            self.redis.set(self._status_key, "stopped")

    def _start_llm_gateway(self, redis_host, redis_port):
        """Start the LLM gateway as a subprocess in this container (127.0.0.1:8081).

        Fatal: the runtime force-injects LLM base-URL env vars that point every
        Bedrock/OpenAI/Anthropic SDK call at this gateway (`docker run -e` beats
        `--env-file`, so nothing can opt back out). If it fails to start, every
        LLM call in this container would silently fail or hang, not just lose
        telemetry -- so raise instead of limping on with no gateway listening.
        """
        import socket
        import subprocess
        import urllib.request

        # An orphaned gateway on 8081 would answer the /healthz probe below and mask
        # one of ours that never bound, so prove the port free before spawning.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as port_probe:
            port_probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                port_probe.bind(("127.0.0.1", 8081))
            except OSError as e:
                logger.error("127.0.0.1:8081 is already in use: %s", e)
                raise RuntimeError(
                    "127.0.0.1:8081 is already in use, so the LLM gateway cannot bind "
                    "it; agent LLM calls are routed through it unconditionally and "
                    "would otherwise fail silently."
                ) from e

        gateway_env = os.environ.copy()
        gateway_env.update(
            {
                "GATEWAY_HOST": "127.0.0.1",
                "GATEWAY_PORT": "8081",
                "CANYONOS_REDIS_HOST": redis_host,
                "CANYONOS_REDIS_PORT": str(redis_port),
            }
        )
        # The image gives the gateway its own venv so its packages never share versions with the agent's.
        gateway_python = "/opt/canyonos-gateway/bin/python"
        if not os.path.exists(gateway_python):
            gateway_python = sys.executable
        try:
            gateway_process = subprocess.Popen(
                [gateway_python, "-m", "canyonos_core.llm_gateway"],
                env=gateway_env,
            )
        except Exception as e:
            logger.error("Failed to start LLM gateway: %s", e)
            raise RuntimeError(
                "LLM gateway failed to start; agent LLM calls are routed through it "
                "unconditionally and would otherwise fail silently."
            ) from e

        # Popen only raises if the process can't be spawned -- it returns a healthy
        # handle even if the gateway starts and dies immediately, so poll /healthz.
        deadline = time.time() + 60
        last_error = None
        while time.time() < deadline:
            if gateway_process.poll() is not None:
                raise RuntimeError(
                    f"LLM gateway exited immediately (code {gateway_process.returncode}); "
                    "agent LLM calls are routed through it unconditionally and would "
                    "otherwise fail silently."
                )
            try:
                with urllib.request.urlopen(
                    "http://127.0.0.1:8081/healthz", timeout=0.5
                ):
                    break
            except OSError as e:
                last_error = e
            time.sleep(0.2)
        else:
            gateway_process.kill()
            raise RuntimeError(
                "LLM gateway did not become healthy on 127.0.0.1:8081 within 60s "
                f"(last health check: {last_error}); "
                "agent LLM calls are routed through it unconditionally and would "
                "otherwise fail silently."
            )

        logger.info(
            "Started LLM gateway on 127.0.0.1:8081 (PID: %d)", gateway_process.pid
        )
        return gateway_process

    def _collect_metrics(self):
        """Snapshot the in-process instance metrics LocalController owns.

        Machine-level metrics (cpu/gpu/disk/memory/uptime) are sampled by the separate
        per-machine collector container (see GlobalController._launch_metrics_collectors);
        only in-process state a sibling process can't observe stays here.

        requests_served is deliberately absent here -- it's incremented directly on
        the metrics hash (see _execute_locally) and drained by GlobalController after
        it reads it, not self-reset on this heartbeat's own timer. Self-resetting it
        here would silently drop counts for any interval GlobalController's poll
        loop falls behind on.
        """
        return {
            "status": "healthy",
            "queue_length": str(self._executor._work_queue.qsize()),
            "observed_at": str(time.time()),
        }

    def _metrics_loop(self):
        """Background thread: periodically publish instance metrics and refresh status."""
        while not self._metrics_stop_event.is_set():
            try:
                metrics = self._collect_metrics()
                self.redis.hset_multiple(self._metrics_key, metrics)
                with self._status_lock:
                    if self._ready.is_set():
                        self.redis.set(self._status_key, "healthy")
                self._load_policy_rules(reload=True)
                self._load_routing()
            except Exception as e:
                logger.warning("Metrics loop encountered an error: %s", e)
            self._metrics_stop_event.wait(self._metrics_interval)

    def _load_agent(self):
        """Dynamically load and instantiate the agent class."""
        if not self.agent_name or not self.agent_file:
            logger.warning(
                "CANYONOS_AGENT_NAME or CANYONOS_AGENT_FILE not set. Running without an agent."
            )
            return None

        # Use a dotted module name (e.g. "agents.aml_agent", not "agents/aml_agent")
        # so importlib derives __package__ correctly and package-relative imports
        # inside nested entrypoints (e.g. `from .prompts import PROMPT`) resolve.
        agent_module_name = (
            self.agent_file.replace(".py", "").replace(os.sep, ".").replace("/", ".")
        )

        # We assume the agent file is in the same directory as the local controller (e.g. copied by Docker)
        # or in the current working directory.
        agent_path = os.path.abspath(str(self.agent_file))

        if not os.path.exists(agent_path):
            logger.error(f"Agent file not found at {agent_path}")
            return None

        try:
            spec = importlib.util.spec_from_file_location(agent_module_name, agent_path)
            if spec is None or getattr(spec, "loader", None) is None:
                logger.error(
                    f"Cannot find spec or loader for module {agent_module_name} at {agent_path}"
                )
                return None
            loader = spec.loader
            assert loader is not None

            module = importlib.util.module_from_spec(spec)
            sys.modules[agent_module_name] = module
            loader.exec_module(module)

            agent_class = getattr(module, self.agent_name)
            agent_instance = agent_class()
            logger.info(
                f"Successfully loaded and instantiated agent: {self.agent_name}"
            )
            return agent_instance
        except Exception as e:
            # The traceback is what names the import that actually failed.
            logger.exception(
                f"Failed to load agent {self.agent_name} from {agent_path}: {e}"
            )
            return None

    # ------------------------------------------------------------------ #
    #  Policy evaluation                                                   #
    # ------------------------------------------------------------------ #

    def _load_policy_rules(self, reload=False):
        """Load policy rules from Redis (cached after first load unless reload is set)."""
        if self._policy_rules is not None and not reload:
            return self._policy_rules

        rules_json = self.redis.get(POLICY_RULES_KEY)
        if rules_json:
            self._policy_rules = json.loads(rules_json)
        else:
            self._policy_rules = []
        return self._policy_rules

    def _check_policy(self, service, context):
        """
        Check if the given service is accessible for the given request context.

        Iterates through rules (sorted most-specific first) and returns True
        if a matching rule grants access to the service.
        """
        rules = self._load_policy_rules()
        if not rules:
            # No policy rules -> allow everything
            return True

        for rule in rules:
            match = rule.get("match", {})
            access = rule.get("access", [])

            # Check if all match keys are satisfied by the request context
            if all(context.get(k) == v for k, v in match.items()):
                if access == "all":
                    return True
                return service in access

        # No rule matched at all
        logger.warning(
            "No policy rule matched for context=%s, denying access to %s",
            context,
            service,
        )
        return False

    # ------------------------------------------------------------------ #
    #  Endpoint resolution (affinity / load balancing)                      #
    # ------------------------------------------------------------------ #

    def _load_routing(self):
        """Copy the routing table from Redis into memory, where requests read it."""
        self._routing = {
            service: json.loads(endpoints)
            for service, endpoints in self.redis.hgetall(ROUTING_ENDPOINTS_KEY).items()
        }
        self._stateful = {
            service
            for service, flag in self.redis.hgetall(ROUTING_STATEFUL_KEY).items()
            if flag == "true"
        }

    def _resolve_endpoint(self, service, request_id):
        """Pick the correct endpoint for a service.

        - **Stateful agents**: check for an existing affinity binding in
          Redis (``affinity:<request_id>:<service>``).  If none exists,
          pick a random replica and persist the binding so all subsequent
          calls within the same request land on the same instance.
        - **Stateless agents**: pick a random replica from the endpoint
          list on every call.

        Returns:
            The chosen endpoint string, or ``None`` if the service is not
            in the routing table.
        """
        endpoints = self._routing.get(service)
        if endpoints is None:
            # Published since the last refresh, e.g. agents provisioned after this
            # controller started.
            self._load_routing()
            endpoints = self._routing.get(service)
        if not endpoints:
            return None
        now = time.monotonic()
        # Every replica is still a candidate when all are marked down, so the call
        # has somewhere to go.
        available_endpoint = [
            e for e in endpoints if self._down_until.get(e, 0) <= now
        ] or endpoints

        # Check if this agent is stateful
        is_stateful = service in self._stateful

        if is_stateful and request_id:
            affinity_key = f"affinity:{request_id}"
            existing = self.redis.hget(affinity_key, service)
            if existing:
                logger.debug(
                    "Affinity hit: %s -> %s (request %s)", service, existing, request_id
                )
                return existing
            # No existing binding — pick randomly and persist to Hash
            chosen = random.choice(available_endpoint)
            self.redis.hset(affinity_key, service, chosen)
            logger.info(
                "Affinity set: %s -> %s (request %s)", service, chosen, request_id
            )
            return chosen
        else:
            # Stateless: pick randomly
            return random.choice(available_endpoint)

    # ------------------------------------------------------------------ #
    #  Request processing                                                  #
    # ------------------------------------------------------------------ #

    def run(self):
        """Poll the request queue and process incoming requests."""
        logger.info("Local controller started, polling request queue...")
        try:
            while True:
                if not self.request_queue.empty():
                    raw = self.request_queue.get()
                    data = None
                    try:
                        data = json.loads(raw)
                        self._process_request(data)
                    except json.JSONDecodeError:
                        logger.error("Invalid JSON in request: %s", raw)
                    except Exception as e:
                        logger.error("Error processing request: %s", e)
                        if isinstance(data, dict):
                            self._mark_future_failed(
                                data.get("future_id"), e, data.get("origin")
                            )
                else:
                    time.sleep(0.001)
        except KeyboardInterrupt:
            self.stop()

    def _mark_future_failed(self, future_id, error, origin=None, error_name=None):
        """Persist a terminal failure locally and, when needed, notify the origin."""
        if not future_id:
            return

        try:
            name = error_type_name(error, error_name)
            self.redis.hset_multiple(
                f"future:{future_id}",
                {"error": name, "failed": 1},
            )
            # A root call, one with no parent, rejected before it started still
            # needs its request cleaned up.
            record = self.redis.hgetall(f"future:{future_id}")
            if record.get("request_id") and not record.get("parent"):
                self.redis.sadd("request:completed", record["request_id"])

            # logs_enabled only gates this richer entry -- the error/failed fields above and
            # the fan-out/relay below must never be made conditional on it.
            if getattr(self, "logs_enabled", True):
                entry = build_failure_entry(
                    error,
                    agent_id=self.agent_id,
                    agent_name=log_source_name(self.agent_name),
                    endpoint=self._my_endpoint,
                    error_name=error_name,
                )
                append_log_entry(self.redis, f"future:{future_id}", entry)

            # Unblock any consumers waiting on this future so a failed dependency
            # surfaces as an error instead of a 300s timeout.
            self._fan_out_to_consumers(future_id, failed=1, error_message=name)

            if origin and origin != self._my_endpoint:
                self._send_result_callback(
                    origin,
                    future_id,
                    failed=1,
                    error_message=name,
                )
        except Exception as e:
            # Never let the failure-recording path itself raise -- callers rely on this being a safe sink.
            logger.error("Failed to record failure for future %s: %s", future_id, e)

    def _process_request(self, data):
        """
        Route a request to the correct controller.

        Looks up the service in the routing table. If the endpoint matches
        this controller, execute locally. Otherwise, forward via gRPC.
        """
        service = data.get("service")
        function = data.get("function")
        args = data.get("args", {})
        parent = data.get("parent")
        future_id = data.get("future_id")
        origin = data.get("origin")  # endpoint of the LC that originated this request
        request_id = data.get("request_id")  # tracing ID set by the endpoint
        created_at = data.get("created_at")  # origin's true submission time
        baggage = data.get("baggage", {})

        # Scope LogHandler's breadcrumb capture to this future during routing.
        canyonos_context.set_current_future_id(future_id or "")

        # 1. Unpack context from baggage (or fall back to local Redis)
        context = baggage.get("context")
        if context is None:
            context = {}
            if request_id:
                context_json = self.redis.get(f"request:{request_id}:context")
                if context_json:
                    context = json.loads(context_json)
        else:
            if request_id:
                # Cache received context locally for downstream stubs
                self.redis.set(f"request:{request_id}:context", json.dumps(context))

        # 2. Unpack affinities from baggage into local Redis Hash
        affinities = baggage.get("affinities", {})
        if request_id and affinities:
            self.redis.hset_multiple(f"affinity:{request_id}", affinities)

        if not service or not function or not future_id:
            logger.error("Malformed request, missing required fields: %s", data)
            self._mark_future_failed(
                future_id,
                "Malformed request: missing service, function, or future_id",
                origin,
                error_name="MalformedRequest",
            )
            return

        # Check policy before routing
        if not self._check_policy(service, context):
            err_msg = f"Unauthorized: Policy denied access to service '{service}'"
            logger.warning(err_msg)
            self._mark_future_failed(
                future_id,
                err_msg,
                origin,
                error_name="PolicyDenied",
            )
            return

        # Honor a route_to pinned by the forwarding controller instead of re-resolving;
        # re-resolving at every hop lets stateless requests ping-pong between replicas.
        route_to = data.get("route_to")
        if route_to:
            endpoint = route_to
        else:
            endpoint = self._resolve_endpoint(service, request_id)
            if not endpoint:
                logger.error(
                    "No endpoint found for service '%s' in routing table.", service
                )
                self._mark_future_failed(
                    future_id,
                    f"No endpoint found for service '{service}'",
                    origin,
                    error_name="NoEndpointFound",
                )
                return

        if endpoint == self._my_endpoint:
            submitted_at = time.time()
            executor_future = self._executor.submit(
                self._execute_locally,
                service,
                function,
                args,
                future_id,
                origin,
                request_id,
                submitted_at,
                parent,
                created_at,
            )
            with self._executor_futures_lock:
                self._executor_futures[executor_future] = future_id
            executor_future.add_done_callback(self._forget_executor_future)
        else:
            # Register the target as a consumer for any Future args
            # so results get pushed to its Redis via WriteResult.
            for key, value in args.items():
                if (
                    isinstance(value, str)
                    and len(value) == 16
                    and all(c in "0123456789abcdefABCDEF" for c in value)
                ):
                    future_key = f"future:{value}"
                    if self.redis.hget(future_key, "id") is not None:
                        self.redis.sadd(f"{future_key}:consumers", endpoint)
                        logger.info(
                            "Registered %s as consumer of future %s (arg '%s')",
                            endpoint,
                            value,
                            key,
                        )

                        # Push the result now if the producer resolved the future before
                        # this consumer registered, since _fan_out_to_consumers couldn't
                        # have seen it.
                        existing_result = self.redis.hget(future_key, "result")
                        if existing_result is not None and existing_result != "":
                            logger.info(
                                "Future %s already resolved, pushing value %s to %s",
                                value,
                                existing_result,
                                endpoint,
                            )
                            self._send_result_callback(endpoint, value, existing_result)

            # Build comprehensive outward baggage so the receiver gets all context and routing descisions
            outbound_baggage = {"context": context} if context else {}
            if request_id:
                all_affs = self.redis.hgetall(f"affinity:{request_id}")
                if all_affs:
                    outbound_baggage["affinities"] = all_affs

            if outbound_baggage:
                data["baggage"] = outbound_baggage

            # Note: We now rely on baggage["affinities"] heavily instead of `target_endpoint`.
            # We explicitly place the destined endpoint into the affinities bag.
            if request_id and "affinities" not in data.get("baggage", {}):
                data.setdefault("baggage", {})["affinities"] = {service: endpoint}
            elif request_id:
                data["baggage"]["affinities"][service] = endpoint

            logger.info(
                "Forwarding %s.%s (future=%s) to %s",
                service,
                function,
                future_id,
                endpoint,
            )
            self._forward_request(endpoint, data)

    def _resolve_future_args(self, args, poll_interval=0.01, timeout=300):
        """
        Check each arg value. If it is a 32-character hex string, assume it's
        a Future ID. Poll Redis until the result is available and replace
        the arg with the resolved value.
        """
        resolved = {}
        for key, value in args.items():
            # Check if this arg value is a UUID hex string identifying a future
            if (
                isinstance(value, str)
                and len(value) == 16
                and all(c in "0123456789abcdefABCDEF" for c in value)
            ):
                future_key = f"future:{value}"
                logger.info(
                    "Arg '%s' looks like a Future UUID (%s), waiting for result...",
                    key,
                    value,
                )
                start = time.time()
                while True:
                    error = self.redis.hget(future_key, "error")
                    if error:
                        raise RuntimeError(error)
                    failed = self.redis.hget(future_key, "failed")
                    if str(failed) == "1":
                        raise RuntimeError(
                            self.redis.hget(future_key, "error") or "Unknown error"
                        )
                    # print("Waiting for result for future next iteration %s", value)
                    result = self.redis.hget(future_key, "result")
                    if result is not None and result != "":
                        logger.info("Future %s resolved for arg '%s'", value, key)
                        resolved[key] = result
                        break
                    if time.time() - start > timeout:
                        raise TimeoutError(
                            f"Timed out waiting for future {value} (arg '{key}') "
                            f"after {timeout}s"
                        )
                    time.sleep(poll_interval)
                print("Resolved arg '%s' to %s", key, resolved[key])
            else:
                resolved[key] = value
        return resolved

    def _execute_locally(
        self,
        service,
        function,
        args,
        future_id,
        origin=None,
        request_id=None,
        submitted_at=None,
        parent=None,
        created_at=None,
    ):
        """Execute a request on the local agent and write the result to Redis.

        A root call, one with no parent, waits on any Futures in the returned value,
        stores a non-dict result as {"value": ...}, and marks the request finished.
        """
        is_root = not parent
        wall_start = time.time()
        thread_cpu_start = time.thread_time()

        # Write a complete, self-contained execution record for this step entirely
        # to this node's own Redis.
        initial_fields = {
            "id": future_id,
            "request_id": request_id or "",
            "result": "",
            "parent": parent or "",
            "service": service,
            "method": function,
            "args": json.dumps(args),
            "failed": 0,
            "error": "",
        }

        if created_at is not None:
            initial_fields["created_at"] = created_at
        self.redis.hset_multiple(f"future:{future_id}", initial_fields)
        if request_id:
            self.redis.sadd(f"request:{request_id}:futures", future_id)
            canyonos_context.set_request_id(request_id)
        canyonos_context.set_current_future_id(future_id)
        canyonos_context.set_current_function(function)
        canyonos_context.set_current_metrics_key(self._metrics_key)
        if self.agent is None:
            logger.error("No agent loaded, cannot execute %s.%s", service, function)
            self._mark_future_failed(
                future_id,
                "No agent loaded",
                origin,
                error_name="NoAgentLoaded",
            )
            return

        method = getattr(self.agent, function, None)
        if method is None:
            logger.error("Agent %s has no method '%s'", self.agent_name, function)
            self._mark_future_failed(
                future_id,
                f"Agent {self.agent_name} has no method '{function}'",
                origin,
                error_name="UnknownMethod",
            )
            return

        self.redis.hincrby(self._metrics_key, "requests_served", 1)

        succeeded = False
        serialized = None
        try:
            # Resolve any Future IDs in the args before executing
            args = self._resolve_future_args(args)

            logger.info(
                "Executing %s.%s (future=%s) locally", service, function, future_id
            )
            result = method(**args)
            if is_root:
                result = _resolved(result)
                if not isinstance(result, dict):
                    result = {"value": result}

            # Serialize the result
            if isinstance(result, (dict, list)):
                serialized = json.dumps(result)
            else:
                serialized = str(result)

            # Write result to local Redis
            self.redis.hset(f"future:{future_id}", "result", serialized)
            self.redis.hset(f"future:{future_id}", "failed", 0)
            succeeded = True

            # Push the result to any consumers registered on this node.
            self._fan_out_to_consumers(future_id, result=serialized)

            logger.info(
                "Completed %s.%s (future=%s) -> %s",
                service,
                function,
                future_id,
                serialized,
            )
        except Exception as e:
            logger.error("Failed to execute %s.%s: %s", service, function, e)

            # `error` holds only the type name; the callback snapshot carries this
            # text to the origin.
            if is_root:
                self.redis.hset(f"future:{future_id}", "error_message", str(e))
            self._mark_future_failed(future_id, e)
            self.redis.hincrby(self._metrics_key, "full_failures", 1)
        finally:
            wall_end = time.time()
            wall_duration = max(wall_end - wall_start, 0.0)
            cpu_seconds = max(time.thread_time() - thread_cpu_start, 0.0)
            cpu_percent = (
                (cpu_seconds / wall_duration * 100.0) if wall_duration else 0.0
            )
            gpu_percent = read_gpu_percent()
            queue_time = (
                max(wall_start - submitted_at, 0.0)
                if submitted_at is not None
                else None
            )

            self.redis.hset_multiple(
                f"future:{future_id}",
                {
                    "finished_at": wall_end,
                    "cpu_resource": cpu_percent,
                    "gpu_resource": gpu_percent,
                    "agent": self.agent_id,
                    **({"queue_time": queue_time} if queue_time is not None else {}),
                },
            )
            self.redis.hincrby(self._metrics_key, "requests_completed", 1)
            self.redis.hincrby(
                self._metrics_key, "execution_ms_total", round(wall_duration * 1000)
            )
            if queue_time is not None:
                self.redis.hincrby(
                    self._metrics_key, "queue_time_ms_total", round(queue_time * 1000)
                )

            # Send the completion callback only now that every final metric
            # has been written, so the snapshot sent to origin is complete.
            if origin and origin != self._my_endpoint:
                if succeeded:
                    self._send_result_callback(
                        origin, future_id, result=serialized, failed=0, error_message=""
                    )
                else:
                    error_message = self.redis.hget(f"future:{future_id}", "error")
                    self._send_result_callback(
                        origin, future_id, failed=1, error_message=error_message or ""
                    )

            if is_root:
                self.redis.sadd("request:completed", request_id)

            canyonos_context.set_current_future_id(parent or "")

    # ------------------------------------------------------------------ #
    #  Request forwarding                                                  #
    # ------------------------------------------------------------------ #

    def _get_remote_stub(self, endpoint):
        """Get or create a cached gRPC stub for a remote controller."""
        with self._remote_stubs_lock:
            if endpoint not in self._remote_stubs:
                self._remote_channels[endpoint] = grpc.insecure_channel(
                    endpoint, options=GRPC_CHANNEL_OPTIONS
                )
                self._remote_stubs[endpoint] = (
                    local_controler_pb2_grpc.LocalControllerStub(
                        self._remote_channels[endpoint]
                    )
                )
                logger.info(
                    "Created gRPC connection to remote controller at %s", endpoint
                )
            return self._remote_stubs[endpoint]

    def _forward_request(self, endpoint, data):
        """Send a request to a remote controller without waiting for its answer, so a
        slow or dead replica never holds up the next request."""
        # Tag the request with our endpoint so the remote LC can call back
        data["origin"] = self._my_endpoint
        # Pin the routing decision so the destination executes the request
        # instead of re-resolving it (which would let stateless requests
        # ping-pong between replicas).
        data["route_to"] = endpoint
        request = local_controler_pb2.JsonResponse(resonse=json.dumps(data))
        call = self._get_remote_stub(endpoint).Execute.future(
            request, timeout=FORWARD_TIMEOUT_SECONDS
        )
        call.add_done_callback(lambda done: self._on_forwarded(done, endpoint, data))

    def _on_forwarded(self, call, endpoint, data):
        """When the replica was unreachable or did not answer in time, mark it down and
        put the request back on the request queue; any other failure, or running out
        of retries, fails the request."""
        error = call.exception()
        if error is None:
            return
        retries = data.get("retries", 0) + 1
        if (
            error.code()
            not in (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)
            or retries > FORWARD_RETRIES
        ):
            logger.error("Failed to forward request to %s: %s", endpoint, error)
            self._mark_future_failed(data.get("future_id"), error)
            return
        self._down_until[endpoint] = time.monotonic() + REPLICA_DOWN_SECONDS
        data["retries"] = retries
        if error.code() == grpc.StatusCode.UNAVAILABLE:
            # Never reached, so routing picks again; a timed-out one may have queued
            # it, and its duplicate check drops a resend.
            data.pop("route_to")
        logger.warning(
            "Forwarding a request to %s failed (%s); queueing it again.",
            endpoint,
            error.code().name,
        )
        # The first retry goes out at once; later ones back off so a replica being
        # replaced has time to come up.
        payload = json.dumps(data)
        if retries == 1:
            self.request_queue.put(payload)
            return
        retry = threading.Timer(
            min(0.5 * 2 ** (retries - 2), 8), self.request_queue.put, [payload]
        )
        retry.name = f"forward-retry-{data.get('future_id')}"
        retry.daemon = True
        retry.start()

    def _send_result_callback(
        self, origin, future_id, result="", failed=0, error_message=""
    ):
        """Send the future's full Redis hash to the originating controller."""
        if not result:
            logger.warning(
                "Agent '%s' is sending an empty/None result for future %s to origin %s, result: %s",
                self.agent_name,
                future_id,
                origin,
                result,
            )

        stub = self._get_remote_stub(origin)
        snapshot = self.redis.hgetall(f"future:{future_id}")
        snapshot.update(
            {
                "future_id": future_id,
                "result": result,
                "failed": int(bool(failed)),
                "error": str(error_message or ""),
            }
        )
        payload = json.dumps(snapshot)
        logger.info("Payload: Future %s,Sent %s ", future_id, payload)
        request = local_controler_pb2.JsonResponse(resonse=payload)
        try:
            call_with_retry(lambda: stub.WriteResult(request), origin)
            logger.info(
                "Sent result callback to %s for future %s, result %s",
                origin,
                future_id,
                result,
            )

        except Exception as e:
            logger.error("Failed to send result callback to %s: %s", origin, e)
            self._mark_future_failed(
                future_id,
                f"Result callback failed: {e}",
                error_name="ResultCallbackFailed",
            )

    def _fan_out_to_consumers(self, future_id, result=None, failed=0, error_message=""):
        """Push a completed future (result or failure) to every endpoint registered
        as a consumer on THIS node's Redis.

        Called at every site that writes a terminal value for a future -- local
        production (_execute_locally), failure (_mark_future_failed), and remote
        arrival (WriteResult) -- so propagation is event-driven and never depends
        on anyone calling Future.value(). Whichever node holds the consumer set is
        always either the producer or the origin, so one of those sites fires; the
        value then re-fans-out at each node it lands on, walking the graph.

        Delivery is intentionally not deduped: a consumer's WriteResult just
        re-writes the same value, so a redundant push (e.g. racing the immediate
        push in _process_request) is idempotent and harmless.
        """
        if not future_id:
            return
        for endpoint in self.redis.smembers(f"future:{future_id}:consumers"):
            if endpoint and endpoint != self._my_endpoint:
                self._send_result_callback(
                    endpoint,
                    future_id,
                    result=result,
                    failed=failed,
                    error_message=error_message,
                )

    # ------------------------------------------------------------------ #
    #  Shutdown                                                            #
    # ------------------------------------------------------------------ #

    def _forget_executor_future(self, executor_future):
        with self._executor_futures_lock:
            self._executor_futures.pop(executor_future, None)

    def stop(self):
        """Gracefully shut down the server."""
        logger.info("Shutting down local controller...")
        self._metrics_stop_event.set()
        self._metrics_thread.join(timeout=2)
        self._executor.shutdown(wait=False, cancel_futures=True)
        with self._executor_futures_lock:
            outstanding = dict(self._executor_futures)
        if outstanding:
            _, unfinished = wait(outstanding, timeout=EXECUTOR_SHUTDOWN_TIMEOUT_SECONDS)
            if unfinished:
                future_ids = sorted(str(outstanding[future]) for future in unfinished)
                logger.warning(
                    "Executor shutdown timed out with requests still running: %s",
                    ", ".join(future_ids),
                )
        self.mark_stopped()
        if self._log_handler is not None:
            logging.getLogger().removeHandler(self._log_handler)
        self.server.stop(0)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=50051)
    args = parser.parse_args()

    controller = LocalController(port=args.port)
    controller.run()
