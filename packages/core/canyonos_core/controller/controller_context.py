# Controller Context
# Config, Redis clients and command execution: the controller surface that
# the Provisioner and the cloud provider runtimes depend on.
# GlobalController subclasses this; the reconciler process builds one directly.

import logging
import os
import re
import subprocess

import yaml

from canyonos_core.controller.utils.config_specs import read_config_specs
from canyonos_core.controller.utils.redis_client import RedisClient

logger = logging.getLogger(__name__)

_RESERVED_ENV_KEYS = frozenset({"CANYONOS_LLM_STUB_TEXT"})


def _is_local_host(host):
    return host in {"localhost", "127.0.0.1"}


def _redis_connect_host(host):
    """Host to open a Redis connection to from this process."""
    return "localhost" if _is_local_host(host) else host


class ControllerContext(object):
    """Everything the provisioner and provider runtimes read off `controller`.

    No cluster bootstrap and no gRPC dependency; those belong to GlobalController alone.
    """

    def __init__(self, config_path):
        self.config_path = config_path
        self.config = self._load_config(config_path)

        redis_cfg = self.config.get("redis", {})
        self.redis = RedisClient(
            host=redis_cfg.get("host", "localhost"),
            port=redis_cfg.get("port", 6379),
            db=redis_cfg.get("db", 0),
        )

        self.poll_interval = self.config.get("poll_interval", 5)
        self._set_controllers(self.config.get("agents", []))
        self.containers = {}  # name -> [runtime_id, ...]
        self.redis_containers = {}  # host -> container_name
        self.node_redis = {}  # host -> RedisClient

    # ------------------------------------------------------------------ #
    #  Config                                                             #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _load_config(config_path):
        """Load the YAML config, importing root .env values and expanding ${VAR} refs.

        Both processes load through here so they cannot disagree about the config.
        """
        project_root = os.path.abspath(os.path.join(os.path.dirname(config_path), ".."))
        # Under the .car layout, config lives at <project>/.car/config, so the
        # naive parent-of-parent lands on .car itself -- go up one more level
        # to reach the actual project root where .env lives.
        if os.path.basename(project_root) == ".car":
            project_root = os.path.dirname(project_root)
        ControllerContext._load_dotenv(os.path.join(project_root, ".env"))
        with open(config_path, "r") as f:
            config = yaml.safe_load(f)
        return ControllerContext._expand_env_value(config)

    @staticmethod
    def _load_dotenv(path):
        """Load simple KEY=VALUE entries without overriding existing environment values."""
        if not os.path.isfile(path):
            return
        with open(path, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                    value = value[1:-1]
                if key in _RESERVED_ENV_KEYS:
                    # Reserved internal control -- never honor it from user .env.
                    continue
                if key and key not in os.environ:
                    os.environ[key] = value

    @staticmethod
    def _expand_env_value(value):
        if isinstance(value, str):
            return re.sub(
                r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}",
                lambda m: os.environ.get(m.group(1), m.group(0)),
                value,
            )
        if isinstance(value, dict):
            return {
                key: ControllerContext._expand_env_value(item)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [ControllerContext._expand_env_value(item) for item in value]
        return value

    def _set_controllers(self, agents):
        """Set the agent spec list and its by-name index together so they can't drift."""
        self.controllers = agents
        self.agent_specs = {spec["name"]: spec for spec in agents}

    def refresh_controllers_from_redis(self):
        """Adopt the published agent specs. True when they replaced what we had.

        Keeps the current specs when nothing is published, so an unseeded Redis
        is not read as "no agents configured".
        """
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

    # ------------------------------------------------------------------ #
    #  Redis clients                                                      #
    # ------------------------------------------------------------------ #

    def _localhost_redis_port(self):
        """The Redis port the local node's container was published on, if any."""
        for ctrl in self.controllers:
            for host, _port in self._get_replica_placements(ctrl):
                if _is_local_host(host):
                    return int(ctrl.get("redis_port", 6379))
        return None

    def attach_local_node_redis(self):
        """Point self.redis at the local node's Redis without launching anything.

        A process that only attaches to a running cluster must reach the same
        client GlobalController repoints to, or it reads a different Redis.
        """
        port = self._localhost_redis_port()
        if port is None:
            return
        client = RedisClient(host="localhost", port=port)
        self.node_redis["localhost"] = client
        self.redis = client

    def node_redis_for_instance(self, instance):
        """Redis client for the node an instance runs on, connecting on demand.

        Connects from the instance's own record rather than assuming this process
        launched it.
        """
        host = instance.get("host")
        if not host:
            return self.redis
        if host in self.node_redis:
            return self.node_redis[host]

        port = int(instance.get("redis_port") or 6379)
        client = RedisClient(host=_redis_connect_host(host), port=port)
        self.node_redis[host] = client
        return client

    def _agent_host_key(self, host):
        """Return the host string as seen by Docker containers (for status key matching)."""
        return "host.docker.internal" if _is_local_host(host) else host

    # ------------------------------------------------------------------ #
    #  Command execution                                                  #
    # ------------------------------------------------------------------ #

    def _run_cmd(self, cmd, host, user=None):
        """
        Run a command locally or on a remote host via SSH.

        Args:
            cmd:  Command list to run.
            host: Target host.
            user: SSH user for remote hosts (None for localhost).

        Returns:
            subprocess.CompletedProcess
        """
        is_local = _is_local_host(host)
        if is_local:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        else:
            remote_cmd = " ".join(cmd)
            if cmd and cmd[0] == "docker":
                remote_cmd = f"sudo {remote_cmd}"
            return subprocess.run(
                self._ssh_args(host, user) + [remote_cmd],
                capture_output=True,
                text=True,
                timeout=180,
            )

    def _ssh_args(self, host, user=None):
        """Return the `ssh ... target` prefix used to reach a remote host."""
        ssh_key_path = os.path.expanduser(
            self.config.get("ec2", {}).get(
                "ssh_private_key_path", "~/.ssh/canyonos_ec2"
            )
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
