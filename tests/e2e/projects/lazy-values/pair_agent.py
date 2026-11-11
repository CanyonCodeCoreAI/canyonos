# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# Returns a list, for the Workflow to unpack.


class PairAgent(object):
    def split(self, name: str) -> list:
        """The name and its length."""
        return [name, len(name)]
