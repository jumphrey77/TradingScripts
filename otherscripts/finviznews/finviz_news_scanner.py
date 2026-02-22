"""
finviz_scanner.py
-----------------
Scans Finviz news for tickers matching your price threshold and/or keywords.
Alerts via terminal sound + print. Logs all alerts to file.
Configure via config.json in the same directory.

Alert Priority Levels:
  [HIGH]    Ticker is under price threshold AND headline contains a keyword
  [WATCH]   Ticker is in your watchlist (any price)
  [PRICE]   Ticker is under price threshold (no keyword)
  [KEYWORD] Keyword matched but ticker is above price threshold
"""

import json
import os
import sys
import time
import winsound
import requests
from bs4 import BeautifulSoup
from datetime import datetime, timedelta
from collections import deque
from io import StringIO
import pandas as pd
import re

# ── Paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")

# ── Load config ────────────────────────────────────────────────────────────────
def load_config():
    with open(CONFIG_PATH, "r") as f:
        return json.load(f)

# ── Terminal helpers ───────────────────────────────────────────────────────────
RESET   = "\033[0m"
RED     = "\033[91m"
YELLOW  = "\033[93m"
CYAN    = "\033[96m"
GREEN   = "\033[92m"
MAGENTA = "\033[95m"
BOLD    = "\033[1m"
DIM     = "\033[2m"
WHITE   = "\033[97m"

def cls():
    os.system("cls" if os.name == "nt" else "clear")

def print_header(cfg):
    now       = datetime.now().strftime("%Y-%m-%d  %H:%M:%S ET")
    threshold = cfg["price_threshold_dollars"]
    interval  = cfg["scan_interval_seconds"]
    watches   = cfg.get("watchlist", [])
    print(f"{BOLD}{CYAN}{'━'*85}{RESET}")
    print(f"{BOLD}{CYAN}  FINVIZ NEWS SCANNER{RESET}  {DIM}|  Price ≤ ${threshold:.2f}  |  Scan every {interval}s  |  {now}{RESET}")
    print(f"{BOLD}{CYAN}{'━'*85}{RESET}")
    print(f"  {DIM}Keywords : {', '.join(cfg['keywords'][:6])}{'...' if len(cfg['keywords'])>6 else ''}{RESET}")
    if watches:
        print(f"  {DIM}Watchlist: {', '.join(watches)}{RESET}")
    print(f"{CYAN}{'─'*80}{RESET}\n")

# ── Beep: ONE beep per scan, pitched by highest priority ──────────────────────
PRIORITY_ORDER = {"HIGH": 0, "WATCH": 1, "PRICE": 2, "KEYWORD": 3}

def beep_scan(cfg, alerts):
    if not alerts:
        return
    highest = min(alerts, key=lambda a: PRIORITY_ORDER.get(a["priority"], 99))["priority"]
    repeat  = cfg.get("alert_sound_repeat", 3)
    if highest == "HIGH":
        for _ in range(repeat):
            winsound.Beep(1200, 200)
            time.sleep(0.1)
    elif highest == "WATCH":
        winsound.Beep(950, 300)
        time.sleep(0.12)
        winsound.Beep(950, 300)
    elif highest == "PRICE":
        winsound.Beep(800, 300)
        time.sleep(0.12)
        winsound.Beep(800, 300)
    else:
        winsound.Beep(600, 450)

def priority_label(priority):
    if priority == "HIGH":
        return f"{RED}{BOLD}[HIGH ★ ]{RESET}"
    elif priority == "WATCH":
        return f"{MAGENTA}{BOLD}[WATCH  ]{RESET}"
    elif priority == "PRICE":
        return f"{YELLOW}{BOLD}[PRICE ↑]{RESET}"
    else:
        return f"{CYAN}[KEYWORD]{RESET}"

