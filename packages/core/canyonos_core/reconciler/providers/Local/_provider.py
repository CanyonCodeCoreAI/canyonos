# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
Local provider for CanyonOS.

This module is the local-provider backend for `provider: local` agents. Every
replica runs on this machine, so it never starts or frees a machine.
"""


def preflight():
    """Do nothing: building the images already needed Docker on this machine."""
    return None


def machine_platform():
    """Return None: replicas run on this machine, so images are built for its own platform."""
    return None


def hourly_cost(machine):
    """Return 0: this machine has no hourly cost."""
    return 0


def start_machine(machine_spec, launch_id):
    """Return this machine; nothing is started."""
    return {"private_host": "localhost", "public_host": "localhost"}


def wait_for_machine(machine):
    """Return nothing more: this machine is already up."""
    return {}


def terminate_machine(machine):
    """Do nothing: this machine outlives the deploy."""
    return None
