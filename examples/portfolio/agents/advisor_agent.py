# SPDX-FileCopyrightText: 2026 Canyon Code, Inc.
# SPDX-License-Identifier: AGPL-3.0-only

# Advisor Agent
#
# Final stage. Turns the computed portfolio metrics and risk figures into a
# short, plain-English briefing using a small, cheap Baseten Model API, called
# through the openai SDK. Token telemetry is recorded onto this execution's
# future:<future_id> hash transparently by the CanyonOS LLM gateway each agent
# container's Baseten calls are routed through. Configure with env vars:
#   BASETEN_API_KEY   (required)
#   BASETEN_MODEL_ID  (default: deepseek-ai/DeepSeek-V4-Flash-0731)
#
# If the LLM is unavailable (returns an empty string), it falls back to a
# deterministic templated summary so the pipeline still returns.
#
# The instructions are the AdvisorAgent.summarize system prompt in config/prompts.yaml, which the
# LLM gateway adds to every chat completion.
#
# Resource profile: cheap CPU; the LLM cost sits in the Baseten call, not here.

import os

from openai import OpenAI


class AdvisorAgent(object):
    def __init__(self):
        self.tools = [self.summarize]
        self.model_id = os.environ.get(
            "BASETEN_MODEL_ID", "deepseek-ai/DeepSeek-V4-Flash-0731"
        )
        self._client = OpenAI(
            base_url="https://inference.baseten.co/v1",
            api_key=os.environ["BASETEN_API_KEY"],
        )

    def summarize(self, holdings: dict, metrics: dict, risk: dict) -> str:
        """Write a short plain-English briefing on the portfolio."""
        prompt = self._build_prompt(holdings, metrics, risk)
        try:
            response = self._client.chat.completions.create(
                model=self.model_id,
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
            )
            return response.choices[0].message.content
        except Exception as e:
            print(f"AdvisorAgent: Baseten call failed ({e}); using templated summary.")
            return self._fallback_summary(metrics, risk)

    def _build_prompt(self, holdings: dict, metrics: dict, risk: dict) -> str:
        lines = [
            "Holdings (weights): " + ", ".join(f"{t}={w}" for t, w in holdings.items())
        ]
        lines.append("\nPer-ticker metrics:")
        for t, m in metrics.items():
            if "error" in m:
                lines.append(f"  {t}: {m['error']}")
                continue
            lines.append(
                f"  {t}: ann_return={m['annualized_return']:.1%}, "
                f"ann_vol={m['annualized_volatility']:.1%}, "
                f"sharpe={m['sharpe']}, max_drawdown={m['max_drawdown']:.1%}"
            )
        lines.append(
            "\nPortfolio: "
            f"ann_return={risk.get('portfolio_annualized_return', 0):.1%}, "
            f"ann_vol={risk.get('portfolio_annualized_volatility', 0):.1%}, "
            f"sharpe={risk.get('portfolio_sharpe')}, "
            f"HHI={risk.get('concentration_hhi')}, "
            f"diversification_ratio={risk.get('diversification_ratio')}"
        )
        return "\n".join(lines)

    def _fallback_summary(self, metrics: dict, risk: dict) -> str:
        ret = risk.get("portfolio_annualized_return", 0.0)
        vol = risk.get("portfolio_annualized_volatility", 0.0)
        sharpe = risk.get("portfolio_sharpe", 0.0)
        hhi = risk.get("concentration_hhi", 0.0)
        top = risk.get("top_holding", {})
        concentration = (
            "highly concentrated"
            if hhi > 0.5
            else "moderately concentrated"
            if hhi > 0.25
            else "well diversified"
        )
        return (
            f"The portfolio has an estimated annualized return of {ret:.1%} against "
            f"{vol:.1%} volatility (Sharpe {sharpe}). It appears {concentration} "
            f"(HHI {hhi}), with {top.get('ticker', 'n/a')} the largest position at "
            f"{top.get('weight', 0):.1%}. Diversification ratio is "
            f"{risk.get('diversification_ratio')}, indicating the extent to which "
            f"combining these holdings reduces standalone risk."
        )


if __name__ == "__main__":
    agent = AdvisorAgent()
    demo_metrics = {
        "AAPL": {
            "annualized_return": 0.18,
            "annualized_volatility": 0.25,
            "sharpe": 0.72,
            "max_drawdown": -0.15,
        },
        "MSFT": {
            "annualized_return": 0.14,
            "annualized_volatility": 0.22,
            "sharpe": 0.64,
            "max_drawdown": -0.12,
        },
    }
    demo_risk = {
        "portfolio_annualized_return": 0.164,
        "portfolio_annualized_volatility": 0.21,
        "portfolio_sharpe": 0.78,
        "concentration_hhi": 0.52,
        "diversification_ratio": 1.12,
        "top_holding": {"ticker": "AAPL", "weight": 0.6},
    }
    print(agent.summarize({"AAPL": 0.6, "MSFT": 0.4}, demo_metrics, demo_risk))
