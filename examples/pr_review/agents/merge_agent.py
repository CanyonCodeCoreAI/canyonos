# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# Merge Agent
#
# Decides whether the pull request merges, pure Python: the review, written with
# the test results in hand, must approve and not ask for changes.


class MergeAgent(object):
    def __init__(self):
        self.tools = [self.merge]

    def merge(self, pr: dict, review: str) -> dict:
        """Merge when the review approves."""
        verdict = review.upper()
        if "REQUEST CHANGES" in verdict or "APPROVE" not in verdict:
            return {"merged": False, "reason": "the review does not approve"}
        return {"merged": True, "reason": f"merged {pr.get('title', '')!r}"}


if __name__ == "__main__":
    print(MergeAgent().merge({"title": "Add retry"}, "Looks good.\nAPPROVE"))
