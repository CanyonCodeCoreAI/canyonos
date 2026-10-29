# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""What `global_controller.yaml` may set for ec2-assign: the `ec2-assign:` section. Each
replica gets an EC2 machine of its own, of the type `machine_type` maps its agent to.
It takes the same keys as ec2-pool's `ec2-pool:` otherwise, and runs on the same
`_provider.py`.

Only `machine_type` is required: `region`, `subnet_id` and `security_group_ids` default
to the deploying machine's own when it is an EC2 machine, such as one made by
`canyonos provision`."""

from canyonos_core.reconciler.providers.EC2 import _schema_pool as _pool

SECTION = "ec2-assign"
SECTION_KEYS = {
    **_pool.SECTION_KEYS,
    # Agent names to machine types, such as `{HelloAgent: t3.micro}`.
    "machine_type": ("agents", True),
}
RETIRED_KEYS = _pool.RETIRED_KEYS
MACHINE_TYPES = None
MACHINE_KEYS = ("market_type",)
# Each replica gets a machine of its own, of the type this key maps its agent to.
MACHINE_PER_REPLICA = "machine_type"