# ── Age string → estimated ET datetime ────────────────────────────────────────
def age_to_et(age_str):
    """
    Convert Finviz age strings like '27 min', '1 hour', '2 hours', '10:35AM'
    into an estimated wall-clock ET datetime string.
    """
    now = datetime.now()
    age = age_str.strip().lower()

    # Already a wall-clock time e.g. "10:35AM"
    match = re.match(r"(\d{1,2}):(\d{2})\s*(am|pm)?", age)
    if match:
        h, m = int(match.group(1)), int(match.group(2))
        meridiem = match.group(3)
        if meridiem == "pm" and h != 12:
            h += 12
        elif meridiem == "am" and h == 12:
            h = 0
        dt = now.replace(hour=h, minute=m, second=0, microsecond=0)
        return dt.strftime("%b %d  %I:%M %p ET")

    match = re.match(r"(\d+)\s*min", age)
    if match:
        dt = now - timedelta(minutes=int(match.group(1)))
        return dt.strftime("%b %d  %I:%M %p ET")

    match = re.match(r"(\d+)\s*hour", age)
    if match:
        dt = now - timedelta(hours=int(match.group(1)))
        return dt.strftime("%b %d  %I:%M %p ET")

    match = re.match(r"(\d+)\s*day", age)
    if match:
        dt = now - timedelta(days=int(match.group(1)))
        return dt.strftime("%b %d  %I:%M %p ET")

    return age_str

# ── Fetch Finviz news page ─────────────────────────────────────────────────────
def fetch_news(cfg):
    headers = {"User-Agent": cfg["user_agent"]}
    try:
        resp = requests.get(cfg["finviz_news_url"], headers=headers, timeout=15)
        resp.raise_for_status()
        return resp.text
    except Exception as e:
        print(f"{RED}  [ERROR] Could not fetch news: {e}{RESET}")
        return None

# ── Parse news rows ────────────────────────────────────────────────────────────
def parse_news_rows(html):
    """
    Returns list of dicts:
      { 'age': str, 'headline': str, 'tickers': [str,...], 'source': str }
    Each row can have multiple ticker badges (up to 9+).
    """
    soup = BeautifulSoup(html, "html.parser")
    rows = []

    news_table = soup.find("table", {"id": "news-table"})
    if not news_table:
        news_table = soup.find("table", class_=lambda c: c and "news" in c.lower())
    if not news_table:
        for t in soup.find_all("table"):
            if t.find("a", class_=lambda c: c and "news" in str(c).lower()):
                news_table = t
                break
    if not news_table:
        return rows

    for tr in news_table.find_all("tr"):
        tds = tr.find_all("td")
        if not tds:
            continue

        time_text = ""
        for td in tds:
            txt = td.get_text(strip=True)
            if txt and (":" in txt or "am" in txt.lower() or "pm" in txt.lower()
                        or "hour" in txt.lower() or "min" in txt.lower() or "day" in txt.lower()):
                time_text = txt
                break

        headline = ""
        link_tag = tr.find("a", class_=lambda c: c and "tab-link" in str(c))
        if not link_tag:
            link_tag = tr.find("a", class_=lambda c: c and "news-link" in str(c))
        if not link_tag:
            for a in tr.find_all("a"):
                cls_str = " ".join(a.get("class", []))
                if "ticker" not in cls_str and len(a.get_text(strip=True)) > 15:
                    link_tag = a
                    break
        if link_tag:
            headline = link_tag.get_text(strip=True)

        tickers = []
        for a in tr.find_all("a"):
            cls_val = " ".join(a.get("class", []))
            txt = a.get_text(strip=True)
            if (txt and txt.isupper() and 1 <= len(txt) <= 5
                    and ("ticker" in cls_val.lower() or "tab-link" not in cls_val.lower())):
                if txt not in tickers and txt != headline:
                    tickers.append(txt)

        source = ""
        for td in reversed(tds):
            txt = td.get_text(strip=True)
            if txt and len(txt) > 2 and not txt.isupper():
                source = txt
                break

        if headline and tickers:
            rows.append({
                "age":      time_text,
                "headline": headline,
                "tickers":  tickers,
                "source":   source,
            })

    return rows

# ── Screener price fetch (paginated, pandas-based) ─────────────────────────────
SCREENER_VIEW = "111"
SCREENER_COLS = "0,1,2,65"

