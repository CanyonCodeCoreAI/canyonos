"""Config, Redis clients and command execution shared by GlobalController and the reconciler.

What it holds:
- Config loading: reads the project's .env, loads the YAML and fills in ${VAR} values, so
  both processes see the same values.
- Redis connections: the main one, plus one per machine opened when first needed.
- The agent list from the config, by name, and a refresh from the list published to Redis.
- Running commands locally or over SSH, and copying the env file to a remote machine.
- Reading replica records (agent_instance:*) out of Redis, as plain functions.

The reconciler runs as a separate process and cannot import global_controller.py, which
adds a grpc_stubs folder to the import path based on the current directory. GlobalController
extends this class with the controller-only work; the reconciler creates one directly and
hands it to the Provisioner.
"""

import logging
import os
import re
import subprocess

from canyonos_core.controller.utils import config_env
from canyonos_core.controller.utils.config_specs import read_config_specs
from canyonos_core.controller.utils.env_file import resolve_env_file
from canyonos_core.controller.utils.redis_client import RedisClient
from canyonos_core.endpoint import ENDPOINT_CPUS, ENDPOINT_PORT, SERVICE_NAME
from canyonos_core.reconciler import providers

logger = logging.getLogger(__name__)

DEFAULT_SSH_KEY_PATH = "~/.ssh/canyonos_ec2"

_REMOTE_COPY_PATH = re.compile(
    r"(/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+/canyonos\.[A-Za-z0-9]+/env"
)


def _is_local_host(host):
    return host in {"localhost", "127.0.0.1"}


def _redis_connect_host(host):
    """Host to open a Redis connection to from this process."""
    if _is_local_host(host):
        return os.environ.get("CANYONOS_REDIS_HOST", "localhost")
    return host


def instance_id(provider, agent_name, replica_index):
    """Return one agent replica's ID (e.g. `local:Alpha:0`), used to key it in Redis."""
    return f"{provider}:{agent_name}:{replica_index}"


def instance_key(provider, agent_name, replica_index):
    """Return the Redis key of one replica's record."""
    return f"agent_instance:{instance_id(provider, agent_name, replica_index)}"


def instance_id_from_record(instance):
    """Return the replica ID for a record read back from Redis."""
    return instance_id(
        instance["provider"], instance["agent_name"], int(instance["replica_index"])
    )


def localhost_redis_port(agents):
    """Return the port of this machine's Redis container, taken from the first agent with
    a replica here, or None if no agent runs here."""
    for ctrl in agents:
        for host, _port in ControllerContext._get_replica_placements(ctrl):
            if _is_local_host(host):
                return int(ctrl.get("redis_port", 6379))
    return None


def list_instances(redis_client, agent_name=None):
    """Instance records straight from Redis."""
    if agent_name:
        instance_ids = sorted(redis_client.smembers(f"agent:{agent_name}:instances"))
        keys = [f"agent_instance:{instance_id}" for instance_id in instance_ids]
    else:
        keys = sorted(redis_client.scan_keys("agent_instance:*"))

    # Skips launches that haven't finished: only the final write adds routing_endpoint.
    return [
        instance
        for key in keys
        if (instance := redis_client.hgetall(key)).get("routing_endpoint")
    ]


