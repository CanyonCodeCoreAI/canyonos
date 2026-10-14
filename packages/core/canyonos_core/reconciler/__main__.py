# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Lets the Global Controller start the reconciler with `python -m
canyonos_core.reconciler`."""

import sys

from canyonos_core.reconciler.reconciler import main

if __name__ == "__main__":
    sys.exit(main())
