import json
import logging
import os
import sys
import threading
import time
import traceback
import uuid
from datetime import datetime,timedelta, date
import yfinance as yf
import pytz

import pandas as pd
from flask import Flask, jsonify, request
from flask_cors import CORS

from config import config
from outcomes import update_outcomes_from_rows
from utils import sanitize_df_for_json, et_now_str, nullable_float
from Production_Grade_Scanner import scan  # <-- change filename if needed

# --------------------------
# GLOBAL STATE (shared)
# --------------------------
LATEST_DF = None
PREVIOUS_SYMBOLS = set()
ACTIVE_SIGNALS = {}          # Ticker -> {"SignalId": "...", "ScanTimestamp": "..."}
LAST_EVENT_STATE = {}        # (Ticker, ScanTimestamp) -> dict of last booleans
EVENTS = []                  # in-memory ring buffer
NEXT_EVENT_ID = 1

REFRESH_SECONDS = 60
OUTCOME_REFRESH_SECONDS = 30

STATE_LOCK = threading.Lock()

# Ensure dirs exist
os.makedirs(config.EVENT_DIR, exist_ok=True)
os.makedirs(config.SCAN_DIR, exist_ok=True)
os.makedirs(config.SIGNAL_DIR, exist_ok=True)
os.makedirs(config.EXPORTS_DIR, exist_ok=True)
#TODO Make SubDir


# -----------------------------
# Simulator helpers
# -----------------------------

NY = pytz.timezone("America/New_York")

def _parse_date(d):
    # expects "YYYY-MM-DD"
    return datetime.strptime(d, "%Y-%m-%d").date()

def _parse_time(t):
    # expects "HH:MM:SS" or "HH:MM"
    fmt = "%H:%M:%S" if len(t.split(":")) == 3 else "%H:%M"
    return datetime.strptime(t, fmt).time()

def _combine_ny(d: date, t):
    return NY.localize(datetime.combine(d, t))

def _safe_float(x):
    try:
        if x is None:
            return None
        if isinstance(x, str) and x.strip() == "":
            return None
        return float(x)
    except Exception:


        return None

def _fetch_intraday_yahoo(symbol, d: date, interval: str):
    """
    Fetch intraday bars for a specific date using yfinance.
    NOTE: Yahoo intraday availability is limited (recent days/weeks).
    """
    # HARDEN: symbol sometimes arrives as ('BATL',) or ['BATL']
    if isinstance(symbol, (list, tuple)):
        symbol = symbol[0] if symbol else ""
    symbol = str(symbol).strip().upper()

    if not symbol:
        return None

    start = datetime.combine(d, datetime.min.time())
    end = start + timedelta(days=1)

    # yfinance wants naive datetimes; it returns tz-aware index sometimes.
    df = yf.download(
        tickers=symbol,
        start=start,
        end=end,
        interval=interval,
        progress=False,
        auto_adjust=False,
        prepost=False,
        threads=False,
    )

    if df is None or df.empty:
        return None

    # Normalize columns (handle MultiIndex from yfinance)
    if isinstance(df.columns, pd.MultiIndex):
        # usually levels like (PriceField, Ticker) or (Ticker, PriceField)
        # We want open/high/low/close as simple lowercase names
        # Pick the level that contains OHLC labels
        lvl0 = [str(x).lower() for x in df.columns.get_level_values(0)]
        lvl1 = [str(x).lower() for x in df.columns.get_level_values(1)]

        # If level 0 looks like OHLC, use it; else use level 1
        ohlc = {"open", "high", "low", "close", "adj close", "volume"}
        use_level = 0 if any(v in ohlc for v in lvl0) else 1

        df.columns = [str(x).lower() for x in df.columns.get_level_values(use_level)]
    else:
        df.columns = [str(c).lower() for c in df.columns]

    # Ensure required columns
    for c in ["open", "high", "low", "close"]:
        if c not in df.columns:
            return None

    # Ensure datetime index is NY tz-aware
    idx = df.index
    if getattr(idx, "tz", None) is None:
        # yfinance sometimes returns naive times; treat as NY
        df.index = pd.DatetimeIndex(df.index).tz_localize(NY, ambiguous="infer", nonexistent="shift_forward")
    else:
        df.index = df.index.tz_convert(NY)

    return df

