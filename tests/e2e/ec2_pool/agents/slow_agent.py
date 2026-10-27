# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

import time


class SlowAgent(object):
    def wait(self, seconds: int) -> int:
        """Sleep, so a call can still be running when its machine goes away."""
        time.sleep(seconds)
        return seconds
