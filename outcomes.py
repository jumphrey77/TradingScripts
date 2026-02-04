# outcomes.py
# - Caching (per-ticker 1m bars with TTL)
# - Fixed clean_hits (booleans + FirstHit + timestamps)
# - Timezone-aware ET handling (America/New_York)
#
# Notes:
# - yfinance 1m data is limited to a recent window and can be throttled.
# - This module caches bars to reduce repeated downloads.
# - Uses conservative tie-breaking: if stop and target hit in same bar -> stop first.

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from typing import Dict, Optional, Tuple, Any, List

import pandas as pd
import yfinance as yf

# ----------------------------
# TIMEZONE
# ----------------------------
ET = ZoneInfo("America/New_York")
UTC = ZoneInfo("UTC")

def _et_now() -> datetime:
    return datetime.now(ET)

def _et_now_str() -> str:
    return _et_now().strftime("%Y-%m-%d %H:%M:%S ET")

def _parse_et(ts_str: str) -> datetime:
    """
    Your timestamps look like: "2026-01-26 15:12:53 ET"
    Returns timezone-aware datetime in America/New_York.
    """
    dt = datetime.strptime(ts_str.replace(" ET", ""), "%Y-%m-%d %H:%M:%S")
    return dt.replace(tzinfo=ET)

def _fmt_et(dt: Optional[datetime]) -> Optional[str]:
    """
    Format a datetime as ET string. Handles tz-aware/naive.
    Assumes naive datetimes are UTC (common from some feeds).
    """
    if dt is None:
        return None
    ts = pd.Timestamp(dt)
    if ts.tzinfo is None:
        ts = ts.tz_localize("UTC")
    ts_et = ts.tz_convert("America/New_York")
    return ts_et.strftime("%Y-%m-%d %H:%M:%S ET")

# ----------------------------
# STORAGE
# ----------------------------
OUTCOME_DIR = "./history/outcomes"
os.makedirs(OUTCOME_DIR, exist_ok=True)
OUTCOME_PATH = os.path.join(OUTCOME_DIR, "outcomes_log.csv")

# ----------------------------
# BARS CACHE
# ----------------------------
@dataclass
class BarsCacheEntry:
    fetched_at_epoch: float
    df: pd.DataFrame  # columns: Datetime(UTC tz-aware), High, Low, Close, Volume

# ticker -> cache entry
_BARS_CACHE: Dict[str, BarsCacheEntry] = {}

# Cache TTL in seconds: keep short to avoid stale bars but reduce rate limits
BARS_CACHE_TTL_SECONDS = 60

def _cache_get(ticker: str) -> Optional[pd.DataFrame]:
    ent = _BARS_CACHE.get(ticker)
    if not ent:
        return None
    if (time.time() - ent.fetched_at_epoch) > BARS_CACHE_TTL_SECONDS:
        return None
    return ent.df

def _cache_set(ticker: str, df: pd.DataFrame) -> None:
    _BARS_CACHE[ticker] = BarsCacheEntry(fetched_at_epoch=time.time(), df=df)

