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
import queue
import random
import sys
import threading
import time
import importlib.util
from concurrent.futures import ThreadPoolExecutor, wait

import grpc
import redis

from canyonos_core.llm_gateway.hooks import PROXY_PORT

try:
    from canyonos_core.controller import gateway_headers, governance
    from canyonos_core.controller.health import start_health_server, stop_health_server
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
    )
except ImportError:
    import canyonos_governance as governance
    import gateway_headers
    from canyonos_health import start_health_server, stop_health_server
    from gpu_metrics import read_gpu_percent
    from local_controller_frontend import start_server
    from log_handler import LogHandler
    from redis_client import RedisClient
    from grpc_options import GRPC_CHANNEL_OPTIONS, call_with_retry
    from log_entry import build_failure_entry, append_log_entry

# Add local generated grpc_stubs to path (Docker context copies them directly to /app)
sys.path.insert(0, ".")
sys.path.insert(0, "/app")
sys.path.insert(0, os.path.abspath("grpc_stubs"))

try:
    import canyonos_core.controller.canyonos_context as canyonos_context
except ImportError:
    import canyonos_context

canyonos_context.install()

import local_controller_pb2
import local_controller_pb2_grpc

try:
    from canyonos_core.controller.future import (
        ENDPOINT_AGENT_NAME,
        AgentCallError,
        Future,
        notify_result,
        wait_for_result,
    )
    from canyonos_core.controller.utils import human_input
except ImportError:
    from future import (
        ENDPOINT_AGENT_NAME,
        AgentCallError,
        Future,
        notify_result,
        wait_for_result,
    )
    import human_input

human_input.install()
# After human_input: httpx loads click, which keeps the input() it imports with.
gateway_headers.install(
    canyonos_context.get_current_future_id, canyonos_context.get_current_function
)


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# CanyonOS's own modules, whose frames are cut from the traceback logged for an agent's failure.
CANYONOS_FILES = {
    __file__,
    canyonos_context.__file__,
    gateway_headers.__file__,
    human_input.__file__,
    sys.modules[Future.__module__].__file__,
}

