#!/usr/bin/env python3
"""
Replay scanner signal logs against Yahoo intraday history (cached) and compute outcomes.

Usage examples:
  python replay_signals.py --log signals_log.csv --out outdir
  python replay_signals.py --log signals_log.csv --out outdir --interval 1m
  python replay_signals.py --log signals_log.csv --out outdir --entry-fill mid --entry-mode market
"""

from __future__ import annotations

import argparse
import os
import sys
import re
import math
import json
import hashlib
from dataclasses import dataclass
from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo
from typing import Dict, Any, Optional, Tuple, List

import pandas as pd

# yfinance is what you're already using
import yfinance as yf

NY = ZoneInfo("America/New_York")
_ET = re.compile(r"\s+ET\s*$", re.IGNORECASE)

# -------------------------
# Helpers
# -------------------------
def time_of_day_bucket(ts) -> str:
    if ts is None or pd.isna(ts):
        return "NA"
    try:
        h = ts.hour
        m = ts.minute
        minutes = h * 60 + m
        if minutes < 570:   return "pre-930"   # before 9:30
        if minutes < 600:   return "930-1000"
        if minutes < 660:   return "1000-1100"
        if minutes < 720:   return "1100-1200"
        if minutes < 780:   return "1200-1300"
        if minutes < 840:   return "1300-1400"
        if minutes < 900:   return "1400-1500"
        return "1500-close"
    except Exception:
        return "NA"

def normalize_yf_intraday(df: pd.DataFrame, symbol: str) -> pd.DataFrame:
    if df is None or df.empty:
        return df

    # Step 1: Collapse MultiIndex FIRST, before any column name operations
    if isinstance(df.columns, pd.MultiIndex):
        levels = [df.columns.get_level_values(i).tolist() for i in range(df.columns.nlevels)]
        
        if symbol in levels[0]:
            # symbol is level 0: ('ATOM', 'Open'), ('ATOM', 'High')...
            df = df.xs(symbol, axis=1, level=0, drop_level=True)
        elif symbol in levels[1]:
            # symbol is level 1: ('Open', 'ATOM'), ('High', 'ATOM')...
            df = df.xs(symbol, axis=1, level=1, drop_level=True)
        else:
            # last resort: just take the last level as field names
            df.columns = [c[-1] for c in df.columns]

    # Step 2: Now it's safe to normalize column names
    df.columns = [str(c).strip().title() for c in df.columns]

    # Step 3: Remove duplicate columns
    if df.columns.duplicated().any():
        df = df.loc[:, ~df.columns.duplicated()].copy()

    # Step 4: Validate required columns exist
    required = {"Open", "High", "Low", "Close"}
    if not required.issubset(set(df.columns)):
        return None

    return df

def parse_ymd(s: str) -> date:
    return datetime.strptime(s, "%Y-%m-%d").date()

def in_range(d: date, start: date, end: date) -> bool:
    return start <= d <= end

def ensure_dir(p: str) -> None:
    os.makedirs(p, exist_ok=True)

def safe_float(x) -> Optional[float]:
    try:
        if x is None:
            return None
        if isinstance(x, (int, float)) and math.isfinite(x):
            return float(x)
        s = str(x).strip()
        if s == "" or s.lower() in {"nan", "none", "null"}:
            return None
        return float(s)
    except Exception:
        return None

def parse_scan_ts(x):
    """
    Accepts:
      '2026-02-17 22:27:47 ET'
      '2026-02-17 22:27:47'
      '2026-02-17T22:27:47-05:00'
      pandas Timestamp
    Returns tz-aware NY pandas Timestamp or pd.NaT.
    """

    if x is None or x == "":
        return pd.NaT

    # If already parsed earlier
    if isinstance(x, pd.Timestamp):
        if x.tzinfo is None:
            return x.tz_localize(NY)
        return x.tz_convert(NY)

    s = str(x).strip()
    if not s:
        return pd.NaT

    # Drop trailing " ET"
    s = _ET.sub("", s)

    # Let pandas parse first
    dt = pd.to_datetime(s, errors="coerce")
    if pd.isna(dt):
        return pd.NaT

    # Ensure NY tz
    if dt.tzinfo is None:
        return dt.tz_localize(NY)

    return dt.tz_convert(NY)

