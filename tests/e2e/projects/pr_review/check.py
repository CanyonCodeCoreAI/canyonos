# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Fail unless a pr_review result came from every agent for the fixed pull request,
"Add retry" adding `def retry(): ...`.

That pull request passes every TestRunnerAgent check, so a result whose tests did not
pass means the agents never saw its title and diff. ReviewAgent has no fallback, so a
non-empty review means the Bedrock call ran, and MergeAgent merges exactly when that
review approves without asking for changes.

Usage: problems(result, query=...) yields one line per problem; nothing means the
result is real. The query only goes into the message.
"""

PASSED = {
    "passed": True,
    "checks": {"has_title": True, "adds_code": True, "no_debug_code": True},
}


def problems(result, *, query=None, request_id=None):
    """Yield why a pr_review result is not every agent's answer to the fixed PR."""
    if not isinstance(result, dict):
        yield f"result is {type(result).__name__}, expected an object"
        return
    if result.get("tests") != PASSED:
        sent = "" if query is None else f" for the query {query!r}"
        yield (
            f"tests are {result.get('tests')!r}{sent}, expected {PASSED!r}: "
            "the agents did not get the pull request's title and diff"
        )
    review = result.get("review")
    if not isinstance(review, str) or not review.strip():
        yield "review is empty"
        return
    verdict = review.upper()
    approves = "APPROVE" in verdict and "REQUEST CHANGES" not in verdict
    if result.get("merged") is not approves:
        yield f"merged is {result.get('merged')!r}, but the review approves: {approves}"