class ControllerContext(object):
    """Everything the provisioner and provider runtimes read off `controller`."""

    def __init__(self, config_path):
        self.config_path = config_path
        self.config = self._load_config(config_path)
        # Validate before launching anything: an agent that boots without its
        # API keys fails deep inside a container, where it is expensive to debug.
        self.env_file_path = resolve_env_file(self.config)

        redis_cfg = self.config.get("redis", {})
        self.redis = RedisClient(
            host=_redis_connect_host(redis_cfg.get("host", "localhost")),
            port=redis_cfg.get("port", 6379),
            db=redis_cfg.get("db", 0),
        )

        self.poll_interval = self.config.get("poll_interval", 5)
        self._set_controllers(self.config.get("agents", []))
        self.redis_containers = {}  # host -> container_name
        self.redis_ports = {}  # host -> published redis port
        self.node_redis = {}  # host -> RedisClient
        providers.bind(self)

    @staticmethod
    def _load_config(config_path):
        """Load the YAML config, importing root .env values and expanding ${VAR} refs,
        and add the `endpoint:` block as one more replica spec after the agents.
        Also rewrites each spec's provider name to its standard spelling (`ec2` becomes
        `EC2`), which is how replica records spell it."""
        config = config_env.load_config(config_path)
        if not isinstance(config, dict):
            raise RuntimeError(f"Config must contain a YAML mapping: {config_path}")
        agents = config["agents"]
        endpoint = config["endpoint"]
        agents.append(
            {
                "name": SERVICE_NAME,
                "type": "endpoint",
                "replicas": 1,
                # One Redis runs per machine, so the endpoint shares the port of the
                # agents placed here.
                "redis_port": localhost_redis_port(agents) or 6379,
                "resources": {"cpu": ENDPOINT_CPUS},
                "api_port": endpoint.get("api_port", ENDPOINT_PORT),
                "agent": endpoint["agent"],
                "method": endpoint["method"],
            }
        )
        for agent in agents:
            agent["provider"] = providers.canonical_name(
                agent.get("provider", providers.DEFAULT)
            )
        return config

    # Kept as aliases for callers that use these helpers directly. The parser
    # itself lives in config_env so the controller, reconciler and schema use
    # the same dotenv and expansion rules.
    _load_dotenv = staticmethod(config_env.load_dotenv)
    _expand_env_value = staticmethod(config_env.expand_env_value)

    def _set_controllers(self, agents):
        """Set the agent spec list and its by-name index together so they can't drift."""
        self.controllers = agents
        self.agent_specs = {spec["name"]: spec for spec in agents}

    def refresh_controllers_from_redis(self):
        """Adopt the published agent specs; True when they replaced what we had."""
        try:
            specs = read_config_specs(self.redis)
        except Exception as e:
            logger.warning("Failed to read published agent specs: %s", e)
            return False
        if specs is None:
            return False
        if specs == self.controllers:
            return False
        self._set_controllers(specs)
        return True

    def refresh_config(self):
        """Re-read the config and its env file path; keep the old ones if the new config
        is unusable."""
        try:
            config = self._load_config(self.config_path)
            self.env_file_path = resolve_env_file(config)
        except Exception as e:
            logger.warning(
                "Keeping the current config; reloading %s failed: %s",
                self.config_path,
                e,
            )
            return
        self.config = config

    def _ssh_user(self, ctrl):
        """SSH user for a service's hosts, as its provider decides."""
        return providers.get(ctrl["provider"]).ssh_user(ctrl)

    @staticmethod
    def _get_replica_placements(ctrl):
        """Normalize replicas into a list of (host, port) placements."""
        replicas = ctrl.get("replicas", 1)
        default_host = ctrl.get("host", "localhost")
        base_port = ctrl.get("port", 50051)

        if isinstance(replicas, int):
            return [(default_host, base_port + i) for i in range(replicas)]
        if isinstance(replicas, list):
            return [
                (r.get("host", default_host), r.get("port", base_port))
                for r in replicas
            ]
        return [(default_host, base_port)]

    def attach_local_node_redis(self):
        """Point self.redis at the local node's Redis without launching anything."""
        port = localhost_redis_port(self.controllers)
        if port is None:
            return
        client = RedisClient(host=_redis_connect_host("localhost"), port=port)
        self.node_redis["localhost"] = client
        self.redis = client

    def node_redis_for_instance(self, instance):
        """Redis client for the node an instance runs on, connecting on demand."""
        host = instance.get("private_host")
        if not host:
            return self.redis
        if host in self.node_redis:
            return self.node_redis[host]

        port = int(instance.get("redis_port") or 6379)
        client = RedisClient(host=_redis_connect_host(host), port=port)
        self.node_redis[host] = client
        return client

    def prune_node_redis(self, instances):
        """Drop the Redis clients of hosts that no configured agent or given replica runs on."""
        hosts = {instance["private_host"] for instance in instances}
        for ctrl in self.controllers:
            hosts.update(host for host, _port in self._get_replica_placements(ctrl))
        for host in set(self.node_redis) - hosts:
            del self.node_redis[host]

    def _run_cmd(self, cmd, host, user=None):
        """Run a command locally, or on a remote host over SSH."""
        is_local = _is_local_host(host)
        try:
            if is_local:
                return subprocess.run(cmd, capture_output=True, text=True, timeout=180)

            remote_cmd = " ".join(cmd)
            if cmd and cmd[0] == "docker":
                remote_cmd = f"sudo {remote_cmd}"
            return subprocess.run(
                self._ssh_args(host, user) + [remote_cmd],
                capture_output=True,
                text=True,
                timeout=180,
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError(
                f"Command timed out after 180s on {host}: {' '.join(cmd)}"
            ) from None
        except OSError as e:
            raise RuntimeError(f"Could not run command on {host}: {e}") from None

    def _push_file(self, local_path, host, user=None):
        """Copy a file into a new owner-only directory on a remote host; return its path."""
        # mktemp -d creates the dir exclusively, so no other user can pre-plant the path.
        remote_cmd = (
            'umask 077 && d=$(mktemp -d "${TMPDIR:-/tmp}/canyonos.XXXXXXXXXX") '
            '&& cat > "$d/env" && printf %s "$d/env"'
        )
        try:
            with open(local_path, "rb") as f:
                result = subprocess.run(
                    self._ssh_args(host, user) + [remote_cmd],
                    stdin=f,
                    capture_output=True,
                    text=True,
                    timeout=180,
                    check=False,
                )
        except subprocess.TimeoutExpired:
            raise RuntimeError(
                f"Copying {local_path} to {host} timed out after 180s"
            ) from None
        except OSError as e:
            raise RuntimeError(f"Could not copy {local_path} to {host}: {e}") from None
        stdout = result.stdout or ""
        if result.returncode != 0:
            raise RuntimeError(
                f"Failed to copy {local_path} to {host}: "
                f"{(result.stderr or stdout).strip()}"
            )
        # The path later goes to `rm -rf`, so accept only what mktemp could print.
        if not _REMOTE_COPY_PATH.fullmatch(stdout):
            raise RuntimeError(
                f"Copying {local_path} to {host} returned an unexpected path: {stdout!r}"
            )
        return stdout

    def _ssh_args(self, host, user=None):
        """Return the `ssh ... target` prefix used to reach a remote host."""
        ssh_key_path = os.path.expanduser(
            self.config.get("ssh_private_key_path", DEFAULT_SSH_KEY_PATH)
        )
        return [
            "ssh",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ServerAliveInterval=10",
            "-o",
            "ServerAliveCountMax=3",
            "-i",
            ssh_key_path,
            f"{user}@{host}" if user else host,
        ]
