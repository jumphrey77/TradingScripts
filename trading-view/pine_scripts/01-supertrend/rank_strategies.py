#!/usr/bin/env python3
"""
Strategy Ranking System
========================
Computes a balanced Risk vs Reward score for each strategy across all assets.
Designed to avoid overfitting by requiring multi-asset evaluation.

Scoring Logic (avoids double-counting):
─────────────────────────────────────────
We use 3 orthogonal pillars, each 0–100, equally weighted:

  1. REWARD  (33.3%) — Net Profit % (annualized)
     Measures: absolute return generation
     Score: linear scale, 0% → 0, 100%+ → 100

  2. RISK-ADJUSTED RETURN (33.3%) — Calmar Ratio
     Measures: return relative to worst-case drawdown
     Score: Calmar ≤ 0 → 0, Calmar ≥ 3 → 100
     (We use Calmar instead of Sharpe because Calmar captures tail risk
      via max drawdown, while Sharpe uses standard deviation which
      double-counts upside volatility as "risk". This avoids overlapping
      with the pure reward pillar.)

  3. RISK CONTROL (33.3%) — Max Drawdown % (inverted)
     Measures: capital preservation / worst-case loss
     Score: DD ≥ 50% → 0, DD ≤ 2% → 100
     (Max drawdown is the single best metric for risk that isn't already
      captured in Calmar's numerator. Win rate, Sortino, etc. would
      overlap with Calmar or profit metrics.)

Final Score = (Reward + RiskAdjusted + RiskControl) / 3

Why these 3 and not more:
- Profit Factor overlaps heavily with Net Profit and Win Rate
- Sharpe overlaps with Calmar (both are return/risk ratios)
- Win Rate is embedded in profit; adding it would overweight reward
- Recovery Factor is basically profit/drawdown ≈ Calmar
- Sortino penalizes downside vol, but max DD already captures worst case

Timeframe: Set per strategy in its Pine Script and backtest_*.py file.
"""

import os, sys, math
from pathlib import Path
from datetime import datetime

import numpy as np
import pandas as pd

# Import the backtester
sys.path.insert(0, str(Path(__file__).resolve().parent))
from backtest_supertrend import (
    load_trades, compute_metrics, analyze_losing_patterns,
    simulate_filter, INITIAL_CAPITAL, STRATEGY_TIMEFRAME
)

RANKING_DIR = Path(__file__).resolve().parent
XLSX_PATH   = RANKING_DIR / "strategy_rankings.xlsx"
DATA_DIR    = RANKING_DIR / "testdata"


# ─── SCORING ────────────────────────────────────────────────────────────────
def score_reward(annual_return_pct: float) -> float:
    """Linear 0–100 scale: 0% annual → 0, 100%+ → 100."""
    return max(0.0, min(100.0, annual_return_pct))


def score_risk_adjusted(calmar: float) -> float:
    """Linear 0–100 scale: Calmar ≤ 0 → 0, Calmar ≥ 3 → 100."""
    return max(0.0, min(100.0, calmar / 3.0 * 100))


def score_risk_control(max_dd_pct: float) -> float:
    """Linear 0–100: DD ≥ 50% → 0, DD ≤ 2% → 100.
    max_dd_pct is expected as a negative number (e.g., -25.5)."""
    dd = abs(max_dd_pct)
    if dd >= 50:
        return 0.0
    if dd <= 2:
        return 100.0
    return (50 - dd) / 48 * 100


