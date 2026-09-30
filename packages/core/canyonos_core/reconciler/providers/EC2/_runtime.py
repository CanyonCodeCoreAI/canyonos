"""
EC2 runtime helpers for CanyonOS.

This module is the EC2-specific backend for `provider: EC2` agents.
It does four things:
1. validate the EC2 config
2. create an EC2 instance
3. start the agent container on that instance
4. clean up the EC2 instance if startup fails

The global controller sets `_controller` before calling these helpers so
they can read config and reuse the controller's Docker/Redis logic.
"""

import hashlib
import logging
import os
import socket
import stat
import subprocess
import threading
import time
from typing import Any

import boto3
from botocore.exceptions import ClientError

from canyonos_core.controller.controller_context import DEFAULT_SSH_KEY_PATH
from canyonos_core.controller.utils.container_names import (
    container_name,
    redis_container_name,
)
from canyonos_core.controller.utils.env_file import env_file_args
from canyonos_core.controller.utils.redis_utils import _wait_for_redis
from canyonos_core.controller.utils.redis_client import RedisClient
from canyonos_core.reconciler.providers.shared_utils.image_transfer import (
    transfer_image,
)
from canyonos_core.reconciler.providers.shared_utils.llm_proxy_env import (
    llm_proxy_docker_env_args,
)

logger = logging.getLogger(__name__)

CONTAINER_PORT = 50051
PROVIDER = "ec2"
_controller: Any = None
_default_key_lock = threading.Lock()
_key_pair_lock = threading.Lock()
_imported_key_pairs = set()


def _generate_default_key(key_path):
    """Create a fresh ed25519 keypair at the default SSH key path.

    Guarded by a lock since replicas provision concurrently in a thread pool
    -- without it, two threads could both see the file missing and race to
    generate it at the same path.
    """
    with _default_key_lock:
        if os.path.isfile(key_path):
            return
        os.makedirs(os.path.dirname(key_path), exist_ok=True, mode=0o700)
        subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-N", "", "-f", key_path, "-q"],
            check=True,
        )
        os.chmod(key_path, 0o600)


def _ssh_key_path(cfg):
    """Return the configured EC2 SSH identity after validating it locally."""
    configured_path = cfg.get("ssh_private_key_path")
    key_path = os.path.expanduser(configured_path or DEFAULT_SSH_KEY_PATH)
    if not os.path.isfile(key_path):
        if configured_path:
            raise ValueError(
                f"EC2 SSH private key does not exist: {key_path}. "
                "Set ec2.ssh_private_key_path to the controller key."
            )
        _generate_default_key(key_path)
    if not os.access(key_path, os.R_OK):
        raise ValueError(f"EC2 SSH private key is not readable: {key_path}")

    mode = stat.S_IMODE(os.stat(key_path).st_mode)
    if mode & 0o077:
        raise ValueError(
            f"EC2 SSH private key has insecure permissions {mode:04o}: {key_path}. "
            "Use chmod 600 (or 400)."
        )
    return key_path


def _ec2_config():
    """Return the EC2 config after checking required fields."""
    cfg = _controller.config.get("ec2", {})
    required = [
        "subnet_id",
        "security_group_ids",
        "region",
    ]
    missing = [field for field in required if not cfg.get(field)]
    if missing:
        raise ValueError(f"Missing EC2 config: {', '.join(sorted(missing))}")
    return cfg


