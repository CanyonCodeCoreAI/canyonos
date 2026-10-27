# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
EC2 provider for CanyonOS.

This module is the EC2-specific backend for `provider: EC2` agents.
It does three things:
1. create an EC2 machine
2. wait until that machine can run containers
3. terminate the EC2 machine

`providers.bind` sets `_controller` before any of these helpers run, so
they can read config and run commands over SSH.
"""

import functools
import hashlib
import logging
import os
import stat
import subprocess
import threading
import time
from typing import Any

from canyonos_core.controller.controller_context import DEFAULT_SSH_KEY_PATH
from canyonos_core.controller.utils.docker_utils import docker_available
from canyonos_core.llm_gateway import pricing

logger = logging.getLogger(__name__)

DEFAULT_SSH_USER = "ubuntu"
# This default AMI is a public AMI created by Canyon Code, containing base Ubuntu + Docker + zstd. Can be overridden manually with your own ami_id
DEFAULT_AMI_ID = "ami-0101d5f2a2a9cd55c"
MACHINE_PLATFORM = "linux/amd64"
# AWS can take minutes to list a machine it just launched.
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


def _ensure_ssh_key():
    """Return the path to the SSH private key, creating the default key if it doesn't
    exist yet. Raises if a configured key is missing, unreadable, or open to other users."""
    configured_path = _controller.config.get("ssh_private_key_path")
    key_path = os.path.expanduser(configured_path or DEFAULT_SSH_KEY_PATH)
    if not os.path.isfile(key_path):
        if configured_path:
            raise ValueError(
                f"EC2 SSH private key {configured_path} was not found. CanyonOS deploys "
                "from a container that sees only the project folder, so put the key in "
                "the project and give ssh_private_key_path relative to it, or leave it "
                "unset to use a generated key."
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


def machine_platform():
    """The Docker platform EC2 machines run: the default AMI is x86."""
    return MACHINE_PLATFORM


def hourly_cost(machine_spec):
    """The USD per hour of one machine of the spec's `machine_type`, or 0 if it has no
    listed price."""
    return pricing.machine_hourly_cost(machine_spec["machine_type"])


def machine_capacity(machine_spec):
    """The vCPUs and memory (MiB) of one machine of the spec's `machine_type`, which
    placement fills with replicas."""
    return _machine_type_capacity(_ec2_config()["region"], machine_spec["machine_type"])


@functools.cache
def _machine_type_capacity(region, machine_type):
    """Ask AWS once per machine type for its vCPUs and memory."""
    import boto3

    described = boto3.client("ec2", region_name=region).describe_instance_types(
        InstanceTypes=[machine_type]
    )["InstanceTypes"][0]
    return {
        "cpu": described["VCpuInfo"]["DefaultVCpus"],
        "memory": described["MemoryInfo"]["SizeInMiB"],
    }


def _ec2_config():
    """Return the config's `ec2:` section, or raise an error naming the config file if
    it has none."""
    cfg = _controller.config.get("ec2")
    if not cfg:
        raise RuntimeError(
            f"{_controller.config_path} has no ec2: section, which starting or "
            "terminating an EC2 machine needs"
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


def start_machine(machine_spec, launch_id):
    """Launch one machine of the spec's `machine_type`, without waiting for it to boot,
    and return its EC2 id as `machine_id`."""
    import boto3
    from botocore.exceptions import NoCredentialsError

    cfg = _ec2_config()
    client = boto3.client("ec2", region_name=cfg["region"])
    try:
        key_name = _ensure_key_pair_imported(cfg, _ensure_ssh_key(), client)
    except NoCredentialsError:
        raise RuntimeError(
            "No AWS credentials found. CanyonOS deploys from a container that can't "
            "read your ~/.aws, so put AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in "
            "the project's .env."
        ) from None
    request = {
        "ImageId": cfg.get("ami_id", DEFAULT_AMI_ID),
        "InstanceType": machine_spec["machine_type"],
        "NetworkInterfaces": [
            {
                "DeviceIndex": 0,
                "SubnetId": cfg["subnet_id"],
                "Groups": cfg["security_group_ids"],
                "AssociatePublicIpAddress": True,
            }
        ],
        "KeyName": key_name,
        # Lets terminate_machine find this machine before its id is saved.
        "ClientToken": launch_id,
        "MinCount": 1,
        "MaxCount": 1,
        "TagSpecifications": [
            {
                "ResourceType": "instance",
                "Tags": [
                    {"Key": "Name", "Value": f"canyonos-{launch_id[:8]}"},
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
    if cfg.get("iam_profile_name"):
        request["IamInstanceProfile"] = {"Name": cfg["iam_profile_name"]}

    market_type = machine_spec.get("market_type", "on-demand")
    # AWS has no "on-demand" MarketType; omitting InstanceMarketOptions is how on-demand is requested.
    if market_type != "on-demand":
        request["InstanceMarketOptions"] = {"MarketType": market_type}

    response = client.run_instances(**request)
    return {"machine_id": response["Instances"][0]["InstanceId"]}


def wait_for_machine(machine):
    """Wait until the new EC2 machine is running, has a public IP and answers SSH, and
    return its addresses, its SSH user and how long its container gets to start."""
    import boto3
    from botocore.exceptions import WaiterError

    cfg = _ec2_config()
    machine_id = machine["machine_id"]
    client = boto3.client("ec2", region_name=cfg["region"])
    try:
        client.get_waiter("instance_running").wait(InstanceIds=[machine_id])
    except WaiterError as e:
        reasons = [
            found["StateReason"]["Message"]
            for reservation in (e.last_response or {}).get("Reservations", [])
            for found in reservation["Instances"]
            if "StateReason" in found
        ]
        raise RuntimeError(
            f"EC2 machine {machine_id} never reached running: {'; '.join(reasons) or e}"
        ) from e

    deadline = time.time() + cfg.get("public_ip_timeout", 120)
    described = None
    while time.time() < deadline:
        response = client.describe_instances(InstanceIds=[machine_id])
        for reservation in response.get("Reservations", []):
            for candidate in reservation.get("Instances", []):
                if candidate.get("InstanceId") == machine_id:
                    described = candidate
                    break
            if described:
                break
        if described and described.get("PublicIpAddress"):
            break
        time.sleep(2)

    if not (described and described.get("PublicIpAddress")):
        raise RuntimeError(f"EC2 machine {machine_id} never got a public IP address.")
    # The control plane reaches the machine over the private IP; the public IP is only recorded.
    private_host = described["PrivateIpAddress"]
    user = _controller.config.get("ec2", {}).get("ssh_user", DEFAULT_SSH_USER)
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
    return {
        "private_host": private_host,
        "public_host": described["PublicIpAddress"],
        "user": user,
        "container_timeout": cfg.get("controller_health_timeout", 180),
    }


def machine_alive(machine):
    """Whether the machine still exists: AWS lists it as pending or running. One that
    AWS no longer lists at all is gone too."""
    import boto3
    from botocore.exceptions import ClientError

    client = boto3.client("ec2", region_name=_ec2_config()["region"])
    try:
        response = client.describe_instances(InstanceIds=[machine["machine_id"]])
    except ClientError as e:
        if e.response["Error"]["Code"] == "InvalidInstanceID.NotFound":
            return False
        raise
    return any(
        found["State"]["Name"] in ("pending", "running")
        for reservation in response["Reservations"]
        for found in reservation["Instances"]
    )


def terminate_machine(machine):
    """Terminate an EC2 machine. If the launch stopped before its machine id was saved,
    the machine is found by its launch id instead. A machine that is already gone is not
    an error. A recent launch that AWS doesn't list yet raises, so the record is kept
    and removal is tried again later."""
    import boto3
    from botocore.exceptions import ClientError

    client = boto3.client("ec2", region_name=_ec2_config()["region"])
    if machine.get("machine_id"):
        machine_ids = [machine["machine_id"]]
    else:
        response = client.describe_instances(
            Filters=[{"Name": "client-token", "Values": [machine["launch_id"]]}]
        )
        machine_ids = [
            found["InstanceId"]
            for reservation in response["Reservations"]
            for found in reservation["Instances"]
        ]
        if not machine_ids:
            if (
                time.time() - float(machine["launched_at"])
                < LAUNCH_LISTING_GRACE_SECONDS
            ):
                raise RuntimeError(
                    f"AWS does not list launch {machine['launch_id']} yet"
                )
            return
    try:
        client.terminate_instances(InstanceIds=machine_ids)
    except ClientError as e:
        # AWS stops listing a terminated machine after about an hour.
        if e.response["Error"]["Code"] != "InvalidInstanceID.NotFound":
            raise