# ----------------------------
# YFINANCE FETCH
# ----------------------------
def fetch_1m_bars_cached(ticker: str) -> Optional[pd.DataFrame]:
    """
    Fetch 1m bars for a ticker with caching.
    Returns a dataframe with columns: Datetime (UTC tz-aware), High, Low, Close, Volume.
    """
    ticker = (ticker or "").strip().upper()
    if not ticker:
        return None

    cached = _cache_get(ticker)
    if cached is not None and not cached.empty:
        return cached

    df = yf.download(
        tickers=ticker,
        interval="1m",
        period="1d",
        progress=False,
        prepost=True,
        threads=False,  # reduce internal thread noise; you already run in background threads
    )
    if df is None or df.empty:
        return None

    # yfinance sometimes returns MultiIndex columns even for single ticker; normalize safely.
    # For a single ticker, common shapes:
    #   columns: ["Open","High","Low","Close","Adj Close","Volume"]
    #   index: DatetimeIndex
    #
    # If columns are MultiIndex (Price field, Ticker), pick the first level matching OHLCV.
    if isinstance(df.columns, pd.MultiIndex):
        # Prefer slicing the first level if it looks like ("High", ticker) etc.
        # df may look like columns: [('Close', 'AAPL'), ('High','AAPL'), ...]
        # We'll build a flat df with needed fields.
        try:
            cols = {}
            for field in ["High", "Low", "Close", "Volume"]:
                if (field, ticker) in df.columns:
                    cols[field] = df[(field, ticker)]
                elif field in df.columns.get_level_values(0):
                    # Fallback: take first matching column for that field
                    cols[field] = df[field].iloc[:, 0]
            df2 = pd.DataFrame(cols)
            df2.index = df.index
            df = df2
        except Exception:
            # Last resort: try to flatten and proceed
            df.columns = [c[0] for c in df.columns]

    # Reset index to make Datetime a column
    df = df.reset_index()
    # Rename first column to Datetime (yfinance uses 'Datetime' or 'Date')
    df = df.rename(columns={df.columns[0]: "Datetime"})

    # Keep only needed
    keep = ["Datetime", "High", "Low", "Close", "Volume"]
    df = df[[c for c in keep if c in df.columns]].copy()
    if "Datetime" not in df.columns or "High" not in df.columns or "Low" not in df.columns:
        return None

    # Normalize Datetime to UTC tz-aware
    # yfinance sometimes returns tz-naive timestamps in local exchange time; treating as UTC is risky.
    # Safer approach: parse and then localize if naive to UTC. In practice yfinance often returns tz-aware already.
    df["Datetime"] = pd.to_datetime(df["Datetime"], errors="coerce", utc=True)
    df = df.dropna(subset=["Datetime"])

    # Ensure numeric types
    for col in ["High", "Low", "Close", "Volume"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    df = df.dropna(subset=["High", "Low"])
    _cache_set(ticker, df)
    return df

def filter_bars_from_et(bars_utc: pd.DataFrame, start_et: datetime) -> pd.DataFrame:
    """
    bars_utc has Datetime as UTC tz-aware.
    start_et is ET tz-aware.
    Returns filtered bars at/after start time (with a small pre-buffer).
    """
    if bars_utc is None or bars_utc.empty:
        return bars_utc

    if start_et.tzinfo is None:
        start_et = start_et.replace(tzinfo=ET)

    # Back buffer to avoid missing first bar
    start_et = start_et - timedelta(minutes=5)
    start_utc = pd.Timestamp(start_et).tz_convert("UTC")

    out = bars_utc[bars_utc["Datetime"] >= start_utc].copy()
    return out

# ----------------------------
# HIT EVALUATION
# ----------------------------
def evaluate_long_hits(
    bars: pd.DataFrame,
    entry_low: float,
    entry_high: Optional[float],
    stop: float,
    t1: float,
    t2: float,
) -> Dict[str, Any]:
    """
    Returns dict with hit booleans + timestamps.
    Conservative tie-breaking: if stop and target hit in same bar -> stop first.

    Entry trigger (V1):
      - Trigger when high >= entry_low (simple).
      - If you want a stricter "zone touch", change to:
            (high >= entry_low) and (low <= entry_high)
    """
    out: Dict[str, Any] = {
        "EntryTriggered": False,
        "EntryTime": None,
        "StopHit": False,
        "StopTime": None,
        "Target1Hit": False,
        "Target1Time": None,
        "Target2Hit": False,
        "Target2Time": None,
        "FirstHit": None,
    }

    if bars is None or bars.empty:
        return out

    # Validate numeric inputs
    try:
        entry_low_f = float(entry_low)
        stop_f = float(stop)
        t1_f = float(t1)
        t2_f = float(t2)
    except Exception:
        return out

    for _, r in bars.iterrows():
        ts = r["Datetime"]
        high = float(r["High"])
        low = float(r["Low"])

        # Entry trigger
        if not out["EntryTriggered"]:
            if high >= entry_low_f:
                out["EntryTriggered"] = True
                out["EntryTime"] = ts

        # Only evaluate stop/targets after entry triggers
        if out["EntryTriggered"]:
            stop_hit = (low <= stop_f)
            t2_hit = (high >= t2_f)
            t1_hit = (high >= t1_f)

            # Conservative tie: stop wins same-bar
            if stop_hit and not out["StopHit"]:
                out["StopHit"] = True
                out["StopTime"] = ts
                if out["FirstHit"] is None:
                    out["FirstHit"] = "STOP"

            if t1_hit and not out["Target1Hit"] and not out["StopHit"]:
                out["Target1Hit"] = True
                out["Target1Time"] = ts
                if out["FirstHit"] is None:
                    out["FirstHit"] = "T1"

            if t2_hit and not out["Target2Hit"] and not out["StopHit"]:
                out["Target2Hit"] = True
                out["Target2Time"] = ts
                if out["FirstHit"] is None:
                    out["FirstHit"] = "T2"

            if out["StopHit"] or out["Target2Hit"]:
                break

    return out

# ----------------------------
# MAIN UPDATE (called by your outcome_worker)
# ----------------------------
def update_outcomes_from_rows(rows: List[dict], now_et_str: str) -> Optional[pd.DataFrame]:
    """
    rows are the same dicts you return to React.
    Writes/updates outcomes_log.csv
    """
    existing = None
    if os.path.exists(OUTCOME_PATH):
        try:
            existing = pd.read_csv(OUTCOME_PATH)
        except Exception:
            existing = None

    new_records: List[dict] = []

    # Parse "as of" time; if caller provides a string, trust it.
    asof_str = now_et_str or _et_now_str()

    for row in rows:
        # Only rows with a plan
        entry_low = row.get("EntryLow")
        stop = row.get("Stop")
        t1 = row.get("Target1")
        t2 = row.get("Target2")

        if not all([row.get("Ticker"), entry_low, stop, t1, t2]):
            continue

        ticker = str(row.get("Ticker")).strip().upper()

        ts_str = row.get("ScanTimestamp")
        if not ts_str:
            # Can't join without it
            continue

        # SignalId is your stable identity; require it
        signal_id = row.get("SignalId")
        if not signal_id:
            continue

        # Scan time: timezone-aware ET
        try:
            scan_dt_et = _parse_et(ts_str)
        except Exception:
            # fallback: treat "asof" as scan time if parsing fails
            try:
                scan_dt_et = _parse_et(asof_str)
            except Exception:
                scan_dt_et = _et_now()

        entry_high = row.get("EntryHigh")

        # Fetch cached bars and filter from scan time
        bars_all = fetch_1m_bars_cached(ticker)
        bars = filter_bars_from_et(bars_all, scan_dt_et) if bars_all is not None else None

        hits = evaluate_long_hits(
            bars=bars,
            entry_low=float(entry_low),
            entry_high=(float(entry_high) if entry_high is not None else None),
            stop=float(stop),
            t1=float(t1),
            t2=float(t2),
        )

        # ✅ FIXED: always include booleans + FirstHit; convert times when present
        clean_hits: Dict[str, Any] = {}
        for k, v in hits.items():
            if isinstance(v, datetime):
                clean_hits[k] = _fmt_et(v)
            else:
                # Convert pandas missing values to None
                try:
                    clean_hits[k] = None if pd.isna(v) else v
                except Exception:
                    clean_hits[k] = v

        rec = {
            "AsOf": asof_str,
            "SignalId": signal_id,
            "Ticker": ticker,
            "ScanTimestamp": ts_str,
            "EntryLow": entry_low,
            "EntryHigh": entry_high,
            "Stop": stop,
            "Target1": t1,
            "Target2": t2,
            **clean_hits,
        }
        new_records.append(rec)

    if not new_records:
        return existing

    df_new = pd.DataFrame(new_records)

    # First write
    if existing is None or existing.empty:
        df_new.to_csv(OUTCOME_PATH, index=False)
        return df_new

    # Merge + de-dup by SignalId (latest AsOf wins)
    combined = pd.concat([existing, df_new], ignore_index=True)

    # Ensure sort keys exist
    if "AsOf" in combined.columns:
        combined = combined.sort_values(["SignalId", "AsOf"])
    else:
        combined = combined.sort_values(["SignalId"])

    combined = combined.drop_duplicates(subset=["SignalId"], keep="last")
    combined.to_csv(OUTCOME_PATH, index=False)
    return combined
