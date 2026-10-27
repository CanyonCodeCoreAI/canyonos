# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

from agents.slow_agent import SlowAgent


class Workflow(object):
    def main(self, seconds: str = "1"):
        return {"waited": SlowAgent().wait(seconds=int(seconds)).value()}
