# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""What `global_controller.yaml` may set for EC2: the `ec2:` section."""

SECTION = "ec2"
SECTION_KEYS = {
    "region": (str, True),
    "machine_type": (dict, True),
    "market_type": (str, False),
    "ami_id": (str, False),
    "subnet_id": (str, True),
    "ssh_user": (str, False),
    "security_group_ids": (list, True),
    "iam_profile_name": (str, False),
    "public_ip_timeout": (int, False),
    "controller_health_timeout": (int, False),
}
# Keys the section used to take, each with the message saying where it went.
RETIRED_KEYS = {
    "ssh_private_key_path": "moved to the top-level ssh_private_key_path",
}
# The key mapping each machine type to how many to start; each type becomes a `machine_spec`.
MACHINE_TYPES = "machine_type"
# Section keys every machine shares, added to each type's `machine_spec`.
MACHINE_KEYS = ("market_type",)
