# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""What `global_controller.yaml` may set for EC2: the `ec2:` section and per-agent keys."""

SECTION = "ec2"
SECTION_KEYS = {
    "region": (str, True),
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
AGENT_KEYS = {
    "machine_type": (str, True),
    "market_type": (str, False),
}
