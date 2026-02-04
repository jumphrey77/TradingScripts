import json
from flask_cors import CORS
import pandas as pd
import traceback
import threading
import time
import os
import sys
import uuid
from datetime import datetime
from outcomes import update_outcomes_from_rows
from flask import Flask, jsonify, request
import logging
from config import config
from utils import sanitize_df_for_json, et_now_str, nullable_float

from Production_Grade_Scanner import scan   # <-- change filename if needed

LATEST_DF = None
PREVIOUS_SYMBOLS = set()
ACTIVE_SIGNALS = {}  # Ticker -> {"SignalId": "...", "ScanTimestamp": "..."}
REFRESH_SECONDS = 60
OUTCOME_REFRESH_SECONDS = 30  # faster is fine; Yahoo 1m updates anyway
#SCAN_TS = None
EVENTS = []          # in-memory ring (simple)
NEXT_EVENT_ID = 1
LAST_EVENT_STATE = {}  # key: (Ticker, ScanTimestamp) -> dict of last booleans

os.makedirs(config.EVENT_DIR, exist_ok=True)
os.makedirs(config.SCAN_DIR, exist_ok=True)
os.makedirs(config.SIGNAL_DIR, exist_ok=True)
os.makedirs(config.EXPORTS_DIR, exist_ok=True)

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
    EVENTS = EVENTS[-200:]  # keep last 200 in memory

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

def outcome_worker():
    global LATEST_DF, LAST_EVENT_STATE

    while True:
        try:
            if LATEST_DF is None or len(LATEST_DF) == 0:
                time.sleep(OUTCOME_REFRESH_SECONDS)
                continue

            rows = LATEST_DF.to_dict(orient="records")
            asof = datetime.now().strftime("%Y-%m-%d %H:%M:%S ET")

            df_out = update_outcomes_from_rows(rows, asof)

            # Emit events only on state transitions (False -> True)
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
            line_number = tb_list[-1].lineno # Use .lineno attribute in newer Python versions
            # In older Python versions, it might be accessing the second element of a tuple: tb_list[-1][1]
            print(f"❌ Outcome worker on line: {line_number}")

        time.sleep(OUTCOME_REFRESH_SECONDS)


def _round(x, nd=2):
    return None if x is None else round(float(x), nd)

def build_trade_plan_from_row(row: dict):
    """
    V1 trade plan using only fields you already have:
      - Premarket (price)
      - ATR % (volatility proxy)
      - Gap Dir (Up/Down)
    """
    pm = nullable_float(row.get("Premarket"), None)
    atr_pct = nullable_float(row.get("ATR %"), None)
    gap_dir = str(row.get("Gap Dir") or "").lower()

    if pm is None or pm <= 0:
        return {
            "Pattern": "N/A",
            "EntryLow": None, "EntryHigh": None,
            "Stop": None,
            "Target1": None, "Target2": None,
            "RR_T1": None, "RR_T2": None,
        }

    # Convert ATR% to a rough dollar ATR (works without minute bars)
    atr_pct = atr_pct if (atr_pct is not None and atr_pct > 0) else 10.0
    atr_dollars = pm * (atr_pct / 100.0)

    # Only generate long continuation plans for "Up" gappers in V1
    if "up" not in gap_dir:
        return {
            "Pattern": "Watch (Non-up gap)",
            "EntryLow": None, "EntryHigh": None,
            "Stop": None,
            "Target1": None, "Target2": None,
            "RR_T1": None, "RR_T2": None,
        }

    # Entry zone: small continuation breakout above current PM price
    entry_low = pm * 1.005
    entry_high = pm * 1.012

    # Stop: below entry by fraction of ATR
    stop = entry_low - (0.60 * atr_dollars)

    # Targets: ATR-based extensions
    target1 = entry_high + (1.00 * atr_dollars)
    target2 = entry_high + (1.80 * atr_dollars)

    # Risk/Reward from entry_high (conservative)
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

def persist_scan(df, ts_str):
    """
    Save:
      1) Snapshot CSV per scan (replay/backtest)
      2) Rolling append log (single growing file)
    """
    safe_ts = ts_str.replace(":", "").replace(" ", "_")
    scan_path = os.path.join(config.SCAN_DIR, f"scan_{safe_ts}.csv")
    df.to_csv(scan_path, index=False)

    log_path = os.path.join(config.SIGNAL_DIR, "signals_log.csv")
    df_with_ts = df.copy()
    
    #df_with_ts.insert(0, "ScanTimestamp", ts_str)
    # ✅ overwrite-safe (no insert)
    df_with_ts["ScanTimestamp"] = ts_str

    header = not os.path.exists(log_path)
    df_with_ts.to_csv(log_path, mode="a", header=header, index=False)

