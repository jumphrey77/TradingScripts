import sys
import importlib
import requests
import pandas as pd
import time
import platform
import json
import os
from pathlib import Path
from datetime import datetime
import pandas_market_calendars as mcal
from io import StringIO
import yfinance as yf
from concurrent.futures import ThreadPoolExecutor, as_completed
import math
from config import config
from utils import safe_float, safe_int

# ===========================
# USER SETTINGS
# ===========================


REQUEST_DELAY = 1.2
MAX_RESULTS = 400

MAX_WORKERS = 1
REFRESH_SECONDS = 60

# ===========================
# FINVIZ CONFIG
# ===========================

BASE_URL = "https://finviz.com/screener.ashx"
SCREENER_PARAMS = {"o": "-change"}

HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "text/html",
    "Accept-Language": "en-US,en;q=0.9",
}

_last_mtime = 0

def load_finviz_config():
#    global _last_mtime
#
#    mtime = config.CONFIG_FILE.stat().st_mtime
#    if mtime != _last_mtime:
#        _last_mtime = mtime
#        print("🔁 NEW Finviz Config Reloaded")
#TODO Fix Debug This

    with open(file=config.CONFIG_FILE, mode="r") as f:
        return json.load(f)


def finviz_url_from_config(cfg):

    filters = []

    # --- Price --- DONE
    if cfg.get("price") :
        # sh_price_u20
        filters.append(f"sh_price_{cfg['price']}")

    # --- Float --- DONE
    if cfg.get("float"):
        # sh_float_u5
        filters.append(f"sh_float_{cfg['float']}")

    # --- Avg Volume --- DONE
    if cfg.get("avgvol"):
        # sh_avgvol_o500
        filters.append(f"sh_avgvol_{cfg['avgvol']}")

    # --- Rel Volume --- DONE
    if cfg.get("relvol"):
        # sh_relvol_o2
        filters.append(f"sh_relvol_{cfg['relvol']}")

    # --- Currrent Volume ---  DONE
    if cfg.get("curvol"):
        filters.append(f"sh_curvol_{cfg['curvol']}")

    # --- News Date --- DONE
    if cfg.get("news"):
        # news_date_today
        filters.append(f"news_date_{cfg['news']}")

    # --- Exchange ---
    if cfg.get("exchange"):
        filters.append("sh_exch_" + ",".join(cfg["exchange"]))

    # --- Market Cap ---
    if cfg.get("market_cap"):
        filters.append(f"cap_{cfg['market_cap']}")

    # --- Gap ---
    if cfg.get("gap_min"):
        filters.append(f"ta_gap_o{cfg['gap_min']}")

    # --- Change ---  DONE
    if cfg.get("change"):
        # &ta_change_u5
        filters.append(f"ta_change_{cfg['change']}")

    joinedFilters =  ",".join(filters)

    return (f"{BASE_URL}?v=111&f={joinedFilters}")

# ===========================
# HELPERS
# ===========================
#region Region-Helpers
def debug(msg):
    if config.DEBUG:
        print(msg)

def output_symbol_analysis(msg):
    if config.OUTPUT_SYMBOL_ANALYSIS:
        print(msg)

# DEPENDENCY CHECKS
def check_module(name, pip_name=None):
    try:
        importlib.import_module(name)
        return True
    except ImportError:
        print(f"\n❌ Missing module: {name}")
        if pip_name:
            print(f"Install with: pip install {pip_name}")
        else:
            print(f"Install with: pip install {name}")
        return False

# DEPENDENCY CHECKS
def check_modules(check_module):
    print("\nChecking Required Modules...\n")

    html_ok = True
    html_ok &= check_module("lxml")
    html_ok &= check_module("bs4", "beautifulsoup4")
    #html_ok &= check_module("html5lib")
    html_ok &= check_module("pandas_market_calendars")
    
    if not html_ok:
        print("\nOne or more required HTML modules missing.")
        print("Install them then re-run this script.\n")
        #sys.exit(1)

def is_market_open(today=None):
    """
    Returns True if the market is open today, False otherwise.
    Uses NYSE calendar from pandas_market_calendars.
    """
    nyse = mcal.get_calendar("NYSE")
    
    if today is None:
        today = datetime.today()

    schedule = nyse.schedule(start_date=today, end_date=today)
    #Return Empty if closed
    #Empty True  = Closed
    #Empty False = Opon


    return not schedule.empty