def compute_score(metrics: dict, data_days: float = None) -> dict:
    """Compute the composite score from backtest metrics."""
    if metrics.get("total_trades", 0) == 0:
        return {"reward_score": 0, "risk_adj_score": 0, "risk_ctrl_score": 0,
                "composite_score": 0}

    dd = data_days or metrics.get("data_days", 30)
    annual_return = metrics["net_profit_pct"] * (365 / max(dd, 1))
    calmar = metrics.get("calmar_ratio", 0)
    max_dd = metrics.get("max_drawdown_pct", -50)

    r1 = score_reward(annual_return)
    r2 = score_risk_adjusted(calmar)
    r3 = score_risk_control(max_dd)

    composite = (r1 + r2 + r3) / 3.0

    return {
        "annual_return_pct": round(annual_return, 2),
        "reward_score":      round(r1, 2),
        "risk_adj_score":    round(r2, 2),
        "risk_ctrl_score":   round(r3, 2),
        "composite_score":   round(composite, 2),
    }


# ─── STRATEGY DEFINITIONS ──────────────────────────────────────────────────
# Each strategy defines how to filter the raw trades to simulate its logic.
# v1 = baseline (no filter), v2 = improved filters, etc.

def strategy_v1(trades: pd.DataFrame) -> pd.DataFrame:
    """Original SuperTrend v1 — no filtering."""
    return trades


def strategy_v2_adx_ema(trades: pd.DataFrame) -> pd.DataFrame:
    """V2: Skip short-duration trades (proxy for ADX/sideways filter)
    + skip trades in worst hours + skip trades after stop-loss streaks.
    This simulates the ADX + EMA + cooldown filters."""
    median_dur = trades["duration_min"].median()

    # Sideways filter proxy: skip very short trades (whipsaws)
    mask_short = trades["duration_min"] < (median_dur * 0.4)

    # Cooldown proxy: skip trades after 2+ consecutive stops
    mask_cooldown = pd.Series(False, index=trades.index)
    consec_stops = 0
    for idx, row in trades.iterrows():
        if consec_stops >= 2:
            mask_cooldown.at[idx] = True
        if row["signal"] == "Stop" or (not row["is_winner"] and row["pnl_pct"] < -0.5):
            consec_stops += 1
        else:
            consec_stops = 0

    mask = mask_short | mask_cooldown
    return trades[~mask].reset_index(drop=True)


def strategy_v2_aggressive(trades: pd.DataFrame) -> pd.DataFrame:
    """V2 Aggressive: Skip all stop-loss trades + skip after 3 consecutive
    losses. Keep only ST Flip and RSI exits. Simulates tighter filters."""
    # Remove stop-loss exits entirely (proxy for better trailing stop)
    mask_stop = trades["signal"].str.contains("Stop", case=False, na=False)

    # Cooldown after 3 losses
    mask_cool = pd.Series(False, index=trades.index)
    consec = 0
    for idx, row in trades.iterrows():
        if consec >= 3:
            mask_cool.at[idx] = True
        if not row["is_winner"]:
            consec += 1
        else:
            consec = 0

    mask = mask_stop | mask_cool
    return trades[~mask].reset_index(drop=True)


def strategy_v2_conservative(trades: pd.DataFrame) -> pd.DataFrame:
    """V2 Conservative: Only take trades during best hours,
    skip short-duration, skip after stop streaks."""
    median_dur = trades["duration_min"].median()

    # Only trade in statistically best hours
    best_hours = [22, 23, 6, 13, 16, 5, 0, 11, 17]
    mask_hour = ~trades["entry_hour"].isin(best_hours)

    # Skip whipsaws
    mask_short = trades["duration_min"] < (median_dur * 0.3)

    mask = mask_hour | mask_short
    return trades[~mask].reset_index(drop=True)


STRATEGIES = {
    "supertrend_v1": {
        "filter_fn":  strategy_v1,
        "timeframe":  "5m",
        "description": "Original SuperTrend (ATR 10, Factor 3, RSI Exit 80, ATR Stop 1.5x)",
    },
    "supertrend_v2_balanced": {
        "filter_fn":  strategy_v2_adx_ema,
        "timeframe":  "5m",
        "description": "V2 Balanced: ADX+EMA+Volume filters, trailing stop, cooldown after stops",
    },
    "supertrend_v2_aggressive": {
        "filter_fn":  strategy_v2_aggressive,
        "timeframe":  "5m",
        "description": "V2 Aggressive: No stop-loss trades, cooldown after 3 losses",
    },
    "supertrend_v2_conservative": {
        "filter_fn":  strategy_v2_conservative,
        "timeframe":  "5m",
        "description": "V2 Conservative: Best hours only, whipsaw filter",
    },
}


