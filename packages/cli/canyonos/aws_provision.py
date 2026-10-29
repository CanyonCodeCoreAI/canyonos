# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Logic for the AWS choices of `canyonos provision`: sign in to AWS, choose where the machine
goes and how it is reached, then launch an EC2 machine that runs `canyonos deploy`.

Nothing is created in AWS until you confirm the summary, except a default VPC when the
region has no VPC at all. A run that stops partway removes what it created. Everything
a run creates is tagged with its provision ID, so Tear down AWS later deletes
that machine with its own security group and key pair, and nothing you made yourself.
The machine's subnet and security group are what its agent machines get too: when the
`ec2-pool:` or `ec2-assign:` section of `global_controller.yaml` leaves them out, the EC2
provider reads them from the machine it runs on.
"""

import json
import os
import secrets
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

from canyonos import dev_machine, env, ui
from utils.tui import input_line, select_menu

# The EC2 provider's default AMI: Ubuntu with Docker and zstd. The CLI ships apart from
# canyonos_core, so it keeps its own copy of the ID.
CANYONOS_AMI_REGION = "us-east-1"
CANYONOS_AMI_ID = "ami-0101d5f2a2a9cd55c"
UBUNTU_AMI_PARAMETER = (
    "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
)
SSH_USER = "ubuntu"
# The smallest disk provisioning gives the machine; an AMI with a bigger snapshot gets its size.
ROOT_VOLUME_GIB = 30
# Swap so small machine types survive building images and running agents: a t3.micro
# has under 1 GiB of memory, and without swap the kernel kills CanyonOS processes.
SWAP_GIB = 2
MACHINE_NAME = "canyonos-controller"
ROLE_NAME = "canyonos-controller"
# Ports you reach the machine on from your own address: SSH, then the API (8080, or
# 8082 in Hello World) and the dashboard (8081).
CALLER_PORTS = ((22, 22), (8080, 8082))
CALLER_IP_URL = "https://checkip.amazonaws.com"
REPO = "CanyonCodeCoreAI/canyonos"
# The installer from the release's own tag, so it matches the version it installs.
INSTALL_URL = "https://raw.githubusercontent.com/{repo}/{tag}/packages/cli/install.sh"
RELEASE_URL = "https://api.github.com/repos/{repo}/releases/tags/{tag}"
# The uv a dev machine installs the CLI with: the version CI uses.
UV_INSTALL_URL = "https://astral.sh/uv/0.12.15/install.sh"
# A new instance profile takes a few seconds before EC2 accepts it.
PROFILE_READY_SECONDS = 60
STS_REGION = "us-east-1"

REGIONS = (
    "us-east-1",
    "us-east-2",
    "us-west-2",
    "eu-west-1",
    "eu-central-1",
    "ap-southeast-1",
    "ap-northeast-1",
)
# x86 only: agent images are built for linux/amd64.
MACHINE_TYPES = (
    ("t3.micro", "2 vCPU, 1 GiB. Cheap for trying it out; tight for building images"),
    ("t3.large", "2 vCPU, 8 GiB. Enough for most workflows"),
    ("t3.medium", "2 vCPU, 4 GiB"),
    ("t3.xlarge", "4 vCPU, 16 GiB"),
    ("m6i.xlarge", "4 vCPU, 16 GiB, steady CPU"),
)

CONTROLLER_POLICY = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "ec2:RunInstances",
                "ec2:DescribeInstances",
                "ec2:DescribeInstanceTypes",
                "ec2:ImportKeyPair",
            ],
            "Resource": "*",
        },
        # Only the agent machines CanyonOS launched, which it tags at launch.
        {
            "Effect": "Allow",
            "Action": "ec2:TerminateInstances",
            "Resource": "*",
            "Condition": {
                "StringEquals": {"aws:ResourceTag/CreatedBy": "EC2 Fast Launch"}
            },
        },
        {
            "Effect": "Allow",
            "Action": "ec2:CreateTags",
            "Resource": "*",
            "Condition": {"StringEquals": {"ec2:CreateAction": "RunInstances"}},
        },
    ],
}
EC2_TRUST_POLICY = {
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {"Service": "ec2.amazonaws.com"},
            "Action": "sts:AssumeRole",
        }
    ],
}


def release_tag(version):
    """The GitHub release tag for a CanyonOS version. One release publishes the CLI and
    every image under that version, so pinning the tag pins all of them."""
    return f"v{version}"


def user_data(version, dev=False):
    """The boot script for the controller machine: add a swap file if the machine has no
    swap, install Docker, Compose and zstd if the AMI lacks them, then exactly this version of the CanyonOS CLI. With `dev`, it
    installs uv and rsync instead, for provisioning to install this checkout's CLI after
    boot."""
    if dev:
        cli = (
            "command -v rsync || (apt-get update && apt-get install -y rsync)\n"
            f"sudo -u {SSH_USER} -H sh -c 'curl -LsSf {UV_INSTALL_URL} | sh'"
        )
    else:
        tag = release_tag(version)
        install_url = INSTALL_URL.format(repo=REPO, tag=tag)
        cli = (
            f"curl -fsSL {install_url} | "
            f"CANYONOS_VERSION={tag} CANYONOS_INSTALL_DIR=/usr/local/bin sh"
        )
    return f"""#!/bin/bash
# From `canyonos provision`: install what `canyonos deploy` needs on this machine.
set -eux
export DEBIAN_FRONTEND=noninteractive
if [ -z "$(swapon --show)" ]; then
  fallocate -l {SWAP_GIB}G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
if ! command -v docker || ! docker compose version || ! command -v zstd; then
  apt-get update
  command -v docker || apt-get install -y docker.io
  docker compose version || apt-get install -y docker-compose-v2
  command -v zstd || apt-get install -y zstd