def beep():
    if platform.system() == "Windows":
        import winsound
        winsound.Beep(1200, 500)
    else:
        print("\a")
#endregion

# ===========================
# FINVIZ FETCH
# ===========================

def fetch_finviz_page(start, url):

    #Last Minute Page Paramaters
    params = SCREENER_PARAMS.copy()
    params["r"] = start

    r = requests.get(url=url, headers=HEADERS, params=params, timeout=20)

    r.raise_for_status()

    #debug(f"Querying Finviz : {r.url}")

    tables = pd.read_html(StringIO(r.text))

    for t in tables:

        cols = [str(c).lower() for c in t.columns]
        
        # No Rows
        if len(t) == 0:
            continue

        # Must contain these columns
        required = ["ticker", "price", "change", "volume"]
        if not all(any(req in c for c in cols) for req in required):
            continue

        # Must be reasonably sized - 11 Columns Normal
        if len(t) > 20 or len(t.columns) != 11:
            continue

        #Check Forst Row
        if "ticker" in cols and "price" in cols and "change" in cols:
            if not isinstance(t.iloc[0]["Ticker"], str):
                continue 

        if "ticker" in cols and "price" in cols and "change" in cols:
            return t

    return None


# ===========================
# YAHOO METRICS (FAST)
# ===========================

def yahoo_metrics(symbol, use_premarket):
    """
    Returns metrics for a single ticker:
    - pre_price: last price used (pre-market or last close)
    - gap: percentage gap vs previous trading day
    - relvol: relative volume (today/avg20)
    - atr_pct: ATR as percentage of previous close

    USE_PREMARKET 
    determines whether to use live intraday bars or last full trading day
    """

    try:
        # --- Daily bars (30 days) ---
        daily = yf.download(symbol, period="30d", interval="1d", 
                            progress=False, threads=False)
        daily = daily.dropna()
        if daily.empty or len(daily) < 2:
            debug(f"{symbol}: Not enough daily data")
            return None

        # --- Force scalar MultiIndex-safe columns ---
        daily.columns = [c[0] if isinstance(c, tuple) else c for c in daily.columns]

        # --- Last trading day fallback ---
        last_day = daily.iloc[-1]
        prev_day = daily.iloc[-2]

        last_close = safe_float(last_day['Close'])
        last_vol = safe_float(last_day['Volume'])
        prev_close = safe_float(prev_day['Close'])

        # If any are missing, bail safely
        if last_close is None or last_vol is None or prev_close is None or prev_close <= 0:
            debug(f"{symbol}: missing close/volume data (last_close={last_close}, prev_close={prev_close}, last_vol={last_vol})")
            return None

        # --- Average volume (20-day) ---
        avg_vol_series = daily['Volume'].tail(20)
        avg_vol = safe_float(avg_vol_series.mean()) if not avg_vol_series.empty else None

        # --- ATR (14-day) ---
        h = daily['High']
        l = daily['Low']
        c = daily['Close'].shift(1)

        tr = pd.concat([
            h - l,
            (h - c).abs(),
            (l - c).abs()
        ], axis=1).max(axis=1)

        atr_val = tr.rolling(14).mean().iloc[-1]
        atr = safe_float(atr_val) if pd.notna(atr_val) else None
        atr_pct = round((atr / prev_close) * 100, 2) if atr is not None and prev_close > 0 else None

        # --- Use pre-market intraday if flag is set ---
        #TODO Use config.USEPREMATETDATA?
        if use_premarket:
             # pre-market intraday logic (prepost=True)
            intraday = yf.download(symbol, period="7d", interval="5m", prepost=True,
                                   progress=False, threads=False)
            intraday = intraday.dropna()
            if not intraday.empty:
                intraday.columns = [c[0] if isinstance(c, tuple) else c for c in intraday.columns]
                latest_idx = intraday.index.max()
                pre_val = intraday["Close"].loc[latest_idx]
                day_vol_val = intraday["Volume"].sum()

                pre_price = safe_float(pre_val) if pd.notna(pre_val) else last_close
                day_vol = safe_float(day_vol_val) if pd.notna(day_vol_val) else last_vol
            else:
                pre_price = last_close
                day_vol = last_vol
        else:
            pre_price = last_close
            day_vol = last_vol

        # --- Gap % ---
        gap = round((pre_price - prev_close) / prev_close * 100, 2) if prev_close > 0 else None

        # --- Relative Volume ---
        relvol = round(day_vol / avg_vol, 2) if avg_vol and day_vol and avg_vol > 0 else None

        #output_symbol_analysis(f"{symbol}: pre_price={pre_price} last_close={last_close} prev_close={prev_close} "
        #        f"gap={gap} relvol={relvol} atr%={atr_pct} day_vol={day_vol} avg_vol={avg_vol}")

        return {
            "pre": pre_price,
            "gap": gap,
            "relvol": relvol,
            "atr_pct": atr_pct
        }

    except Exception as e:
        import traceback
        debug(f"Yahoo error {symbol}: {e}")
        traceback.print_exc()
        return None
    