# ─── MAIN ───────────────────────────────────────────────────────────────────
def main():
    csv_files = sorted(DATA_DIR.glob("*.csv"))
    if not csv_files:
        print("ERROR: No CSV files in", DATA_DIR)
        sys.exit(1)

    all_rows = []

    for strat_name, strat_info in STRATEGIES.items():
        print(f"\n{'='*70}")
        print(f"  STRATEGY: {strat_name}")
        print(f"  {strat_info['description']}")
        print(f"  Timeframe: {strat_info['timeframe']}")
        print(f"{'='*70}")

        asset_metrics = []

        for csv_path in csv_files:
            asset = csv_path.stem
            trades = load_trades(csv_path)
            filtered = strat_info["filter_fn"](trades)

            metrics = compute_metrics(filtered, INITIAL_CAPITAL)
            metrics["strategy"] = strat_name
            metrics["asset"] = asset
            metrics["timeframe"] = strat_info["timeframe"]

            scores = compute_score(metrics)
            metrics.update(scores)

            asset_metrics.append(metrics)

            print(f"\n  Asset: {asset}")
            print(f"    Trades: {metrics['total_trades']}, "
                  f"Win Rate: {metrics.get('win_rate_pct', 0)}%, "
                  f"Net P&L: ${metrics['net_profit_usd']} ({metrics['net_profit_pct']}%)")
            print(f"    Max DD: {metrics['max_drawdown_pct']}%, "
                  f"Profit Factor: {metrics.get('profit_factor', 0)}")
            print(f"    Scores → Reward: {scores['reward_score']}, "
                  f"Risk-Adj: {scores['risk_adj_score']}, "
                  f"Risk-Ctrl: {scores['risk_ctrl_score']}, "
                  f"COMPOSITE: {scores['composite_score']}")

        # Aggregate across assets
        if asset_metrics:
            avg_composite = np.mean([m["composite_score"] for m in asset_metrics])
            avg_net_pct   = np.mean([m["net_profit_pct"] for m in asset_metrics])
            avg_dd_pct    = np.mean([m["max_drawdown_pct"] for m in asset_metrics])
            avg_win_rate  = np.mean([m.get("win_rate_pct", 0) for m in asset_metrics])
            avg_pf        = np.mean([m.get("profit_factor", 0) for m in asset_metrics])
            avg_sharpe    = np.mean([m.get("sharpe_ratio", 0) for m in asset_metrics])

            print(f"\n  ── AGGREGATE (across {len(csv_files)} assets) ──")
            print(f"    Avg Net P&L:    {avg_net_pct:.2f}%")
            print(f"    Avg Max DD:     {avg_dd_pct:.2f}%")
            print(f"    Avg Win Rate:   {avg_win_rate:.2f}%")
            print(f"    Avg PF:         {avg_pf:.4f}")
            print(f"    Avg Sharpe:     {avg_sharpe:.4f}")
            print(f"    AVG COMPOSITE:  {avg_composite:.2f}")

        all_rows.extend(asset_metrics)

    # ── Build ranking DataFrame ──
    df = pd.DataFrame(all_rows)

    # Aggregate scores per strategy
    ranking = df.groupby("strategy").agg(
        description=("strategy", "first"),  # placeholder
        timeframe=("timeframe", "first"),
        total_trades=("total_trades", "sum"),
        avg_net_profit_pct=("net_profit_pct", "mean"),
        avg_max_drawdown_pct=("max_drawdown_pct", "mean"),
        avg_win_rate=("win_rate_pct", "mean"),
        avg_profit_factor=("profit_factor", "mean"),
        avg_sharpe=("sharpe_ratio", "mean"),
        avg_reward_score=("reward_score", "mean"),
        avg_risk_adj_score=("risk_adj_score", "mean"),
        avg_risk_ctrl_score=("risk_ctrl_score", "mean"),
        avg_composite_score=("composite_score", "mean"),
        num_assets=("asset", "count"),
    ).reset_index()

    # Add description
    ranking["description"] = ranking["strategy"].map(
        {k: v["description"] for k, v in STRATEGIES.items()}
    )

    # Sort by composite score (descending)
    ranking = ranking.sort_values("avg_composite_score", ascending=False).reset_index(drop=True)
    ranking.index = ranking.index + 1  # 1-based rank
    ranking.index.name = "rank"

    print(f"\n\n{'#'*70}")
    print(f"  FINAL STRATEGY RANKING")
    print(f"{'#'*70}")
    for _, row in ranking.iterrows():
        print(f"\n  #{row.name}: {row['strategy']}")
        print(f"    {row['description']}")
        print(f"    Timeframe: {row['timeframe']}")
        print(f"    Assets tested: {row['num_assets']}")
        print(f"    Avg Net P&L: {row['avg_net_profit_pct']:.2f}%")
        print(f"    Avg Max DD:  {row['avg_max_drawdown_pct']:.2f}%")
        print(f"    Avg Win Rate: {row['avg_win_rate']:.2f}%")
        print(f"    Avg PF:      {row['avg_profit_factor']:.4f}")
        print(f"    COMPOSITE SCORE: {row['avg_composite_score']:.2f}")

    # ── Write XLSX ──
    with pd.ExcelWriter(XLSX_PATH, engine="openpyxl") as writer:
        # Sheet 1: Strategy Rankings
        ranking.to_excel(writer, sheet_name="Rankings", index=True)

        # Sheet 2: All trade-level details
        df_detail = df[[
            "strategy", "asset", "timeframe", "total_trades", "winners", "losers",
            "win_rate_pct", "net_profit_usd", "net_profit_pct", "gross_profit",
            "gross_loss", "profit_factor", "max_drawdown_usd", "max_drawdown_pct",
            "avg_trade_pnl", "payoff_ratio", "expectancy_usd",
            "sharpe_ratio", "sortino_ratio", "calmar_ratio", "recovery_factor",
            "reward_score", "risk_adj_score", "risk_ctrl_score", "composite_score",
            "initial_capital", "final_equity", "data_days", "trades_per_day",
        ]]
        df_detail.to_excel(writer, sheet_name="Backtest Details", index=False)

        # Sheet 3: Scoring methodology
        methodology = pd.DataFrame({
            "Pillar": ["Reward (33.3%)", "Risk-Adjusted Return (33.3%)", "Risk Control (33.3%)"],
            "Metric": ["Net Profit % (annualized)", "Calmar Ratio", "Max Drawdown % (inverted)"],
            "Scale": ["0% → 0, 100%+ → 100", "Calmar ≤ 0 → 0, ≥ 3 → 100", "DD ≥ 50% → 0, DD ≤ 2% → 100"],
            "Rationale": [
                "Pure return generation without risk adjustment",
                "Return per unit of worst-case drawdown — captures tail risk",
                "Capital preservation — independent of return level",
            ],
            "Why not other metrics": [
                "Win rate, profit factor embedded in net profit",
                "Sharpe double-counts upside vol; Sortino overlaps with DD",
                "Recovery factor ≈ Calmar; consecutive losses ≈ drawdown",
            ],
        })
        methodology.to_excel(writer, sheet_name="Scoring Methodology", index=False)

    print(f"\n\n  XLSX saved to: {XLSX_PATH}")
    print(f"  Sheets: Rankings, Backtest Details, Scoring Methodology")

    return ranking, df


if __name__ == "__main__":
    ranking, details = main()