def dt_to_datestr(d: date) -> str:
    return d.strftime("%Y-%m-%d")

def cache_key(symbol: str, d: date, interval: str, auto_adjust: bool = False, prepost: bool = False) -> str:
    adj = "adj" if auto_adjust else "raw"
    pp = "prepost" if prepost else "rth"
    return f"{symbol}_{dt_to_datestr(d)}_{interval}_{adj}_{pp}"

def choose_entry_price(rec: Dict[str, Any], mode: str, fill: str) -> Optional[float]:
    """
    mode:
      - market: enter at bar open at/after signal time
      - limit/stop: you can still compute entry price based on EntryLow/EntryHigh with fill
    fill: low/mid/high
    """
    low = safe_float(rec.get("EntryLow"))
    high = safe_float(rec.get("EntryHigh"))

    if fill == "low":
        return low
    if fill == "high":
        return high
    # mid default
    if low is None and high is None:
        return None
    if low is None:
        return high
    if high is None:
        return low
    return (low + high) / 2.0


def load_intraday_yahoo(symbol: str, d: date, interval: str) -> pd.DataFrame:
    """
    Pull intraday bars for a date. We request a slightly wider range so Yahoo includes the day.
    yfinance returns timezone-aware index often; we normalize to NY if possible.
    """
    # Pull day range with buffer
    start = datetime(d.year, d.month, d.day) - timedelta(days=1)
    end = datetime(d.year, d.month, d.day) + timedelta(days=2)

    df = yf.download(
        tickers=symbol,
        start=start.strftime("%Y-%m-%d"),
        end=end.strftime("%Y-%m-%d"),
        interval=interval,
        progress=False,
        auto_adjust=False,
        prepost=False,
        group_by="column",
        threads=True,
    )

    #handles MultiIndex, title-cases columns
    df = normalize_yf_intraday(df, symbol)

    if df is None or df.empty:
        return None


#    print(symbol, type(df.columns), df.columns[:10])

    # yfinance sometimes returns multiindex columns, sometimes single.
 #   if isinstance(df.columns, pd.MultiIndex):
 #       # if symbol level exists, collapse it
 #       if symbol in df.columns.get_level_values(0):
 #           df = df[symbol].copy()
 #       else:
 #           df.columns = [c[-1] for c in df.columns]

    if df.empty:
        return df

    # Normalize index timezone to NY if possible
    if hasattr(df.index, "tz") and df.index.tz is not None:
        try:
            df.index = df.index.tz_convert(NY)
        except Exception:
            pass
    else:
        # naive index -> assume NY
        if ZoneInfo is not None:
            df.index = df.index.tz_localize(NY, nonexistent="shift_forward", ambiguous="NaT")

    # Keep only that day (NY date)
    df = df[df.index.date == d].copy()
    return df

def find_bar_at_or_after(df: pd.DataFrame, t: datetime) -> Optional[pd.Timestamp]:
    if df is None or df.empty:
        return None
    # Ensure comparable timezones
    if isinstance(df.index, pd.DatetimeIndex) and df.index.tz is not None and t.tzinfo is not None:
        try:
            t = t.astimezone(df.index.tz)
        except Exception:
            pass
    pos = df.index.searchsorted(pd.Timestamp(t))
    if pos >= len(df.index):
        return None
    return df.index[pos]

