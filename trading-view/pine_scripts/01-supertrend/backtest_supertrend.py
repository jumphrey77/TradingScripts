#!/usr/bin/env python3
"""
SuperTrend Strategy Backtester & Analyzer
=========================================
Reads TradingView trade export CSVs and computes comprehensive performance
metrics.  Also simulates strategy improvements by filtering trades based on
observable patterns (trade duration, time-of-day, consecutive-loss streaks,
etc.) to estimate the effect of adding filters to the Pine Script.

Timeframe: To be set per strategy — this strategy targets the 5-minute chart.
"""

import os, sys, math
from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd

# ─── CONFIGURATION ──────────────────────────────────────────────────────────
STRATEGY_NAME = "supertrend_v1"
STRATEGY_TIMEFRAME = "5m"            # <-- set per strategy, remembered here
INITIAL_CAPITAL = 1000.0
COMMISSION_PCT = 0.1                 # 0.1 % per side
SLIPPAGE_TICKS = 3

DATA_DIR = Path(__file__).resolve().parent / "testdata"
RESULTS_DIR = Path(__file__).resolve().parent / "results"
RESULTS_DIR.mkdir(exist_ok=True)


# ─── HELPERS ────────────────────────────────────────────────────────────────
def load_trades(csv_path: str | Path) -> pd.DataFrame:
    """Load a TradingView trade-list CSV and return one row per round-trip."""
    raw = pd.read_csv(csv_path)
    raw.columns = raw.columns.str.strip()

    entries = raw[raw["Type"] == "Entry long"].copy()
    exits   = raw[raw["Type"] == "Exit long"].copy()

    entries = entries.sort_values("Trade #").reset_index(drop=True)
    exits   = exits.sort_values("Trade #").reset_index(drop=True)

    trades = pd.DataFrame({
        "trade_num":       exits["Trade #"].values,
        "entry_time":      pd.to_datetime(entries["Date and time"].values),
        "exit_time":       pd.to_datetime(exits["Date and time"].values),
        "signal":          exits["Signal"].values,
        "entry_price":     entries["Price USD"].values,
        "exit_price":      exits["Price USD"].values,
        "qty":             entries["Position size (qty)"].values,
        "position_value":  entries["Position size (value)"].values,
        "pnl_usd":         exits["Net P&L USD"].values,
        "pnl_pct":         exits["Net P&L %"].values,
        "fav_excursion":   exits["Favorable excursion USD"].values,
        "fav_excursion_pct": exits["Favorable excursion %"].values,
        "adv_excursion":   exits["Adverse excursion USD"].values,
        "adv_excursion_pct": exits["Adverse excursion %"].values,
        "cum_pnl":         exits["Cumulative P&L USD"].values,
        "cum_pnl_pct":     exits["Cumulative P&L %"].values,
    })

    trades["duration_min"] = (trades["exit_time"] - trades["entry_time"]).dt.total_seconds() / 60
    trades["entry_hour"]   = trades["entry_time"].dt.hour
    trades["is_winner"]    = trades["pnl_usd"] > 0
    trades["day_of_week"]  = trades["entry_time"].dt.dayofweek  # Mon=0

    return trades


