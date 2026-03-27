#!/usr/bin/env python3
"""
Fetch Historical OHLCV Data for Backtesting
=============================================
Downloads years of 5-minute candle data from free public APIs.
No API key required.

Usage:
    pip install requests pandas
    python3 fetch_ohlcv.py

Output: CSV files in testdata/ folder with columns:
    datetime, open, high, low, close, volume

Supports: Coinbase (DOGE-USD), Binance (DOGEUSDT fallback)
"""

import os, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
import pandas as pd

# ─── CONFIGURATION ──────────────────────────────────────────────────────────
OUTPUT_DIR = Path(__file__).resolve().parent / "testdata"
OUTPUT_DIR.mkdir(exist_ok=True)

# Pairs to fetch (add more for cross-market testing)
PAIRS = [
    {"exchange": "coinbase", "symbol": "DOGE-USD",  "filename": "DOGEUSD_5m_ohlcv.csv"},
    {"exchange": "coinbase", "symbol": "BTC-USD",   "filename": "BTCUSD_5m_ohlcv.csv"},
    {"exchange": "coinbase", "symbol": "ETH-USD",   "filename": "ETHUSD_5m_ohlcv.csv"},
]

GRANULARITY = 300           # 5 minutes in seconds
MAX_CANDLES_PER_REQUEST = 300  # Coinbase limit
YEARS_OF_DATA = 3           # How far back to fetch


# ─── COINBASE FETCHER ───────────────────────────────────────────────────────
def fetch_coinbase(symbol: str, start: datetime, end: datetime) -> pd.DataFrame:
    """Fetch OHLCV from Coinbase Exchange API in batches."""
    url = f"https://api.exchange.coinbase.com/products/{symbol}/candles"
    all_candles = []
    current_end = end

    total_batches = int((end - start).total_seconds() / (GRANULARITY * MAX_CANDLES_PER_REQUEST)) + 1
    batch_num = 0

    while current_end > start:
        batch_start = current_end - timedelta(seconds=GRANULARITY * MAX_CANDLES_PER_REQUEST)
        if batch_start < start:
            batch_start = start

        params = {
            "start": batch_start.isoformat(),
            "end":   current_end.isoformat(),
            "granularity": GRANULARITY,
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
                    # Rate limited — back off
                    wait = 2 ** (retries + 1)
                    print(f"    Rate limited, waiting {wait}s...")
                    time.sleep(wait)
                    retries += 1
                else:
                    print(f"    HTTP {resp.status_code}: {resp.text[:200]}")
                    retries += 1
                    time.sleep(2)
            except requests.RequestException as e:
                print(f"    Request error: {e}")
                retries += 1
                time.sleep(2 ** retries)

        current_end = batch_start
        if batch_num % 50 == 0:
            print(f"    Batch {batch_num}/{total_batches} — {len(all_candles)} candles so far")
        time.sleep(0.15)  # Stay under rate limits

    if not all_candles:
        return pd.DataFrame()

    # Coinbase format: [timestamp, low, high, open, close, volume]
    df = pd.DataFrame(all_candles, columns=["timestamp", "low", "high", "open", "close", "volume"])
    df["datetime"] = pd.to_datetime(df["timestamp"], unit="s", utc=True)
    df = df[["datetime", "open", "high", "low", "close", "volume"]]
    df = df.sort_values("datetime").drop_duplicates(subset="datetime").reset_index(drop=True)

    return df


# ─── BINANCE FETCHER (fallback) ─────────────────────────────────────────────
def fetch_binance(symbol: str, start: datetime, end: datetime) -> pd.DataFrame:
    """Fetch OHLCV from Binance public API. Symbol format: DOGEUSDT"""
    url = "https://api.binance.com/api/v3/klines"
    all_candles = []
    current_start = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)

    while current_start < end_ms:
        params = {
            "symbol": symbol,
            "interval": "5m",
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
                        current_start = end_ms  # Done
                        break
                    all_candles.extend(data)
                    current_start = data[-1][6] + 1  # Close time + 1ms
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

    # Binance format: [open_time, open, high, low, close, volume, close_time, ...]
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
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=365 * YEARS_OF_DATA)

    print(f"Fetching {YEARS_OF_DATA} years of 5m OHLCV data")
    print(f"Period: {start.date()} to {end.date()}")
    print(f"Output: {OUTPUT_DIR}/\n")

    for pair in PAIRS:
        symbol = pair["symbol"]
        exchange = pair["exchange"]
        outfile = OUTPUT_DIR / pair["filename"]

        print(f"{'='*60}")
        print(f"  {exchange.upper()}: {symbol}")
        print(f"  Output: {outfile.name}")
        print(f"{'='*60}")

        if exchange == "coinbase":
            df = fetch_coinbase(symbol, start, end)
        elif exchange == "binance":
            df = fetch_binance(symbol, start, end)
        else:
            print(f"  Unknown exchange: {exchange}")
            continue

        if df.empty:
            print(f"  FAILED — no data returned. Trying Binance fallback...")
            # Map Coinbase symbols to Binance
            binance_map = {"DOGE-USD": "DOGEUSDT", "BTC-USD": "BTCUSDT", "ETH-USD": "ETHUSDT"}
            bsym = binance_map.get(symbol)
            if bsym:
                df = fetch_binance(bsym, start, end)

        if df.empty:
            print(f"  FAILED — no data from either source.\n")
            continue

        df.to_csv(outfile, index=False)
        print(f"  Saved: {len(df)} candles")
        print(f"  Range: {df['datetime'].min()} to {df['datetime'].max()}")
        print(f"  File:  {outfile}\n")

    print("\nDone! Place these CSV files in the testdata/ folder.")
    print("Then run: python3 backtest_supertrend.py")


if __name__ == "__main__":
    main()
