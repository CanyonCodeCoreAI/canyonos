# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""
CanyonOS standard color palette.

The green->white gradient introduced by the `canyonos init` banner, reused
across the CLI so everything shares one look. `GREEN` is the primary brand
color; `WHITE` the secondary; `GRADIENT` the full ramp for multi-line output.
Both flip to a dark-on-light variant when the terminal background is light.
"""

import re
import sys

from canyonos.os_support import is_terminal, query_terminal

GREEN = "#2BD17E"

_GRADIENT_DARK = ["#2BD17E", "#55DA98", "#80E3B2", "#AAEDCB", "#D5F6E5", "#FFFFFF"]
_GRADIENT_LIGHT = ["#2BD17E", "#1F9C61", "#177249", "#0F4E31", "#082A1A", "#000000"]

# 100ms is fine locally but can be exceeded by a real SSH round-trip; 400ms gives a
# laggy remote session a real chance to answer before we give up and assume dark.
_BACKGROUND_QUERY_TIMEOUT = 0.4


def _is_light_background():
    """Ask the terminal for its background color and return True if it is light; used
    once at import to pick the CLI's color palette. A terminal that can't answer is
    taken as dark."""
    if not is_terminal(sys.stdin):
        return False
    reply = query_terminal(
        "\x1b]11;?\x07", sys.stdin, sys.stdout, _BACKGROUND_QUERY_TIMEOUT
    )
    m = re.search(r"rgb:([0-9a-f]{2})\S*/([0-9a-f]{2})\S*/([0-9a-f]{2})", reply, re.I)
    return (
        bool(m)
        and (0.299 * int(m[1], 16) + 0.587 * int(m[2], 16) + 0.114 * int(m[3], 16))
        > 128
    )


# Primary -> secondary ramp (used for the init banner, top to bottom).
GRADIENT = _GRADIENT_LIGHT if _is_light_background() else _GRADIENT_DARK
WHITE = GRADIENT[-1]