def apply_trade_sanity(row):
    
    base = float(row.get("Score") or 0.0)   # this is MomentumScore from scanner

    entry_high = nullable_float(row.get("EntryHigh"), None)
    stop = nullable_float(row.get("Stop"), None)
    rr2 = nullable_float(row.get("RR_T2"), None)

    # If no plan, downgrade hard
    if entry_high is None or stop is None or rr2 is None:
        return round(base * 0.60, 2)

    # Risk % from entry to stop
    risk_pct = ((entry_high - stop) / entry_high) * 100.0 if entry_high > 0 else 999.0

    # --- Penalties ---
    # 1) RR penalty (we want RR_T2 >= 2.0)
    rr_penalty = 1.0
    if rr2 < 2.0:
        rr_penalty = 0.70
    elif rr2 < 2.5:
        rr_penalty = 0.85
    elif rr2 >= 3.0:
        rr_penalty = 1.05  # small boost for great RR

    # 2) Too-wide stop penalty
    stop_penalty = 1.0
    if risk_pct > 12:
        stop_penalty = 0.70
    elif risk_pct > 9:
        stop_penalty = 0.82
    elif risk_pct > 6:
        stop_penalty = 0.92

    # Final
    return round(base * rr_penalty * stop_penalty, 2)

#1.3 Good
def scanner_worker():
    global LATEST_DF, PREVIOUS_SYMBOLS, ACTIVE_SIGNALS

    while True:
        try:
            print("\n🔄 Running scheduled scan...")

            df = scan(return_df=True)

            if df is None or len(df) == 0:
                print("ℹ️ No rows returned from scan()")
                time.sleep(REFRESH_SECONDS)
                continue

            # ----------------------------
            # 1) NEW flags (based on last scan results)
            # ----------------------------
            current_symbols = set(df["Ticker"].astype(str))
            new_symbols = current_symbols - PREVIOUS_SYMBOLS
            df["NEW"] = df["Ticker"].astype(str).apply(lambda t: t in new_symbols)

            # ----------------------------
            # 2) Add plans + scoring
            #    (Do this BEFORE persisting; does NOT touch SignalId)
            # ----------------------------
            plans = df.apply(lambda r: build_trade_plan_from_row(r.to_dict()), axis=1)
            plans_df = pd.DataFrame(list(plans))
            df = pd.concat([df.reset_index(drop=True), plans_df.reset_index(drop=True)], axis=1)

            # Keep original score for debugging
            if "Score" in df.columns:
                df["MomentumScore"] = df["Score"]
            else:
                df["MomentumScore"] = None

            # Final score used by UI
            df["Score"] = df.apply(apply_trade_sanity, axis=1)

            # ----------------------------
            # 3) Stable SignalId + stable ScanTimestamp per active ticker
            #    ✅ Assign ONLY when ticker becomes newly active
            # ----------------------------
            now_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S ET")
            current = set(df["Ticker"].astype(str))

            # Remove tickers that are no longer active
            for t in list(ACTIVE_SIGNALS.keys()):
                if t not in current:
                    del ACTIVE_SIGNALS[t]

            # Assign ids to newly active tickers (ONLY)
            new_active = current - set(ACTIVE_SIGNALS.keys())
            for t in new_active:
                ACTIVE_SIGNALS[t] = {
                    "SignalId": str(uuid.uuid4()),
                    "ScanTimestamp": now_ts
                }

            # Apply stable fields to df (overwrite-safe)
            df["SignalId"] = df["Ticker"].astype(str).map(lambda t: ACTIVE_SIGNALS[t]["SignalId"])
            df["ScanTimestamp"] = df["Ticker"].astype(str).map(lambda t: ACTIVE_SIGNALS[t]["ScanTimestamp"])

            # ----------------------------
            # 4) Persist (use a scan-run timestamp)
            #    IMPORTANT: your persist_scan should NOT insert ScanTimestamp if it exists
            #    (you fixed this already)
            # ----------------------------
            persist_scan(df, now_ts)

            # ----------------------------
            # 5) Publish to API + update memory
            # ----------------------------
            LATEST_DF = df
            PREVIOUS_SYMBOLS = current_symbols

            if new_symbols:
                #print("\n🆕 NEW TICKERS FOUND:")
                #for s in sorted(new_symbols):
                #    print("  ", s)
                #lstSort = sorted(new_symbols)
                output_string = ", ".join(new_symbols)
                print(f"\n🆕 NEW TICKERS FOUND: {output_string}")

            print(f"✅ Published {len(df)} rows to API")

        except Exception as e:
            import traceback
            print("❌ Scanner error:", e)
            traceback.print_exc()

        time.sleep(REFRESH_SECONDS)

