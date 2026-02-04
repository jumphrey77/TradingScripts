import pandas as pd
import numpy as np

def compute_vwap(df: pd.DataFrame):
    typical = (df["High"] + df["Low"] + df["Close"]) / 3
    vwap = (typical * df["Volume"]).cumsum() / df["Volume"].cumsum()
    return vwap

def compute_atr(df: pd.DataFrame, period=14):
    high_low = df["High"] - df["Low"]
    high_close = (df["High"] - df["Close"].shift()).abs()
    low_close = (df["Low"] - df["Close"].shift()).abs()

    tr = pd.concat([high_low, high_close, low_close], axis=1).max(axis=1)
    atr = tr.rolling(period).mean()
    return atr

def speed_of_move(df: pd.DataFrame, bars=3):
    return (df["Close"] - df["Close"].shift(bars)) / df["Close"].shift(bars)

def premarket_levels(df):
    pm = df.between_time("04:00", "09:29")
    return {
        "pm_high": pm["High"].max(),
        "pm_low": pm["Low"].min(),
        "pm_volume": pm["Volume"].sum()
    }

def volume_spike(df, lookback=20):
    avg = df["Volume"].rolling(lookback).mean()
    return df["Volume"] / avg