def _fetch_screener_page(url, ticker_str, start, headers):
    params = {"v": SCREENER_VIEW, "t": ticker_str, "c": SCREENER_COLS, "r": start}
    try:
        resp   = requests.get(url, headers=headers, params=params, timeout=20)
        resp.raise_for_status()
        tables = pd.read_html(StringIO(resp.text))
    except Exception:
        return None

    for t in tables:
        cols = [str(c).lower() for c in t.columns]
        if len(t) == 0:
            continue
        required = ["ticker", "price", "change", "volume"]
        if not all(any(req in c for c in cols) for req in required):
            continue
        if len(t) > 20 or len(t.columns) != 11:
            continue
        if not isinstance(t.iloc[0]["Ticker"], str):
            continue
        return t
    return None

def fetch_ticker_prices(tickers, cfg):
    if not tickers:
        return {}
    prices     = {}
    headers    = {"User-Agent": cfg["user_agent"]}
    url        = cfg["finviz_screener_base_url"]
    ticker_str = ",".join(tickers)
    start = 1
    while True:
        df = _fetch_screener_page(url, ticker_str, start, headers)
        if df is None or len(df) == 0:
            break
        for _, row in df.iterrows():
            ticker = str(row.get("Ticker", "")).strip()
            raw    = row.get("Price", None)
            if ticker:
                try:
                    prices[ticker] = float(str(raw).replace(",", ""))
                except (ValueError, TypeError):
                    prices[ticker] = None
        if len(df) < 20:
            break
        start += 20
        time.sleep(0.5)
    return prices

# ── Keyword matching ───────────────────────────────────────────────────────────
def headline_has_keyword(headline, keywords):
    hl = headline.lower()
    return [kw for kw in keywords if kw.lower() in hl]

# ── Logging ────────────────────────────────────────────────────────────────────
def log_alert(cfg, alert):
    log_path = os.path.join(SCRIPT_DIR, cfg["log_file"])
    with open(log_path, "a", encoding="utf-8") as f:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        f.write(
            f"{ts} | {alert['priority']:8s} | "
            f"{alert['ticker']:6s} | "
            f"${alert.get('price','?'):>7} | "
            f"News: {alert.get('news_time','?'):22s} | "
            f"KW: {', '.join(alert.get('keywords',[])) or 'none':30s} | "
            f"{alert['headline'][:80]} | "
            f"{alert['source']}\n"
        )

# ── Display rolling window — most recent ON TOP ────────────────────────────────
def display_rolling(rolling, cfg):
    window = cfg.get("rolling_display_window", 20)
    # Take last N from the deque and reverse so newest is first
    recent = list(rolling)[-window:][::-1]
    print(f"\n{BOLD}{WHITE}  Recent Alerts  (showing {len(recent)} of {len(rolling)} total):{RESET}")
    print(f"  {DIM}{'─'*76}{RESET}")
    for a in recent:
        pl      = priority_label(a["priority"])
        tk      = f"{BOLD}{a['ticker']:<4}{RESET}"
        price   = f"${a.get('price','?')}"
        news_ts = a.get("news_time", a["timestamp"])
        kws     = ", ".join(a.get("keywords", [])) or ""
        hl      = a["headline"][:50] + ("…" if len(a["headline"]) > 50 else "")
        kw_str  = f"  {GREEN}↳ {kws}{RESET}" if kws else ""
        print(f"  {DIM}{news_ts}{RESET}  {pl}  {tk}  {YELLOW}{price:>8}{RESET}  {hl}{kw_str}")
    print()