ROUTING_ADDRESSES_KEY = "routing_table:addresses"
ROUTING_STATEFUL_KEY = "routing_table:stateful"
EXECUTOR_SHUTDOWN_TIMEOUT_SECONDS = 5
# A replica only queues a request forwarded to it, so one slower than this to
# accept it is stuck.
FORWARD_TIMEOUT_SECONDS = 2
# How long routing skips a replica after forwarding a request to it failed; the
# reconciler replaces it meanwhile.
REPLICA_DOWN_SECONDS = 30
FORWARD_RETRIES = 8
# One question's wait plus 5 minutes; a call that asks several can still outrun it.
FUTURE_RESULT_TIMEOUT_SECONDS = human_input.QUESTION_TIMEOUT_SECONDS + 300
ENDPOINT_LOG_SOURCE = "Endpoint"
# Every outbound call goes through the gateway, so a gateway that keeps dying fails the replica.
MAX_GATEWAY_RESTARTS = 3


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

        # Public port is how the routing table and other machines know us;
        # internally the gRPC server binds to `port` (50051 inside Docker).
        self.public_port = os.environ.get("CANYONOS_AGENT_PORT", str(port))

        self._my_address = f"{self.agent_host}:{self.public_port}"

        # Connect to Redis. Readiness is published only after a configured
        # agent has loaded successfully.
        redis_host = os.environ.get("CANYONOS_REDIS_HOST", "localhost")
        redis_port = int(os.environ.get("CANYONOS_REDIS_PORT", 6379))
        self.redis = RedisClient(host=redis_host, port=redis_port)
        self._metrics_interval = float(os.environ.get("CANYONOS_POLL_INTERVAL", 5))
        # Before the server serves, so no call arrives ahead of its admission check.
        try:
            self._rules = governance.load(self.redis.client)
        except Exception as e:
            logger.warning(
                "Could not load the governance rules, admitting every call: %s", e
            )
            self._rules = governance.Rules([], {}, {}, frozenset())

        # The server admits calls from here on, so what failing a refused one touches
        # (its failure entry, the fan-out to its consumers) exists before it starts;
        # the replica id is read further down.
        self.replica_id = None
        # self._forwarded is how a replica remembers which replica is running each call it handed off, so it can fail those calls if that replica disappears.
        self._forwarded = {}
        # Cache for gRPC stubs to remote controllers
        self._remote_channels = {}  # address -> grpc.Channel
        self._remote_stubs = {}  # address -> LocalControllerStub
        # Result callbacks on executor and gRPC threads create stubs too, not just
        # the loop that forwards requests.
        self._remote_stubs_lock = threading.Lock()
        self.server, self.servicer = start_server(port, my_address=self._my_address)
        self.request_queue = self.servicer.request_queue
        # Let the gRPC servicer fan a result out to this machine's consumers as
        # soon as it arrives via WriteResult (see _fan_out_to_consumers).
        self.servicer.on_result = self._fan_out_to_consumers
        self.servicer.on_request_done = self._fail_waiting_questions
        self.servicer.admit = self._admit

        self._load_routing()
        self._status_key = f"controller:{self.agent_host}:{self.public_port}:status"

        # Agent LLM calls go through the gateway, so it starts before ready.
        self._gateway_restarts = 0
        self._redis_address = (redis_host, redis_port)
        if runs_agent:
            try:
                self._gateway_process = self._start_llm_gateway(redis_host, redis_port)
            except Exception:
                # The status key has no TTL, so a stale "healthy" would outlive
                # this container.
                self.redis.set(self._status_key, "failed")
                self.server.stop(0)
                raise

        # Stamps completed requests and logs with the replica that ran them; whatever
        # launches the replica names it.
        self.replica_id = os.environ.get("CANYONOS_REPLICA_ID")

        # global_controller.yaml's `logs:` flag, on by default -- set `logs: false` to opt out. Only
        # gates the rich `logs` detail below -- never the cheap `error`/`failed` fields, always written.
        self.logs_enabled = (
            os.environ.get("CANYONOS_LOGS_ENABLED", "true").lower() == "true"
        )
        self._log_handler = None
        if self.logs_enabled:
            self._log_handler = LogHandler(
                self.redis,
                agent_id=self.replica_id,
                agent_name=log_source_name(self.agent_name),
                address=self._my_address,
            )
            # CanyonOS's own per-call lines go to stdout only, not into the agent's logs.
            self._log_handler.addFilter(
                lambda record: record.name not in (logger.name, Future.__module__)
            )
            logging.getLogger().addHandler(self._log_handler)

        # Periodically publish replica metrics, on the same cadence
        # GlobalController polls with (via CANYONOS_POLL_INTERVAL).
        self._metrics_key = f"controller:{self.agent_host}:{self.public_port}:metrics"
        # Written by the reconciler when it starts draining this replica.
        self._draining_key = f"controller:{self.agent_host}:{self.public_port}:draining"
        self._draining = False
        self._failed_leftovers = False
        # Calls the drain failed back to their callers; nothing they do later is reported.
        self._cut_off = set()
        # Forwards sent on, not yet taken by their target. A queued request is counted
        # by the queue itself (unfinished_tasks) until run() has processed it.
        self._unsent = 0
        self._unsent_lock = threading.Lock()
        # One transaction, so a reader never sees "initializing" without a heartbeat to judge it by.
        # Cumulative request counters are always increasing, never reset. It is the consumers job to get the delta between polls to get the specific metrics.
        now = str(time.time())
        # This replica's status, the one source of its health (see health()):
        # initializing -> healthy -> failed or stopped. Redis gets a copy.
        self._status = "initializing"
        self.redis.set_with_hash(
            self._status_key,
            self._status,
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
        self._status_lock = threading.Lock()
        # Before the agent loads, so a slow constructor reads as starting, not as a
        # refused connection. Off unless CANYONOS_HEALTH_PORT is set.
        self._health_server = start_health_server(self._health_checks())

        # Thread pool for executing agent methods concurrently.
        # This prevents deadlocks when an agent method creates nested Futures
        # that need to be routed through the same controller's request queue.
        max_instances = int(os.environ.get("CANYONOS_MAX_AGENT_INSTANCES", 16))
        self._executor = ThreadPoolExecutor(max_workers=max_instances)
        self._executor_futures = {}
        self._executor_futures_lock = threading.Lock()
        # address -> time.monotonic() until which new picks skip it
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
            stop_health_server(self._health_server)
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
            self._my_address,
            max_instances,
            "reported healthy to Redis"
            if publish_ready
            else "readiness left to the launcher",
        )

    def mark_ready(self):
        """Set this replica's status in Redis to `healthy`, which the Global Controller
        waits for before routing to it."""
        self._set_status("healthy")

    def mark_failed(self):
        """Set this replica's status to `failed`, so the Global Controller no longer
        counts it as healthy. Best effort in Redis, as it starts a teardown."""
        self._set_status("failed", best_effort=True)

    def mark_stopped(self):
        self._set_status("stopped", best_effort=True)

    def _set_status(self, status, best_effort=False):
        """Hold `status` (health() reads it) and copy it to Redis. `best_effort` is for
        teardown: a Redis error is logged, not raised, so the error that started the
        teardown and the rest of the cleanup still happen. The heartbeat then goes
        stale, which the Global Controller reads as a replica that is gone."""
        with self._status_lock:
            self._status = status
            try:
                self.redis.set(self._status_key, status)
            except redis.RedisError as e:
                if not best_effort:
                    raise
                logger.warning("Could not record status %r in Redis: %s", status, e)

    def health(self):
        """This replica's health, the one source for both reports: (status, alive,
        reason). The status goes to Redis, where the Global Controller and reconciler
        read it on Docker and EC2; _health_checks serves the same to Kubernetes probes.
        Alive means its own threads and the LLM gateway still run. Nothing here reads
        Redis: a Redis outage must not make every replica look dead at once."""
        if not self._metrics_thread.is_alive():
            return self._status, False, "metrics thread stopped"
        gateway = getattr(self, "_gateway_process", None)
        if gateway is not None and gateway.poll() is not None:
            return (
                self._status,
                False,
                f"LLM gateway exited with code {gateway.returncode}",
            )
        return self._status, True, "alive"

    def _health_checks(self):
        """health() as the HTTP checks Kubernetes probes: started (the agent loaded),
        ready (it should get traffic) and alive (it should not be restarted)."""

        def started():
            status = self.health()[0]
            return status != "initializing", status

        def ready():
            status = self.health()[0]
            return status == "healthy", status

        def alive():
            return self.health()[1:]

        return {"/startupz": started, "/readyz": ready, "/livez": alive}

    def _start_llm_gateway(self, redis_host, redis_port):
        """Start the LLM gateway as a subprocess in this container (127.0.0.1:8081).

        Fatal: the runtime force-injects env vars that point every Bedrock/Anthropic
        SDK call at this gateway and every other HTTP(S) call at its proxy
        (`docker run -e` beats `--env-file`, so nothing can opt back out), which
        sends every OpenAI-format call here. If it fails to start, every
        LLM call in this container would silently fail or hang, not just lose
        telemetry -- so raise instead of limping on with no gateway listening.
        """
        import socket
        import subprocess
        import urllib.request

        # An orphaned gateway on 8081 would answer the /healthz probe below and mask
        # one of ours that never bound, so prove its ports free before spawning.
        for port in (8081, PROXY_PORT):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as port_probe:
                port_probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                try:
                    port_probe.bind(("127.0.0.1", port))
                except OSError as e:
                    logger.error("127.0.0.1:%d is already in use: %s", port, e)
                    raise RuntimeError(
                        f"127.0.0.1:{port} is already in use, so the LLM gateway cannot "
                        "bind it; agent LLM calls are routed through it unconditionally "
                        "and would otherwise fail silently."
                    ) from e

        gateway_env = os.environ.copy()
        # The gateway's own calls to providers must not loop back through its proxy.
        gateway_env.pop("HTTP_PROXY", None)
        gateway_env.pop("HTTPS_PROXY", None)
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
        """Snapshot the in-process replica metrics LocalController owns.

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
            "draining": str(int(self._draining)),
            "open_requests": str(len(self.servicer.open_requests)),
            "pending_requests": str(self.request_queue.unfinished_tasks + self._unsent),
            "observed_at": str(time.time()),
        }

    def _watch_llm_gateway(self):
        """Restart the LLM gateway if it has exited. After MAX_GATEWAY_RESTARTS restarts, fail
        this replica and stop serving and heartbeating instead, so the reconciler replaces it."""
        # Only a replica that runs an agent starts a gateway.
        if not (self.agent_name or self.agent_file):
            return
        if self._gateway_process.poll() is None:
            return
        code = self._gateway_process.returncode
        if self._gateway_restarts >= MAX_GATEWAY_RESTARTS:
            logger.error(
                "LLM gateway exited (code %s) after %d restarts; failing this replica",
                code,
                self._gateway_restarts,
            )
            self.mark_failed()
            self.server.stop(0)
            self._metrics_stop_event.set()
            return
        self._gateway_restarts += 1
        logger.warning(
            "LLM gateway exited (code %s); restarting it (%d of %d)",
            code,
            self._gateway_restarts,
            MAX_GATEWAY_RESTARTS,
        )
        self._gateway_process = self._start_llm_gateway(*self._redis_address)

    def _metrics_loop(self):
        """Background thread: periodically publish replica metrics and refresh status."""
        while not self._metrics_stop_event.is_set():
            # First and on its own, so a failure later in the tick never leaves stale rules.
            self._refresh_rules()
            try:
                self._watch_llm_gateway()
                # Read before collecting, so a heartbeat saying draining comes after refusals began.
                remove_at = self.redis.get(self._draining_key)
                self._draining = remove_at is not None
                # A stateful replica keeps taking calls; open_requests holds its drain instead.
                self.servicer.refusing = (
                    self._draining and self.agent_name not in self._stateful
                )
                # Two heartbeats before removal, so every caller gets an error, not silence.
                if (
                    self._draining
                    and not self._failed_leftovers
                    and time.time() >= float(remove_at) - 2 * self._metrics_interval
                ):
                    self._failed_leftovers = True
                    self._fail_unfinished()
                metrics = self._collect_metrics()
                self.redis.hset_multiple(self._metrics_key, metrics)
                with self._status_lock:
                    if self._status == "healthy":
                        self.redis.set(self._status_key, "healthy")
                self._load_routing()
                self._fail_calls_to_gone_replicas()
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
                f"Failed to load agent {self.agent_name} from {self.agent_file}: {type(e).__name__}: {e}"
            )
            return None

    # ------------------------------------------------------------------ #
    #  Policy evaluation                                                   #
    # ------------------------------------------------------------------ #

    def _refresh_rules(self):
        """Replace the governance snapshot, keeping the previous one when Redis can't
        give a readable one."""
        try:
            self._rules = governance.load(self.redis.client, previous=self._rules)
        except Exception as e:
            logger.warning("Keeping the previous governance rules: %s", e)

    def _request_context(self, data):
        """The request's `_context`: carried in the baggage once forwarded, else as the
        endpoint stored it."""
        context = data.get("baggage", {}).get("context")
        if context is not None:
            return context
        request_id = data.get("request_id")
        context_json = (
            self.redis.get(f"request:{request_id}:context") if request_id else None
        )
        return json.loads(context_json) if context_json else {}

    def _admit(self, data):
        """Refuse a call before it is queued when governance says so, failing its
        future; None lets it through."""
        agent_name, function = data.get("service"), data.get("function")
        future_id = data.get("future_id")
        if not agent_name or not function or not future_id:
            # Left to _process_request, which reports it as MalformedRequest.
            return None
        refusal = governance.refuse_call(
            self._rules, agent_name, function, self._request_context(data)
        )
        if refusal is None:
            return None
        # The name leads the text, so a caller that only passes the error on, up to
        # the request's /status, still says which rule refused it.
        refusal = governance.Refusal(
            refusal.error_name, f"{refusal.error_name}: {refusal.message}"
        )
        logger.warning(refusal.message)
        self._mark_future_failed(
            future_id,
            refusal.message,
            data.get("origin"),
            error_name=refusal.error_name,
            before_start=True,
        )
        return refusal

    # ------------------------------------------------------------------ #
    #  Address resolution (affinity / load balancing)                       #
    # ------------------------------------------------------------------ #

    def _load_routing(self):
        """Copy the routing table from Redis into memory, where requests read it."""
        self._routing = {
            agent_name: json.loads(addresses)
            for agent_name, addresses in self.redis.hgetall(
                ROUTING_ADDRESSES_KEY
            ).items()
        }
        self._stateful = {
            agent_name
            for agent_name, flag in self.redis.hgetall(ROUTING_STATEFUL_KEY).items()
            if flag == "true"
        }

    def _resolve_address(self, agent_name, request_id):
        """Pick the correct address for an agent.

        - **Stateful agents**: check for an existing affinity binding in
          Redis (``affinity:<request_id>:<agent>``).  If none exists,
          pick a random replica and persist the binding so all subsequent
          calls within the same request land on the same replica.
        - **Stateless agents**: pick a random replica from the address
          list on every call.

        Returns:
            The chosen address string, or ``None`` if the agent is not
            in the routing table.
        """
        addresses = self._routing.get(agent_name)
        if addresses is None:
            # Published since the last refresh, e.g. agents provisioned after this
            # controller started.
            self._load_routing()
            addresses = self._routing.get(agent_name)
        if not addresses:
            return None
        now = time.monotonic()
        # Every replica is still a candidate when all are marked down, so the call
        # has somewhere to go.
        available_addresses = [
            e for e in addresses if self._down_until.get(e, 0) <= now
        ] or addresses

        # Check if this agent is stateful
        is_stateful = agent_name in self._stateful

        if is_stateful and request_id:
            affinity_key = f"affinity:{request_id}"
            existing = self.redis.hget(affinity_key, agent_name)
            if existing:
                logger.debug(
                    "Affinity hit: %s -> %s (request %s)",
                    agent_name,
                    existing,
                    request_id,
                )
                return existing
            # No existing binding — pick randomly and persist to Hash
            chosen = random.choice(available_addresses)
            self.redis.hset(affinity_key, agent_name, chosen)
            logger.info(
                "Affinity set: %s -> %s (request %s)", agent_name, chosen, request_id
            )
            return chosen
        else:
            # Stateless: pick randomly
            return random.choice(available_addresses)

    # ------------------------------------------------------------------ #
    #  Request processing                                                  #
    # ------------------------------------------------------------------ #

    def run(self):
        """Take requests off the queue and process them, sleeping while it is empty."""
        logger.info("Local controller started, waiting for requests...")
        try:
            while True:
                # Blocks until a request is queued.
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
                finally:
                    # Pending from its put until here, so a drain never sees a request
                    # in no one's hands; a forward is counted in _unsent before this.
                    self.request_queue.task_done()
        except KeyboardInterrupt:
            self.stop()

    def _mark_future_failed(
        self,
        future_id,
        error,
        origin=None,
        error_name=None,
        log_entry=True,
        before_start=False,
    ):
        """Persist a terminal failure locally and, when needed, notify the origin.
        `before_start` marks a call failed before it ran, which nothing else will
        stamp `finished_at` on."""
        if not future_id:
            return

        try:
            record = self.redis.hgetall(f"future:{future_id}")
            message = str(error)
            # A failure passed on from a called agent keeps that agent's wording.
            if isinstance(error, BaseException) and not isinstance(
                error, AgentCallError
            ):
                message = f"{record.get('service')}.{record.get('method')} failed: {type(error).__name__}: {message}"
            failure = {"error": message, "failed": 1}
            if error_name:
                failure["error_name"] = error_name
            # Only before the call ran: telemetry treats finished_at as the last write.
            if before_start:
                failure["finished_at"] = time.time()
            self.redis.hset_multiple(f"future:{future_id}", failure)
            # A root call, one with no parent, rejected before it started still
            # needs its request cleaned up.
            if record.get("request_id") and not record.get("parent"):
                self.redis.sadd("request:completed", record["request_id"])

            # logs_enabled only gates this richer entry -- the error/failed fields above and
            # the fan-out/relay below must never be made conditional on it.
            if log_entry and getattr(self, "logs_enabled", True):
                entry = build_failure_entry(
                    error,
                    agent_id=self.replica_id,
                    agent_name=log_source_name(self.agent_name),
                    address=self._my_address,
                    error_name=error_name,
                )
                append_log_entry(self.redis, f"future:{future_id}", entry)

            # Unblock any consumers waiting on this future so a failed dependency surfaces as an error.
            self._fan_out_to_consumers(future_id, failed=1, error_message=message)

            if origin and origin != self._my_address:
                self._send_result_callback(
                    origin,
                    future_id,
                    failed=1,
                    error_message=message,
                )
        except Exception as e:
            # Never let the failure-recording path itself raise -- callers rely on this being a safe sink.
            logger.error("Failed to record failure for future %s: %s", future_id, e)

    def _fail_waiting_questions(self, request_id):
        """Fail every question a finished request still has waiting, so each agent that
        asked stops waiting and the request can be cleaned up."""
        while (waiting := self.redis.rpop(f"request:{request_id}:waiting")) is not None:
            future_id = json.loads(waiting)["future_id"]
            # Telemetry exports only finished spans.
            self.redis.hset(f"future:{future_id}", "finished_at", time.time())
            self._mark_future_failed(
                future_id,
                "Request finished before the question was answered",
                error_name="RequestFinished",
            )

    def _process_request(self, data):
        """
        Route a request to the correct controller.

        Looks up the agent in the routing table. If the address matches
        this controller, execute locally. Otherwise, forward via gRPC.
        """
        agent_name = data.get("service")
        function = data.get("function")
        args = data.get("args", {})
        parent = data.get("parent")
        future_id = data.get("future_id")
        origin = data.get("origin")  # address of the LC that originated this request
        request_id = data.get("request_id")  # tracing ID set by the endpoint
        created_at = data.get("created_at")  # origin's true submission time
        baggage = data.get("baggage", {})

        # Scope LogHandler's breadcrumb capture to this future during routing.
        canyonos_context.set_current_future_id(future_id or "")

        # 1. Unpack context from baggage (or fall back to local Redis)
        context = self._request_context(data)
        if request_id and baggage.get("context") is not None:
            # Cache received context locally for downstream stubs
            self.redis.set(f"request:{request_id}:context", json.dumps(context))

        # 2. Unpack affinities from baggage into local Redis Hash
        affinities = baggage.get("affinities", {})
        if request_id and affinities:
            self.redis.hset_multiple(f"affinity:{request_id}", affinities)

        if not agent_name or not function or not future_id:
            logger.error("Malformed request, missing required fields: %s", data)
            self._mark_future_failed(
                future_id,
                "Malformed request: missing service, function, or future_id",
                origin,
                error_name="MalformedRequest",
                before_start=True,
            )
            return

        # Honor a route_to pinned by the forwarding controller instead of re-resolving;
        # re-resolving at every hop lets stateless requests ping-pong between replicas.
        route_to = data.get("route_to")
        if route_to:
            address = route_to
        else:
            address = self._resolve_address(agent_name, request_id)
            if not address:
                logger.error(
                    "No address found for agent '%s' in routing table.", agent_name
                )
                self._mark_future_failed(
                    future_id,
                    f"No running replica of {agent_name} right now; all are starting, "
                    "restarting or being removed.",
                    origin,
                    error_name="NoRunningReplica",
                    before_start=True,
                )
                return

        future_args = {key: args[key] for key in data.get("future_args", [])}
        # Only the first hop's Redis holds the producer's record; later hops trust this check.
        if not route_to:
            for key, arg_future_id in future_args.items():
                if self.redis.hget(f"future:{arg_future_id}", "request_id") != (
                    request_id or ""
                ):
                    self._mark_future_failed(
                        future_id,
                        f"Argument '{key}' of {agent_name}.{function} comes from a different request.",
                        origin,
                        error_name="InvalidArgument",
                        before_start=True,
                    )
                    return

        if address == self._my_address:
            # The endpoint runs no agent code: a call to it is a question for the human.
            if agent_name == ENDPOINT_AGENT_NAME:
                # The asker's own record, so telemetry ties the answer written here to its request.
                self.redis.hset_multiple(
                    f"future:{future_id}",
                    {
                        "id": future_id,
                        "request_id": request_id,
                        "parent": parent,
                        "service": agent_name,
                        "method": function,
                        "args": json.dumps(args),
                        "created_at": created_at,
                    },
                )
                self.redis.sadd(f"request:{request_id}:futures", future_id)
                # Before listing the question, so its answer or failure always reaches the asker.
                self.redis.sadd(f"future:{future_id}:consumers", origin)
                self.redis.lpush(
                    f"request:{request_id}:waiting",
                    json.dumps({"future_id": future_id, "question": args["question"]}),
                )
                # A question can arrive after its request finished; checking after holding closes the race.
                root = self.redis.hgetall(
                    f"future:{self.redis.get(f'request:{request_id}:future')}"
                )
                if root.get("result") or str(root.get("failed")) == "1":
                    self._fail_waiting_questions(request_id)
                return
            # This request's later calls are bound here, so a drain waits for it to finish.
            if request_id and agent_name in self._stateful:
                self.servicer.open_requests.add(request_id)
            submitted_at = time.time()
            executor_future = self._executor.submit(
                self._execute_locally,
                agent_name,
                function,
                args,
                future_id,
                origin,
                request_id,
                submitted_at,
                parent,
                created_at,
                future_args,
            )
            with self._executor_futures_lock:
                self._executor_futures[executor_future] = (
                    future_id,
                    origin,
                    agent_name,
                    function,
                )
            executor_future.add_done_callback(self._forget_executor_future)
        else:
            # Register the target as a consumer for any Future args
            # so results get pushed to its Redis via WriteResult.
            for key, value in future_args.items():
                future_key = f"future:{value}"
                self.redis.sadd(f"{future_key}:consumers", address)
                logger.info(
                    "Registered %s as consumer of future %s (arg '%s')",
                    address,
                    value,
                    key,
                )

                # Push the result now if the producer resolved the future before
                # this consumer registered, since _fan_out_to_consumers couldn't
                # have seen it.
                existing_result = self.redis.hget(future_key, "result")
                if existing_result is not None:
                    logger.info(
                        "Future %s already resolved, pushing value %s to %s",
                        value,
                        existing_result,
                        address,
                    )
                    self._send_result_callback(address, value, existing_result)

            # Build comprehensive outward baggage so the receiver gets all context and routing descisions
            outbound_baggage = {"context": context} if context else {}
            if request_id:
                all_affs = self.redis.hgetall(f"affinity:{request_id}")
                if all_affs:
                    outbound_baggage["affinities"] = all_affs

            if outbound_baggage:
                data["baggage"] = outbound_baggage

            # Note: We now rely on baggage["affinities"] heavily instead of `target_endpoint`.
            # We explicitly place the destined address into the affinities bag.
            if request_id and "affinities" not in data.get("baggage", {}):
                data.setdefault("baggage", {})["affinities"] = {agent_name: address}
            elif request_id:
                data["baggage"]["affinities"][agent_name] = address

            logger.info(
                "Forwarding %s.%s (future=%s) to %s",
                agent_name,
                function,
                future_id,
                address,
            )
            self._forward_request(address, data)

    def _resolve_future_args(
        self, args, future_args, timeout=FUTURE_RESULT_TIMEOUT_SECONDS
    ):
        """
        Replace each arg named in future_args (its value is a Future id) with
        that Future's result, waiting for it (wait_for_result). Other args
        pass through unchanged.
        """
        resolved = {}
        for key, value in args.items():
            if key in future_args:
                logger.info(
                    "Arg '%s' is Future %s, waiting for result...",
                    key,
                    value,
                )
                try:
                    resolved[key] = wait_for_result(self.redis, value, timeout)
                except TimeoutError:
                    # Another machine's Redis has no record of a producer that ran elsewhere.
                    producer = self.redis.hgetall(f"future:{value}")
                    source = (
                        f" from {producer['service']}.{producer['method']}"
                        if producer
                        else ""
                    )
                    raise TimeoutError(
                        f"Timed out after {timeout}s waiting for argument '{key}'{source}."
                    ) from None
                logger.info("Future %s resolved for arg '%s'", value, key)
            else:
                resolved[key] = value
        return resolved

    def _execute_locally(
        self,
        agent_name,
        function,
        args,
        future_id,
        origin=None,
        request_id=None,
        submitted_at=None,
        parent=None,
        created_at=None,
        future_args=(),
    ):
        """Execute a request on the local agent and write the result to Redis.

        A root call, one with no parent, waits on any Futures in the returned value,
        stores a non-dict result as {"value": ...}, and marks the request finished.
        """
        is_root = not parent
        wall_start = time.time()
        thread_cpu_start = time.thread_time()

        # Write a complete, self-contained execution record for this step entirely
        # to this machine's own Redis.
        initial_fields = {
            "id": future_id,
            "request_id": request_id or "",
            "parent": parent or "",
            "service": agent_name,
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
            logger.error("No agent loaded, cannot execute %s.%s", agent_name, function)
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
        started = False
        serialized = None
        try:
            # Resolve any Future IDs in the args before executing
            args = self._resolve_future_args(args, future_args)

            logger.info(
                "Executing %s.%s (future=%s) locally", agent_name, function, future_id
            )
            started = True
            returned = result = method(**args)
            if is_root:
                returned = result = _resolved(result)
                if not isinstance(result, dict):
                    result = {"value": result}

            # Serialize the result
            if isinstance(result, (dict, list)):
                try:
                    serialized = json.dumps(result)
                except TypeError as error:
                    # Only on failure: name the top-level key or index that can't be converted.
                    reason = f"{error}."
                    is_dict = isinstance(result, dict)
                    # A wrapped non-dict return has no key of its own to name.
                    if result is returned:
                        for key, value in (
                            result.items() if is_dict else enumerate(result)
                        ):
                            try:
                                json.dumps(value)
                            except TypeError as value_error:
                                place = f"key '{key}'" if is_dict else f"index {key}"
                                reason = f"{value_error} (at {place})."
                                break
                    raise TypeError(
                        f"its return value can't be converted to JSON: {reason}"
                    ) from None
            else:
                serialized = str(result)

            if future_id in self._cut_off:
                return
            # Write result to local Redis
            self.redis.hset(f"future:{future_id}", "result", serialized)
            self.redis.hset(f"future:{future_id}", "failed", 0)
            succeeded = True

            # Push the result to any consumers registered on this machine.
            self._fan_out_to_consumers(future_id, result=serialized)

            logger.info(
                "Completed %s.%s (future=%s) -> %s",
                agent_name,
                function,
                future_id,
                serialized,
            )
        except Exception as e:
            logger.error("Failed to execute %s.%s: %s", agent_name, function, e)

            # Keep only the agent's own frames in the logged traceback.
            kept, tb = [], e.__traceback__
            while tb is not None:
                if tb.tb_frame.f_code.co_filename not in CANYONOS_FILES:
                    kept.append(tb)
                tb = tb.tb_next
            for earlier, later in zip(kept, kept[1:] + [None]):
                earlier.tb_next = later
            e.__traceback__ = kept[0] if kept else None

            # A call whose arguments never arrived, or that only passed on a called agent's failure, is not this agent's failure.
            own_failure = started and not isinstance(e, AgentCallError)
            self._mark_future_failed(future_id, e, log_entry=own_failure)
            if own_failure:
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
                    "agent": self.replica_id,
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
            if origin and origin != self._my_address and future_id not in self._cut_off:
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

    def _get_remote_stub(self, address):
        """Get or create a cached gRPC stub for a remote controller."""
        with self._remote_stubs_lock:
            if address not in self._remote_stubs:
                self._remote_channels[address] = grpc.insecure_channel(
                    address, options=GRPC_CHANNEL_OPTIONS
                )
                self._remote_stubs[address] = (
                    local_controller_pb2_grpc.LocalControllerStub(
                        self._remote_channels[address]
                    )
                )
                logger.info(
                    "Created gRPC connection to remote controller at %s", address
                )
            return self._remote_stubs[address]

    def _forward_request(self, address, data):
        """Send a request to a remote controller without waiting for its answer, so a
        slow or dead replica never holds up the next request."""
        # Tag the request with our address so the remote LC can call back
        data["origin"] = self._my_address
        # Pin the routing decision so the destination executes the request
        # instead of re-resolving it (which would let stateless requests
        # ping-pong between replicas).
        data["route_to"] = address
        self._forwarded[data.get("future_id")] = address
        request = local_controller_pb2.JsonResponse(response=json.dumps(data))
        call = self._get_remote_stub(address).Execute.future(
            request, timeout=FORWARD_TIMEOUT_SECONDS
        )
        # Before the callback is added, since it may run at once and count it back down.
        self._count_unsent(1)
        call.add_done_callback(lambda done: self._on_forwarded(done, address, data))

    def _count_unsent(self, change):
        """Adjust the count of forwards this replica sent on that their target has not
        taken yet, which a drain waits for."""
        with self._unsent_lock:
            self._unsent += change

    def _resend(self, payload):
        """Put a forward back on the request queue once its backoff is over, unless its
        call settled meanwhile."""
        if json.loads(payload).get("future_id") in self._forwarded:
            self.request_queue.put(payload)
        self._count_unsent(-1)

    def _on_forwarded(self, call, address, data):
        """When the replica was unreachable or did not answer in time, mark it down and
        put the request back on the request queue; any other failure, or running out
        of retries, fails the request."""
        error = call.exception()
        if error is None:
            self._count_unsent(-1)
            return
        retries = data.get("retries", 0) + 1
        no_answer = error.code() in (
            grpc.StatusCode.UNAVAILABLE,
            grpc.StatusCode.DEADLINE_EXCEEDED,
        )
        if not no_answer or retries > FORWARD_RETRIES:
            logger.error("Failed to forward request to %s: %s", address, error)
            reason = error.details()
            if no_answer:
                replicas = len(self._routing.get(data.get("service")) or [])
                reason = f"it didn't answer in time ({retries} tries across its {replicas} replica(s))"
            self._mark_future_failed(
                data.get("future_id"),
                f"Could not send the call to {data.get('service')}.{data.get('function')}: {reason}",
                error_name="SendFailed",
            )
            self._count_unsent(-1)
            return
        self._down_until[address] = time.monotonic() + REPLICA_DOWN_SECONDS
        if data.get("future_id") not in self._forwarded:
            # Settled meanwhile, by its result or as lost: nothing left to send.
            self._count_unsent(-1)
            return
        data["retries"] = retries
        if error.code() == grpc.StatusCode.UNAVAILABLE:
            # Never reached, so routing picks again; a timed-out one may have queued
            # it, and its duplicate check drops a resend.
            data.pop("route_to")
        logger.warning(
            "Forwarding a request to %s failed (%s); queueing it again.",
            address,
            error.code().name,
        )
        # The first retry goes out at once; later ones back off so a replica being
        # replaced has time to come up.
        payload = json.dumps(data)
        if retries == 1:
            self.request_queue.put(payload)
            self._count_unsent(-1)
            return
        # Stays counted until _resend puts it back on the queue.
        retry = threading.Timer(
            min(0.5 * 2 ** (retries - 2), 8), self._resend, [payload]
        )
        retry.name = f"forward-retry-{data.get('future_id')}"
        retry.daemon = True
        retry.start()

    def _send_result_callback(
        self, origin, future_id, result=None, failed=0, error_message=""
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
                "failed": int(bool(failed)),
                "error": str(error_message or ""),
            }
        )
        # An absent result means not finished, so a failure must not send one.
        if result is not None:
            snapshot["result"] = result
        payload = json.dumps(snapshot)
        logger.info("Payload: Future %s,Sent %s ", future_id, payload)
        request = local_controller_pb2.JsonResponse(response=payload)
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
            # Otherwise marking it failed sends to the same unreachable consumer again.
            self.redis.srem(f"future:{future_id}:consumers", origin)
            # A failed call keeps its own error; only an undeliverable result becomes one.
            if not failed:
                reason = e.details() if isinstance(e, grpc.Call) else e
                error_message = (
                    f"Could not send the result of {snapshot.get('service')}."
                    f"{snapshot.get('method')} back to its caller: {reason}"
                )
                self._mark_future_failed(
                    future_id, error_message, error_name="ResultNotDelivered"
                )
            # One plain try with a small note, since the full hash may be over gRPC's size limit.
            note = json.dumps(
                {"future_id": future_id, "failed": 1, "error": error_message}
            )
            try:
                stub.WriteResult(local_controller_pb2.JsonResponse(response=note))
            except Exception as note_error:
                logger.error(
                    "Could not tell %s that future %s failed: %s",
                    origin,
                    future_id,
                    note_error,
                )

    def _fail_calls_to_gone_replicas(self):
        """Fail every call handed to a replica that is neither routed nor draining, such
        as one on a machine that died, so its caller gets an error instead of waiting."""
        # Not routing_table:addresses, which drops a draining replica whose calls still finish.
        known = self.redis.hgetall("routing_table:replicas").values()
        known = {address for addresses in known for address in json.loads(addresses)}
        for future_id, address in list(self._forwarded.items()):
            if address not in known:
                call = self.redis.hgetall(f"future:{future_id}")
                self._mark_future_failed(
                    future_id,
                    f"{call.get('service')}.{call.get('method')} stopped before it "
                    "finished: its replica is gone (its machine may have stopped).",
                    error_name="ReplicaRemovedError",
                )

    def _fan_out_to_consumers(self, future_id, result=None, failed=0, error_message=""):
        """Push a completed future (result or failure) to every address registered
        as a consumer on THIS machine's Redis.

        Called at every site that writes a terminal value for a future -- local
        production (_execute_locally), failure (_mark_future_failed), and remote
        arrival (WriteResult) -- so propagation is event-driven and never depends
        on anyone calling Future.value(). Whichever machine holds the consumer set is
        always either the producer or the origin, so one of those sites fires; the
        value then re-fans-out at each machine it lands on, walking the graph.

        Delivery is intentionally not deduped: a consumer's WriteResult just
        re-writes the same value, so a redundant push (e.g. racing the immediate
        push in _process_request) is idempotent and harmless.
        """
        if not future_id:
            return
        # Code in this process waiting on the value (wait_for_result) wakes at once.
        notify_result(future_id)
        self._forwarded.pop(future_id, None)
        for address in self.redis.smembers(f"future:{future_id}:consumers"):
            if address and address != self._my_address:
                self._send_result_callback(
                    address,
                    future_id,
                    result=result,
                    failed=failed,
                    error_message=error_message,
                )

    # ------------------------------------------------------------------ #
    #  Shutdown                                                            #
    # ------------------------------------------------------------------ #

    def _fail_unfinished(self):
        """Fail every call still running or queued here, so its caller gets an error
        instead of waiting on a replica that is about to be removed."""
        with self._executor_futures_lock:
            unfinished = list(self._executor_futures.values())
        while True:
            try:
                raw = self.request_queue.get_nowait()
            except queue.Empty:
                break
            # Taken and never run: done, for the queue's count of pending requests.
            self.request_queue.task_done()
            try:
                data = json.loads(raw)
            except ValueError:
                continue
            unfinished.append(
                (
                    data.get("future_id"),
                    data.get("origin"),
                    data.get("service"),
                    data.get("function"),
                )
            )
        self._cut_off.update(future_id for future_id, *_ in unfinished)
        for future_id, origin, agent_name, function in unfinished:
            logger.warning("Failing %s: its replica's drain timed out.", future_id)
            self._mark_future_failed(
                future_id,
                f"{agent_name}.{function} stopped before it finished: its replica "
                "was removed (scaled down or replaced).",
                origin,
                error_name="ReplicaRemovedError",
            )

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
                future_ids = sorted(
                    str(outstanding[future][0]) for future in unfinished
                )
                logger.warning(
                    "Executor shutdown timed out with requests still running: %s",
                    ", ".join(future_ids),
                )
        self.mark_stopped()
        if self._log_handler is not None:
            logging.getLogger().removeHandler(self._log_handler)
        self.server.stop(0)
        stop_health_server(self._health_server)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=50051)
    args = parser.parse_args()

    controller = LocalController(port=args.port)
    controller.run()
