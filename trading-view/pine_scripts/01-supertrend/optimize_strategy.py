#!/usr/bin/env python3
"""
Deep Trade Analysis & Strategy Optimizer
==========================================
Analyzes v3_strict trades in detail and tests targeted improvements.
"""

import sys, math
from pathlib import Path
from dataclasses import dataclass

import numpy as np
import pandas as pd

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR   = SCRIPT_DIR / "testdata"

sys.path.insert(0, str(SCRIPT_DIR))
from backtest_ohlcv import (
    calc_atr, calc_supertrend, calc_rsi, calc_adx, calc_ema, calc_sma,
    StrategyConfig, Trade, run_backtest, compute_metrics, compute_score,
    split_data, STRATEGIES,
)


def analyze_v3_trades(ohlcv_path: Path, cfg: StrategyConfig):
    """Deep analysis of v3 trade characteristics."""
    df = pd.read_csv(ohlcv_path)
    df["datetime"] = pd.to_datetime(df["datetime"], errors="coerce", utc=True)
    df = df.dropna(subset=["datetime"]).reset_index(drop=True)

    trades, eq = run_backtest(df, cfg)
    if not trades:
        return

    asset = ohlcv_path.stem.replace("_5m_ohlcv", "")
    print(f"\n{'='*70}")
    print(f"  DEEP ANALYSIS: {asset} — {cfg.name}")
    print(f"{'='*70}")
    print(f"  Total trades: {len(trades)}")

    # Classify trades
    winners = [t for t in trades if t.pnl > 0]
    losers = [t for t in trades if t.pnl <= 0]
    print(f"  Winners: {len(winners)}, Losers: {len(losers)}")

    # By exit signal
    by_signal = {}
    for t in trades:
        sig = t.exit_signal
        if sig not in by_signal:
            by_signal[sig] = {"count": 0, "pnl": 0, "wins": 0}
        by_signal[sig]["count"] += 1
        by_signal[sig]["pnl"] += t.pnl
        if t.pnl > 0:
            by_signal[sig]["wins"] += 1

    print(f"\n  By Exit Signal:")
    for sig, info in sorted(by_signal.items(), key=lambda x: x[1]["pnl"]):
        wr = info["wins"] / info["count"] * 100
        print(f"    {sig:15s}: {info['count']:4d} trades, "
              f"P&L: ${info['pnl']:8.2f}, Win Rate: {wr:.1f}%")

    # Favorable excursion analysis (MFE/MAE)
    if winners:
        avg_mfe_win = np.mean([t.max_fav for t in winners])
        avg_mae_win = np.mean([t.max_adv for t in winners])
        avg_exit_win = np.mean([t.pnl_pct for t in winners])
        print(f"\n  Winners:")
        print(f"    Avg MFE (max favorable): {avg_mfe_win:.2f}%")
        print(f"    Avg MAE (max adverse):   {avg_mae_win:.2f}%")
        print(f"    Avg exit P&L:            {avg_exit_win:.2f}%")
        print(f"    Avg gave back:           {avg_mfe_win - avg_exit_win:.2f}%")

    if losers:
        avg_mfe_lose = np.mean([t.max_fav for t in losers])
        avg_mae_lose = np.mean([t.max_adv for t in losers])
        avg_exit_lose = np.mean([t.pnl_pct for t in losers])
        print(f"\n  Losers:")
        print(f"    Avg MFE (was winning by): {avg_mfe_lose:.2f}%")
        print(f"    Avg MAE (max adverse):    {avg_mae_lose:.2f}%")
        print(f"    Avg exit P&L:             {avg_exit_lose:.2f}%")

        # Losers that were once positive
        was_positive = [t for t in losers if t.max_fav > 0.3]
        if was_positive:
            print(f"    Losers that were >0.3% positive: {len(was_positive)} "
                  f"(${sum(t.pnl for t in was_positive):.2f})")

    # Duration analysis
    durations_w = [(pd.Timestamp(t.exit_time) - pd.Timestamp(t.entry_time)).total_seconds() / 3600
                   for t in winners if t.exit_time is not None]
    durations_l = [(pd.Timestamp(t.exit_time) - pd.Timestamp(t.entry_time)).total_seconds() / 3600
                   for t in losers if t.exit_time is not None]
    if durations_w:
        print(f"\n  Duration (hours):")
        print(f"    Winners avg: {np.mean(durations_w):.1f}h, median: {np.median(durations_w):.1f}h")
    if durations_l:
        print(f"    Losers avg:  {np.mean(durations_l):.1f}h, median: {np.median(durations_l):.1f}h")

    # ADX at entry analysis
    c = df["close"].values
    h = df["high"].values
    l = df["low"].values
    atr = calc_atr(h, l, c, cfg.atr_period)
    adx = calc_adx(h, l, c, cfg.adx_length)
    rsi_arr = calc_rsi(c, cfg.rsi_length)
    ema50 = calc_ema(c, 50)
    ema100 = calc_ema(c, 100)
    ema200 = calc_ema(c, 200)

    # ATR as % of price (volatility regime)
    atr_pct = atr / c * 100

    print(f"\n  Indicator values at entry:")
    adx_entries_w = [adx[t.entry_bar] for t in winners if not np.isnan(adx[t.entry_bar])]
    adx_entries_l = [adx[t.entry_bar] for t in losers if not np.isnan(adx[t.entry_bar])]
    if adx_entries_w:
        print(f"    ADX (winners):  avg={np.mean(adx_entries_w):.1f}, median={np.median(adx_entries_w):.1f}")
    if adx_entries_l:
        print(f"    ADX (losers):   avg={np.mean(adx_entries_l):.1f}, median={np.median(adx_entries_l):.1f}")

    rsi_entries_w = [rsi_arr[t.entry_bar] for t in winners if not np.isnan(rsi_arr[t.entry_bar])]
    rsi_entries_l = [rsi_arr[t.entry_bar] for t in losers if not np.isnan(rsi_arr[t.entry_bar])]
    if rsi_entries_w:
        print(f"    RSI (winners):  avg={np.mean(rsi_entries_w):.1f}, median={np.median(rsi_entries_w):.1f}")
    if rsi_entries_l:
        print(f"    RSI (losers):   avg={np.mean(rsi_entries_l):.1f}, median={np.median(rsi_entries_l):.1f}")

    atr_pct_w = [atr_pct[t.entry_bar] for t in winners if not np.isnan(atr_pct[t.entry_bar])]
    atr_pct_l = [atr_pct[t.entry_bar] for t in losers if not np.isnan(atr_pct[t.entry_bar])]
    if atr_pct_w:
        print(f"    ATR% (winners): avg={np.mean(atr_pct_w):.3f}%, median={np.median(atr_pct_w):.3f}%")
    if atr_pct_l:
        print(f"    ATR% (losers):  avg={np.mean(atr_pct_l):.3f}%, median={np.median(atr_pct_l):.3f}%")

    # EMA slope analysis - are winners more often in strong uptrends?
    ema100_slope = np.diff(ema100, prepend=ema100[0]) / c * 10000  # basis points per bar
    slope_w = [ema100_slope[t.entry_bar] for t in winners if not np.isnan(ema100_slope[t.entry_bar])]
    slope_l = [ema100_slope[t.entry_bar] for t in losers if not np.isnan(ema100_slope[t.entry_bar])]
    if slope_w:
        print(f"    EMA100 slope (winners): avg={np.mean(slope_w):.2f} bps/bar")
    if slope_l:
        print(f"    EMA100 slope (losers):  avg={np.mean(slope_l):.2f} bps/bar")

    # Distance from EMA200
    dist_200_w = [(c[t.entry_bar] - ema200[t.entry_bar]) / ema200[t.entry_bar] * 100
                  for t in winners if not np.isnan(ema200[t.entry_bar])]
    dist_200_l = [(c[t.entry_bar] - ema200[t.entry_bar]) / ema200[t.entry_bar] * 100
                  for t in losers if not np.isnan(ema200[t.entry_bar])]
    if dist_200_w:
        print(f"    Dist from EMA200 (winners): avg={np.mean(dist_200_w):.2f}%")
    if dist_200_l:
        print(f"    Dist from EMA200 (losers):  avg={np.mean(dist_200_l):.2f}%")

    return trades


