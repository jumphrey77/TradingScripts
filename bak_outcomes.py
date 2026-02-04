import os
import pandas as pd
from datetime import datetime, timedelta
import yfinance as yf
from zoneinfo import ZoneInfo

OUTCOME_DIR = "./history/outcomes"
os.makedirs(OUTCOME_DIR, exist_ok=True)
OUTCOME_PATH = os.path.join(OUTCOME_DIR, "outcomes_log.csv")

ET = ZoneInfo("America/New_York")

def _parse_et(ts_str: str):
    dt = datetime.strptime(ts_str.replace(" ET",""), "%Y-%m-%d %H:%M:%S")
    return dt.replace(tzinfo=ET)

def fetch_1m_bars(ticker: str, start_dt: datetime):
    """
    Yahoo 1m bars are limited (recent window). Good for same-day / recent tracking.
    """
    # fetch a buffer back so we don't miss first bar
    start_dt = start_dt - timedelta(minutes=5)
    df = yf.download(
        tickers=ticker,
        interval="1m",
        period="1d",
        progress=False,
        prepost=True
    )
    if df is None or df.empty:
        return None
    
    # ✅ yfinance sometimes returns MultiIndex columns; flatten them
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [c[0] for c in df.columns]


    # yfinance returns tz-aware index sometimes; normalize to naive for comparisons
    df = df.reset_index()
    # columns usually: Datetime, Open, High, Low, Close, Adj Close, Volume
    # Keep only needed
    df = df.rename(columns={df.columns[0]: "Datetime"})
    df = df[["Datetime", "High", "Low", "Close", "Volume"]]
     
    # Filter to start
    # Ensure both sides are pandas Timestamps (naive)
    df["Datetime"] = pd.to_datetime(df["Datetime"], utc=True, errors="coerce")
    start_ts_utc  = pd.Timestamp(start_dt, tz="America/New_York").tz_convert("UTC")

    df = df[df["Datetime"] >= start_ts_utc ]
    return df

def evaluate_long_hits(bars: pd.DataFrame, entry_low, entry_high, stop, t1, t2):

    def _scalar(x):
        # If x is a Series/DataFrame cell, extract first value
        try:
            if hasattr(x, "iloc"):
                return x.iloc[0]
        except Exception:
            pass
        return x

    """
    Returns dict with hit booleans + timestamps.
    Conservative tie-breaking: if stop and target hit in same bar -> stop first.
    """
    out = {
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

    for _, r in bars.iterrows():
        ts = r["Datetime"]
        high = float(_scalar(r["High"]))
        low = float(_scalar(r["Low"]))


        # entry trigger: price trades into/through entry zone
        if not out["EntryTriggered"]:
            if high >= float(entry_low):
                out["EntryTriggered"] = True
                out["EntryTime"] = ts

        # only evaluate stop/targets after entry triggers
        if out["EntryTriggered"]:
            stop_hit = (low <= float(stop))
            t2_hit = (high >= float(t2))
            t1_hit = (high >= float(t1))

            # conservative tie: stop wins same-bar
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

            # end early if stop hit or T2 hit
            if out["StopHit"] or out["Target2Hit"]:
                break

    return out

def update_outcomes_from_rows(rows: list, now_et_str: str):
    """
    rows are the same dicts you return to React.
    Writes/updates outcomes_log.csv
    """
    # Load existing outcomes (so we can update, not duplicate)
    existing = None
    if os.path.exists(OUTCOME_PATH):
        existing = pd.read_csv(OUTCOME_PATH)

    new_records = []

    for row in rows:
        # only long breakout plans
        if not row.get("EntryLow") or not row.get("Stop") or not row.get("Target1") or not row.get("Target2"):
            continue

        ticker = row.get("Ticker")

        ts_str = row.get("ScanTimestamp")
        if not ts_str:
            print("Row Had No ScanTimestamp")
            continue  # can't join without it

        # if your rows don't include scan timestamp, we’ll treat "now" as scan time
        try:
            scan_dt = _parse_et(ts_str)
        except Exception:
            scan_dt = _parse_et(now_et_str)

        entry_low = row.get("EntryLow")
        entry_high = row.get("EntryHigh")
        stop = row.get("Stop")
        t1 = row.get("Target1")
        t2 = row.get("Target2")

        if not all([ticker, entry_low, stop, t1, t2]):
            continue

        bars = fetch_1m_bars(ticker, scan_dt)
        hits = evaluate_long_hits(bars, entry_low, entry_high, stop, t1, t2)

        clean_hits = {}
        for k, v in hits.items():
            if isinstance(v, datetime):
                ts = pd.Timestamp(v)
                if ts.tzinfo is None:
                    ts = ts.tz_localize("UTC")
                ts_et = ts.tz_convert("America/New_York")
                clean_hits[k] = ts_et.strftime("%Y-%m-%d %H:%M:%S ET")
            else:
                clean_hits[k] = None if pd.isna(v) else v



        signal_id = row.get("SignalId")
        if not signal_id:
            continue

        #scan_dt.strftime("%Y-%m-%d %H:%M:%S ET"),
        rec = {
            "AsOf": now_et_str,
            "SignalId": signal_id,
            "Ticker": ticker,
            "ScanTimestamp": row.get("ScanTimestamp"),  # keep, useful
            "EntryLow": entry_low,
            "EntryHigh": entry_high,
            "Stop": stop,
            "Target1": t1,
            "Target2": t2,
            **clean_hits
        }
        new_records.append(rec)

    df_new = pd.DataFrame(new_records)

    if existing is None:
        df_new.to_csv(OUTCOME_PATH, index=False)
        return df_new

    # de-dup by Ticker + ScanTimestamp (latest AsOf wins)
    #combined = combined.drop_duplicates(subset=["Ticker", "ScanTimestamp"], keep="last")
    combined = pd.concat([existing, df_new], ignore_index=True)
    combined = combined.sort_values(["Ticker", "ScanTimestamp", "AsOf"])
    combined = combined.drop_duplicates(subset=["SignalId"], keep="last")
    combined.to_csv(OUTCOME_PATH, index=False)
    return combined