fi
systemctl enable --now docker
usermod -aG docker {SSH_USER}
{cli}
"""


def release_exists(version):
    """Whether GitHub has a release for this version: True, False, or None when GitHub
    can't be reached to tell."""
    request = urllib.request.Request(
        RELEASE_URL.format(repo=REPO, tag=release_tag(version)), method="HEAD"
    )
    try:
        with urllib.request.urlopen(request, timeout=10):
            return True
    except urllib.error.HTTPError as e:
        return False if e.code == 404 else None
    except OSError:
        return None


CREATED_BY = "canyonos provision"
# Holds the provision ID on everything one run creates, so teardown finds exactly those.
PROVISION_ID_TAG = "canyonos-provision"
# The tags machines got under this command's earlier names, `canyonos setup` and
# `canyonos install`; teardown still finds them.
OLD_CREATED_BY = ("canyonos install", "canyonos setup")
OLD_ID_TAGS = ("canyonos-install", "canyonos-setup")
# How the EC2 provider tags the agent machines it launches: by what made them, and with
# the EC2 id of the machine that deployed them.
AGENT_CREATED_BY = "EC2 Fast Launch"
DEPLOYED_FROM_TAG = "canyonos-deployed-from"
# A terminated machine's network interface takes a while to let go of its group.
GROUP_RELEASE_SECONDS = 120
LIVE_STATES = ["pending", "running", "stopping", "stopped"]

CREATE = "__create__"
OTHER = "__other__"
NO_ROLE = "__no_role__"
DEFAULT_CREDENTIALS = "__default__"
AWS_LOGIN = "__aws_login__"
ACCESS_KEYS = "__access_keys__"
LAUNCH = "__launch__"
OFFICIAL = "__official__"
DEV = "__dev__"
REMOVE = "__remove__"


class _Cancelled(Exception):
    """You backed out of a menu or prompt."""


def _numbered(entries):
    """Turn (value, title, detail) entries into menu options labelled `1. title`, with
    the detail, if any, on the line under it."""
    return [
        (value, f"{n}. {title}" + (f"\n   {detail}" if detail else ""))
        for n, (value, title, detail) in enumerate(entries, 1)
    ]


def _pick(entries, title):
    choice = select_menu(_numbered(entries), title)
    if choice is None:
        raise _Cancelled
    return choice


def _ask(prompt):
    while True:
        value = input_line(prompt, hint="enter next · esc back")
        if value is None:
            raise _Cancelled
        if value:
            return value


def _all(client, operation, key, **kwargs):
    """Every item AWS lists for `operation`, across all pages."""
    if not client.can_paginate(operation):
        return getattr(client, operation)(**kwargs)[key]
    return [
        item
        for page in client.get_paginator(operation).paginate(**kwargs)
        for item in page[key]
    ]


def _name_tag(resource):
    return next(
        (tag["Value"] for tag in resource.get("Tags", []) if tag["Key"] == "Name"), ""
    )


def _tag(resource, key):
    return next(
        (tag["Value"] for tag in resource.get("Tags", []) if tag["Key"] == key), None
    )


def provenance(resource):
    """The tags that show provisioning made a resource, as `Key=Value` pairs, so you
    can tell it is the right one before removing it. Empty if it has none."""
    keys = ("CreatedBy", PROVISION_ID_TAG, *OLD_ID_TAGS, DEPLOYED_FROM_TAG)
    return ", ".join(
        f"{key}={_tag(resource, key)}" for key in keys if _tag(resource, key)
    )


def provision_tags(resource_type, provision_id, name=None):
    """A `TagSpecifications` entry marking a resource as made by one provision run."""
    tags = [
        {"Key": "CreatedBy", "Value": CREATED_BY},
        {"Key": PROVISION_ID_TAG, "Value": provision_id},
    ]
    if name:
        tags.insert(0, {"Key": "Name", "Value": name})
    return {"ResourceType": resource_type, "Tags": tags}


def caller_ip():
    """Your public IPv4 address as AWS sees it, or None if it can't be found."""
    try:
        with urllib.request.urlopen(CALLER_IP_URL, timeout=5) as response:
            return response.read().decode().strip() or None
    except OSError:
        return None


def group_rules(group_id, ip):
    """The inbound rules a CanyonOS security group needs. Its machines reach each other
    on every TCP port, since the endpoint's published gRPC port changes per deploy, and
    `ip` reaches SSH, the API and the dashboard."""
    rules = [
        {
            "IpProtocol": "tcp",
            "FromPort": 0,
            "ToPort": 65535,
            "UserIdGroupPairs": [
                {"GroupId": group_id, "Description": "CanyonOS machines"}
            ],
        }
    ]
    if ip:
        rules += [
            {
                "IpProtocol": "tcp",
                "FromPort": low,
                "ToPort": high,
                "IpRanges": [
                    {"CidrIp": f"{ip}/32", "Description": "canyonos provision"}
                ],
            }
            for low, high in CALLER_PORTS
        ]
    return rules


def _covers(permission, rule):
    """Whether an existing inbound permission already allows everything `rule` does."""
    protocol = permission.get("IpProtocol")
    if protocol == "tcp":
        if not (
            permission["FromPort"] <= rule["FromPort"]
            and permission["ToPort"] >= rule["ToPort"]
        ):
            return False
    elif protocol != "-1":
        return False
    if "UserIdGroupPairs" in rule:
        wanted = rule["UserIdGroupPairs"][0]["GroupId"]
        return any(
            pair.get("GroupId") == wanted
            for pair in permission.get("UserIdGroupPairs", [])
        )
    wanted = rule["IpRanges"][0]["CidrIp"]
    return any(
        ip_range.get("CidrIp") in (wanted, "0.0.0.0/0")
        for ip_range in permission.get("IpRanges", [])
    )


def missing_rules(group, ip):
    """The rules from `group_rules` that the existing security group doesn't allow yet."""
    return [
        rule
        for rule in group_rules(group["GroupId"], ip)
        if not any(_covers(p, rule) for p in group.get("IpPermissions", []))
    ]