app = Flask(__name__)
CORS(app)

# --------------------------
# DEBUGGING/LOGGING
# --------------------------

# List all endpoints you want to hide from the terminal logs
BLOCKED_ENDPOINTS = [
    "/api/events",
    "/api/scan",
    "/api/events", 
    "/api/outcomes",
    "/static"  # You can even hide static file requests
]

class PollingFilter(logging.Filter):
    def filter(self, record):
        msg = record.getMessage()
        # Returns False if ANY blocked endpoint is found in the log message
        return not any(endpoint in msg for endpoint in BLOCKED_ENDPOINTS)

log = logging.getLogger('werkzeug')

for x in log.filters:
    print(f"LOG FILTERS {x.filter}")


poll_filter = PollingFilter()
if not config.DEBUG_API:
    log.addFilter(poll_filter)
else:
    log.removeFilter(poll_filter)

#if not config.DEBUG_API:
#    #Suppress Logging    
#    log.addFilter(PollingFilter())
#else:
#    log.removeFilter(PollingFilter)

# --------------------------
# API ROUTES
# --------------------------
@app.route("/api/config/schema", methods=["GET"])
def api_config_schema():
    """
    Return the REAL schema JSON referenced by the config's "$schema" field.
    This is what your React editor expects (nested properties, oneOf enums, $defs, etc).
    """
    try:
        # Load config to locate $schema
        with open(config.CONFIG_FILE, "r") as f:
            cfg = json.load(f)

        schema_ref = cfg.get("$schema")
        if not schema_ref:
            return jsonify({"error": "Config missing $schema field"}), 500

        # Resolve relative to the config file directory
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
    
    #GET METHOD
    if request.method == "GET":
        try:
            with open(config.CONFIG_FILE, "r") as f:
                return jsonify(json.load(f))
        except Exception as e:
            return jsonify({"ok": False, "errors": [{"path": "(root)", "message": str(e)}]}), 500

    # POST/PUT save
    payload = request.get_json(force=True) or {}

    # Accept either {config: {...}} OR direct {...}
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

#-- NEW ABOVE
@app.route("/api/scan")

def api_scan():
    global LATEST_DF

    if LATEST_DF is None:
        return jsonify({"rows": [], "timestamp": None})    

    clean_df = sanitize_df_for_json(LATEST_DF)

    safe = clean_df.where(pd.notnull(clean_df), None)

    return jsonify({
        "rows": safe.to_dict(orient="records"),
        "timestamp": et_now_str()
    })
        
@app.route("/api/outcomes")

def api_outcomes():
    path = "./history/outcomes/outcomes_log.csv"
    
    if not os.path.exists(path):
        return jsonify({"rows": []})
    df = pd.read_csv(path)

    # return last 500 rows max
    return jsonify({"rows": df.tail(500).to_dict(orient="records")})

@app.route("/api/events")

def api_events():
    # /api/events?after_id=123
    after_id = 0
    try:
        after_id = int(request.args.get("after_id", "0"))
    except:
        after_id = 0

    new_events = [e for e in EVENTS if e["id"] > after_id]
    return jsonify({"events": new_events, "latest_id": (EVENTS[-1]["id"] if EVENTS else after_id)})

# --------------------------
# START SERVER
# --------------------------
    
if __name__ == "__main__":

    print("\n🔥 Momentum Scanner API running on http://localhost:5000\n")

    t1 = threading.Thread(target=scanner_worker, daemon=True)
    t1.start()

    # OUTCOMES THREAD
    t2 = threading.Thread(target=outcome_worker, daemon=True)
    t2.start()

    app.run(debug=True, port=5000, use_reloader=False)