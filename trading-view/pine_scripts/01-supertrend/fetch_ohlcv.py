#!/usr/bin/env python3
"""
Fetch Historical OHLCV Data for Backtesting
=============================================
Interactive script — prompts for date range, timeframe, and assets.
Downloads from Coinbase (free, no API key).

Usage:
    pip install requests pandas
    python fetch_ohlcv.py
"""

import os, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
import pandas as pd

OUTPUT_DIR = Path(__file__).resolve().parent / "testdata"
OUTPUT_DIR.mkdir(exist_ok=True)

# Coinbase granularity map (seconds)
TIMEFRAME_MAP = {
    "1m":  60,
    "5m":  300,
    "15m": 900,
    "30m": 1800,
    "1h":  3600,
    "6h":  21600,
    "1d":  86400,
}

MAX_CANDLES_PER_REQUEST = 300  # Coinbase limit

# Coinbase → Binance symbol mapping for fallback
BINANCE_MAP = {
    "DOGE-USD": "DOGEUSDT",
    "BTC-USD":  "BTCUSDT",
    "ETH-USD":  "ETHUSDT",
    "SOL-USD":  "SOLUSDT",
    "ADA-USD":  "ADAUSDT",
    "XRP-USD":  "XRPUSDT",
    "AVAX-USD": "AVAXUSDT",
    "LINK-USD": "LINKUSDT",
    "DOT-USD":  "DOTUSDT",
    "MATIC-USD":"MATICUSDT",
}

# Binance interval strings
BINANCE_INTERVAL_MAP = {
    "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1h": "1h", "6h": "6h", "1d": "1d",
}


# ─── PROMPTS ────────────────────────────────────────────────────────────────
def prompt_assets() -> list[str]:
    print("\n── ASSET SELECTION ──")
    print("Enter Coinbase symbols separated by commas.")
    print("Examples: DOGE-USD, BTC-USD, ETH-USD, SOL-USD")
    print("Common pairs: DOGE-USD, BTC-USD, ETH-USD, SOL-USD, ADA-USD, XRP-USD, AVAX-USD, LINK-USD")
    raw = input("\nAssets [DOGE-USD, BTC-USD, ETH-USD, SOL-USD]: ").strip()
    if not raw:
        return ["DOGE-USD", "BTC-USD", "ETH-USD", "SOL-USD"]
    return [s.strip().upper() for s in raw.split(",") if s.strip()]


def prompt_timeframe() -> str:
    print("\n── TIMEFRAME ──")
    print("Options: 1m, 5m, 15m, 30m, 1h, 6h, 1d")
    raw = input("Timeframe [5m]: ").strip()
    if not raw:
        return "5m"
    if raw not in TIMEFRAME_MAP:
        print(f"  Invalid timeframe '{raw}', defaulting to 5m")
        return "5m"
    return raw


def prompt_date_range() -> tuple[datetime, datetime]:
    print("\n── DATE RANGE ──")
    print("Enter dates as YYYY-MM-DD (or press Enter for defaults)")

    end_default = datetime.now(timezone.utc)
    start_default = end_default - timedelta(days=365 * 3)

    raw_start = input(f"Start date [{start_default.strftime('%Y-%m-%d')}]: ").strip()
    raw_end   = input(f"End date   [{end_default.strftime('%Y-%m-%d')}]: ").strip()

    try:
        start = datetime.strptime(raw_start, "%Y-%m-%d").replace(tzinfo=timezone.utc) if raw_start else start_default
    except ValueError:
        print(f"  Invalid date '{raw_start}', using default")
        start = start_default

    try:
        end = datetime.strptime(raw_end, "%Y-%m-%d").replace(tzinfo=timezone.utc) if raw_end else end_default
    except ValueError:
        print(f"  Invalid date '{raw_end}', using default")
        end = end_default

    return start, end


def prompt_continue() -> bool:
    raw = input("\nFetch another batch? (y/n) [n]: ").strip().lower()
    return raw in ("y", "yes")


# ─── COINBASE FETCHER ───────────────────────────────────────────────────────
def fetch_coinbase(symbol: str, start: datetime, end: datetime, granularity: int) -> pd.DataFrame:
    url = f"https://api.exchange.coinbase.com/products/{symbol}/candles"
    all_candles = []
    current_end = end

    total_seconds = (end - start).total_seconds()
    total_batches = int(total_seconds / (granularity * MAX_CANDLES_PER_REQUEST)) + 1

    print(f"    Estimated batches: ~{total_batches}")
    batch_num = 0

    while current_end > start:
        batch_start = current_end - timedelta(seconds=granularity * MAX_CANDLES_PER_REQUEST)
        if batch_start < start:
            batch_start = start

        params = {
            "start": batch_start.isoformat(),
            "end":   current_end.isoformat(),
            "granularity": granularity,
        }

        batch_num += 1
        retries = 0
        while retries < 4:
            try:
                resp = requests.get(url, params=params, timeout=15)
                if resp.status_code == 200:
                    data = resp.json()
                    if data:
                        all_candles.extend(data)
                    break
                elif resp.status_code == 429:
                    wait = 2 ** (retries + 1)
                    print(f"    Rate limited, waiting {wait}s...")
                    time.sleep(wait)
                    retries += 1
                elif resp.status_code == 404:
                    print(f"    Symbol {symbol} not found on Coinbase")
                    return pd.DataFrame()
                else:
                    print(f"    HTTP {resp.status_code}: {resp.text[:200]}")
                    retries += 1
                    time.sleep(2)
            except requests.RequestException as e:
                print(f"    Request error: {e}")
                retries += 1
                time.sleep(2 ** retries)

        current_end = batch_start

        # Progress updates
        if batch_num % 20 == 0:
            pct = min(100, batch_num / max(total_batches, 1) * 100)
            print(f"    [{pct:5.1f}%] Batch {batch_num}/{total_batches} — {len(all_candles)} candles so far")

        time.sleep(0.15)

    if not all_candles:
        return pd.DataFrame()

    # Coinbase format: [timestamp, low, high, open, close, volume]
    df = pd.DataFrame(all_candles, columns=["timestamp", "low", "high", "open", "close", "volume"])
    df["datetime"] = pd.to_datetime(df["timestamp"], unit="s", utc=True)
    df = df[["datetime", "open", "high", "low", "close", "volume"]]
    df = df.sort_values("datetime").drop_duplicates(subset="datetime").reset_index(drop=True)
    return df