def _ensure_key_pair_imported(cfg, key_path, client):
    """Import the controller's SSH public key as a per-project EC2 key pair, if it isn't already.

    Naming the key pair after the project id and a hash of the public key itself
    (rather than one fixed name) keeps unrelated projects, and a key that gets
    regenerated after the original file is lost, from colliding under the same
    AWS key pair name and silently drifting out of sync with it.
    """
    public_key = subprocess.run(
        ["ssh-keygen", "-y", "-f", key_path],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.encode()
    project_id = _controller.config.get("project_id") or "default"
    fingerprint = hashlib.sha256(public_key).hexdigest()[:8]
    key_name = f"canyonos-ec2-{project_id}-{fingerprint}"
    imported = (cfg["region"], key_name)
    with _key_pair_lock:
        if imported in _imported_key_pairs:
            return key_name
        try:
            client.import_key_pair(KeyName=key_name, PublicKeyMaterial=public_key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") != "InvalidKeyPair.Duplicate":
                raise
        _imported_key_pairs.add(imported)
    return key_name


def provision_instance(spec, replica_index, next_host_port=None):
    """Launch one EC2 instance for an agent replica and wait for its IPs."""
    cfg = _ec2_config()
    client = boto3.client("ec2", region_name=cfg["region"])
    key_name = _ensure_key_pair_imported(cfg, _ssh_key_path(cfg), client)
    agent_name = spec["name"]
    request = {
        "ImageId": cfg["ami_id"],
        "InstanceType": spec["instance_type"],
        "NetworkInterfaces": [
            {
                "DeviceIndex": 0,
                "SubnetId": cfg["subnet_id"],
                "Groups": cfg["security_group_ids"],
                "AssociatePublicIpAddress": True,
            }
        ],
        "KeyName": key_name,
        "MinCount": 1,
        "MaxCount": 1,
        "TagSpecifications": [
            {
                "ResourceType": "instance",
                "Tags": [
                    {"Key": "Name", "Value": f"canyonos-{agent_name}-{replica_index}"},
                    {"Key": "CreatedBy", "Value": "EC2 Fast Launch"},
                ],
            },
            {
                "ResourceType": "volume",
                "Tags": [
                    {
                        "Key": "CreatedBy",
                        "Value": "EC2 Fast Launch",
                    }
                ],
            },
        ],
    }
    if cfg.get("instance_profile_name"):
        request["IamInstanceProfile"] = {"Name": cfg["instance_profile_name"]}

    response = client.run_instances(**request)
    instance_id = response["Instances"][0]["InstanceId"]
    runtime_id = f"{container_name(agent_name, replica_index)}--{instance_id}"
    client.get_waiter("instance_running").wait(InstanceIds=[instance_id])

    deadline = time.time() + cfg.get("public_ip_timeout", 120)
    instance = None
    while time.time() < deadline:
        response = client.describe_instances(InstanceIds=[instance_id])
        for reservation in response.get("Reservations", []):
            for candidate in reservation.get("Instances", []):
                if candidate.get("InstanceId") == instance_id:
                    instance = candidate
                    break
            if instance:
                break
        if instance and instance.get("PublicIpAddress"):
            break
        time.sleep(2)

    if not (instance and instance.get("PublicIpAddress")):
        raise RuntimeError(f"EC2 instance {instance_id} never got a public IP address.")
    # The control plane reaches the instance over the private IP; the public IP is only handed to outside workflow callers.
    private_host = instance["PrivateIpAddress"]
    public_host = instance["PublicIpAddress"]

    redis_port = spec.get(
        "redis_port", _controller.config.get("redis", {}).get("port", 6379)
    )
    record = {
        "private_host": private_host,
        "public_host": public_host,
        "runtime_id": runtime_id,
        "redis_host": "host.docker.internal",
        "redis_port": redis_port,
    }
    return record


def bootstrap_instance(provisioned, spec, replica_index, agent_id):
    """Start the agent container on the new EC2 host and return its record."""
    cfg = _ec2_config()
    private_host = provisioned["private_host"]
    runtime_id = provisioned["runtime_id"]
    redis_host = provisioned["redis_host"]
    redis_port = provisioned["redis_port"]

    try:
        _bootstrap_instance(
            private_host,
            spec,
            replica_index,
            cfg,
            redis_host=redis_host,
            redis_port=redis_port,
            agent_id=agent_id,
        )
        health_port = (
            spec.get("db_port", 5432)
            if spec.get("type") == "database"
            else CONTAINER_PORT
        )
        _check_controller_health(
            f"{private_host}:{health_port}",
            timeout=cfg.get("controller_health_timeout", 180),
        )
        instance = {
            "agent_name": spec["name"],
            "provider": "EC2",
            "instance_type": spec["instance_type"],
            "replica_index": str(replica_index),
            "private_host": private_host,
            "public_host": provisioned["public_host"],
            "host_port": str(CONTAINER_PORT),
            "container_port": str(CONTAINER_PORT),
            "endpoint": f"{private_host}:{CONTAINER_PORT}",
            "redis_host": redis_host,
            "redis_port": str(redis_port),
            "runtime_id": runtime_id,
        }
        if spec.get("type") == "workflow":
            instance["api_port"] = str(spec.get("api_port", 8080))
        elif spec.get("type") == "database":
            db_port = str(spec.get("db_port", 5432))
            instance["container_port"] = "5432"
            instance["host_port"] = db_port
            instance["endpoint"] = f"{private_host}:{db_port}"
        return instance
    except Exception:
        terminate_instance(provisioned)
        raise


def _bootstrap_instance(
    private_host, spec, replica_index, cfg, redis_host, redis_port, agent_id
):
    """Run the agent container over SSH."""
    ssh_user = cfg["ssh_user"]

    for _ in range(20):
        result = _controller._run_cmd(["true"], private_host, user=ssh_user)
        if result.returncode == 0:
            break
        time.sleep(2)
    else:
        raise TimeoutError(f"SSH never became ready on {private_host}")

    redis_container = redis_container_name(private_host)
    result = _controller._run_cmd(
        [
            "docker",
            "run",
            "-d",
            "--name",
            redis_container,
            "-p",
            f"{redis_port}:{redis_port}",
            "redis:alpine",
            "redis-server",
            "--port",
            str(redis_port),
        ],
        private_host,
        user=ssh_user,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Failed to start Redis on {private_host}: {(result.stderr or result.stdout or '').strip()}"
        )
    getattr(_controller, "redis_containers", {})[private_host] = redis_container
    node_redis = RedisClient(host=private_host, port=int(redis_port))
    getattr(_controller, "node_redis", {})[private_host] = node_redis

    _wait_for_redis(node_redis, private_host, redis_port)

    node_redis.set(f"controller:{private_host}:{CONTAINER_PORT}:agent_id", agent_id)
    if spec.get("instance_type"):
        node_redis.set(f"agent:{agent_id}:instance_type", spec["instance_type"])

    agent_name = spec["name"]
    image = f"canyonos-{agent_name.lower()}"
    container = container_name(agent_name, replica_index)
    if spec.get("type") == "database":
        port_args = ["-p", f"{spec.get('db_port', 5432)}:5432"]
    else:
        port_args = ["-p", f"{CONTAINER_PORT}:{CONTAINER_PORT}"]
        if spec.get("type") == "workflow":
            port_args += ["-p", f"{spec.get('api_port', 8080)}:8080"]

    volume_args = []
    if spec.get("type") == "database":
        volume_path = spec.get("volume_path")
        if volume_path:
            volume_args = ["-v", f"canyonos-{agent_name.lower()}-data:{volume_path}"]

    transfer_image(_controller, image, private_host, ssh_user)

    cmd = [
        "docker",
        "run",
        "-d",
        "--restart",
        "unless-stopped",
        "--add-host=host.docker.internal:host-gateway",
        "--name",
        container,
        *port_args,
        *volume_args,
        "-e",
        f"CANYONOS_REDIS_HOST={redis_host}",
        "-e",
        f"CANYONOS_REDIS_PORT={redis_port}",
        "-e",
        f"CANYONOS_AGENT_HOST={private_host}",
        "-e",
        f"CANYONOS_AGENT_PORT={CONTAINER_PORT}",
        "-e",
        f"CANYONOS_POLL_INTERVAL={_controller.config.get('poll_interval', 5)}",
        # Route the agent's LLM SDK calls through the in-container proxy for telemetry.
        *llm_proxy_docker_env_args(),
        # The LLM stub is a local-only `canyonos test` control; it must never be
        # active on EC2. Pin it empty explicitly so a user's --env-file cannot
        # turn it on (docker: -e beats --env-file).
        "-e",
        "CANYONOS_LLM_STUB_TEXT=",
        "-e",
        f"CANYONOS_LOGS_ENABLED={str(bool(_controller.config.get('logs', True))).lower()}",
    ]
    if spec.get("type") == "workflow":
        project_id = _controller.config.get("project_id")
        if project_id:
            cmd.extend(["-e", f"CANYONOS_PROJECT_ID={project_id}"])
    elif spec.get("type") == "database":
        for key, value in spec.get("env", {}).items():
            cmd.extend(["-e", f"{key}={value}"])

    # User secrets from `env_file`. Explicit -e flags above still win over
    # anything in the file.
    with env_file_args(_controller, private_host, ssh_user, is_local=False) as env_args:
        cmd.extend(env_args)
        cmd.append(image)
        result = _controller._run_cmd(cmd, private_host, user=ssh_user)
    if result.returncode != 0:
        raise RuntimeError(
            f"SSH bootstrap failed on {private_host}: {(result.stderr or result.stdout or '').strip()}"
        )


def _check_controller_health(endpoint, timeout=None):
    """Wait until the launched container accepts TCP connections."""
    host, port = endpoint.split(":")
    deadline = time.time() + (
        timeout
        or _controller.config.get("ec2", {}).get("controller_health_timeout", 180)
    )
    while time.time() < deadline:
        try:
            with socket.create_connection((host, int(port)), timeout=2):
                return True
        except OSError:
            time.sleep(2)
    raise TimeoutError(f"EC2 runtime endpoint never became reachable at {endpoint}.")


def terminate_instance(instance):
    """Delete the EC2 instance that belongs to a runtime id."""
    runtime_id = instance.get("runtime_id") if isinstance(instance, dict) else instance
    if not runtime_id or "--" not in runtime_id:
        raise ValueError(f"Invalid EC2 runtime id: {runtime_id}")

    host = instance.get("private_host") if isinstance(instance, dict) else None
    if host:
        getattr(_controller, "redis_containers", {}).pop(host, None)
        getattr(_controller, "node_redis", {}).pop(host, None)

    client = boto3.client("ec2", region_name=_ec2_config()["region"])
    client.terminate_instances(InstanceIds=[runtime_id.rsplit("--", 1)[1]])


def docker_container_name(instance):
    """The name this instance's container answers to on its EC2 host.

    The runtime id is `<container name>--<ec2 instance id>`, since terminating
    the replica means terminating the host; only the part before the separator
    was ever passed to `docker run --name`.
    """
    runtime_id = instance.get("runtime_id")
    return runtime_id.rsplit("--", 1)[0] if runtime_id else None