def _describe_rule(rule):
    ports = (
        "every TCP port"
        if (rule["FromPort"], rule["ToPort"]) == (0, 65535)
        else f"TCP {rule['FromPort']}"
        + (f"-{rule['ToPort']}" if rule["ToPort"] != rule["FromPort"] else "")
    )
    source = (
        "machines in this group"
        if "UserIdGroupPairs" in rule
        else rule["IpRanges"][0]["CidrIp"]
    )
    return f"{ports} from {source}"


def launch_request(
    *,
    ami_id,
    root_device,
    root_volume_gib,
    machine_type,
    subnet_id,
    group_id,
    key_name,
    profile_name,
    provision_id,
    version,
    dev=False,
):
    """The `run_instances` request for the controller machine: a public IP, IMDSv2 with
    a hop limit of 2 so the Global Controller container can use the machine's role, and
    a boot script that installs Docker and the CanyonOS CLI, or, with `dev`, what
    provisioning needs to install this checkout's CLI after boot."""
    request = {
        "ImageId": ami_id,
        "InstanceType": machine_type,
        "MinCount": 1,
        "MaxCount": 1,
        "KeyName": key_name,
        "NetworkInterfaces": [
            {
                "DeviceIndex": 0,
                "SubnetId": subnet_id,
                "Groups": [group_id],
                "AssociatePublicIpAddress": True,
            }
        ],
        "BlockDeviceMappings": [
            {
                "DeviceName": root_device,
                "Ebs": {
                    "VolumeSize": root_volume_gib,
                    "VolumeType": "gp3",
                    "DeleteOnTermination": True,
                },
            }
        ],
        "MetadataOptions": {
            "HttpEndpoint": "enabled",
            "HttpTokens": "required",
            "HttpPutResponseHopLimit": 2,
        },
        "UserData": user_data(version, dev),
        # Not tagged `CreatedBy=EC2 Fast Launch`, so `canyonos stop` never terminates it.
        "TagSpecifications": [
            provision_tags("instance", provision_id, MACHINE_NAME),
            provision_tags("volume", provision_id),
        ],
    }
    if profile_name:
        request["IamInstanceProfile"] = {"Name": profile_name}
    return request


def root_volume(image):
    """The AMI's root device name, and the disk size in GiB to give it: at least
    `ROOT_VOLUME_GIB`, and never smaller than the AMI's own root snapshot."""
    device = image["RootDeviceName"]
    snapshot_gib = next(
        (
            mapping["Ebs"].get("VolumeSize", 0)
            for mapping in image.get("BlockDeviceMappings", [])
            if mapping.get("DeviceName") == device and "Ebs" in mapping
        ),
        0,
    )
    return device, max(ROOT_VOLUME_GIB, snapshot_gib)


def ensure_controller_role(iam):
    """Create the `canyonos-controller` role and instance profile, or bring existing
    ones up to date, so the machine can launch, tag and terminate agent machines.
    Returns the instance profile name."""
    from botocore.exceptions import ClientError

    def tolerate_existing(call, **kwargs):
        try:
            call(**kwargs)
        except ClientError as e:
            if e.response["Error"]["Code"] != "EntityAlreadyExists":
                raise

    tolerate_existing(
        iam.create_role,
        RoleName=ROLE_NAME,
        AssumeRolePolicyDocument=json.dumps(EC2_TRUST_POLICY),
        Description="Lets a CanyonOS controller machine launch agent machines",
    )
    iam.put_role_policy(
        RoleName=ROLE_NAME,
        PolicyName=ROLE_NAME,
        PolicyDocument=json.dumps(CONTROLLER_POLICY),
    )
    tolerate_existing(iam.create_instance_profile, InstanceProfileName=ROLE_NAME)
    profile = iam.get_instance_profile(InstanceProfileName=ROLE_NAME)["InstanceProfile"]
    if not any(role["RoleName"] == ROLE_NAME for role in profile["Roles"]):
        iam.add_role_to_instance_profile(
            InstanceProfileName=ROLE_NAME, RoleName=ROLE_NAME
        )
    return ROLE_NAME


def save_private_key(name, material, ssh_dir=None):
    """Write a new key pair's private key to `~/.ssh/<name>.pem`, readable only by you,
    and return its path. Never overwrites a file."""
    ssh_dir = Path(ssh_dir or Path.home() / ".ssh")
    ssh_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = ssh_dir / f"{name}.pem"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as file:
        file.write(material)
    return path


def run_instances_when_profile_ready(ec2, request, deadline_seconds=None):
    """Launch the machine, retrying while EC2 doesn't see a just-created instance
    profile yet. Returns the new machine's ID."""
    from botocore.exceptions import ClientError

    deadline = time.monotonic() + (
        PROFILE_READY_SECONDS if deadline_seconds is None else deadline_seconds
    )
    while True:
        try:
            return ec2.run_instances(**request)["Instances"][0]["InstanceId"]
        except ClientError as e:
            error = e.response["Error"]
            profile_not_ready = error["Code"] == "InvalidParameterValue" and (
                "iamInstanceProfile" in error.get("Message", "")
            )
            if not profile_not_ready or time.monotonic() > deadline:
                raise
            time.sleep(5)


def provision_machines(ec2):
    """The machines `canyonos provision` launched in this region that aren't terminated."""
    return _live_machines(
        ec2, [{"Name": "tag:CreatedBy", "Values": [CREATED_BY, *OLD_CREATED_BY]}]
    )


def _live_machines(ec2, filters):
    """The machines matching `filters` that aren't terminated or being terminated."""
    reservations = _all(
        ec2,
        "describe_instances",
        "Reservations",
        Filters=[
            *filters,
            {"Name": "instance-state-name", "Values": LIVE_STATES},
        ],
    )
    return [machine for found in reservations for machine in found["Instances"]]