# ─── BINANCE FETCHER (fallback) ─────────────────────────────────────────────
def fetch_binance(symbol: str, start: datetime, end: datetime, interval: str) -> pd.DataFrame:
    url = "https://api.binance.com/api/v3/klines"
    all_candles = []
    current_start = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)

    print(f"    Fetching from Binance ({symbol})...")

    while current_start < end_ms:
        params = {
            "symbol": symbol,
            "interval": interval,
            "startTime": current_start,
            "endTime": end_ms,
            "limit": 1000,
        }

        retries = 0
        while retries < 4:
            try:
                resp = requests.get(url, params=params, timeout=15)
                if resp.status_code == 200:
                    data = resp.json()
                    if not data:
                        current_start = end_ms
                        break
                    all_candles.extend(data)
                    current_start = data[-1][6] + 1
                    break
                elif resp.status_code == 429:
                    wait = 2 ** (retries + 1)
                    print(f"    Rate limited, waiting {wait}s...")
                    time.sleep(wait)
                    retries += 1
                else:
                    print(f"    HTTP {resp.status_code}")
                    retries += 1
                    time.sleep(2)
            except requests.RequestException as e:
                print(f"    Error: {e}")
                retries += 1
                time.sleep(2 ** retries)

        if len(all_candles) % 5000 == 0 and all_candles:
            print(f"    {len(all_candles)} candles fetched...")
        time.sleep(0.1)

    if not all_candles:
        return pd.DataFrame()

    df = pd.DataFrame(all_candles)
    df = df.iloc[:, :6]
    df.columns = ["timestamp", "open", "high", "low", "close", "volume"]
    df["datetime"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col])
    df = df[["datetime", "open", "high", "low", "close", "volume"]]
    df = df.sort_values("datetime").drop_duplicates(subset="datetime").reset_index(drop=True)
    return df


# ─── MAIN ───────────────────────────────────────────────────────────────────
def main():
    print("=" * 60)
    print("  OHLCV Data Fetcher for Backtesting")
    print("  Coinbase (primary) + Binance (fallback)")
    print("=" * 60)

    while True:
        assets    = prompt_assets()
        timeframe = prompt_timeframe()
        start, end = prompt_date_range()
        granularity = TIMEFRAME_MAP[timeframe]
        binance_interval = BINANCE_INTERVAL_MAP[timeframe]

        days = (end - start).days
        est_candles = int(days * 86400 / granularity)
        print(f"\n  Summary:")
        print(f"    Assets:    {', '.join(assets)}")
        print(f"    Timeframe: {timeframe}")
        print(f"    Period:    {start.strftime('%Y-%m-%d')} to {end.strftime('%Y-%m-%d')} ({days} days)")
        print(f"    Est. candles per asset: ~{est_candles:,}")
        print(f"    Output:    {OUTPUT_DIR}/")

        confirm = input(f"\n  Proceed? (y/n) [y]: ").strip().lower()
        if confirm == "n":
            continue

        for symbol in assets:
            filename = f"{symbol.replace('-', '')}_{timeframe}_ohlcv.csv"
            outfile = OUTPUT_DIR / filename

            print(f"\n{'─'*60}")
            print(f"  Fetching: {symbol} ({timeframe})")
            print(f"  Output:   {filename}")
            print(f"{'─'*60}")

            # Try Coinbase first
            df = fetch_coinbase(symbol, start, end, granularity)

            # Fallback to Binance if Coinbase fails
            if df.empty:
                bsym = BINANCE_MAP.get(symbol)
                if bsym:
                    print(f"  Coinbase failed, trying Binance ({bsym})...")
                    df = fetch_binance(bsym, start, end, binance_interval)
                else:
                    print(f"  No Binance mapping for {symbol}")

            if df.empty:
                print(f"  FAILED — no data from either source.")
                continue

            df.to_csv(outfile, index=False)
            print(f"\n  SAVED: {len(df):,} candles")
            print(f"  Range: {df['datetime'].min()} to {df['datetime'].max()}")
            print(f"  File:  {outfile}")

        if not prompt_continue():
            break

    print("\nDone! CSV files are in the testdata/ folder.")
    print("Upload them to GitHub or let Claude know they're ready.")


if __name__ == "__main__":
    main()
