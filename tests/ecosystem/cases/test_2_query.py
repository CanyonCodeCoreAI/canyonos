# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""One query through the deployed endpoint produced a result the project's own
check accepts as real."""

import json

RESULT_CHARACTERS = 4000


def test_query_result_is_real(query_result, check):
    found = list(check.problems(query_result.result))
    result = json.dumps(query_result.result)[:RESULT_CHARACTERS]
    assert not found, "\n".join([*found, f"result: {result}"])