def removal_plan(ec2, provision_id, machine_ids=(), id_tag=PROVISION_ID_TAG):
    """What tearing down one provision run deletes: the given machines, and the security groups
    and key pairs tagged with its provision ID. Never touches a key pair or group provisioning
    didn't make. A tagged one that another running machine still uses is kept, under
    `kept` with the machines using it. The agent machines the given machines deployed
    are terminated too, and so are any in a removed group, since they would keep it from
    being deleted. `tags` holds each removed group,
    agent machine and key pair's `provenance`."""
    machine_ids = list(machine_ids)
    by_provision = [{"Name": f"tag:{id_tag}", "Values": [provision_id]}]
    group_ids, agent_ids, key_names, kept, tags = [], [], [], {}, {}
    for group in _all(
        ec2, "describe_security_groups", "SecurityGroups", Filters=by_provision
    ):
        group_id = group["GroupId"]
        users = _live_machines(
            ec2, [{"Name": "instance.group-id", "Values": [group_id]}]
        )
        agents = [m for m in users if _tag(m, "CreatedBy") == AGENT_CREATED_BY]
        others = [
            m["InstanceId"]
            for m in users
            if m not in agents and m["InstanceId"] not in machine_ids
        ]
        if others:
            # Its agents may belong to the other machine, so they stay as well.
            kept[f"security group {group_id}"] = others
            continue
        group_ids.append(group_id)
        tags[group_id] = provenance(group)
        for agent in agents:
            if agent["InstanceId"] not in agent_ids:
                agent_ids.append(agent["InstanceId"])
                tags[agent["InstanceId"]] = provenance(agent)
    deployed = (
        _live_machines(
            ec2, [{"Name": f"tag:{DEPLOYED_FROM_TAG}", "Values": machine_ids}]
        )
        if machine_ids
        else []
    )
    for agent in deployed:
        if agent["InstanceId"] not in agent_ids:
            agent_ids.append(agent["InstanceId"])
            tags[agent["InstanceId"]] = provenance(agent)
    for pair in ec2.describe_key_pairs(Filters=by_provision)["KeyPairs"]:
        name = pair["KeyName"]
        others = [
            m["InstanceId"]
            for m in _live_machines(ec2, [{"Name": "key-name", "Values": [name]}])
            if m["InstanceId"] not in machine_ids + agent_ids
        ]
        if others:
            kept[f"key pair {name}"] = others
        else:
            key_names.append(name)
            tags[name] = provenance(pair)
    return {
        "machine_ids": machine_ids,
        "agent_ids": agent_ids,
        "group_ids": group_ids,
        "key_names": key_names,
        "kept": kept,
        "tags": tags,
    }


def _agent_machines(count):
    """How many agent machines a Global Controller machine runs, in words."""
    if not count:
        return "no agent machines"
    return f"{count} agent machine{'s' if count != 1 else ''}"


def describe_plan(plan, ssh_dir=None, with_tags=False):
    """One line per thing a removal plan deletes. `with_tags` adds each one's
    provisioning tags, for showing before it runs."""
    ssh_dir = Path(ssh_dir or Path.home() / ".ssh")

    def line(kind, resource_id):
        found = plan.get("tags", {}).get(resource_id) if with_tags else None
        return f"{kind} {resource_id}" + (f"  ({found})" if found else "")

    lines = [
        line("Global Controller machine", machine_id)
        for machine_id in plan["machine_ids"]
    ]
    lines += [line("agent machine", machine_id) for machine_id in plan["agent_ids"]]
    lines += [line("security group", group_id) for group_id in plan["group_ids"]]
    for key_name in plan["key_names"]:
        lines.append(line("key pair", key_name))
        if (ssh_dir / f"{key_name}.pem").exists():
            lines.append(f"private key {ssh_dir / f'{key_name}.pem'}")
    return lines


def _delete_group_when_released(ec2, group_id, deadline_seconds):
    from botocore.exceptions import ClientError

    deadline = time.monotonic() + deadline_seconds
    while True:
        try:
            ec2.delete_security_group(GroupId=group_id)
            return
        except ClientError as e:
            code = e.response["Error"]["Code"]
            if code == "InvalidGroup.NotFound":
                return
            if code != "DependencyViolation" or time.monotonic() > deadline:
                raise
            time.sleep(5)


def remove_resources(ec2, plan, ssh_dir=None, group_release_seconds=None):
    """Delete what a removal plan lists: terminate the machines and wait until they are
    gone, then delete the security groups, the key pairs, and the private keys saved
    for them under `~/.ssh`. Returns what was removed, one line each. Callers confirm
    the key pairs with you first and take out any you keep."""
    removed = describe_plan(plan, ssh_dir)
    machine_ids = plan["machine_ids"] + plan["agent_ids"]
    if machine_ids:
        ec2.terminate_instances(InstanceIds=machine_ids)
        ec2.get_waiter("instance_terminated").wait(InstanceIds=machine_ids)
    for group_id in plan["group_ids"]:
        _delete_group_when_released(
            ec2,
            group_id,
            GROUP_RELEASE_SECONDS
            if group_release_seconds is None
            else group_release_seconds,
        )
    ssh_dir = Path(ssh_dir or Path.home() / ".ssh")
    for key_name in plan["key_names"]:
        ec2.delete_key_pair(KeyName=key_name)
        (ssh_dir / f"{key_name}.pem").unlink(missing_ok=True)
    return removed