# ===========================
# MAIN
# ===========================

def scan(return_df=False):

    start = 1
    pages = []
 
    today = datetime.today()

    # GET FINVIZ CONFIG
    cfg = load_finviz_config()

    fv = cfg.get("finviz", {})
    sc = cfg.get("scanner", {})
    app = cfg.get("appsettings", {})

    # APPLICATION SETTINGS
    config.DEBUG = app.get("Debug", True)
    config.DEBUG_API = app.get("DebugAPI", False)
    config.USE_PREMARKET = app.get("UsePreMarketData", True)
    config.OUTPUT_SYMBOL_ANALYSIS = app.get("OutputSymbolAnalysis", False)
    
    # SCAN SETTINGS
    SC_MIN_PRICE = sc.get("price_min", 1)
    SC_MAX_PRICE = sc.get("price_max", 20)

    SC_GAP = sc.get("gap", 2)
    SC_RELVOL = sc.get("relvol", 1.5)
    SC_ATR = sc.get("atr", 2)
    SC_MIN_SCORE = sc.get("score_min", 200)

    url = finviz_url_from_config(fv)

    debug(f"  Built URL : {url}")

    # CHECK IF MARKETS AARE OPEN
    if not is_market_open(today):
        # Market CLOSED (weekend/holiday) → force EOD fallback
        use_premarket_flag = False
        debug("Market closed today → using last full trading day")
        debug(f"USE_PREMARKET set to {config.USE_PREMARKET}")
    else:
        # Market open → use whatever flag the user set
        use_premarket_flag = config.USE_PREMARKET

    # url = 'https://finviz.com/screener.ashx
    #   ?v=111
    #   &f=sh_float_u50,sh_relvol_o2,sh_curvol_o500,news_date_prevdays7,ta_change_u20'
    
    # FETCH FIN VIZ DATA
    while True:

        debug(f"\nFetching Finviz r={start}")

        tbl = fetch_finviz_page(start=start, url=url)

        if tbl is None:
            break

        pages.append(tbl)

        start += len(tbl)

        if start > MAX_RESULTS:
            break

        time.sleep(REQUEST_DELAY)

    debug(f"\nDone Fetching Finviz Pages")
    debug(f"   URL: {url}")

    finviz_df_all = pd.concat(pages)

    # Filter Out Unwanted Sectors
    ignoresectors = fv.get("ignoresectors", [])  # default to empty list

    print(f"IGNORE SECTORS CONFIG: {ignoresectors}")
    debug(f"TABLE COUNT BEFORE {len(finviz_df_all) if finviz_df_all is not None else 0}")

    finviz_df = finviz_df_all

    if finviz_df_all is not None and ignoresectors:
        ignoresectors_set = {s.strip().lower() for s in ignoresectors if s}

        # Column 3 is Sector
        sector_series = finviz_df_all.iloc[:, 3].astype(str).str.strip().str.lower()
        finviz_df = finviz_df_all[~sector_series.isin(ignoresectors_set)]

    debug(f"TABLE COUNT AFTER {len(finviz_df) if finviz_df is not None else 0}")

    tickers = finviz_df["Ticker"].unique().tolist()

    #debug(f"\nUniverse size: {len(tickers)}")

    results = []

    debug(f"USING PREMARKET DATA : {use_premarket_flag}\n")

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:

        futures = {
            pool.submit(yahoo_metrics, t, use_premarket_flag): t
            for t in tickers
        }

        for fut in as_completed(futures):

            t = futures[fut]

            metrics = fut.result()

            if not metrics:
                continue

            pre = safe_float(metrics.get("pre"), None)
            if pre is None:
                continue

            gap = max(safe_float(metrics.get("gap"), 0.0), 0.0)
            relvol = max(safe_float(metrics.get("relvol"), 0.0), 0.0)
            atr_pct = max(safe_float(metrics.get("atr_pct"), 0.0), 0.0)

            gap_term = math.log1p(min(gap, 120) / 20.0)             # heavier compression
            relvol_term = math.log1p(relvol) ** 1.15       # slight boost
            atr_term = math.log1p(atr_pct)

            raw = gap_term * relvol_term * atr_term

            score = round(raw * 55, 2)

            rejected = False

            #output_symbol_analysis(
            #    f"{t} Price={pre:.2f} Gap={gap:.2f}% RelVol={relvol:.2f} ATR%={atr_pct} Score={score}"
            #    )
            
            if pre is None or pre < SC_MIN_PRICE or pre > SC_MAX_PRICE:
                output_symbol_analysis(f"{t} ❌ Price limit [{pre}] [{SC_MIN_PRICE}-{SC_MAX_PRICE}]")
                rejected = True

            if gap is None or gap < SC_GAP:
                output_symbol_analysis(f"{t} ❌ Gap too small [{gap}] [{SC_GAP}]")
                rejected = True

            if relvol is None or relvol < SC_RELVOL:
                # Rel Volume is Loweer then our Min
                output_symbol_analysis(f"{t} ❌ RelVol low - Min [{relvol}] [{SC_RELVOL}]")
                rejected = True

            if atr_pct is None or atr_pct < SC_ATR:
                output_symbol_analysis(f"{t} ❌ ATR low {atr_pct} [{SC_ATR}]")
                rejected = True

            if score is None or score < SC_MIN_SCORE:
                output_symbol_analysis(f"{t} ❌ SCORE TR low [{score}] {SC_MIN_SCORE}]")
                rejected = True

            if rejected:
                output_symbol_analysis(f"")
                continue
            
            output_symbol_analysis(f"{t} ✅ Passed\n")

            gap_dir = "Up" if gap > 0 else "Down"

            tv_link = f"https://www.tradingview.com/chart/?symbol={t}"

            results.append({
                "Ticker": t,
                "Premarket": round(pre, 3),
                "Gap %": gap,
                "Gap Dir": gap_dir,
                "RelVol": round(relvol, 2),
                "ATR %": round(atr_pct, 2),
                "Score": score,
                "Chart": tv_link
            })

    debug(f"\nExporting to CSV")

    df = pd.DataFrame(results).sort_values("Score", ascending=False)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    
    #TODO SAVE TO DAY FOLDER
    daydirname = datetime.now().strftime("%Y-%m-%d")
    daypath = os.path.join(config.EXPORTS_DIR, daydirname)
    os.makedirs(daypath, exist_ok=True)
    print(f"DAY DIRECTORY {daydirname} | {daypath}")
    #csv_file = os.path.join(config.EXPORTS_DIR,f"{config.OUTPUT_PREFIX}_{timestamp}.csv")
    csv_file = os.path.join(config.EXPORTS_DIR, daydirname,f"{config.OUTPUT_PREFIX}_{timestamp}.csv")

    df.to_csv(csv_file, index=False)

    print(f"\n🔥 USE_PREMARKET is {config.USE_PREMARKET}")
    print(f"🔥 FINAL {len(df)} QUALIFIERS")
    print(df.head(25))
    print(f"\n💾 Saved to {csv_file}")

    if return_df:
        return df

if __name__ == "__main__":

    check_modules(check_module)
    
    previous_symbols = set()

    while True:
        df = scan()

        # New tickers logic
        current_symbols = set(df["Ticker"])
        new_symbols = current_symbols - previous_symbols

        if new_symbols:
            beep()
            #print("\n🆕 NEW TICKERS FOUND:")
            lstSort = sorted(new_symbols)
            output_string = ", ".join(lstSort)
            print(f"\n🆕 NEW TICKERS FOUND: {output_string}")
            #for s in lstSort:
            #    print("  ", s)

        previous_symbols = current_symbols
        
        time.sleep(REFRESH_SECONDS)