def test_improvements(ohlcv_path: Path):
    """Test targeted strategy improvements."""
    df = pd.read_csv(ohlcv_path)
    df["datetime"] = pd.to_datetime(df["datetime"], errors="coerce", utc=True)
    df = df.dropna(subset=["datetime"]).reset_index(drop=True)
    data_days = (df["datetime"].iloc[-1] - df["datetime"].iloc[0]).total_seconds() / 86400

    asset = ohlcv_path.stem.replace("_5m_ohlcv", "")

    # Define improvement variants
    variants = {
        # Baseline v3
        "v3_strict": STRATEGIES["supertrend_v3_strict"],

        # V6a: Add take-profit at 2x ATR
        "v6a_takeprofit": StrategyConfig(
            name="v6a_takeprofit",
            atr_period=14, factor=5.0,
            use_rsi_exit=True, rsi_overbought=70,
            use_stop=True, sl_atr_mult=3.0, trailing_stop=True,
            use_hard_stop=True, hard_stop_pct=8.0,
            use_adx=True, adx_length=14, adx_threshold=30,
            use_ema=True, ema_length=100,
            use_vol_filter=True, vol_ma_length=20, vol_multiplier=1.0,
            use_cooldown=True, cooldown_bars=12,
            min_hold_bars=6,
        ),

        # V6b: Higher ADX (35), wider trailing (3.5x), EMA 200
        "v6b_ultra_strict": StrategyConfig(
            name="v6b_ultra_strict",
            atr_period=14, factor=5.0,
            use_rsi_exit=True, rsi_overbought=70,
            use_stop=True, sl_atr_mult=3.5, trailing_stop=True,
            use_hard_stop=True, hard_stop_pct=10.0,
            use_adx=True, adx_length=14, adx_threshold=35,
            use_ema=True, ema_length=200,
            use_vol_filter=True, vol_ma_length=20, vol_multiplier=1.0,
            use_cooldown=True, cooldown_bars=18,
            min_hold_bars=12,
        ),

        # V6c: Factor 6, ADX 25, EMA 100, wider stop, no RSI exit (let winners run)
        "v6c_let_run": StrategyConfig(
            name="v6c_let_run",
            atr_period=14, factor=6.0,
            use_rsi_exit=False,
            use_stop=True, sl_atr_mult=3.0, trailing_stop=True,
            use_hard_stop=True, hard_stop_pct=8.0,
            use_adx=True, adx_length=14, adx_threshold=25,
            use_ema=True, ema_length=100,
            use_vol_filter=True, vol_ma_length=20, vol_multiplier=1.0,
            use_cooldown=True, cooldown_bars=12,
            min_hold_bars=12,
        ),

        # V6d: Factor 4, ADX 30, EMA 100, tighter trailing (2.5x), 50% equity
        "v6d_half_size": StrategyConfig(
            name="v6d_half_size",
            atr_period=14, factor=4.0,
            use_rsi_exit=True, rsi_overbought=70,
            use_stop=True, sl_atr_mult=2.5, trailing_stop=True,
            use_hard_stop=True, hard_stop_pct=6.0,
            use_adx=True, adx_length=14, adx_threshold=30,
            use_ema=True, ema_length=100,
            use_vol_filter=True, vol_ma_length=20, vol_multiplier=1.0,
            use_cooldown=True, cooldown_bars=12,
            min_hold_bars=6,
            equity_pct=50.0,
        ),

        # V6e: Factor 5, ADX 30, EMA 50+200 dual (price > both), trailing 3x
        "v6e_dual_ema": StrategyConfig(
            name="v6e_dual_ema",
            atr_period=14, factor=5.0,
            use_rsi_exit=True, rsi_overbought=70,
            use_stop=True, sl_atr_mult=3.0, trailing_stop=True,
            use_hard_stop=True, hard_stop_pct=8.0,
            use_adx=True, adx_length=14, adx_threshold=30,
            use_ema=True, ema_length=100,
            use_vol_filter=True, vol_ma_length=20, vol_multiplier=1.0,
            use_cooldown=True, cooldown_bars=12,
            min_hold_bars=6,
        ),

        # V6f: Factor 5, ADX 25, no EMA filter, wider stop 4x, 24-bar cooldown
        "v6f_wide_stop": StrategyConfig(
            name="v6f_wide_stop",
            atr_period=14, factor=5.0,
            use_rsi_exit=True, rsi_overbought=70,
            use_stop=True, sl_atr_mult=4.0, trailing_stop=True,
            use_hard_stop=True, hard_stop_pct=10.0,
            use_adx=True, adx_length=14, adx_threshold=25,
            use_ema=True, ema_length=100,
            use_vol_filter=False,
            use_cooldown=True, cooldown_bars=24,
            min_hold_bars=12,
        ),

        # V6g: SuperTrend factor 7 (very few signals), ADX 20, EMA 100
        "v6g_factor7": StrategyConfig(
            name="v6g_factor7",
            atr_period=14, factor=7.0,
            use_rsi_exit=True, rsi_overbought=70,
            use_stop=True, sl_atr_mult=3.0, trailing_stop=True,
            use_hard_stop=True, hard_stop_pct=8.0,
            use_adx=True, adx_length=14, adx_threshold=20,
            use_ema=True, ema_length=100,
            use_vol_filter=False,
            use_cooldown=True, cooldown_bars=12,
            min_hold_bars=6,
        ),
    }

    results = {}
    for name, cfg in variants.items():
        # Full
        trades, eq = run_backtest(df, cfg)
        m = compute_metrics(trades, eq, cfg, data_days)
        m["asset"] = asset
        m.update(compute_score(m))

        # OOS
        _, test_df = split_data(df, 0.7)
        sub_days = (test_df["datetime"].iloc[-1] - test_df["datetime"].iloc[0]).total_seconds() / 86400
        t_oos, eq_oos = run_backtest(test_df.reset_index(drop=True), cfg)
        m_oos = compute_metrics(t_oos, eq_oos, cfg, sub_days)
        m_oos.update(compute_score(m_oos))

        results[name] = {"full": m, "oos": m_oos}

    return results


