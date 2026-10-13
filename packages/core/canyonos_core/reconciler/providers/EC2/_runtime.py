"""
EC2 runtime helpers for CanyonOS.

This module is the EC2-specific backend for `provider: EC2` agents.
It does three things:
1. create an EC2 instance
2. start the agent container on that instance
3. terminate the EC2 instance

`providers.bind` sets `_controller` before any of these helpers run, so
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

from canyonos_core.controller.controller_context import DEFAULT_SSH_KEY_PATH
from canyonos_core.controller.deploy import WORKFLOW_CONTAINER_PORT
from canyonos_core.controller.utils.container_log import dump_container_log
from canyonos_core.controller.utils.container_names import (
    container_name,
    data_volume_name,
    image_name,
    project_label_args,
    redis_container_name,
)
from canyonos_core.controller.utils.docker_utils import docker_available
from canyonos_core.controller.utils.env_file import env_file_args
from canyonos_core.controller.utils.redis_utils import _wait_for_redis
from canyonos_core.controller.utils.redis_client import RedisClient
from canyonos_core.llm_gateway import pricing
from canyonos_core.reconciler.providers.shared_utils.docker_host import (
    container_log_tail,
    container_running,
)
from canyonos_core.reconciler.providers.shared_utils.image_transfer import (
    transfer_image,
)
from canyonos_core.reconciler.providers.shared_utils.llm_gateway_env import (
    llm_gateway_docker_env_args,
)
from canyonos_core.reconciler.providers.shared_utils.resource_limits import (
    resource_limit_args,
)

logger = logging.getLogger(__name__)

CONTAINER_PORT = 50051
DEFAULT_SSH_USER = "ubuntu"
# This default AMI is a public AMI created by Canyon Code, containing base Ubuntu + Docker + zstd. Can be overridden manually with your own ami_id
DEFAULT_AMI_ID = "ami-0101d5f2a2a9cd55c"
# AWS can take minutes to list an instance it just launched.
LAUNCH_LISTING_GRACE_SECONDS = 300
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


def _ssh_key_path():
    """Return the path to the SSH private key, creating the default key if it doesn't
    exist yet. Raises if a configured key is missing, unreadable, or open to other users."""
    configured_path = _controller.config.get("ssh_private_key_path")
    key_path = os.path.expanduser(configured_path or DEFAULT_SSH_KEY_PATH)
    if not os.path.isfile(key_path):
        if configured_path:
            raise ValueError(
                f"EC2 SSH private key does not exist: {key_path}. "
                "Set ssh_private_key_path to the controller key."
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


def preflight():
    """Raise if Docker isn't installed and running on this machine; EC2 replicas run
    images built here."""
    if not docker_available():
        raise RuntimeError(
            "EC2-backed `canyonos deploy` requires local Docker, "
            "but Docker is unavailable or unreachable."
        )


def port_claim_host(spec):
    """Return None: each replica gets its own instance, so there is no shared host to
    pick a free port on."""
    return None


def ssh_user(entry):
    """The SSH user for every EC2 host: `ec2.ssh_user`, else `ubuntu`."""
    return _controller.config.get("ec2", {}).get("ssh_user", DEFAULT_SSH_USER)


def hourly_cost(spec):
    """The USD per hour of the agent's `instance_type`, or 0 if it has no listed price."""
    return pricing.instance_hourly_cost(spec["instance_type"])


def _ec2_config():
    """Return the config's `ec2:` section, or raise an error naming the config file if
    it has none."""
    cfg = _controller.config.get("ec2")
    if not cfg:
        raise RuntimeError(
            f"{_controller.config_path} has no ec2: section, which launching or "
            "removing an EC2 replica needs"
        )
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
    from botocore.exceptions import ClientError

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


