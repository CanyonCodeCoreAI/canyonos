# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# Test Runner Agent
#
# Stands in for a CI run: a few checks on the pull request's diff, pure Python.

import os

FORBIDDEN = ("breakpoint(", "import pdb", "print(")


class TestRunnerAgent(object):
    def __init__(self):
        # tests/e2e/governance.sh sets it to stage a replica that crashes at boot.
        if os.environ.get("TESTRUNNER_BROKEN") == "1":
            raise RuntimeError("TESTRUNNER_BROKEN is set")
        self.tools = [self.run]

    def run(self, pr: dict) -> dict:
        """Check the pull request's diff and return which checks passed."""
        added = [
            line[1:]
            for line in pr.get("diff", "").splitlines()
            if line.startswith("+") and not line.startswith("+++")
        ]
        checks = {
            "has_title": bool(pr.get("title", "").strip()),
            "adds_code": bool(added),
            "no_debug_code": not any(
                token in line for line in added for token in FORBIDDEN
            ),
        }
        return {"passed": all(checks.values()), "checks": checks}


if __name__ == "__main__":
    print(TestRunnerAgent().run({"title": "Add retry", "diff": "+def retry(): ..."}))
