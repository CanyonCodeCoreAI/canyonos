# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Fail unless a TradingAgents result is a full run: the final graph state with a
trading signal, not an empty or partial state.

Usage: problems(result) yields one line per problem; nothing means the result is real.
"""

STATE_FIELDS = (
    "market_report",
    "sentiment_report",
    "news_report",
    "fundamentals_report",
    "investment_plan",
    "trader_investment_plan",
    "final_trade_decision",
)


def problems(result):
    """Yield why a TradingAgents result is not a full run; the ecosystem check fails
    the project on any line."""
    if not isinstance(result, dict):
        yield f"result is {type(result).__name__}, expected an object"
        return
    for field in STATE_FIELDS:
        value = result.get(field)
        if not isinstance(value, str) or not value.strip():
            yield f"{field} is empty"
    signal = result.get("signal")
    if not isinstance(signal, str) or not signal.strip():
        yield "signal is empty"