class _AwsProvision:
    """One run of AWS provisioning: the choices made so far and what was created."""

    def __init__(self):
        self.provision_id = secrets.token_hex(3)
        self.ec2 = None
        self.machine_id = None
        # Whether the machine gets this checkout instead of the official release.
        self.dev = False
        self.key_path = None
        # Created but left in place if the run stops: they are free and reusable.
        self.kept = []

    def run(self):
        self.session = self._sign_in()
        self.region = self._choose_region()
        self.ec2 = self.session.client("ec2", region_name=self.region)
        self._choose_version()
        vpc_id = self._choose_vpc()
        subnet_id = self._choose_subnet(vpc_id)
        group = self._choose_security_group(vpc_id)
        machine_type = self._choose_machine_type()
        key_name = self._choose_key_pair()
        if self.dev and key_name != CREATE:
            self._find_private_key(key_name)
        profile = self._choose_role()
        ami_id = self._ami_id()

        self._confirm(subnet_id, group, machine_type, key_name, profile, ami_id)
        if self.dev:
            ui.say(
                f"Building the Global Controller image for {dev_machine.PLATFORM}. "
                "On an Arm machine this emulates x86 and takes a while."
            )
            dev_machine.build_core_image()
            ui.ok(f"Built {dev_machine.BUILD_TAG}")

        group_id = self._prepare_security_group(vpc_id, group)
        key_name, key_path = self._prepare_key_pair(key_name)
        if profile == CREATE:
            with ui.status(f"Creating the {ROLE_NAME} role"):
                profile = ensure_controller_role(self.session.client("iam"))
            self.kept.append(f"IAM role {ROLE_NAME}")
        image = self.ec2.describe_images(ImageIds=[ami_id])["Images"][0]
        root_device, root_volume_gib = root_volume(image)
        request = launch_request(
            ami_id=ami_id,
            root_device=root_device,
            root_volume_gib=root_volume_gib,
            machine_type=machine_type,
            subnet_id=subnet_id,
            group_id=group_id,
            key_name=key_name,
            profile_name=None if profile == NO_ROLE else profile,
            provision_id=self.provision_id,
            version=env.VERSION,
            dev=self.dev,
        )
        with ui.status("Launching the machine"):
            machine_id = run_instances_when_profile_ready(self.ec2, request)
            self.machine_id = machine_id
            self.ec2.get_waiter("instance_running").wait(InstanceIds=[machine_id])
            described = self.ec2.describe_instances(InstanceIds=[machine_id])
        machine = described["Reservations"][0]["Instances"][0]
        if self.dev:
            dev_machine.install_on(
                key_path, machine["PublicIpAddress"], SSH_USER, ui.status
            )
            ui.ok("The machine runs this checkout's CLI and Global Controller image")
        self._show_next_steps(machine, key_name, key_path, profile)

    def _choose_version(self):
        """From a development CLI, ask whether the machine gets this checkout or the
        official release; a released CLI always installs its own release."""
        if env.is_production:
            self._check_release()
            return
        choice = _pick(
            [
                (
                    DEV,
                    "This checkout",
                    "Builds the Global Controller image here and copies the checkout "
                    "over, so the machine runs your changes.",
                ),
                (
                    OFFICIAL,
                    f"The official {release_tag(env.VERSION)} release",
                    "What a user installing this version gets.",
                ),
            ],
            f"This is a {env.environment} CLI. Which CanyonOS should the machine run?",
        )
        if choice == OFFICIAL:
            self._check_release()
            return
        missing = dev_machine.missing_tools()
        if missing:
            ui.fail(
                f"Shipping this checkout needs {', '.join(missing)} on this machine."
            )
            raise _Cancelled
        if subprocess.run(["docker", "info"], capture_output=True).returncode != 0:
            ui.fail("Docker isn't running here, so the image can't be built.")
            raise _Cancelled
        self.dev = True

    def _find_private_key(self, key_name):
        """Provisioning signs in to the machine to install this checkout, so it needs the
        private key of an existing key pair: `~/.ssh/<name>.pem`, or a path you give."""
        default = Path.home() / ".ssh" / f"{key_name}.pem"
        if default.exists():
            self.key_path = default
            return
        while True:
            path = Path(_ask(f"Path to the private key for {key_name}: ")).expanduser()
            if path.is_file():
                self.key_path = path
                return
            ui.fail(f"No file at {path}")

    def _check_release(self):
        """Stop before anything is created when the machine couldn't install this CLI's
        version, and say when that version isn't the code you're running."""
        found = release_exists(env.VERSION)
        if found is False:
            ui.fail(
                f"There is no CanyonOS {release_tag(env.VERSION)} release for the "
                "machine to install. Upgrade the CLI (`canyonos upgrade`) or run "
                "`canyonos provision` from a released version."
            )
            raise _Cancelled
        if found is None:
            ui.warn(
                f"Couldn't check GitHub for the {release_tag(env.VERSION)} release; "
                "the machine's install fails if it doesn't exist."
            )
        if not env.is_production:
            ui.warn(
                f"This is a {env.environment} CLI. The machine installs the "
                f"{release_tag(env.VERSION)} release, not this checkout's changes."
            )

    def teardown(self):
        """Run `canyonos provision` → Tear down AWS: sign in, pick a region and one of
        the Global Controller machines provisioned there, then remove it with what
        provisioning made for it and the agent machines it deployed."""
        self.session = self._sign_in()
        self.region = self._choose_region(warn_about_ami=False)
        self.ec2 = self.session.client("ec2", region_name=self.region)
        machines = provision_machines(self.ec2)
        if not machines:
            ui.say(f"No provisioned Global Controller machines in {self.region}.")
            return
        self._remove(machines)

    def _remove(self, machines):
        # Each machine's agent machines, which removing it removes too.
        agents = Counter(
            _tag(agent, DEPLOYED_FROM_TAG)
            for agent in _live_machines(
                self.ec2,
                [
                    {
                        "Name": f"tag:{DEPLOYED_FROM_TAG}",
                        "Values": [machine["InstanceId"] for machine in machines],
                    }
                ],
            )
        )
        entries = [
            (
                machine["InstanceId"],
                f"{machine['InstanceId']}  {machine['InstanceType']}  "
                f"{machine.get('PublicIpAddress') or machine.get('PrivateIpAddress', '')}",
                f"{machine['State']['Name']}, launched "
                f"{machine['LaunchTime']:%Y-%m-%d %H:%M}, "
                f"{_agent_machines(agents[machine['InstanceId']])}. "
                f"{provenance(machine)}",
            )
            for machine in machines
        ]
        machine_id = _pick(
            entries,
            "Which Global Controller machine should be removed? "
            "Its agent machines are removed with it.",
        )
        machine = next(m for m in machines if m["InstanceId"] == machine_id)
        id_tag = next(
            (key for key in (PROVISION_ID_TAG, *OLD_ID_TAGS) if _tag(machine, key)),
            None,
        )
        if id_tag:
            plan = removal_plan(
                self.ec2, _tag(machine, id_tag), [machine_id], id_tag=id_tag
            )
        else:
            ui.warn(
                "This machine has no provision ID, so only the machine itself is removed."
            )
            plan = {
                "machine_ids": [machine_id],
                "agent_ids": [],
                "group_ids": [],
                "key_names": [],
                "kept": {},
                "tags": {},
            }
        plan["tags"][machine_id] = provenance(machine)
        if plan["key_names"] and not self._confirm_key_removal(plan["key_names"]):
            plan["key_names"] = []
        for resource, users in plan["kept"].items():
            ui.say(f"Keeping {resource}: {', '.join(users)} still use it.")
        ui.say("This removes:")
        for line in describe_plan(plan, with_tags=True):
            ui.say(f"  {line}")
        _pick([(REMOVE, "Remove them", None)], "Remove?")
        with ui.status("Removing"):
            removed = remove_resources(self.ec2, plan)
        ui.ok(f"Removed {', '.join(removed)}")
        ui.hint(
            f"The {ROLE_NAME} IAM role is kept for other machines; delete it in the "
            "IAM console if nothing uses it."
        )

    def _confirm_key_removal(self, key_names):
        """Ask whether to remove key pairs provisioning made, keeping them unless you choose
        to remove them: no answer, Esc or Ctrl+C keeps them, and says where they are."""
        try:
            remove = self._remove_key_pairs(key_names)
        except (_Cancelled, KeyboardInterrupt):
            remove = False
        if not remove:
            for name in key_names:
                ui.say(f"Kept key pair {name} and ~/.ssh/{name}.pem, if it was saved.")
        return remove

    def _remove_key_pairs(self, key_names):
        """Ask whether to remove the key pairs provisioning made for the machine, with the
        private keys saved for them, or keep them: a key may be in use somewhere AWS
        can't see, such as GitHub."""
        names = ", ".join(key_names)
        return _pick(
            [
                (
                    True,
                    "Remove the key pair",
                    f"Deletes {names} in AWS and its private key under ~/.ssh.",
                ),
                (
                    False,
                    "Keep the key pair",
                    "If you use its private key anywhere else, keep it. Provisioning can "
                    "also use it again for the next machine.",
                ),
            ],
            f"Provisioning made the key pair {names} for this machine.",
        )

    def rollback(self):
        """Remove what this run created in AWS, other than the IAM role and a default
        VPC. A key pair it created is removed only if you say so, since its private key
        may already be in use somewhere AWS can't see. Does nothing if it created
        nothing."""
        if self.ec2 is None:
            return
        plan = removal_plan(
            self.ec2, self.provision_id, [self.machine_id] if self.machine_id else []
        )
        if plan["key_names"] and not self._confirm_key_removal(plan["key_names"]):
            plan["key_names"] = []
        if not any(plan[k] for k in ("machine_ids", "group_ids", "key_names")):
            return
        with ui.status("Removing what this run created"):
            removed = remove_resources(self.ec2, plan)
        ui.ok(f"Removed {', '.join(removed)}")

    def _sign_in(self):
        import boto3
        from botocore.exceptions import BotoCoreError, ClientError

        while True:
            entries = [
                (
                    DEFAULT_CREDENTIALS,
                    "Use your default AWS credentials",
                    "Environment variables, AWS_PROFILE, ~/.aws, SSO or an earlier "
                    "`aws login`.",
                )
            ]
            if shutil.which("aws"):
                entries.append(
                    (
                        AWS_LOGIN,
                        "Sign in with your browser",
                        "Runs `aws login` with your AWS console sign-in.",
                    )
                )
            entries.append(
                (
                    ACCESS_KEYS,
                    "Enter an access key and secret",
                    "Used for this run only and not saved.",
                )
            )
            choice = _pick(entries, "Which AWS credentials should provisioning use?")
            if choice == AWS_LOGIN:
                if subprocess.run(["aws", "login"]).returncode != 0:
                    ui.fail("`aws login` did not finish.")
                    continue
                session = boto3.Session()
            elif choice == ACCESS_KEYS:
                try:
                    session = boto3.Session(
                        aws_access_key_id=_ask("Access key ID: "),
                        aws_secret_access_key=ui.secret("Secret access key"),
                    )
                except _Cancelled:
                    continue
            else:
                session = boto3.Session()
            try:
                identity = session.client(
                    "sts", region_name=session.region_name or STS_REGION
                ).get_caller_identity()
            except (BotoCoreError, ClientError) as e:
                ui.fail(f"AWS did not accept these credentials: {e}")
                continue
            ui.ok(
                f"Signed in to AWS account {identity['Account']} as {identity['Arn']}"
            )
            return session

    def _choose_region(self, warn_about_ami=True):
        current = self.session.region_name
        regions = (
            [current, *(r for r in REGIONS if r != current)] if current else REGIONS
        )
        entries = [
            (region, region, "Your default region" if region == current else None)
            for region in regions
        ]
        entries.append((OTHER, "Another region", None))
        region = _pick(
            entries,
            "Which region should the machine run in?"
            if warn_about_ami
            else "Which region is the machine in?",
        )
        if region == OTHER:
            region = _ask("Region, e.g. ca-central-1: ")
        if warn_about_ami and region != CANYONOS_AMI_REGION:
            ui.warn(
                f"Agent machines outside {CANYONOS_AMI_REGION} need an AMI with Docker "
                "and zstd: set ami_id under ec2-assign: or ec2-pool: in "
                "global_controller.yaml."
            )
        return region

    def _choose_vpc(self):
        vpcs = sorted(
            _all(self.ec2, "describe_vpcs", "Vpcs"),
            key=lambda vpc: not vpc.get("IsDefault"),
        )
        if not vpcs:
            _pick(
                [(CREATE, "Create the default VPC", "A public subnet in each zone.")],
                f"{self.region} has no VPC.",
            )
            vpc_id = self.ec2.create_default_vpc()["Vpc"]["VpcId"]
            self.kept.append(f"default VPC {vpc_id}")
            ui.ok(f"Created the default VPC {vpc_id}")
            return vpc_id
        entries = [
            (
                vpc["VpcId"],
                f"{vpc['VpcId']}  {vpc['CidrBlock']}",
                " · ".join(
                    part
                    for part in (
                        "default" if vpc.get("IsDefault") else "",
                        _name_tag(vpc),
                    )
                    if part
                )
                or None,
            )
            for vpc in vpcs
        ]
        return _pick(entries, "Which VPC? Agent machines join it too.")

    def _choose_subnet(self, vpc_id):
        filters = [{"Name": "vpc-id", "Values": [vpc_id]}]
        subnets = sorted(
            _all(self.ec2, "describe_subnets", "Subnets", Filters=filters),
            key=lambda subnet: subnet["AvailabilityZone"],
        )
        if not subnets:
            ui.fail(
                f"{vpc_id} has no subnets. Create one, then run `canyonos provision` again."
            )
            raise _Cancelled
        public = self._subnets_with_internet_route(vpc_id, subnets)
        entries = [
            (
                subnet["SubnetId"],
                f"{subnet['SubnetId']}  {subnet['AvailabilityZone']}  "
                f"{subnet['CidrBlock']}",
                " · ".join(
                    part
                    for part in (
                        _name_tag(subnet),
                        ""
                        if subnet["SubnetId"] in public
                        else "No internet gateway route: the machine can't install",
                    )
                    if part
                )
                or None,
            )
            for subnet in subnets
        ]
        return _pick(entries, "Which subnet? Agent machines launch into it too.")

    def _subnets_with_internet_route(self, vpc_id, subnets):
        """IDs of the subnets whose route table sends 0.0.0.0/0 to an internet gateway."""
        tables = _all(
            self.ec2,
            "describe_route_tables",
            "RouteTables",
            Filters=[{"Name": "vpc-id", "Values": [vpc_id]}],
        )

        def reaches_internet(table):
            return any(
                route.get("DestinationCidrBlock") == "0.0.0.0/0"
                and route.get("GatewayId", "").startswith("igw-")
                for route in table.get("Routes", [])
            )

        explicit = {}
        main_public = False
        for table in tables:
            for association in table.get("Associations", []):
                if association.get("Main"):
                    main_public = reaches_internet(table)
                elif association.get("SubnetId"):
                    explicit[association["SubnetId"]] = reaches_internet(table)
        return {
            subnet["SubnetId"]
            for subnet in subnets
            if explicit.get(subnet["SubnetId"], main_public)
        }

    def _choose_security_group(self, vpc_id):
        self.caller_ip = caller_ip()
        if self.caller_ip is None:
            ui.warn(
                "Couldn't find your public IP, so SSH, API and dashboard access "
                "aren't added. Add them to the security group yourself."
            )
        you = self.caller_ip or "you"
        groups = _all(
            self.ec2,
            "describe_security_groups",
            "SecurityGroups",
            Filters=[{"Name": "vpc-id", "Values": [vpc_id]}],
        )
        entries = [
            (
                CREATE,
                "Create a security group for CanyonOS",
                f"Its machines reach each other; {you} reaches SSH, the API and the "
                "dashboard.",
            ),
            *(
                (group["GroupId"], f"{group['GroupId']}  {group['GroupName']}", None)
                for group in groups
            ),
        ]
        choice = _pick(
            entries, "Which security group? Agent machines are put in it too."
        )
        if choice == CREATE:
            return CREATE
        return next(group for group in groups if group["GroupId"] == choice)

    def _choose_machine_type(self):
        entries = [(name, name, detail) for name, detail in MACHINE_TYPES]
        entries.append((OTHER, "Another machine type", "Must be x86 (amd64)."))
        choice = _pick(
            entries,
            "Which machine type? It builds images and runs the Global Controller.",
        )
        return _ask("Machine type, e.g. c6i.xlarge: ") if choice == OTHER else choice

    def _choose_key_pair(self):
        pairs = self.ec2.describe_key_pairs()["KeyPairs"]
        entries = [
            (
                CREATE,
                "Create a key pair",
                "Saves the private key to ~/.ssh/<name>.pem.",
            ),
            *(
                (
                    pair["KeyName"],
                    pair["KeyName"],
                    f"Found ~/.ssh/{pair['KeyName']}.pem"
                    if (Path.home() / ".ssh" / f"{pair['KeyName']}.pem").exists()
                    else None,
                )
                for pair in pairs
            ),
        ]
        return _pick(entries, "Which key pair should you SSH in with?")

    def _choose_role(self):
        from botocore.exceptions import BotoCoreError, ClientError

        try:
            profiles = _all(
                self.session.client("iam"),
                "list_instance_profiles",
                "InstanceProfiles",
            )
        except (BotoCoreError, ClientError) as e:
            ui.warn(f"Couldn't list IAM instance profiles: {e}")
            profiles = []
        entries = [
            (
                CREATE,
                f"Use the {ROLE_NAME} role",
                "Created or updated now. It can launch EC2 machines, and tag and "
                "terminate only the ones CanyonOS launched.",
            ),
            *(
                (profile["InstanceProfileName"], profile["InstanceProfileName"], None)
                for profile in profiles
                if profile["InstanceProfileName"] != ROLE_NAME
            ),
            (
                NO_ROLE,
                "No role",
                "Agent machines can't launch until you attach one yourself.",
            ),
        ]
        return _pick(entries, "Which IAM role should the machine deploy with?")

    def _ami_id(self):
        if self.region == CANYONOS_AMI_REGION:
            return CANYONOS_AMI_ID
        ssm = self.session.client("ssm", region_name=self.region)
        return ssm.get_parameter(Name=UBUNTU_AMI_PARAMETER)["Parameter"]["Value"]

    def _confirm(self, subnet_id, group, machine_type, key_name, profile, ami_id):
        def created(value, label):
            return f"new {label}" if value == CREATE else value

        rows = (
            ("Region", self.region),
            ("Subnet", subnet_id),
            (
                "Security group",
                "new" if group == CREATE else group["GroupId"],
            ),
            ("Machine type", machine_type),
            ("Key pair", created(key_name, "key pair")),
            (
                "IAM role",
                {CREATE: ROLE_NAME, NO_ROLE: "none"}.get(profile, profile),
            ),
            ("AMI", ami_id),
            (
                "CanyonOS",
                "this checkout" if self.dev else release_tag(env.VERSION),
            ),
        )
        ui.blank()
        for label, value in rows:
            ui.say(f"{label + ':':<16}{value}")
        ui.blank()
        _pick(
            [(LAUNCH, "Launch the machine", "EC2 charges apply while it runs.")],
            "Launch?",
        )

    def _prepare_security_group(self, vpc_id, group):
        if group == CREATE:
            name = f"canyonos-{self.provision_id}"
            group_id = self.ec2.create_security_group(
                GroupName=name,
                Description="CanyonOS controller and agent machines",
                VpcId=vpc_id,
                TagSpecifications=[
                    provision_tags("security-group", self.provision_id, name)
                ],
            )["GroupId"]
            rules = group_rules(group_id, self.caller_ip)
        else:
            group_id = group["GroupId"]
            rules = missing_rules(group, self.caller_ip)
            if rules:
                ui.say(f"{group_id} doesn't allow:")
                for rule in rules:
                    ui.say(f"  {_describe_rule(rule)}")
                answer = select_menu(
                    _numbered(
                        [
                            (True, "Add these rules", None),
                            (False, "Leave the group as it is", None),
                        ]
                    ),
                    "Add them?",
                )
                if answer is None:
                    raise _Cancelled
                if not answer:
                    rules = []
        if rules:
            self.ec2.authorize_security_group_ingress(
                GroupId=group_id, IpPermissions=rules
            )
            ui.ok(f"Security group {group_id} allows what CanyonOS needs")
        return group_id

    def _prepare_key_pair(self, key_name):
        if key_name != CREATE:
            path = self.key_path or Path.home() / ".ssh" / f"{key_name}.pem"
            return key_name, path if path.exists() else None
        key_name = f"canyonos-{self.provision_id}"
        material = self.ec2.create_key_pair(
            KeyName=key_name,
            KeyType="ed25519",
            KeyFormat="pem",
            TagSpecifications=[provision_tags("key-pair", self.provision_id)],
        )["KeyMaterial"]
        path = save_private_key(key_name, material)
        ui.ok(f"Saved the private key to {path}")
        return key_name, path

    def _show_next_steps(self, machine, key_name, key_path, profile):
        address = machine.get("PublicIpAddress") or machine["PrivateIpAddress"]
        key = str(key_path) if key_path else f"<private key for {key_name}>"
        ui.blank()
        ui.ok(f"Launched {machine['InstanceId']} at {address}")
        if self.dev:
            ui.say(
                f"This checkout is in ~/{dev_machine.REMOTE_CHECKOUT} on it, with the "
                "examples. Copy another project to it with:"
            )
        else:
            ui.say(
                f"It installs Docker and CanyonOS {release_tag(env.VERSION)}, the "
                "same version as this CLI, over the next few minutes. "
                "Copy your project to it:"
            )
        ui.command(f"scp -i {key} -r <project folder> {SSH_USER}@{address}:~/")
        ui.say("Then sign in, wait for the install, and deploy:")
        ui.command(f"ssh -i {key} {SSH_USER}@{address}")
        ui.command("cloud-init status --wait && cd <project folder> && canyonos deploy")
        ui.blank()
        ui.hint(
            "To run agents on EC2, set `provider: ec2-assign` and give each agent a "
            "machine type under `ec2-assign: machine_type:` in global_controller.yaml, "
            "or `provider: ec2-pool` with a pool under `ec2-pool: machine_type:`. They launch "
            "into this machine's subnet and security group."
        )
        if profile == NO_ROLE:
            ui.warn(
                "The machine has no IAM role, so it can't launch agent machines yet."
            )
        ui.hint(
            "When you're done, run `canyonos provision` and choose Tear down AWS to "
            "delete the machine with its security group and key pair."
        )


