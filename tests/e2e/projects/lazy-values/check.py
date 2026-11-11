# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Fail unless the lazy-values workflow got every agent call's result where it used
it: unpacked, awaited, read from a project object by a library, the Future's own
`.id` read next to a result that has none, and handed to a project module that is
not rewritten.

Usage: problems(result, query=...) yields one line per problem; nothing means the
result is real. Without a query it checks project.yaml's, "World".
"""

DEFAULT_QUERY = "World"


def problems(result, *, query=None, request_id=None):
    """Yield each entry of the result that differs from what `query` gives."""
    name = DEFAULT_QUERY if query is None else query
    greeting = f"Hello, {name}! I'm the HelloAgent!"
    expected = {
        "unpacked": [name, len(name)],
        "starred": [name, [len(name)]],
        "nested": [0, name, len(name)],
        "looped": [f"{name}:{len(name)}"],
        "awaited": [greeting, greeting, [name, len(name)]],
        "holder": {"greeting": greeting},
        "future_id": True,
        "helper": greeting.upper(),
        "helper_object": {"greeting": greeting},
    }
    if not isinstance(result, dict):
        yield f"result is {result!r}, expected a dict"
        return
    for key, want in expected.items():
        if result.get(key) != want:
            yield f"{key} was {result.get(key)!r}, expected {want!r}"
