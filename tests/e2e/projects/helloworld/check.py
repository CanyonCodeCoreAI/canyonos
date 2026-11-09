# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Fail unless the helloworld result is HelloAgent's greeting for the query.

Usage: problems(result, query=...) yields one line per problem; nothing means the
result is real. Without a query it checks project.yaml's, "World".
"""

DEFAULT_QUERY = "World"


def problems(result, *, query=None, request_id=None):
    """Yield why a helloworld result is not exactly HelloAgent's greeting for `query`."""
    name = DEFAULT_QUERY if query is None else query
    expected = {"greeting": f"Hello, {name}! I'm the HelloAgent!"}
    if result != expected:
        yield f"result is {result!r}, expected {expected!r}"
