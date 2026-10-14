# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Fail unless an OpenRCA result names a root cause after a real agent trajectory.

Usage: problems(result) yields one line per problem; nothing means the result is real.
"""


def problems(result):
    """Yield why an OpenRCA result names no root cause; the ecosystem check fails
    the project on any line."""
    if not isinstance(result, dict):
        yield f"result is {type(result).__name__}, expected an object"
        return
    prediction = result.get("prediction")
    if not isinstance(prediction, str) or not prediction.strip():
        yield "prediction is empty"
    if not result.get("trajectory"):
        yield "trajectory is empty, so the agent took no steps"