def simulate_one(rec: Dict[str, Any], df: pd.DataFrame, signal_ts: datetime,
                 entry_mode: str, entry_fill: str,
                 pct_levels: List[float]) -> Dict[str, Any]:
    """
    Returns dict similar to your simulator payload (simplified).
    """
    out: Dict[str, Any] = {}
    symbol = str(rec.get("Ticker") or "").strip().upper()
    score = safe_float(rec.get("Score"))

    if not symbol:
        return {"status": "ERROR", "reason": "Missing Ticker", "rec": rec}

    if df is None or df.empty:
        return {"status": "NO_DATA", "symbol": symbol, "reason": "No intraday data"}

    # Choose bar time to start simulation from
    bar_ts = find_bar_at_or_after(df, signal_ts)
    if bar_ts is None:
        return {"status": "NO_DATA", "symbol": symbol, "reason": "No bars at/after signal time"}

    # Entry
    entry_price = None
    entry_time = None

    if entry_mode == "market":
        # enter at Open of bar_ts
        entry_price = safe_float(df.loc[bar_ts].get("Open"))
        entry_time = bar_ts
    else:
        # use recommended entry price (low/mid/high)
        entry_price = choose_entry_price(rec, entry_mode, entry_fill)
        entry_time = bar_ts  # "attempt time"
        if entry_price is None:
            return {"status": "ERROR", "symbol": symbol, "reason": "No EntryLow/EntryHigh"}

        # Determine if it would fill: if bar's Low <= limit <= High
        lo = safe_float(df.loc[bar_ts].get("Low"))
        hi = safe_float(df.loc[bar_ts].get("High"))
        if lo is None or hi is None:
            return {"status": "ERROR", "symbol": symbol, "reason": "Bad bar data"}
        if not (lo <= entry_price <= hi):
            # not filled on first bar; you can optionally scan forward for fill
            # We'll scan forward until filled or end of day
            filled = False
            for ts in df.loc[bar_ts:].index:
                lo = safe_float(df.loc[ts].get("Low"))
                hi = safe_float(df.loc[ts].get("High"))
                if lo is None or hi is None:
                    continue
                if lo <= entry_price <= hi:
                    entry_time = ts
                    filled = True
                    break
            if not filled:
                return {
                    "status": "OK",
                    "symbol": symbol,
                    "score": score,
                    "entry": {"mode": entry_mode, 
                              "fill_mode": entry_fill, 
                              "price": round(entry, 2) if entry is not None else None, 
                              "time": entry_time.isoformat()},
                    "levels": {},
                    "stats": {"mfe_pct": None, "mae_pct": None},
                    "outcome": {"result": "NO_FILL"},
                    "timing": {}
                }

    # Now simulate from entry_time to end of day
    after = df.loc[entry_time:]
    if after.empty:
        return {"status": "NO_DATA", "symbol": symbol, "reason": "No data after entry"}

    stop = safe_float(rec.get("Stop"))
    t1 = safe_float(rec.get("Target1"))
    t2 = safe_float(rec.get("Target2"))

    entry = safe_float(entry_price)
    high_max = after["High"].max()
    low_min = after["Low"].min()

    mfe_pct = abs((float(high_max) - entry)) / entry if entry > 0 else None
    mae_pct = abs((float(low_min) - entry)) / entry if entry > 0 else None

    # Price at signal time (first bar open after signal)
    signal_bar_open = safe_float(df.loc[bar_ts].get("Open")) if bar_ts is not None else None

    entry_distance_pct = round(abs((entry - signal_bar_open) / signal_bar_open), 4) if entry and signal_bar_open else None
    t1_distance_pct = round((t1 - entry) / entry, 4) if t1 and entry else None
    t2_distance_pct = round((t2 - entry) / entry, 4) if t2 and entry else None
    stop_distance_pct = round(abs((stop - entry) / entry), 4) if stop and entry else None

    # Find hit times
    levels: Dict[str, Any] = {}

    def first_hit_time(price_level: float, direction: str) -> Optional[pd.Timestamp]:
        if price_level is None:
            return None
        if direction == "up":
            hit = after[after["High"] >= price_level]
        else:
            hit = after[after["Low"] <= price_level]
        if hit.empty:
            return None
        return hit.index[0]

    # pct levels
    for p in pct_levels:
        lvl_price = entry * (1.0 + p)
        tm = first_hit_time(lvl_price, "up")
        levels[f"pct_{int(p*100)}"] = {"hit": tm is not None, "pct": p, "price": lvl_price, "time": tm}

    # targets / stop
    t1_tm = first_hit_time(t1, "up") if t1 is not None else None
    t2_tm = first_hit_time(t2, "up") if t2 is not None else None
    st_tm = first_hit_time(stop, "down") if stop is not None else None

    levels["t1"] = {"hit": t1_tm is not None, "price": t1, "time": t1_tm}
    levels["t2"] = {"hit": t2_tm is not None, "price": t2, "time": t2_tm}
    levels["stop"] = {"hit": st_tm is not None, "price": stop, "time": st_tm}

    # Determine "outcome" (simple rule: best result achieved; you can switch to worst/best policy later)
    outcome = "OPEN_AT_CLOSE"
    outcome_time = None

    # Collect all events that actually hit, with their timestamps
    events = []

    # if stop hit at any time, mark STOP_HIT (you can add conflict policy later)
    if st_tm is not None:
        events.append(("STOP_HIT", st_tm))
  
    for p in sorted(pct_levels):
        key = f"pct_{int(p*100)}"
        if levels[key]["hit"]:
            events.append((f"PCT_{int(p*100)}_HIT", levels[key]["time"]))

    if t1_tm is not None:
        events.append(("T1_HIT", t1_tm))

    if t2_tm is not None:
        events.append(("T2_HIT", t2_tm))

    # Pick whichever event happened first
    if events:
        events.sort(key=lambda x: x[1])  # sort by timestamp
        outcome, outcome_time = events[0]

    timing = {
        "mins_to_entry": int((entry_time - bar_ts).total_seconds() // 60) if entry_time and bar_ts else None,
        "mins_to_t1": int((t1_tm - entry_time).total_seconds() // 60) if t1_tm is not None else None,
        "mins_to_t2": int((t2_tm - entry_time).total_seconds() // 60) if t2_tm is not None else None,
        "mins_to_stop": int((st_tm - entry_time).total_seconds() // 60) if st_tm is not None else None,
    }
    # pct timing
    for p in pct_levels:
        key = f"pct_{int(p*100)}"
        tm = levels[key]["time"]
        timing[f"mins_to_pct_{int(p*100)}"] = int((tm - entry_time).total_seconds() // 60) if tm is not None else None

    return {
        "status": "OK",
        "symbol": symbol,
        "score": score,
        "signal_time": signal_ts.isoformat(),
        "entry": {"mode": entry_mode, "fill_mode": entry_fill, 
                  "price": round(entry, 2) if entry is not None else None,  
                  "time": entry_time.isoformat()},
        "levels": {k: (v if v["time"] is None else {**v, "time": v["time"].isoformat()}) for k, v in levels.items()},
        "stats": {"mfe_pct": round(mfe_pct, 4) if mfe_pct is not None else None, 
            "mae_pct": round(mae_pct, 4) if mae_pct is not None else None},  
        "outcome": {"result": outcome, "time": outcome_time.isoformat() if outcome_time is not None else None},
        "timing": timing,
        "meta": {
            "ScanTimestamp": rec.get("ScanTimestamp"),
            "SignalStartTimestamp": rec.get("SignalStartTimestamp"),
            "Pattern": rec.get("Pattern"),
        },
        "distances": {
            "entry_distance_pct": entry_distance_pct,
            "t1_distance_pct": t1_distance_pct,
            "t2_distance_pct": t2_distance_pct,
            "stop_distance_pct": stop_distance_pct,
        }
    }


# -------------------------
# Main
# -------------------------
_EMPTY = object()  # sentinel at module level

def main():
    ap = argparse.ArgumentParser()

    ap.add_argument("--log", required=True, help="Signals log CSV file (45k rows etc.)")
    ap.add_argument("--out", required=True, help="Output directory")
    ap.add_argument("--interval", default="1m", choices=["1m", "2m", "5m", "15m"], help="Yahoo bar interval")
    ap.add_argument("--cache", default=None, help="Cache directory (defaults to OUT/.cache)")
    ap.add_argument("--entry-mode", default="market", choices=["market", "limit"], help="Entry mode for replay")
    ap.add_argument("--entry-fill", default="mid", choices=["low", "mid", "high"], help="If using limit, which entry price")
    ap.add_argument("--pct-levels", default="0.05,0.10,0.15", help="Comma list of pct levels")
    #ap.add_argument("--dedupe", default="none",
    #                choices=["none", "signal_start", "signal_start_and_ticker"],
    #                help="Collapse repeated scans before replay")
    ap.add_argument("--max-rows", type=int, default=0, help="Limit rows for testing (0 = all)")
    
    ap.add_argument("--start-date", required=True, help="YYYY-MM-DD (inclusive)")
    ap.add_argument("--end-date", required=True, help="YYYY-MM-DD (inclusive)")
    ap.add_argument("--dedupe", 
                    default="none",
                    choices=["none", "signal_start", "signal_start_and_ticker"],
                    help="Optional: collapse repeated refresh scans")

    args = ap.parse_args()

    outdir = args.out
    ensure_dir(outdir)

    cache_dir = args.cache or os.path.join(outdir, ".cache")
    ensure_dir(cache_dir)

    pct_levels = []
    for p in args.pct_levels.split(","):
        p = p.strip()
        if not p:
            continue
        pct_levels.append(float(p))
    pct_levels = sorted(pct_levels)

    # Load log
    df = pd.read_csv(args.log)
    if args.max_rows and args.max_rows > 0:
        df = df.head(args.max_rows).copy()

    # normalize columns we need
    needed = ["Ticker", "ScanTimestamp", "EntryLow", "EntryHigh", "Stop", "Target1", "Target2", "Score"]
    for c in needed:
        if c not in df.columns:
            print(f"ERROR: missing required column: {c}")
            print(f"Columns found: {list(df.columns)}")
            sys.exit(2)

    # normalize
    df["_symbol"] = df["Ticker"].astype(str).str.strip().str.upper()

    # Parse timestamps
    df["_scan_dt"] = df["ScanTimestamp"].apply(parse_scan_ts)
    df["_scan_dt"] = pd.to_datetime(df["_scan_dt"], errors="coerce")
    df = df[df["_scan_dt"].notna()].copy()

    # Day bucket (local NY day)
    df["_date"] = df["_scan_dt"].dt.date

    # Stable ordering for “scan-by-scan” evaluation
    df = df.sort_values(["_date", "_scan_dt", "_symbol"]).copy()

    # --- date range filter (inclusive) ---
    start_d = parse_ymd(args.start_date)
    end_d = parse_ymd(args.end_date)

    df = df[df["_date"].apply(lambda d: in_range(d, start_d, end_d))].copy()

    # --- Optional dedupe ---
    if args.dedupe in (None, "", "none", "off", "false", "0"):
        pass  # keep ALL recommendations (no dedupe)
    elif args.dedupe == "signal_start":
        if "SignalStartTimestamp" not in df.columns:
            print("WARN: --dedupe signal_start requires SignalStartTimestamp; skipping dedupe.")
        else:
            df["_sst"] = df["SignalStartTimestamp"].astype(str).str.strip()
            # NOTE: This dedupes across *all days* (usually too aggressive)
            df = df.drop_duplicates(subset=["_symbol", "_sst"], keep="first").copy()
    elif args.dedupe == "signal_start_and_ticker":
        if "SignalStartTimestamp" not in df.columns:
            print("WARN: --dedupe signal_start_and_ticker requires SignalStartTimestamp; skipping dedupe.")
        else:
            df["_sst"] = df["SignalStartTimestamp"].astype(str).str.strip()
            # This is the recommended one: dedupe per day + symbol + signal lifecycle
            df = df.drop_duplicates(subset=["_date", "_symbol", "_sst"], keep="first").copy()
    else:
        print(f"WARN: unknown dedupe mode {args.dedupe!r}; no dedupe applied.")
        
    # Replay
    results: List[Dict[str, Any]] = []
    failures: List[Dict[str, Any]] = []

    # cache for this run (avoid reading cache file repeatedly)
    mem_cache: Dict[Tuple[str, date], Optional[pd.DataFrame]] = {}

    days = sorted(df["_date"].unique())
    print(f"Loaded rows: {len(df):,}")
    print(f"Unique days: {len(days)}")

    for d in days:
        day_df = df[df["_date"] == d]
        tickers = sorted(day_df["_symbol"].unique())
        print(f"\n{dt_to_datestr(d)}: {len(day_df):,} scans | {len(tickers)} unique tickers")

        # Fetch each ticker once
        for sym in tickers:
            key = (sym, d)
            if key in mem_cache:
                continue

            ck = cache_key(sym, d, args.interval)
            cache_path = os.path.join(cache_dir, f"{ck}.parquet")
            meta_path = os.path.join(cache_dir, f"{ck}.meta.json")

            if os.path.exists(cache_path):
                try:
                    hist = pd.read_parquet(cache_path)
                    hist = normalize_yf_intraday(hist, sym)
                    # restore tz if needed is messy; parquet keeps it generally
                    mem_cache[key] = hist if hist is not None and not hist.empty else _EMPTY
                    continue
                except Exception:
                    pass

            try:
                hist = load_intraday_yahoo(sym, d, args.interval)
                if hist is not None and not hist.empty:
                    mem_cache[key] = hist
                    hist.to_parquet(cache_path)
                    with open(meta_path, "w", encoding="utf-8") as f:
                        json.dump({"symbol": sym, "date": dt_to_datestr(d), "interval": args.interval}, f)
                else:
                    mem_cache[key] = _EMPTY  # ← fetch succeeded but no data
            except Exception as e:
                mem_cache[key] = _EMPTY      # ← fetch failed entirely
                failures.append({"date": dt_to_datestr(d), "symbol": sym, "error": str(e)})

        # Now replay each scan row
        for _, row in day_df.iterrows():
            rec = row.to_dict()
            sym = rec["_symbol"]
            hist = mem_cache.get((sym, d))
            if hist is _EMPTY:
                hist = None
            signal_dt: datetime = rec["_scan_dt"]

            r = simulate_one(
                rec=rec,
                df=hist,
                signal_ts=signal_dt,
                entry_mode=args.entry_mode,
                entry_fill=args.entry_fill,
                pct_levels=pct_levels
            )
            results.append(r)

    # Flatten results to a table
    flat_rows = []
    for r in results:
        base = {
            "status": r.get("status"),
            "symbol": r.get("symbol"),
            "score": r.get("score"),
            "signal_time": r.get("signal_time"),
            "ScanTimestamp": (r.get("meta") or {}).get("ScanTimestamp"),
            "SignalStartTimestamp": (r.get("meta") or {}).get("SignalStartTimestamp"),
            "Pattern": (r.get("meta") or {}).get("Pattern"),
            "outcome": (r.get("outcome") or {}).get("result"),
            "mfe_pct": (r.get("stats") or {}).get("mfe_pct"),
            "mae_pct": (r.get("stats") or {}).get("mae_pct"),
            "entry_price": (r.get("entry") or {}).get("price"),
            "entry_time": (r.get("entry") or {}).get("time"),
            "time_of_day": time_of_day_bucket(r.get("_scan_dt") or pd.Timestamp(r.get("signal_time")) if r.get("signal_time") else None),
        }
        # levels
        lv = r.get("levels") or {}
        for k, v in lv.items():
            base[f"{k}_hit"] = bool(v.get("hit"))
            base[f"{k}_time"] = v.get("time")
        # timing
        tm = r.get("timing") or {}
        for k, v in tm.items():
            base[k] = v
        #distances
        dist = r.get("distances") or {}
        base["entry_distance_pct"] = dist.get("entry_distance_pct")
        base["t1_distance_pct"] = dist.get("t1_distance_pct")
        base["t2_distance_pct"] = dist.get("t2_distance_pct")
        base["stop_distance_pct"] = dist.get("stop_distance_pct")
        
        flat_rows.append(base)

    out_results = os.path.join(outdir, "results.csv")
    out_fail = os.path.join(outdir, "yahoo_failures.csv")

    resdf = pd.DataFrame(flat_rows)
    resdf = resdf[resdf["status"] == "OK"].copy()  # ← add this
    resdf.to_csv(out_results, index=False)
    if failures:
        pd.DataFrame(failures).to_csv(out_fail, index=False)

    # Winners: hit any pct level, T1 or T2
    winner_outcomes = {"T1_HIT", "T2_HIT"} | {f"PCT_{int(p*100)}_HIT" for p in pct_levels}
    winners = resdf[resdf["outcome"].isin(winner_outcomes)].copy()
    winners.to_csv(os.path.join(outdir, "winners.csv"), index=False)

    # Losers: stopped out, or never hit any goal
    loser_outcomes = {"STOP_HIT", "OPEN_AT_CLOSE", "NO_FILL"}
    losers = resdf[resdf["outcome"].isin(loser_outcomes)].copy()
    losers.to_csv(os.path.join(outdir, "losers.csv"), index=False)

    print(f"Winners: {len(winners):,} | Losers: {len(losers):,}")

    # Summaries
    okdf = resdf[resdf["status"] == "OK"].copy()

    # Score buckets
    def bucket(s):
        try:
            if pd.isna(s):
                return "NA"
            s = float(s)
            lo = int(s // 100) * 100
            hi = lo + 99
            return f"{lo}-{hi}"
        except Exception:
            return "NA"

    okdf["score_bucket"] = okdf["score"].apply(bucket)

    # pct hits (use highest configured pct as "winner" proxy)
    best_pct = max(int(p*100) for p in pct_levels) if pct_levels else 5
    pct_col = f"pct_{best_pct}_hit"

    # If that column not present (should be), fallback to any pct_ hit
    if pct_col not in okdf.columns:
        pct_cols = [c for c in okdf.columns if c.startswith("pct_") and c.endswith("_hit")]
        pct_col = pct_cols[0] if pct_cols else None

    def summary_group(g: pd.DataFrame) -> pd.Series:
        return pd.Series({
            "count": len(g),
            "pct_hit_rate": float(g[pct_col].mean()) if pct_col else float("nan"),
            "stop_hit_rate": float(g["stop_hit"].mean()) if "stop_hit" in g.columns else float("nan"),
            "avg_mfe_pct": float(g["mfe_pct"].mean()) if "mfe_pct" in g.columns else float("nan"),
            "avg_mae_pct": float(g["mae_pct"].mean()) if "mae_pct" in g.columns else float("nan"),
            "median_mfe_pct": float(g["mfe_pct"].median()) if "mfe_pct" in g.columns else float("nan"),
            "median_mae_pct": float(g["mae_pct"].median()) if "mae_pct" in g.columns else float("nan"),
        })

    by_bucket = okdf.groupby("score_bucket", dropna=False).apply(summary_group).reset_index()
    by_bucket = by_bucket.round(4)
    by_bucket.to_csv(os.path.join(outdir, "summary_by_score_bucket.csv"), index=False)

    by_ticker = okdf.groupby("symbol", dropna=False).apply(summary_group).reset_index()
    by_ticker = by_ticker.round(4)
    by_ticker.to_csv(os.path.join(outdir, "summary_by_ticker.csv"), index=False)

    by_tod = okdf.groupby("time_of_day", dropna=False).apply(summary_group).reset_index()
    by_tod = by_tod.round(4)
    by_tod.to_csv(os.path.join(outdir, "summary_by_time_of_day.csv"), index=False)

    if "Pattern" in okdf.columns:
        by_pattern = okdf.groupby("Pattern", dropna=False).apply(summary_group).reset_index()
        by_pattern = by_pattern.round(4)
        by_pattern.to_csv(os.path.join(outdir, "summary_by_pattern.csv"), index=False)
    
    # Print headline summary
    total = len(resdf)
    ok = int((resdf["status"] == "OK").sum())
    no_data = int((resdf["status"] == "NO_DATA").sum())
    err = int((resdf["status"] == "ERROR").sum())

    print("\nDONE")
    print(f"Total scans replayed: {total:,}")
    print(f"OK: {ok:,} | NO_DATA: {no_data:,} | ERROR: {err:,}")
    print(f"Wrote: {out_results}")
    if failures:
        print(f"Wrote: {out_fail}")
    print("Wrote Summaries in:", outdir)
    print("Wrote Winners in:", outdir)


if __name__ == "__main__":
    main()
