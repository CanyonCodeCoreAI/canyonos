# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""The one entry point callers use to reach the provider an agent runs on."""

import importlib
from typing import Any

_PACKAGES = {
    "local": "canyonos_core.reconciler.providers.Local",
    "EC2": "canyonos_core.reconciler.providers.EC2",
}
NAMES = tuple(_PACKAGES)
DEFAULT = "local"
SCHEMAS: dict[str, Any] = {
    name: importlib.import_module(f"{package}._schema")
    for name, package in _PACKAGES.items()
}
_controller = None


def canonical_name(name):
    """Return the standard spelling of a provider name given in any casing (`ec2` gives
    `EC2`), or None if no provider has that name."""
    if isinstance(name, str):
        for canonical in NAMES:
            if canonical.casefold() == name.casefold():
                return canonical
    return None


def get(name):
    """Return the provider module for a name in any casing, with this process's controller
    set on it. Each provider is imported only when first asked for, so an unused one's
    dependencies (boto3 for EC2) never load. Raises ValueError for an unknown name."""
    canonical = canonical_name(name)
    if canonical is None:
        raise ValueError(f"Unknown provider {name!r}; use one of: {', '.join(NAMES)}.")
    provider: Any = importlib.import_module(f"{_PACKAGES[canonical]}._runtime")
    provider._controller = _controller
    return provider


def bind(controller):
    """Give the providers this process's controller, which they read config from and
    run commands through."""
    global _controller
    _controller = controller