def compute_metrics(trades: pd.DataFrame, capital: float = INITIAL_CAPITAL) -> dict:
    """Compute comprehensive backtest metrics from a trades DataFrame."""
    n = len(trades)
    if n == 0:
        return {"total_trades": 0}

    winners = trades[trades["is_winner"]]
    losers  = trades[~trades["is_winner"]]

    total_pnl = trades["pnl_usd"].sum()

    # Equity curve
    equity = capital + trades["pnl_usd"].cumsum()
    peak = equity.cummax()
    drawdown = equity - peak
    max_dd = drawdown.min()
    max_dd_pct = (drawdown / peak).min() * 100

    # Profit factor
    gross_profit = winners["pnl_usd"].sum() if len(winners) > 0 else 0
    gross_loss   = abs(losers["pnl_usd"].sum()) if len(losers) > 0 else 0.001
    profit_factor = gross_profit / gross_loss if gross_loss != 0 else float('inf')

    # Consecutive wins/losses
    is_w = trades["is_winner"].values
    max_consec_wins = max_consec_losses = cur_w = cur_l = 0
    for w in is_w:
        if w:
            cur_w += 1; cur_l = 0
            max_consec_wins = max(max_consec_wins, cur_w)
        else:
            cur_l += 1; cur_w = 0
            max_consec_losses = max(max_consec_losses, cur_l)

    # Sharpe-like ratio (trade-level, annualized roughly)
    ret = trades["pnl_pct"].values / 100
    avg_ret = np.mean(ret)
    std_ret = np.std(ret, ddof=1) if n > 1 else 0.001
    # Approximate trades per year (based on data density)
    data_days = (trades["exit_time"].max() - trades["entry_time"].min()).total_seconds() / 86400
    trades_per_day = n / max(data_days, 1)
    trades_per_year = trades_per_day * 365
    sharpe = (avg_ret / std_ret) * math.sqrt(trades_per_year) if std_ret > 0 else 0

    # Sortino (downside deviation)
    neg_ret = ret[ret < 0]
    down_dev = np.std(neg_ret, ddof=1) if len(neg_ret) > 1 else 0.001
    sortino = (avg_ret / down_dev) * math.sqrt(trades_per_year) if down_dev > 0 else 0

    # Calmar (annualized return / max drawdown)
    annual_return_pct = (total_pnl / capital) * (365 / max(data_days, 1)) * 100
    calmar = annual_return_pct / abs(max_dd_pct) if max_dd_pct != 0 else 0

    # Recovery factor
    recovery_factor = total_pnl / abs(max_dd) if max_dd != 0 else 0

    # Win/loss averages
    avg_win  = winners["pnl_usd"].mean() if len(winners) > 0 else 0
    avg_loss = losers["pnl_usd"].mean()  if len(losers) > 0 else 0
    avg_win_pct  = winners["pnl_pct"].mean() if len(winners) > 0 else 0
    avg_loss_pct = losers["pnl_pct"].mean()  if len(losers) > 0 else 0

    # Expectancy
    win_rate = len(winners) / n
    expectancy = (win_rate * avg_win) + ((1 - win_rate) * avg_loss)

    return {
        "strategy":            STRATEGY_NAME,
        "timeframe":           STRATEGY_TIMEFRAME,
        "total_trades":        n,
        "winners":             len(winners),
        "losers":              len(losers),
        "win_rate_pct":        round(win_rate * 100, 2),
        "net_profit_usd":      round(total_pnl, 2),
        "net_profit_pct":      round(total_pnl / capital * 100, 2),
        "gross_profit":        round(gross_profit, 2),
        "gross_loss":          round(-gross_loss, 2),
        "profit_factor":       round(profit_factor, 4),
        "max_drawdown_usd":    round(max_dd, 2),
        "max_drawdown_pct":    round(max_dd_pct, 2),
        "avg_trade_pnl":       round(trades["pnl_usd"].mean(), 4),
        "avg_win_usd":         round(avg_win, 4),
        "avg_loss_usd":        round(avg_loss, 4),
        "avg_win_pct":         round(avg_win_pct, 4),
        "avg_loss_pct":        round(avg_loss_pct, 4),
        "payoff_ratio":        round(abs(avg_win / avg_loss), 4) if avg_loss != 0 else 0,
        "expectancy_usd":      round(expectancy, 4),
        "max_consec_wins":     max_consec_wins,
        "max_consec_losses":   max_consec_losses,
        "sharpe_ratio":        round(sharpe, 4),
        "sortino_ratio":       round(sortino, 4),
        "calmar_ratio":        round(calmar, 4),
        "recovery_factor":     round(recovery_factor, 4),
        "avg_duration_min":    round(trades["duration_min"].mean(), 1),
        "initial_capital":     capital,
        "final_equity":        round(capital + total_pnl, 2),
        "data_days":           round(data_days, 1),
        "trades_per_day":      round(trades_per_day, 1),
    }


