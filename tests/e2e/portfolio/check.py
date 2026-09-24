"""Fail unless a portfolio workflow result came from the real pipeline.

Every stage of the example has a quiet fallback: PriceAgent switches to
synthetic prices when yfinance fails, and AdvisorAgent returns a templated
summary when Bedrock fails. A result built from either still has the right
shape, so this checks where the data came from, not just that it is there.

Usage: check.py < result.json   (the workflow's return value)
"""

import json
import sys

EXPECTED_TICKERS = {"AAPL", "MSFT", "NVDA"}
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


def problems(result):
    if not isinstance(result, dict):
        yield f"result is {type(result).__name__}, expected an object"
        return

    tickers = set((result.get("holdings") or {}).keys())
    if tickers != EXPECTED_TICKERS:
        yield f"holdings are {sorted(tickers)}, expected {sorted(EXPECTED_TICKERS)}"

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

    risk = result.get("risk") or {}
    if "error" in risk:
        yield f"risk failed: {risk['error']}"
    for field in RISK_FIELDS:
        if not isinstance(risk.get(field), (int, float)):
            yield f"risk.{field} is not a number"

    summary = result.get("summary")
    if not isinstance(summary, str) or not summary.strip():
        yield "summary is empty"
    elif TEMPLATED_SUMMARY_MARKER in summary:
        yield "summary is the templated fallback, so the Bedrock call failed"


def main():
    result = json.load(sys.stdin)
    found = list(problems(result))
    for problem in found:
        print(f"FAIL {problem}", file=sys.stderr)
    if found:
        sys.exit(1)
    print("portfolio result OK: real prices for every ticker and a Bedrock summary")


if __name__ == "__main__":
    main()
