# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""What `global_controller.yaml` may set for ec2-pool: the `ec2-pool:` section.

Only `machine_type` is required: `region`, `subnet_id` and `security_group_ids` default
to the deploying machine's own when it is an EC2 machine, such as one made by
`canyonos provision`."""

SECTION = "ec2-pool"
SECTION_KEYS = {
    "region": (str, False),
    "machine_type": (dict, True),
    "market_type": (str, False),
    "ami_id": (str, False),
    "subnet_id": (str, False),
    "ssh_user": (str, False),
    "security_group_ids": (list, False),
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
# The machines are the pool above, not one per replica.
MACHINE_PER_REPLICA = None
