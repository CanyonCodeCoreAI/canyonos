# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The one entry point callers use to reach the provider an agent runs on."""

import importlib
from typing import Any

# Each provider's package, and its schema module there. ec2-pool and ec2-assign share one
# `_provider.py` and differ in their section and how it declares their machines.
_PACKAGES = {
    "local": ("canyonos_core.reconciler.providers.Local", "_schema"),
    "ec2-pool": ("canyonos_core.reconciler.providers.EC2", "_schema_pool"),
    "ec2-assign": ("canyonos_core.reconciler.providers.EC2", "_schema_assign"),
}
NAMES = tuple(_PACKAGES)
DEFAULT = "local"
# Provider names and sections that were renamed, each with its new name.
RENAMED = {"EC2": "ec2-pool"}
RENAMED_SECTIONS = {"ec2": "ec2-pool"}
SCHEMAS: dict[str, Any] = {
    name: importlib.import_module(f"{package}.{schema}")
    for name, (package, schema) in _PACKAGES.items()
}
_controller = None


def canonical_name(name):
    """Return the standard spelling of a provider name given in any casing (`EC2-Pool` gives
    `ec2-pool`). Raises ValueError, naming the known providers, if no provider has that
    name."""
    if isinstance(name, str):
        for canonical in NAMES:
            if canonical.casefold() == name.casefold():
                return canonical
    raise ValueError(f"Unknown provider {name!r}; use one of: {', '.join(NAMES)}.")


def _resolve(name):
    """The standard name for a provider name in any casing, or for a renamed provider's
    old name, as machine records from before the rename store it. Raises ValueError for
    an unknown name."""
    return canonical_name(RENAMED.get(name, name))


def schema(name):
    """Return the schema module for a provider name, read as `get` reads it, so a machine
    record's stored name finds it."""
    return SCHEMAS[_resolve(name)]


def get(name):
    """Return the provider module for a name in any casing, with this process's controller
    set on it. Each provider is imported only when first asked for, so an unused one's
    dependencies (boto3 for EC2) never load. A renamed provider's old name gives the new
    one's module, so machines recorded before the rename can still be checked and
    terminated. Raises ValueError for an unknown name."""
    canonical = _resolve(name)
    provider: Any = importlib.import_module(f"{_PACKAGES[canonical][0]}._provider")
    provider._controller = _controller
    return provider


def bind(controller):
    """Give the providers this process's controller, which they read config from and
    run commands through."""
    global _controller
    _controller = controller