def _aws_errors():
    from botocore.exceptions import BotoCoreError, ClientError, WaiterError

    return (
        BotoCoreError,
        ClientError,
        WaiterError,
        OSError,
        subprocess.CalledProcessError,
        dev_machine.DevMachineError,
    )


def run_aws_provision():
    """Walk through AWS provisioning in the terminal and launch a controller machine. Returns
    True once it is running. If you back out or a step fails, removes what this run
    created and returns False."""
    aws_errors = _aws_errors()
    run = _AwsProvision()
    try:
        run.run()
        return True
    except (_Cancelled, KeyboardInterrupt):
        ui.say("Provisioning stopped.")
    except aws_errors as e:
        ui.fail(f"Provisioning failed: {e}")
    try:
        run.rollback()
    except aws_errors as e:
        ui.fail(f"Couldn't remove everything this run created: {e}")
        ui.hint(
            f"Find it in the EC2 console by the tag {PROVISION_ID_TAG}={run.provision_id}."
        )
    if run.kept:
        ui.say(f"Kept for next time: {', '.join(run.kept)}")
    return False


def run_aws_teardown():
    """Walk through tearing down a machine `canyonos provision` launched, in the terminal.
    Returns True once it is removed or there was nothing to remove, False if you backed
    out or AWS refused a step."""
    try:
        _AwsProvision().teardown()
        return True
    except (_Cancelled, KeyboardInterrupt):
        ui.say("Nothing removed.")
    except _aws_errors() as e:
        ui.fail(f"Teardown failed: {e}")
    return False
