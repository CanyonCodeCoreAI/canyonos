# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

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
hands it to the machine and replica provisioners.
"""

import logging
import os
import re
import subprocess

from canyonos_core.controller.utils import config_env
from canyonos_core.controller.utils.config_specs import read_config_specs
from canyonos_core.controller.utils.config_env import resolve_env_file
from canyonos_core.controller.utils.redis_client import RedisClient
from canyonos_core.endpoint import ENDPOINT_CPUS, ENDPOINT_PORT, ENDPOINT_AGENT_NAME
from canyonos_core.reconciler import providers

logger = logging.getLogger(__name__)

DEFAULT_SSH_KEY_PATH = "~/.ssh/canyonos_ec2"

_REMOTE_COPY_PATH = re.compile(
    r"(/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+/canyonos\.[A-Za-z0-9]+/env"
)


def _is_local_host(host):
    return host in {"localhost", "127.0.0.1"}


def ssh_args(config, host, user=None):
    """Return the `ssh ... target` prefix that reaches a remote host with the key
    `config` names."""
    ssh_key_path = os.path.expanduser(
        config.get("ssh_private_key_path", DEFAULT_SSH_KEY_PATH)
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


def run_on_machine(config, cmd, host, user=None):
    """Run a command on the machine at `host`: here when it is this one, otherwise over
    SSH with the key `config` names."""
    try:
        if _is_local_host(host):
            return subprocess.run(cmd, capture_output=True, text=True, timeout=180)

        remote_cmd = " ".join(cmd)
        if cmd and cmd[0] == "docker":
            remote_cmd = f"sudo {remote_cmd}"
        return subprocess.run(
            ssh_args(config, host, user) + [remote_cmd],
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


def _redis_connect_host(host):
    """Host to open a Redis connection to from this process."""
    if _is_local_host(host):
        return os.environ.get("CANYONOS_REDIS_HOST", "localhost")
    return host


def replica_id(agent_name, replica_index):
    """Return one agent replica's ID (e.g. `Alpha-0`), used to key it in Redis and to
    label its telemetry."""
    return f"{agent_name}-{replica_index}"


def replica_key(agent_name, replica_index):
    """Return the Redis key of one replica's record."""
    return f"agent_instance:{replica_id(agent_name, replica_index)}"


def replica_id_from_record(replica):
    """Return the replica ID for a record read back from Redis."""
    return replica_id(replica["agent_name"], replica["replica_index"])


def list_replicas(redis_client, agent_name=None):
    """Replica records straight from Redis."""
    if agent_name:
        replica_ids = sorted(redis_client.smembers(f"agent:{agent_name}:instances"))
        keys = [f"agent_instance:{replica_id}" for replica_id in replica_ids]
    else:
        keys = sorted(redis_client.scan_keys("agent_instance:*"))

    # Skips launches that haven't finished: only the final write adds address.
    return [
        replica for key in keys if (replica := redis_client.hgetall(key)).get("address")
    ]


class ControllerContext(object):
    """Everything the provisioners and providers read off `controller`."""

    def __init__(self, config_path):
        self.config_path = config_path
        self.config = self._load_config(config_path)
        # Validate before launching anything: an agent that boots without its
        # API keys fails deep inside a container, where it is expensive to debug.
        self.env_file_path = resolve_env_file(self.config_path)

        redis_cfg = self.config.get("redis", {})
        self.redis = RedisClient(
            host=_redis_connect_host(redis_cfg.get("host", "localhost")),
            port=redis_cfg.get("port", 6379),
            db=redis_cfg.get("db", 0),
        )

        self.poll_interval = self.config.get("poll_interval", 5)
        self._set_agent_specs(self.config.get("agents", []))
        self.redis_containers = {}  # host -> container_name
        self.redis_ports = {}  # host -> published redis port
        self.machine_redis = {}  # host -> RedisClient
        providers.bind(self)

    @staticmethod
    def _load_config(config_path):
        """Load the YAML config, importing root .env values and expanding ${VAR} refs,
        and add the `endpoint:` block as one more replica spec after the agents.
        Also gives each agent spec the deployment's `provider`, in the spelling replica
        records use (`ec2` becomes `EC2`); the endpoint stays on this machine. A config
        without `project_id` is refused: `canyonos deploy` writes one before syncing."""
        config = config_env.load_config(config_path)
        if not isinstance(config, dict):
            raise RuntimeError(f"Config must contain a YAML mapping: {config_path}")
        if not config.get("project_id"):
            raise RuntimeError(
                f"{config_path} has no project_id. A current `canyonos deploy` writes one "
                "before syncing; a config you supply yourself needs `project_id: <uuid>`."
            )
        agent_specs = config["agents"]
        endpoint = config["endpoint"]
        provider = providers.canonical_name(config.get("provider", providers.DEFAULT))
        for agent_spec in agent_specs:
            agent_spec["provider"] = provider
        agent_specs.append(
            {
                "name": ENDPOINT_AGENT_NAME,
                "type": "endpoint",
                "replicas": 1,
                "resources": {"cpu": ENDPOINT_CPUS},
                "api_port": endpoint.get("api_port", ENDPOINT_PORT),
                "agent": endpoint["agent"],
                "method": endpoint["method"],
                "provider": providers.DEFAULT,
            }
        )
        return config

    def _set_agent_specs(self, agent_specs):
        """Set the agent spec list and its by-name index together so they can't drift."""
        self.agent_specs = agent_specs
        self.agent_specs_by_name = {
            agent_spec["name"]: agent_spec for agent_spec in agent_specs
        }

    def refresh_agent_specs_from_redis(self):
        """Adopt the published agent specs; True when they replaced what we had."""
        try:
            agent_specs = read_config_specs(self.redis)
        except Exception as e:
            logger.warning("Failed to read published agent specs: %s", e)
            return False
        if agent_specs is None:
            return False
        if agent_specs == self.agent_specs:
            return False
        self._set_agent_specs(agent_specs)
        return True

    def refresh_config(self):
        """Re-read the config and its env file path; keep the old ones if the new config
        is unusable."""
        try:
            config = self._load_config(self.config_path)
            self.env_file_path = resolve_env_file(self.config_path)
        except Exception as e:
            logger.warning(
                "Keeping the current config; reloading %s failed: %s",
                self.config_path,
                e,
            )
            return
        self.config = config

    def attach_local_machine_redis(self):
        """Point self.redis at this machine's Redis without launching anything."""
        port = self.config.get("redis", {}).get("port", 6379)
        self.redis_ports["localhost"] = port
        client = RedisClient(host=_redis_connect_host("localhost"), port=port)
        self.machine_redis["localhost"] = client
        self.redis = client

    def machine_redis_for_replica(self, replica):
        """Redis client for the machine a replica runs on, connecting on demand."""
        host = replica.get("private_host")
        if not host:
            return self.redis
        if host in self.machine_redis:
            return self.machine_redis[host]

        port = int(replica.get("redis_port") or 6379)
        client = RedisClient(host=_redis_connect_host(host), port=port)
        self.machine_redis[host] = client
        return client

    def remove_unused_redis_clients(self, replicas):
        """Drop the Redis clients of machines other than this one that no given replica runs on."""
        hosts = {"localhost"} | {replica["private_host"] for replica in replicas}
        for host in set(self.machine_redis) - hosts:
            # Two threads may drop the same client at once.
            self.machine_redis.pop(host, None)

    def _run_cmd(self, cmd, host, user=None):
        """Run a command locally, or on a remote host over SSH."""
        return run_on_machine(self.config, cmd, host, user)

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
        return ssh_args(self.config, host, user)