def analyze_losing_patterns(trades: pd.DataFrame) -> dict:
    """Analyze patterns in losing trades to suggest improvements."""
    losers = trades[~trades["is_winner"]]
    winners = trades[trades["is_winner"]]

    analysis = {}

    # 1. By exit signal type
    by_signal = trades.groupby("signal").agg(
        count=("pnl_usd", "count"),
        total_pnl=("pnl_usd", "sum"),
        avg_pnl=("pnl_usd", "mean"),
        win_rate=("is_winner", "mean"),
    ).round(4)
    analysis["by_signal"] = by_signal

    # 2. By hour of day
    by_hour = trades.groupby("entry_hour").agg(
        count=("pnl_usd", "count"),
        total_pnl=("pnl_usd", "sum"),
        avg_pnl=("pnl_usd", "mean"),
        win_rate=("is_winner", "mean"),
    ).round(4)
    analysis["by_hour"] = by_hour

    # 3. By day of week
    by_dow = trades.groupby("day_of_week").agg(
        count=("pnl_usd", "count"),
        total_pnl=("pnl_usd", "sum"),
        avg_pnl=("pnl_usd", "mean"),
        win_rate=("is_winner", "mean"),
    ).round(4)
    analysis["by_dow"] = by_dow

    # 4. Short-duration trades (likely whipsaws/sideways)
    median_dur = trades["duration_min"].median()
    short = trades[trades["duration_min"] < median_dur / 2]
    analysis["short_trades_pnl"] = round(short["pnl_usd"].sum(), 2)
    analysis["short_trades_count"] = len(short)
    analysis["short_trades_win_rate"] = round(short["is_winner"].mean() * 100, 2) if len(short) > 0 else 0

    # 5. Trades after consecutive losses (chasing/overtrading)
    consec_losses = 0
    after_streak = []
    for _, row in trades.iterrows():
        if consec_losses >= 3:
            after_streak.append(row)
        if not row["is_winner"]:
            consec_losses += 1
        else:
            consec_losses = 0
    if after_streak:
        streak_df = pd.DataFrame(after_streak)
        analysis["after_3_loss_streak_pnl"] = round(streak_df["pnl_usd"].sum(), 2)
        analysis["after_3_loss_streak_count"] = len(streak_df)
        analysis["after_3_loss_streak_win_rate"] = round(streak_df["is_winner"].mean() * 100, 2)
    else:
        analysis["after_3_loss_streak_pnl"] = 0
        analysis["after_3_loss_streak_count"] = 0
        analysis["after_3_loss_streak_win_rate"] = 0

    # 6. Favorable excursion analysis (trades that were winning then lost)
    gave_back = trades[(trades["fav_excursion_pct"] > 0.3) & (~trades["is_winner"])]
    analysis["gave_back_count"] = len(gave_back)
    analysis["gave_back_pnl"] = round(gave_back["pnl_usd"].sum(), 2)
    analysis["gave_back_avg_fav_excursion"] = round(gave_back["fav_excursion_pct"].mean(), 2) if len(gave_back) > 0 else 0

    # 7. Identify best/worst hours
    worst_hours = by_hour.nsmallest(3, "total_pnl")
    best_hours = by_hour.nlargest(3, "total_pnl")
    analysis["worst_hours"] = worst_hours.index.tolist()
    analysis["best_hours"] = best_hours.index.tolist()

    return analysis


def simulate_filter(trades: pd.DataFrame, mask: pd.Series, name: str,
                    capital: float = INITIAL_CAPITAL) -> dict:
    """Simulate removing trades that match the mask (True = SKIP trade).
    Recompute equity curve with compound growth."""
    filtered = trades[~mask].copy().reset_index(drop=True)
    if len(filtered) == 0:
        return {"filter": name, "total_trades": 0, "net_profit_usd": 0}
    metrics = compute_metrics(filtered, capital)
    metrics["filter"] = name
    metrics["trades_removed"] = int(mask.sum())
    return metrics


def print_metrics(m: dict, title: str = ""):
    """Pretty-print metrics."""
    if title:
        print(f"\n{'='*60}")
        print(f"  {title}")
        print(f"{'='*60}")
    for k, v in m.items():
        print(f"  {k:30s}: {v}")


