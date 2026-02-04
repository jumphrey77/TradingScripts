# utils.py
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo
import math
import pandas as pd

ET = ZoneInfo("America/New_York")

def safe_float(x, default=0.0):
    """
    Use safe_float ONLY where zero is acceptable
    Convert x to float safely.
    - Returns `default` if x is None, NaN, or not convertible.
    """
    try:
        if x is None:
            return default
        if hasattr(x, "item"):  # numpy scalar -> python scalar
            x = x.item()
        if pd.isna(x):
            return default
        return float(x)
    except Exception:
        return default


def nullable_float(x, default=None):
    """
    Convert to float, but preserve None for missing values.
    Used when None is semantically meaningful.
    nullable_float “This value does not exist”
    """
    try:
        if x is None:
            return default
        if hasattr(x, "item"):
            x = x.item()
        if pd.isna(x):
            return default
        return float(x)
    except Exception:
        return default

def safe_int(x, default=0):
    """
    Convert x to int safely.
    - Returns `default` if x is None, NaN, or not convertible.
    """
    try:
        if x is None:
            return default
        if hasattr(x, "item"):
            x = x.item()
        if pd.isna(x):
            return default
        return int(x)
    except Exception:
        return default


def sanitize_df_for_json_bak(df: pd.DataFrame) -> pd.DataFrame:
    """
    Ensure numpy/pandas scalars become JSON-friendly primitives.
    """
    clean = df.copy()
    for col in clean.columns:
        clean[col] = clean[col].apply(lambda v: v.item() if hasattr(v, "item") else v)
    return clean

def sanitize_df_for_json(df: pd.DataFrame) -> pd.DataFrame:
    clean = df.copy()

    def fix(v):
        if hasattr(v, "item"):
            v = v.item()
        # pandas missing values
        if v is None or (isinstance(v, float) and (math.isnan(v) or math.isinf(v))):
            return None
        if pd.isna(v):
            return None
        # pandas timestamps
        if isinstance(v, (pd.Timestamp,)):
            return v.isoformat()
        return v

    for col in clean.columns:
        clean[col] = clean[col].map(fix)

    return clean



def et_now_str() -> str:
    """
    Timestamp string in the format you're using everywhere.
    (Note: This is a label; it's not timezone-aware conversion.)
    """
    return datetime.now(ET).strftime("%Y-%m-%d %H:%M:%S ET")