def provision_instance(spec, replica_index, next_host_port, launch_id):
    """Launch one EC2 instance for an agent replica, without waiting for it to boot."""
    import boto3

    cfg = _ec2_config()
    client = boto3.client("ec2", region_name=cfg["region"])
    key_name = _ensure_key_pair_imported(cfg, _ssh_key_path(), client)
    agent_name = spec["name"]
    request = {
        "ImageId": cfg.get("ami_id", DEFAULT_AMI_ID),
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
        # Lets terminate_instance find this instance before its id is saved.
        "ClientToken": launch_id,
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

    market_type = spec.get("market_type", "on-demand")
    # AWS has no "on-demand" MarketType; omitting InstanceMarketOptions is how on-demand is requested.
    if market_type != "on-demand":
        request["InstanceMarketOptions"] = {"MarketType": market_type}

    response = client.run_instances(**request)
    instance_id = response["Instances"][0]["InstanceId"]
    redis_port = spec.get(
        "redis_port", _controller.config.get("redis", {}).get("port", 6379)
    )
    return {
        "runtime_id": f"{container_name(agent_name, replica_index)}--{instance_id}",
        "redis_host": "host.docker.internal",
        "redis_port": redis_port,
    }


def bootstrap_instance(provisioned, spec, replica_index, agent_id):
    """Wait for the new EC2 host to boot, start the agent container on it, and return
    its record."""
    import boto3
    from botocore.exceptions import WaiterError

    cfg = _ec2_config()
    runtime_id = provisioned["runtime_id"]
    redis_host = provisioned["redis_host"]
    redis_port = provisioned["redis_port"]
    instance_id = runtime_id.rsplit("--", 1)[1]
    client = boto3.client("ec2", region_name=cfg["region"])
    try:
        client.get_waiter("instance_running").wait(InstanceIds=[instance_id])
    except WaiterError as e:
        reasons = [
            found["StateReason"]["Message"]
            for reservation in (e.last_response or {}).get("Reservations", [])
            for found in reservation["Instances"]
            if "StateReason" in found
        ]
        raise RuntimeError(
            f"EC2 instance {instance_id} never reached running: "
            f"{'; '.join(reasons) or e}"
        ) from e

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
        spec.get("db_port", 5432) if spec.get("type") == "database" else CONTAINER_PORT
    )
    instance = {
        "agent_name": spec["name"],
        "provider": "EC2",
        "replica_index": str(replica_index),
        "private_host": private_host,
        "public_host": public_host,
        "host_port": str(CONTAINER_PORT),
        "container_port": str(CONTAINER_PORT),
        "endpoint": f"{private_host}:{CONTAINER_PORT}",
        "routing_endpoint": f"{private_host}:{health_port}",
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
    try:
        _check_controller_health(
            instance["routing_endpoint"],
            timeout=cfg.get("controller_health_timeout", 180),
        )
    except TimeoutError:
        # Show the log now: removing the failed launch terminates the host and its log.
        dump_container_log(instance, "unreachable", log_tail)
        raise
    return instance


def _bootstrap_instance(
    private_host, spec, replica_index, cfg, redis_host, redis_port, agent_id
):
    """Run the agent container over SSH."""
    user = cfg.get("ssh_user", DEFAULT_SSH_USER)

    for _ in range(20):
        result = _controller._run_cmd(["true"], private_host, user=user)
        if result.returncode == 0:
            break
        time.sleep(2)
    else:
        raise TimeoutError(
            f"SSH never became ready on {user}@{private_host}: "
            f"{(result.stderr or '').strip()}"
        )

    redis_container = redis_container_name(private_host)
    result = _controller._run_cmd(
        [
            "docker",
            "run",
            "-d",
            *project_label_args(),
            "--name",
            redis_container,
            *resource_limit_args(),
            "-p",
            f"{redis_port}:{redis_port}",
            "redis:alpine",
            "redis-server",
            "--port",
            str(redis_port),
        ],
        private_host,
        user=user,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Failed to start Redis on {private_host}: {(result.stderr or result.stdout or '').strip()}"
        )
    node_redis = RedisClient(host=private_host, port=int(redis_port))

    _wait_for_redis(node_redis, private_host, redis_port)

    node_redis.set(f"controller:{private_host}:{CONTAINER_PORT}:agent_id", agent_id)

    agent_name = spec["name"]
    image = image_name(agent_name)
    container = container_name(agent_name, replica_index)
    if spec.get("type") == "database":
        port_args = ["-p", f"{spec.get('db_port', 5432)}:5432"]
    else:
        port_args = ["-p", f"{CONTAINER_PORT}:{CONTAINER_PORT}"]
        if spec.get("type") == "workflow":
            port_args += [
                "-p",
                f"{spec.get('api_port', 8080)}:{WORKFLOW_CONTAINER_PORT}",
            ]

    volume_args = []
    if spec.get("type") == "database":
        volume_path = spec.get("volume_path")
        if volume_path:
            volume_args = ["-v", f"{data_volume_name(agent_name)}:{volume_path}"]

    transfer_image(_controller, image, private_host, user)

    cmd = [
        "docker",
        "run",
        "-d",
        *project_label_args(),
        "--restart",
        "unless-stopped",
        "--add-host=host.docker.internal:host-gateway",
        "--name",
        container,
        *port_args,
        *volume_args,
        *resource_limit_args(
            spec.get("resources"), apply_defaults=spec.get("type") != "database"
        ),
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
        # Route the agent's LLM SDK calls through the in-container gateway for telemetry.
        *llm_gateway_docker_env_args(),
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
    with env_file_args(_controller, private_host, user, is_local=False) as env_args:
        cmd.extend(env_args)
        cmd.append(image)
        result = _controller._run_cmd(cmd, private_host, user=user)
    if result.returncode != 0:
        raise RuntimeError(
            f"SSH bootstrap failed on {private_host}: {(result.stderr or result.stdout or '').strip()}"
        )


def _check_controller_health(endpoint, timeout):
    """Wait until the launched container accepts TCP connections."""
    host, port = endpoint.split(":")
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, int(port)), timeout=2):
                return True
        except OSError:
            time.sleep(2)
    raise TimeoutError(f"EC2 runtime endpoint never became reachable at {endpoint}.")


