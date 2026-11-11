# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# A project module that imports no agent, so it loads as written: the Workflow hands
# it agent call results and it must get them as results, not Futures.

import dataclasses


def shout(text):
    return text.upper()


@dataclasses.dataclass
class Box:
    greeting: object = None
