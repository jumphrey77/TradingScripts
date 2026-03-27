#!/usr/bin/env python3
"""
Validate Backtest Results Against TradingView XLSX Export
==========================================================
Compares our Python backtest metrics (from supertrend_v2.pine trade CSV)
against the official TradingView strategy tester XLSX export.

Focus: Net Profit (without open trades) and Max Drawdown.

Usage:
  1. Export the strategy tester results from TradingView as XLSX
  2. Place the XLSX file in the testdata/ folder named supertrend_v2.xlsx
     (or pass the path as a command-line argument)
  3. Run: python3 validate_against_xlsx.py [path/to/supertrend_v2.xlsx]
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from backtest_supertrend import load_trades, compute_metrics, INITIAL_CAPITAL

DATA_DIR = Path(__file__).resolve().parent / "testdata"
DEFAULT_XLSX = DATA_DIR / "supertrend_v2.xlsx"


def extract_tv_metrics(xlsx_path: Path) -> dict:
    """Extract Net Profit and Max Drawdown from TradingView's XLSX export.

    TradingView XLSX typically has sheets like:
      - 'Performance Summary' with key metrics
      - 'Trade List' with individual trades

    This function tries multiple common formats.
    """
    xls = pd.ExcelFile(xlsx_path)
    sheet_names = xls.sheet_names
    print(f"  XLSX sheets: {sheet_names}")

    tv_metrics = {}

    # Try to find performance summary
    for sn in sheet_names:
        df = pd.read_excel(xlsx_path, sheet_name=sn, header=None)

        # Look for "Net Profit" row
        for i, row in df.iterrows():
            for j, val in enumerate(row):
                if isinstance(val, str):
                    val_lower = val.strip().lower()
                    if "net profit" in val_lower and "open" not in val_lower:
                        # Next cell(s) should have the value
                        for k in range(j + 1, min(j + 4, len(row))):
                            cell = row.iloc[k]
                            if isinstance(cell, (int, float)) and not np.isnan(cell):
                                tv_metrics["tv_net_profit_usd"] = cell
                                break
                    if "max" in val_lower and "drawdown" in val_lower:
                        for k in range(j + 1, min(j + 4, len(row))):
                            cell = row.iloc[k]
                            if isinstance(cell, (int, float)) and not np.isnan(cell):
                                tv_metrics["tv_max_drawdown_usd"] = cell
                                break

    # Try trade list to compute from trades directly
    for sn in sheet_names:
        df = pd.read_excel(xlsx_path, sheet_name=sn)
        cols_lower = [str(c).lower().strip() for c in df.columns]

        # Check if this looks like a trade list
        if any("trade" in c or "type" in c for c in cols_lower):
            print(f"  Found trade-like sheet: '{sn}' with {len(df)} rows")

            # Try to find P&L column
            pnl_col = None
            for c in df.columns:
                cl = str(c).lower().strip()
                if "net p&l" in cl or "net profit" in cl or "p&l" in cl:
                    if "%" not in cl and "cumul" not in cl:
                        pnl_col = c
                        break

            if pnl_col:
                # Filter to exit rows only
                type_col = None
                for c in df.columns:
                    if str(c).lower().strip() in ("type", "trade type"):
                        type_col = c
                        break

                if type_col:
                    exits = df[df[type_col].astype(str).str.contains("Exit", case=False, na=False)]
                else:
                    exits = df

                pnl_values = pd.to_numeric(exits[pnl_col], errors="coerce").dropna()
                if len(pnl_values) > 0:
                    tv_metrics["tv_net_profit_from_trades"] = pnl_values.sum()

                    # Compute max drawdown from trade-level equity curve
                    equity = INITIAL_CAPITAL + pnl_values.cumsum()
                    peak = equity.cummax()
                    dd = equity - peak
                    tv_metrics["tv_max_drawdown_from_trades"] = dd.min()

    return tv_metrics


def validate(csv_path: Path, xlsx_path: Path):
    """Compare Python backtest vs TradingView XLSX."""
    print(f"\n{'='*70}")
    print(f"  VALIDATION: Python Backtest vs TradingView XLSX")
    print(f"{'='*70}")
    print(f"  CSV  (our trades): {csv_path.name}")
    print(f"  XLSX (TV export) : {xlsx_path.name}")

    # Our metrics
    trades = load_trades(csv_path)
    our = compute_metrics(trades)

    print(f"\n  ── OUR PYTHON BACKTEST ──")
    print(f"    Net Profit (USD): ${our['net_profit_usd']}")
    print(f"    Net Profit (%):   {our['net_profit_pct']}%")
    print(f"    Max Drawdown ($): ${our['max_drawdown_usd']}")
    print(f"    Max Drawdown (%): {our['max_drawdown_pct']}%")
    print(f"    Total Trades:     {our['total_trades']}")

    # TV metrics
    tv = extract_tv_metrics(xlsx_path)
    if not tv:
        print("\n  WARNING: Could not extract metrics from XLSX.")
        print("  Please check the XLSX format and sheet structure.")
        return

    print(f"\n  ── TRADINGVIEW XLSX ──")
    for k, v in tv.items():
        print(f"    {k}: {v}")

    # Compare
    print(f"\n  ── COMPARISON ──")

    tv_net = tv.get("tv_net_profit_usd") or tv.get("tv_net_profit_from_trades")
    tv_dd  = tv.get("tv_max_drawdown_usd") or tv.get("tv_max_drawdown_from_trades")

    if tv_net is not None:
        diff_net = our["net_profit_usd"] - tv_net
        pct_diff = abs(diff_net / tv_net * 100) if tv_net != 0 else float('inf')
        match = "MATCH" if pct_diff < 1 else ("CLOSE" if pct_diff < 5 else "MISMATCH")
        print(f"    Net Profit: Ours=${our['net_profit_usd']}, TV=${tv_net}, "
              f"Diff=${diff_net:.2f} ({pct_diff:.2f}%) [{match}]")

        if match == "MISMATCH":
            print(f"\n    POSSIBLE REASONS FOR NET PROFIT MISMATCH:")
            print(f"      1. Open trades: TV may include unrealized P&L from open positions")
            print(f"      2. Commission calculation: rounding differences in 0.1% commission")
            print(f"      3. Slippage model: Pine slippage=3 ticks vs our simplified model")
            print(f"      4. Fill price: TV uses OHLC within the bar; CSV only shows signal price")
            print(f"      5. Compounding: equity changes between trades affect position sizing")

    if tv_dd is not None:
        diff_dd = our["max_drawdown_usd"] - tv_dd
        pct_diff = abs(diff_dd / tv_dd * 100) if tv_dd != 0 else float('inf')
        match = "MATCH" if pct_diff < 1 else ("CLOSE" if pct_diff < 5 else "MISMATCH")
        print(f"    Max Drawdown: Ours=${our['max_drawdown_usd']}, TV=${tv_dd}, "
              f"Diff=${diff_dd:.2f} ({pct_diff:.2f}%) [{match}]")

        if match == "MISMATCH":
            print(f"\n    POSSIBLE REASONS FOR MAX DRAWDOWN MISMATCH:")
            print(f"      1. Intra-bar drawdown: TV tracks DD at every tick within a bar,")
            print(f"         while our CSV only has entry/exit prices (misses intra-trade DD)")
            print(f"      2. Equity curve granularity: TV updates equity every bar,")
            print(f"         we only update at trade boundaries")
            print(f"      3. Open trade DD: TV may include unrealized losses in DD calculation")
            print(f"      4. Adverse excursion: TV measures DD from peak equity including")
            print(f"         unrealized gains within trades")

    print(f"\n  ── RECOMMENDATIONS ──")
    print(f"    • Ensure 'fill_orders_on_standard_ohlc=true' in Pine strategy()")
    print(f"    • Use 'calc_on_every_tick=false' to match bar-close execution")
    print(f"    • Export trade list WITH 'Include open trades: No' setting")
    print(f"    • Compare trade count first — if counts differ, a filter is missing")


def main():
    xlsx_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX
    if not xlsx_path.exists():
        print(f"XLSX file not found: {xlsx_path}")
        print(f"\nTo use this validator:")
        print(f"  1. Run supertrend_v2.pine on TradingView")
        print(f"  2. Export the trade list as XLSX")
        print(f"  3. Save it as: {DEFAULT_XLSX}")
        print(f"  4. Run: python3 {__file__} [{xlsx_path}]")

        # Still show our computed metrics for reference
        csv_files = sorted(DATA_DIR.glob("*.csv"))
        if csv_files:
            print(f"\n  ── OUR METRICS (from CSV) ──")
            for csv_path in csv_files:
                trades = load_trades(csv_path)
                m = compute_metrics(trades)
                print(f"\n  {csv_path.name}:")
                print(f"    Net Profit: ${m['net_profit_usd']} ({m['net_profit_pct']}%)")
                print(f"    Max DD:     ${m['max_drawdown_usd']} ({m['max_drawdown_pct']}%)")
                print(f"    Trades:     {m['total_trades']}")
        return

    # Find matching CSV
    csv_files = sorted(DATA_DIR.glob("*.csv"))
    for csv_path in csv_files:
        validate(csv_path, xlsx_path)


if __name__ == "__main__":
    main()