def _first_hit_time(df_post, condition_series: pd.Series):
    if condition_series is None or df_post is None or df_post.empty:
        return None
    hits = condition_series[condition_series]
    if hits.empty:
        return None
    return hits.index[0]

def _simulate_one(rec: dict, cfg: dict, df: pd.DataFrame, signal_ts: datetime):
    """
    rec columns expected (from your table):
      Ticker, Score, EntryLow, EntryHigh, Stop, Target1, Target2
    cfg:
      entry_mode: limit|stop|market  (default limit)
      entry_fill: low|mid|high       (default mid)
      profit_pct: float (default 0.15)
      conflict_policy: worst_case|best_case (default worst_case)
      use_stop: bool (default True)
    """
    """
    #symbol = str(rec.get("Ticker") or "").strip().upper()
    """
    raw = rec.get("Ticker")
    if isinstance(raw, (list, tuple)):
        raw = raw[0] if raw else ""
    symbol = str(raw or "").strip().upper()
    
    if not symbol:
        return {"status": "ERROR", "reason": "Missing Ticker", "rec": rec}

    entry_low = _safe_float(rec.get("EntryLow"))
    entry_high = _safe_float(rec.get("EntryHigh"))
    stop_price = _safe_float(rec.get("Stop"))
    t1 = _safe_float(rec.get("Target1"))
    t2 = _safe_float(rec.get("Target2"))
    score = _safe_float(rec.get("Score"))

    entry_mode = (cfg.get("entry_mode") or "limit").lower()
    entry_fill_mode = (cfg.get("entry_fill") or "mid").lower()
    conflict_policy = (cfg.get("conflict_policy") or "worst_case").lower()
    profit_pct = float(cfg.get("profit_pct") or 0.15)
    use_stop = bool(cfg.get("use_stop", True))

    if df is None or df.empty:
        return {"status": "NO_DATA", "symbol": symbol, "score": score, "reason": "No intraday bars from Yahoo"}

    # Slice from signal time
    df2 = df[df.index >= signal_ts].copy()
    if df2.empty:
        return {"status": "NO_DATA", "symbol": symbol, "score": score, "reason": "No bars after signal_time"}

    # -----------------
    # Entry detection
    # -----------------
    entry_time = None
    entry_price = None

    if entry_mode == "market":
        entry_time = df2.index[0]
        entry_price = float(df2.iloc[0]["open"])

    elif entry_mode == "limit":
        if entry_low is None or entry_high is None:
            return {"status": "ERROR", "symbol": symbol, "score": score, "reason": "EntryLow/EntryHigh required for limit"}
        # bar overlaps zone?
        cond = (df2["low"] <= entry_high) & (df2["high"] >= entry_low)
        entry_time = _first_hit_time(df2, cond)
        if entry_time is None:
            return {"status": "NO_TRADE", "symbol": symbol, "score": score, "reason": "Limit zone never touched"}
        if entry_fill_mode == "low":
            entry_price = float(entry_low)
        elif entry_fill_mode == "high":
            entry_price = float(entry_high)
        else:
            entry_price = float((entry_low + entry_high) / 2.0)

    elif entry_mode == "stop":
        if entry_low is None:
            return {"status": "ERROR", "symbol": symbol, "score": score, "reason": "EntryLow required for stop"}
        cond = (df2["high"] >= entry_low)
        entry_time = _first_hit_time(df2, cond)
        if entry_time is None:
            return {"status": "NO_TRADE", "symbol": symbol, "score": score, "reason": "Stop entry never triggered"}
        entry_price = float(entry_low)

    else:
        return {"status": "ERROR", "symbol": symbol, "score": score, "reason": f"Unknown entry_mode: {entry_mode}"}

    # Post-entry bars
    post = df2[df2.index >= entry_time]
    if post.empty:
        return {"status": "NO_DATA", "symbol": symbol, "score": score, "reason": "No post-entry bars"}

    # Compute percent target
    pct_target_price = entry_price * (1.0 + profit_pct)

    # Hit detection times (raw hits for tuning)
    stop_hit_time = None
    if use_stop and stop_price is not None:
        stop_hit_time = _first_hit_time(post, post["low"] <= stop_price)

    t1_hit_time = None
    if t1 is not None:
        t1_hit_time = _first_hit_time(post, post["high"] >= t1)

    t2_hit_time = None
    if t2 is not None:
        t2_hit_time = _first_hit_time(post, post["high"] >= t2)

    pct_hit_time = _first_hit_time(post, post["high"] >= pct_target_price)

    # Same-bar conflict note: stop and any target can both be "hit" in same candle.
    # For raw hit timestamps we still report them; for "outcome" we can apply conflict policy.
    # Outcome logic (simple): whichever happens first wins; if same timestamp and conflict -> policy decides.

    events = []
    if stop_hit_time is not None:
        events.append(("STOP", stop_hit_time))
    if t1_hit_time is not None:
        events.append(("T1", t1_hit_time))
    if t2_hit_time is not None:
        events.append(("T2", t2_hit_time))
    if pct_hit_time is not None:
        events.append(("PCT", pct_hit_time))

    outcome = "OPEN_AT_CLOSE"
    outcome_time = None

    if events:
        # sort by time
        events.sort(key=lambda x: x[1])
        first_name, first_ts = events[0]
        # check same-ts conflicts
        same_ts = [e[0] for e in events if e[1] == first_ts]
        if "STOP" in same_ts and len(same_ts) > 1:
            # stop + target same candle
            if conflict_policy == "best_case":
                # choose first non-stop
                for nm in same_ts:
                    if nm != "STOP":
                        outcome = f"{nm}_HIT"
                        outcome_time = first_ts
                        break
            else:
                outcome = "STOP_HIT"
                outcome_time = first_ts
        else:
            outcome = "STOP_HIT" if first_name == "STOP" else f"{first_name}_HIT"
            outcome_time = first_ts

    # Stats: MFE/MAE from entry
    mfe_pct = float((post["high"].max() / entry_price) - 1.0)
    mae_pct = float((post["low"].min() / entry_price) - 1.0)

    # Time deltas
    minutes_to_entry = int((entry_time - signal_ts).total_seconds() // 60)

    def _mins(a, b):
        if a is None or b is None:
            return None
        return int((a - b).total_seconds() // 60)

    last_close = float(post.iloc[-1]["close"])
    pnl_close_pct = float((last_close / entry_price) - 1.0)

    return {
        "status": "OK",
        "symbol": symbol,
        "score": score,
        "entry": {
            "mode": entry_mode,
            "fill_mode": entry_fill_mode,
            "time": entry_time.isoformat(),
            "price": entry_price,
            "minutes_to_entry": minutes_to_entry
        },
        "levels": {
            "stop": {"price": stop_price, "hit": stop_hit_time is not None, "time": stop_hit_time.isoformat() if stop_hit_time else None},
            "t1": {"price": t1, "hit": t1_hit_time is not None, "time": t1_hit_time.isoformat() if t1_hit_time else None},
            "t2": {"price": t2, "hit": t2_hit_time is not None, "time": t2_hit_time.isoformat() if t2_hit_time else None},
            "pct": {"pct": profit_pct, "price": pct_target_price, "hit": pct_hit_time is not None, "time": pct_hit_time.isoformat() if pct_hit_time else None},
        },
        "outcome": {"result": outcome, "time": outcome_time.isoformat() if outcome_time else None, "conflict_policy": conflict_policy},
        "stats": {"mfe_pct": mfe_pct, "mae_pct": mae_pct, "pnl_close_pct": pnl_close_pct},
        "timing": {
            "mins_to_stop": _mins(stop_hit_time, entry_time),
            "mins_to_t1": _mins(t1_hit_time, entry_time),
            "mins_to_t2": _mins(t2_hit_time, entry_time),
            "mins_to_pct": _mins(pct_hit_time, entry_time),
        }
    }


# --------------------------
# EVENTS
# --------------------------
def push_event(event_type, ticker, scan_ts, details=None):
    global NEXT_EVENT_ID, EVENTS

    evt = {
        "id": NEXT_EVENT_ID,
        "ts": et_now_str(),
        "type": event_type,
        "Ticker": ticker,
        "ScanTimestamp": scan_ts,
        "details": details or {}
    }
    NEXT_EVENT_ID += 1

    EVENTS.append(evt)
    EVENTS = EVENTS[-200:]

    # Persist to CSV log
    df_evt = pd.DataFrame([{
        "id": evt["id"],
        "ts": evt["ts"],
        "type": evt["type"],
        "Ticker": evt["Ticker"],
        "ScanTimestamp": evt["ScanTimestamp"],
        "details": str(evt["details"])
    }])
    header = not os.path.exists(config.EVENT_LOG)
    df_evt.to_csv(config.EVENT_LOG, mode="a", header=header, index=False)

# --------------------------
# OUTCOME WORKER
# --------------------------
def outcome_worker():
    global LAST_EVENT_STATE

    while True:
        try:
            with STATE_LOCK:
                df_local = None if LATEST_DF is None else LATEST_DF.copy()

            if df_local is None or len(df_local) == 0:
                time.sleep(OUTCOME_REFRESH_SECONDS)
                continue

            rows = df_local.to_dict(orient="records")
            asof = et_now_str()

            df_out = update_outcomes_from_rows(rows, asof)

            if df_out is not None and len(df_out):
                for _, r in df_out.iterrows():
                    key = (r["Ticker"], r["ScanTimestamp"])
                    prev = LAST_EVENT_STATE.get(key, {
                        "EntryTriggered": False,
                        "Target1Hit": False,
                        "Target2Hit": False,
                        "StopHit": False
                    })

                    cur = {
                        "EntryTriggered": bool(r.get("EntryTriggered")),
                        "Target1Hit": bool(r.get("Target1Hit")),
                        "Target2Hit": bool(r.get("Target2Hit")),
                        "StopHit": bool(r.get("StopHit")),
                    }

                    with STATE_LOCK:
                        if cur["EntryTriggered"] and not prev["EntryTriggered"]:
                            push_event("ENTRY_TRIGGERED", r["Ticker"], r["ScanTimestamp"], {"EntryTime": r.get("EntryTime")})
                        if cur["Target1Hit"] and not prev["Target1Hit"]:
                            push_event("TARGET1_HIT", r["Ticker"], r["ScanTimestamp"], {"Target1Time": r.get("Target1Time")})
                        if cur["Target2Hit"] and not prev["Target2Hit"]:
                            push_event("TARGET2_HIT", r["Ticker"], r["ScanTimestamp"], {"Target2Time": r.get("Target2Time")})
                        if cur["StopHit"] and not prev["StopHit"]:
                            push_event("STOP_HIT", r["Ticker"], r["ScanTimestamp"], {"StopTime": r.get("StopTime")})

                        LAST_EVENT_STATE[key] = cur

        except Exception as e:
            print("❌ Outcome worker error:", e)
            tb_list = traceback.extract_tb(sys.exc_info()[2])
            line_number = tb_list[-1].lineno
            print(f"❌ Outcome worker on line: {line_number}")

        time.sleep(OUTCOME_REFRESH_SECONDS)

# --------------------------
# TRADE PLAN HELPERS
# --------------------------
def _round(x, nd=2):
    return None if x is None else round(float(x), nd)

def build_trade_plan_from_row(row: dict):
    pm = nullable_float(row.get("Premarket"), None)
    atr_pct = nullable_float(row.get("ATR %"), None)
    gap_dir = str(row.get("Gap Dir") or "").lower()

    if pm is None or pm <= 0:
        return {"Pattern": "N/A", "EntryLow": None, "EntryHigh": None, "Stop": None, "Target1": None, "Target2": None, "RR_T1": None, "RR_T2": None}

    atr_pct = atr_pct if (atr_pct is not None and atr_pct > 0) else 10.0
    atr_dollars = pm * (atr_pct / 100.0)

    if "up" not in gap_dir:
        return {"Pattern": "Watch (Non-up gap)", "EntryLow": None, "EntryHigh": None, "Stop": None, "Target1": None, "Target2": None, "RR_T1": None, "RR_T2": None}

    entry_low = pm * 1.005
    entry_high = pm * 1.012
    stop = entry_low - (0.60 * atr_dollars)
    target1 = entry_high + (1.00 * atr_dollars)
    target2 = entry_high + (1.80 * atr_dollars)

    risk = max(entry_high - stop, 0.01)
    rr1 = (target1 - entry_high) / risk
    rr2 = (target2 - entry_high) / risk

    return {
        "Pattern": "Premarket Breakout (ATR targets)",
        "EntryLow": _round(entry_low),
        "EntryHigh": _round(entry_high),
        "Stop": _round(stop),
        "Target1": _round(target1),
        "Target2": _round(target2),
        "RR_T1": _round(rr1, 2),
        "RR_T2": _round(rr2, 2),
    }

def apply_trade_sanity(row):
    base = float(row.get("Score") or 0.0)  # momentum score
    entry_high = nullable_float(row.get("EntryHigh"), None)
    stop = nullable_float(row.get("Stop"), None)
    rr2 = nullable_float(row.get("RR_T2"), None)

    if entry_high is None or stop is None or rr2 is None:
        return round(base * 0.60, 2)

    risk_pct = ((entry_high - stop) / entry_high) * 100.0 if entry_high > 0 else 999.0

    rr_penalty = 1.0
    if rr2 < 2.0:
        rr_penalty = 0.70
    elif rr2 < 2.5:
        rr_penalty = 0.85
    elif rr2 >= 3.0:
        rr_penalty = 1.05

    stop_penalty = 1.0
    if risk_pct > 12:
        stop_penalty = 0.70
    elif risk_pct > 9:
        stop_penalty = 0.82
    elif risk_pct > 6:
        stop_penalty = 0.92

    return round(base * rr_penalty * stop_penalty, 2)

def persist_scan(df, ts_str):
    safe_ts = ts_str.replace(":", "").replace(" ", "_")
    scan_path = os.path.join(config.SCAN_DIR, f"scan_{safe_ts}.csv")
    df.to_csv(scan_path, index=False)

    log_path = os.path.join(config.SIGNAL_DIR, "signals_log.csv")
    header = not os.path.exists(log_path)
    df.to_csv(log_path, mode="a", header=header, index=False)

# --------------------------
# SCANNER WORKER
# --------------------------
def scanner_worker():
    global LATEST_DF, PREVIOUS_SYMBOLS, ACTIVE_SIGNALS

    while True:
        try:
            print("🔄 Running scheduled scan...")

            df = scan(return_df=True)
            if df is None or len(df) == 0:
                print("ℹ️ No rows returned from scan()")
                time.sleep(REFRESH_SECONDS)
                continue

            current_symbols = set(df["Ticker"].astype(str))
            new_symbols = current_symbols - PREVIOUS_SYMBOLS
            df["NEW"] = df["Ticker"].astype(str).apply(lambda t: t in new_symbols)

            plans = df.apply(lambda r: build_trade_plan_from_row(r.to_dict()), axis=1)
            df = pd.concat([df.reset_index(drop=True), pd.DataFrame(list(plans)).reset_index(drop=True)], axis=1)

            if "Score" in df.columns:
                df["MomentumScore"] = df["Score"]
            else:
                df["MomentumScore"] = None

            df["Score"] = df.apply(apply_trade_sanity, axis=1)

            now_ts = et_now_str()
            current = set(df["Ticker"].astype(str))

            with STATE_LOCK:
                for t in list(ACTIVE_SIGNALS.keys()):
                    if t not in current:
                        del ACTIVE_SIGNALS[t]

                new_active = current - set(ACTIVE_SIGNALS.keys())
                for t in new_active:
                    ACTIVE_SIGNALS[t] = {"SignalId": str(uuid.uuid4()), "ScanTimestamp": now_ts}

                df["SignalId"] = df["Ticker"].astype(str).map(lambda t: ACTIVE_SIGNALS[t]["SignalId"])
                df["ScanTimestamp"] = df["Ticker"].astype(str).map(lambda t: ACTIVE_SIGNALS[t]["ScanTimestamp"])

                persist_scan(df, now_ts)

                LATEST_DF = df
                PREVIOUS_SYMBOLS = current_symbols

            if new_symbols:
                print(f"\n🆕 NEW TICKERS FOUND: {', '.join(sorted(new_symbols))}")
            print(f"✅ Published {len(df)} rows to API")

        except Exception as e:
            print("❌ Scanner error:", e)
            traceback.print_exc()

        time.sleep(REFRESH_SECONDS)

# --------------------------
# FLASK APP
# --------------------------
app = Flask(__name__)
CORS(app)

BLOCKED_ENDPOINTS = ["/api/events", "/api/scan", "/api/outcomes", "/static"]

class PollingFilter(logging.Filter):
    def filter(self, record):
        msg = record.getMessage()
        return not any(endpoint in msg for endpoint in BLOCKED_ENDPOINTS)

log = logging.getLogger("werkzeug")
if not config.DEBUG_API:
    log.addFilter(PollingFilter())

# --------------------------
# API ROUTES
# --------------------------
@app.route("/api/config/schema", methods=["GET"])
def api_config_schema():
    try:
        with open(config.CONFIG_FILE, "r") as f:
            cfg = json.load(f)

        schema_ref = cfg.get("$schema")
        if not schema_ref:
            return jsonify({"error": "Config missing $schema field"}), 500

        cfg_dir = os.path.dirname(os.path.abspath(config.CONFIG_FILE))
        schema_path = schema_ref if os.path.isabs(schema_ref) else os.path.join(cfg_dir, schema_ref)
        if not os.path.exists(schema_path):
            return jsonify({"error": f"Schema file not found: {schema_path}"}), 404

        with open(schema_path, "r") as f:
            schema = json.load(f)

        return jsonify(schema)
    except Exception as e:
        return jsonify({"error": f"Failed to load schema: {e}"}), 500

@app.route("/api/config", methods=["GET", "POST", "PUT"])
def api_config():
    if request.method == "GET":
        try:
            with open(config.CONFIG_FILE, "r") as f:
                return jsonify(json.load(f))
        except Exception as e:
            return jsonify({"ok": False, "errors": [{"path": "(root)", "message": str(e)}]}), 500

    payload = request.get_json(force=True) or {}
    if isinstance(payload, dict) and "config" in payload and isinstance(payload["config"], dict):
        payload = payload["config"]

    if not isinstance(payload, dict):
        return jsonify({"ok": False, "errors": [{"path": "(root)", "message": "Config must be a JSON object"}]}), 400

    try:
        with open(config.CONFIG_FILE, "w") as f:
            json.dump(payload, f, indent=2)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "errors": [{"path": "(root)", "message": str(e)}]}), 500

