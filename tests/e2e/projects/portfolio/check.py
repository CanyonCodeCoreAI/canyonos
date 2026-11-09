# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

"""Fail unless a portfolio workflow result came from the real pipeline.

Every stage of the example has a quiet fallback: PriceAgent switches to
synthetic prices when yfinance fails, and AdvisorAgent returns a templated
summary when Bedrock fails. A result built from either still has the right
shape, so this checks where the data came from, not just that it is there.

Holdings and weights are checked against the fixed query in config/test_query.txt,
40% Apple, 35% Microsoft and 25% Nvidia, the query every case sends.

Usage: problems(result, query=...) yields one line per problem; nothing means the
result is real. FAILING_QUERY is a query whose result names the agent that failed.
"""

EXPECTED_WEIGHTS = {"AAPL": 0.40, "MSFT": 0.35, "NVDA": 0.25}
EXPECTED_TICKERS = set(EXPECTED_WEIGHTS)
WEIGHT_TOLERANCE = 0.02
MIN_PRICE_DAYS = 20
METRIC_FIELDS = (
    "annualized_return",
    "annualized_volatility",
    "sharpe",
    "max_drawdown",
)
RISK_FIELDS = (
    "portfolio_annualized_return",
    "portfolio_annualized_volatility",
    "portfolio_sharpe",
)
TEMPLATED_SUMMARY_MARKER = "combining these holdings reduces standalone risk"
FAILING_QUERY = ("I own no stocks", "IntentAgent.parse failed: ")


def problems(result, *, query=None, request_id=None):
    """Yield why a portfolio result did not come from the query's holdings, real
    prices and Bedrock."""
    if not isinstance(result, dict):
        yield f"result is {type(result).__name__}, expected an object"
        return

    holdings = result.get("holdings") or {}
    if set(holdings) != EXPECTED_TICKERS:
        yield f"holdings are {sorted(holdings)}, expected {sorted(EXPECTED_TICKERS)}"
    else:
        for ticker, weight in EXPECTED_WEIGHTS.items():
            if abs(holdings[ticker] - weight) > WEIGHT_TOLERANCE:
                yield f"holdings.{ticker} is {holdings[ticker]}, expected {weight}"
    lookback = result.get("lookback_days")
    if not isinstance(lookback, int) or lookback <= 0:
        yield f"lookback_days is {lookback!r}, expected a positive number of days"

    metrics = result.get("metrics") or {}
    for ticker in sorted(EXPECTED_TICKERS):
        entry = metrics.get(ticker)
        if not isinstance(entry, dict):
            yield f"metrics.{ticker} is missing"
            continue
        if "error" in entry:
            yield f"metrics.{ticker} failed: {entry['error']}"
        if entry.get("source") != "yfinance":
            yield f"metrics.{ticker} used {entry.get('source')!r} prices, not yfinance"
        for field in METRIC_FIELDS:
            if not isinstance(entry.get(field), (int, float)):
                yield f"metrics.{ticker}.{field} is not a number"
        if (entry.get("n_days") or 0) < MIN_PRICE_DAYS:
            yield f"metrics.{ticker} has {entry.get('n_days')!r} days of prices"

    risk = result.get("risk") or {}
    if "error" in risk:
        yield f"risk failed: {risk['error']}"
    for field in RISK_FIELDS:
        if not isinstance(risk.get(field), (int, float)):
            yield f"risk.{field} is not a number"
    if risk.get("n_holdings") != len(EXPECTED_TICKERS):
        yield f"risk covers {risk.get('n_holdings')!r} holdings, expected 3"

    summary = result.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        yield "summary is empty"
    elif TEMPLATED_SUMMARY_MARKER in summary:
        yield "summary is the templated fallback, so the Bedrock call failed"
