# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Fail unless a pr_review workflow result came from every agent.

ReviewAgent has no fallback, so a non-empty review means the Bedrock call ran.

Usage: check.py < result.json   (the workflow's return value)
"""

import json
import sys


def problems(result):
    if not isinstance(result, dict):
        yield f"result is {type(result).__name__}, expected an object"
        return
    if not isinstance(result.get("tests"), dict):
        yield "tests is missing"
    review = result.get("review")
    if not isinstance(review, str) or not review.strip():
        yield "review is empty"
    if not isinstance(result.get("merged"), bool):
        yield "merged is missing"


def main():
    result = json.load(sys.stdin)
    found = list(problems(result))
    for problem in found:
        print(f"FAIL {problem}", file=sys.stderr)
    if found:
        sys.exit(1)
    print("pr_review result OK: tests, a Bedrock review and a merge decision")


if __name__ == "__main__":
    main()