@app.route("/api/scan")
def api_scan():
    with STATE_LOCK:
        df_local = None if LATEST_DF is None else LATEST_DF.copy()

    if df_local is None:
        return jsonify({"rows": [], "timestamp": None})

    clean_df = sanitize_df_for_json(df_local)
    #safe = clean_df.where(pd.notnull(clean_df), None)

    return jsonify({"rows": clean_df.to_dict(orient="records"), "timestamp": et_now_str()})

@app.route("/api/outcomes")
def api_outcomes():
    path = "./history/outcomes/outcomes_log.csv"
    if not os.path.exists(path):
        return jsonify({"rows": []})
    df = pd.read_csv(path)
    return jsonify({"rows": df.tail(500).to_dict(orient="records")})

@app.route("/api/events")
def api_events():
    after_id = 0
    try:
        after_id = int(request.args.get("after_id", "0"))
    except:
        after_id = 0

    with STATE_LOCK:
        new_events = [e for e in EVENTS if e["id"] > after_id]
        latest_id = (EVENTS[-1]["id"] if EVENTS else after_id)

    return jsonify({"events": new_events, "latest_id": latest_id})

@app.post("/api/sim/run_day_batch")
def api_sim_run_day_batch():
    payload = request.get_json(force=True) or {}

    d = _parse_date(payload.get("date"))
    signal_time = _parse_time(payload.get("signal_time", "09:30:00"))
    signal_ts = _combine_ny(d, signal_time)

    interval = payload.get("bar_interval", "1m")
    cfg = payload.get("cfg", {}) or {}
    recs = payload.get("recs", []) or []

    # basic caching so we only download each ticker once
    cache = {}
    results = []

    for rec in recs:
        #symbol = str(rec.get("Ticker") or "").strip().upper()
        raw = rec.get("Ticker")
        if isinstance(raw, (list, tuple)):
            raw = raw[0] if raw else ""
        symbol = str(raw).strip().upper()
        if not symbol:
            results.append({"status": "ERROR", "reason": "Missing Ticker", "rec": rec})
            continue

        if symbol not in cache:
            try:
                print("DEBUG ticker raw:", repr(rec.get("Ticker")), "=> symbol:", repr(symbol), "type:", type(rec.get("Ticker")))
                cache[symbol] = _fetch_intraday_yahoo(symbol, d, interval)
            except Exception as e:
                cache[symbol] = None
                results.append({"status": "NO_DATA", "symbol": symbol, "reason": f"yfinance error: {e}"})
                continue

        try:
            r = _simulate_one(rec, cfg, cache[symbol], signal_ts)
            results.append(r)
        except Exception as e:
            results.append({"status": "ERROR", "symbol": symbol, "reason": str(e)})

    # Summary stats for tuning
    ok = [r for r in results if r.get("status") == "OK"]
    summary = {
        "count": len(results),
        "ok": len(ok),
        "filled": sum(1 for r in ok if r.get("entry", {}).get("price") is not None),
        "t1_hit": sum(1 for r in ok if r.get("levels", {}).get("t1", {}).get("hit")),
        "t2_hit": sum(1 for r in ok if r.get("levels", {}).get("t2", {}).get("hit")),
        "pct_hit": sum(1 for r in ok if r.get("levels", {}).get("pct", {}).get("hit")),
        "stop_hit": sum(1 for r in ok if r.get("levels", {}).get("stop", {}).get("hit")),
    }

    return jsonify({"summary": summary, "results": results})

# --------------------------
# START
# --------------------------
if __name__ == "__main__":
    print("\n🔥 Momentum Scanner API running on http://localhost:5000\n")

    threading.Thread(target=scanner_worker, daemon=True).start()
    threading.Thread(target=outcome_worker, daemon=True).start()

    app.run(debug=True, port=5000, use_reloader=False)
