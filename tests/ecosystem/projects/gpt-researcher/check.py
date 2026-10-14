# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Fail unless a GPT Researcher result holds a written report that cites sources.

The single-agent path returns `report` with `research_information.source_urls`; the
multi-agent path returns only `report`. Either way an empty report means the
pipeline did not run.

Usage: problems(result) yields one line per problem; nothing means the result is real.
"""

MIN_REPORT_CHARACTERS = 500


def problems(result):
    """Yield why a GPT Researcher result holds no real report; the ecosystem check
    fails the project on any line."""
    if not isinstance(result, dict):
        yield f"result is {type(result).__name__}, expected an object"
        return
    report = result.get("report")
    if not isinstance(report, str) or len(report.strip()) < MIN_REPORT_CHARACTERS:
        yield f"report is missing or shorter than {MIN_REPORT_CHARACTERS} characters"
    info = result.get("research_information")
    if info is not None and not info.get("source_urls"):
        yield "research_information.source_urls is empty, so no web search happened"