def main():
    ohlcv_files = sorted(DATA_DIR.glob("*_5m_ohlcv.csv"))
    v3_cfg = STRATEGIES["supertrend_v3_strict"]

    # Step 1: Deep analysis of v3 trades
    for f in ohlcv_files:
        analyze_v3_trades(f, v3_cfg)

    # Step 2: Test improvements across all assets
    print(f"\n\n{'#'*70}")
    print(f"  IMPROVEMENT TESTING")
    print(f"{'#'*70}")

    all_results = {}
    for f in ohlcv_files:
        asset = f.stem.replace("_5m_ohlcv", "")
        results = test_improvements(f)
        for name, r in results.items():
            if name not in all_results:
                all_results[name] = {"full": [], "oos": []}
            all_results[name]["full"].append(r["full"])
            all_results[name]["oos"].append(r["oos"])

    # Step 3: Rank improvements
    print(f"\n\n{'#'*70}")
    print(f"  IMPROVEMENT RANKINGS (avg across {len(ohlcv_files)} assets)")
    print(f"{'#'*70}")

    ranking = []
    for name, data in all_results.items():
        full_metrics = data["full"]
        oos_metrics = data["oos"]
        avg_pnl = np.mean([m["net_profit_pct"] for m in full_metrics])
        avg_dd = np.mean([m["max_drawdown_pct"] for m in full_metrics])
        avg_wr = np.mean([m.get("win_rate_pct", 0) for m in full_metrics])
        avg_pf = np.mean([m.get("profit_factor", 0) for m in full_metrics])
        avg_score = np.mean([m["composite_score"] for m in full_metrics])
        avg_trades = np.mean([m["total_trades"] for m in full_metrics])

        oos_pnl = np.mean([m["net_profit_pct"] for m in oos_metrics])
        oos_dd = np.mean([m["max_drawdown_pct"] for m in oos_metrics])
        oos_score = np.mean([m["composite_score"] for m in oos_metrics])

        ranking.append({
            "strategy": name,
            "full_pnl": avg_pnl, "full_dd": avg_dd, "full_wr": avg_wr,
            "full_pf": avg_pf, "full_score": avg_score, "avg_trades": avg_trades,
            "oos_pnl": oos_pnl, "oos_dd": oos_dd, "oos_score": oos_score,
        })

    ranking.sort(key=lambda x: x["oos_score"], reverse=True)

    print(f"\n  {'Strategy':<25s} {'Full P&L':>9s} {'Full DD':>9s} {'WR':>7s} "
          f"{'PF':>6s} {'Trades':>7s} {'OOS P&L':>9s} {'OOS DD':>9s} {'OOS Score':>10s}")
    print(f"  {'─'*95}")
    for r in ranking:
        print(f"  {r['strategy']:<25s} {r['full_pnl']:>8.2f}% {r['full_dd']:>8.2f}% "
              f"{r['full_wr']:>6.1f}% {r['full_pf']:>5.3f} {r['avg_trades']:>6.0f} "
              f"{r['oos_pnl']:>8.2f}% {r['oos_dd']:>8.2f}% {r['oos_score']:>9.2f}")

    print(f"\n  BEST BY OOS SCORE: {ranking[0]['strategy']}")
    best_oos_pnl = max(ranking, key=lambda x: x["oos_pnl"])
    print(f"  BEST BY OOS P&L:   {best_oos_pnl['strategy']} ({best_oos_pnl['oos_pnl']:.2f}%)")


if __name__ == "__main__":
    main()