def terminate_instance(instance):
    """Terminate the EC2 instance behind a replica's record. If the launch stopped before
    its runtime id was saved, the instance is found by its launch id instead. An instance
    that is already gone is not an error. A recent launch that AWS doesn't list yet
    raises, so the record is kept and removal is tried again later."""
    import boto3
    from botocore.exceptions import ClientError

    client = boto3.client("ec2", region_name=_ec2_config()["region"])
    if instance.get("runtime_id"):
        instance_ids = [instance["runtime_id"].rsplit("--", 1)[1]]
    else:
        response = client.describe_instances(
            Filters=[{"Name": "client-token", "Values": [instance["launch_id"]]}]
        )
        instance_ids = [
            found["InstanceId"]
            for reservation in response["Reservations"]
            for found in reservation["Instances"]
        ]
        if not instance_ids:
            if (
                time.time() - float(instance["launched_at"])
                < LAUNCH_LISTING_GRACE_SECONDS
            ):
                raise RuntimeError(
                    f"AWS does not list launch {instance['launch_id']} yet"
                )
            return
    try:
        client.terminate_instances(InstanceIds=instance_ids)
    except ClientError as e:
        # AWS stops listing a terminated instance after about an hour.
        if e.response["Error"]["Code"] != "InvalidInstanceID.NotFound":
            raise


def _container_name(instance):
    """The name this instance's container answers to on its EC2 host.

    The runtime id is `<container name>--<ec2 instance id>`, since terminating
    the replica means terminating the host; only the part before the separator
    was ever passed to `docker run --name`.
    """
    runtime_id = instance.get("runtime_id")
    return runtime_id.rsplit("--", 1)[0] if runtime_id else None


def is_running(instance):
    """True if the replica's container is running on its EC2 host; an unreachable
    host counts as not running."""
    return container_running(
        _controller,
        _container_name(instance),
        instance["private_host"],
        ssh_user(instance),
    )


def log_tail(instance, lines):
    """Return the last `lines` lines of the replica container's output, read over SSH.
    Raises RuntimeError with the reason if they can't be read."""
    return container_log_tail(
        _controller,
        _container_name(instance),
        instance["private_host"],
        ssh_user(instance),
        lines,
    )
