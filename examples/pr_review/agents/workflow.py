# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# Pull request review workflow: the agent the endpoint serves at POST /review.
#
#   1. TestRunnerAgent - checks the diff and returns a pass/fail summary
#   2. ReviewAgent     - one Bedrock call that reviews the diff against that summary
#   3. MergeAgent      - merges when the review, which saw the tests, approves
#
# config/governance.yaml makes MergeAgent require TestRunnerAgent and moves
# ReviewAgent to another model once its spend passes a threshold.
#
# After `canyonos deploy`:
#   curl -X POST http://localhost:8080/review \
#        -H 'Content-Type: application/json' \
#        -d '{"pr": {"title": "Add retry", "diff": "+def retry(): ..."}}'
#   curl http://localhost:8080/status/<request_id>

import json

from agents.test_runner_agent import TestRunnerAgent
from agents.review_agent import ReviewAgent
from agents.merge_agent import MergeAgent


class Workflow(object):
    def review(self, pr: dict) -> dict:
        if isinstance(pr, str):
            # `canyonos test` sends its query as text: the PR's title, then its diff.
            title, _, diff = pr.partition("\n")
            pr = {"title": title, "diff": diff.strip("\n")}

        # Each call returns a Future at once and the next takes it as an argument,
        # so all three are dispatched before any result. Each Future feeds one
        # agent only: two agents waiting on the same one keep pushing its result
        # to each other.
        tests = TestRunnerAgent().run(pr=pr)
        review = ReviewAgent().review(pr=pr, tests=tests)
        merge = MergeAgent().merge(pr=pr, review=review)

        # Merge first: a refused merge fails the request with its own error,
        # not with the error of an argument it was still waiting on.
        decision = json.loads(merge.value())
        return {
            "tests": json.loads(tests.value()),
            "review": review.value(),
            "merged": decision["merged"],
        }