# ── Main scan loop ─────────────────────────────────────────────────────────────
def main():
    print(f"{BOLD}{CYAN}Starting Finviz News Scanner...{RESET}")
    print(f"Config: {CONFIG_PATH}\n")

    # Key = "TICKER::headline_text" — persists across scans to prevent duplicates
    seen_headlines = set()
    rolling        = deque(maxlen=500)
    scan_count     = 0

    while True:
        cfg       = load_config()
        threshold = cfg["price_threshold_dollars"]
        keywords  = cfg["keywords"]
        mode      = cfg.get("keyword_alert_mode", "both")
        watchlist = set(t.upper() for t in cfg.get("watchlist", []))

        cls()
        print_header(cfg)

        scan_count += 1
        print(f"  {DIM}Scan #{scan_count}  |  Fetching news...{RESET}")

        html = fetch_news(cfg)
        if not html:
            time.sleep(cfg["scan_interval_seconds"])
            continue

        rows        = parse_news_rows(html)
        all_tickers = list({t for row in rows for t in row["tickers"]})
        print(f"  {DIM}Parsed {len(rows)} rows  |  {len(all_tickers)} unique tickers  |  Fetching prices...{RESET}")

        prices   = fetch_ticker_prices(all_tickers, cfg)
        resolved = sum(1 for v in prices.values() if v is not None)
        print(f"  {DIM}Prices resolved: {resolved}/{len(all_tickers)}{RESET}\n")

        new_alerts = []

        for row in rows:
            headline    = row["headline"]
            tickers     = row["tickers"]
            source      = row["source"]
            age         = row["age"]
            # Compute news time ONCE per row using the age at parse time
            news_time   = age_to_et(age)
            matched_kws = headline_has_keyword(headline, keywords)

            for ticker in tickers:
                # ── Dedup key: ticker + raw headline text (not computed time)
                # This persists across scans so the same story is never re-alerted
                key = f"{ticker}::{headline}"
                if key in seen_headlines:
                    continue

                price           = prices.get(ticker)
                under_threshold = (price is not None and price <= threshold)
                is_watched      = ticker in watchlist

                priority = None
                if under_threshold and matched_kws:
                    priority = "HIGH"
                elif is_watched:
                    priority = "WATCH"
                elif under_threshold and mode in ("both", "price"):
                    priority = "PRICE"
                elif matched_kws and mode in ("both", "keyword"):
                    priority = "KEYWORD"

                if priority:
                    seen_headlines.add(key)   # Mark as seen — will not re-fire
                    alert = {
                        "timestamp": datetime.now().strftime("%H:%M:%S"),
                        "news_time": news_time,
                        "priority":  priority,
                        "ticker":    ticker,
                        "price":     f"{price:.2f}" if price is not None else "N/A",
                        "keywords":  matched_kws,
                        "headline":  headline,
                        "source":    source,
                        "age":       age,
                    }
                    rolling.append(alert)
                    log_alert(cfg, alert)
                    new_alerts.append(alert)

        # ── Fire ONE beep for the whole scan ──────────────────────────────────
        if new_alerts:
            new_alerts.sort(key=lambda a: PRIORITY_ORDER.get(a["priority"], 99))
            beep_scan(cfg, new_alerts)

            print(f"\n{RED}{BOLD}  *** {len(new_alerts)} NEW ALERT(S) THIS SCAN ***{RESET}\n")
            for alert in new_alerts:
                pl    = priority_label(alert["priority"])
                tk    = f"{BOLD}{alert['ticker']:<4}{RESET}"
                price = f"${alert['price']}"
                kws   = f"  {GREEN}[{', '.join(alert['keywords'])}]{RESET}" if alert["keywords"] else ""
                print(f"  {pl}  {tk}  {YELLOW}{price:>8}{RESET}  {DIM}{alert['news_time']}{RESET}  {alert['headline'][:55]}{kws}")
                print(f"            {DIM}{alert['source']}{RESET}\n")
        else:
            print(f"  {DIM}No new alerts this scan.{RESET}\n")

        if rolling:
            display_rolling(rolling, cfg)

        # ── Footer with next scan time ────────────────────────────────────────
        interval  = cfg["scan_interval_seconds"]
        next_scan = (datetime.now() + timedelta(seconds=interval)).strftime("%I:%M %p")
        print(f"  {DIM}Next scan in {interval}s  @  {next_scan} ET  |  Edit config.json anytime{RESET}")
        print(f"  {DIM}Log: {os.path.join(SCRIPT_DIR, cfg['log_file'])}{RESET}")
        print(f"{CYAN}{'─'*80}{RESET}")

        time.sleep(interval)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print(f"\n\n{YELLOW}Scanner stopped.{RESET}\n")
        sys.exit(0)