# ─── MAIN ───────────────────────────────────────────────────────────────────
def main():
    csv_files = sorted(DATA_DIR.glob("*.csv"))
    if not csv_files:
        print("ERROR: No CSV files found in", DATA_DIR)
        sys.exit(1)

    all_results = []

    for csv_path in csv_files:
        asset = csv_path.stem  # filename without extension
        print(f"\n{'#'*70}")
        print(f"# ASSET: {asset}")
        print(f"# FILE : {csv_path.name}")
        print(f"{'#'*70}")

        trades = load_trades(csv_path)

        # ── Baseline metrics ──
        baseline = compute_metrics(trades)
        baseline["asset"] = asset
        print_metrics(baseline, f"BASELINE — {STRATEGY_NAME}")

        # ── Losing trade analysis ──
        analysis = analyze_losing_patterns(trades)
        print(f"\n{'─'*60}")
        print("  PATTERN ANALYSIS")
        print(f"{'─'*60}")
        print("\n  By Exit Signal:")
        print(analysis["by_signal"].to_string())
        print("\n  By Hour of Day:")
        print(analysis["by_hour"].to_string())
        print(f"\n  Short trades (<{trades['duration_min'].median()/2:.0f} min):")
        print(f"    Count: {analysis['short_trades_count']}, "
              f"P&L: ${analysis['short_trades_pnl']}, "
              f"Win Rate: {analysis['short_trades_win_rate']}%")
        print(f"\n  Trades after 3+ consecutive losses:")
        print(f"    Count: {analysis['after_3_loss_streak_count']}, "
              f"P&L: ${analysis['after_3_loss_streak_pnl']}, "
              f"Win Rate: {analysis['after_3_loss_streak_win_rate']}%")
        print(f"\n  Trades that gave back profits (>0.3% fav excursion, lost):")
        print(f"    Count: {analysis['gave_back_count']}, "
              f"P&L: ${analysis['gave_back_pnl']}, "
              f"Avg fav excursion: {analysis['gave_back_avg_fav_excursion']}%")
        print(f"\n  Worst hours: {analysis['worst_hours']}")
        print(f"  Best hours : {analysis['best_hours']}")

        # ── Simulate filters ──
        print(f"\n{'─'*60}")
        print("  FILTER SIMULATIONS (removing flagged trades)")
        print(f"{'─'*60}")

        filters = {}

        # Filter 1: Skip very short trades (whipsaw filter)
        median_dur = trades["duration_min"].median()
        filters["skip_short_trades"] = trades["duration_min"] < (median_dur * 0.3)

        # Filter 2: Skip worst hours
        filters["skip_worst_hours"] = trades["entry_hour"].isin(analysis["worst_hours"])

        # Filter 3: Skip stop-loss exits (tighter risk → avoid big losers)
        filters["skip_stop_losses"] = trades["signal"].str.contains("Stop", case=False, na=False)

        # Filter 4: Skip trades after 3+ consecutive losses (cooldown)
        consec_mask = pd.Series(False, index=trades.index)
        consec_losses = 0
        for idx, row in trades.iterrows():
            if consec_losses >= 3:
                consec_mask.at[idx] = True
            if not row["is_winner"]:
                consec_losses += 1
            else:
                consec_losses = 0
        filters["skip_after_3_losses"] = consec_mask

        # Filter 5: Combined best filters
        filters["combined_short+worst_hrs"] = (
            filters["skip_short_trades"] | filters["skip_worst_hours"]
        )

        for name, mask in filters.items():
            result = simulate_filter(trades, mask, name)
            result["asset"] = asset
            print(f"\n  Filter: {name}")
            print(f"    Trades removed: {result.get('trades_removed', 0)}")
            print(f"    Remaining: {result['total_trades']}")
            print(f"    Net Profit: ${result['net_profit_usd']} ({result['net_profit_pct']}%)")
            print(f"    Max DD: ${result['max_drawdown_usd']} ({result['max_drawdown_pct']}%)")
            print(f"    Win Rate: {result['win_rate_pct']}%")
            print(f"    Profit Factor: {result['profit_factor']}")
            print(f"    Sharpe: {result['sharpe_ratio']}")

        all_results.append({
            "asset": asset,
            "baseline": baseline,
            "analysis": analysis,
            "filters": {name: simulate_filter(trades, mask, name) for name, mask in filters.items()},
        })

    return all_results


if __name__ == "__main__":
    results = main()
    print("\n\nDone. Results computed for", len(results), "asset(s).")
