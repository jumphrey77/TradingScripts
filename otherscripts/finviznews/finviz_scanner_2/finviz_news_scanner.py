"""
finviz_scanner.py
-----------------
Scans Finviz news for tickers matching your price threshold and/or keywords.
Alerts via terminal sound + print. Logs all alerts to file.
Configure via config.json in the same directory.

Alert Priority Levels :
  [HIGH]   Ticker is under price threshold AND headline contains a keyword
  [PRICE]  Ticker is under price threshold (screener match only)
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

# ── Paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")

# ── Load config ────────────────────────────────────────────────────────────────
def load_config():
    with open(CONFIG_PATH, "r") as f:
        return json.load(f)

# ── Terminal helpers ───────────────────────────────────────────────────────────
RESET  = "\033[0m"
RED    = "\033[91m"
YELLOW = "\033[93m"
CYAN   = "\033[96m"
GREEN  = "\033[92m"
BOLD   = "\033[1m"
DIM    = "\033[2m"
WHITE  = "\033[97m"

def cls():
    os.system("cls" if os.name == "nt" else "clear")

def print_header(cfg):
    now = datetime.now().strftime("%Y-%m-%d  %H:%M:%S")
    threshold = cfg["price_threshold_dollars"]
    interval  = cfg["scan_interval_seconds"]
    print(f"{BOLD}{CYAN}{'━'*80}{RESET}")
    print(f"{BOLD}{CYAN}  FINVIZ NEWS SCANNER{RESET}  {DIM}|  Price ≤ ${threshold:.2f}  |  Scan every {interval}s  |  {now}{RESET}")
    print(f"{BOLD}{CYAN}{'━'*80}{RESET}")
    print(f"  {DIM}Keywords: {', '.join(cfg['keywords'][:6])}{'...' if len(cfg['keywords'])>6 else ''}{RESET}")
    print(f"{CYAN}{'─'*80}{RESET}\n")

def beep(cfg, priority):
    """Play different beep patterns based on priority."""
    repeat = cfg.get("alert_sound_repeat", 3)
    if priority == "HIGH":
        # Urgent: fast triple beep
        for _ in range(repeat):
            winsound.Beep(1200, 200)
            time.sleep(0.1)
    elif priority == "PRICE":
        # Medium: two beeps
        for _ in range(2):
            winsound.Beep(900, 300)
            time.sleep(0.15)
    else:
        # Keyword only: single lower beep
        winsound.Beep(600, 400)

def priority_color(priority):
    if priority == "HIGH":
        return RED + BOLD
    elif priority == "PRICE":
        return YELLOW + BOLD
    else:
        return CYAN

def priority_label(priority):
    if priority == "HIGH":
        return f"{RED}{BOLD}[HIGH ★]{RESET}"
    elif priority == "PRICE":
        return f"{YELLOW}{BOLD}[PRICE ↑]{RESET}"
    else:
        return f"{CYAN}[KEYWORD]{RESET}"

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
    Finviz news page shows up to ~90 stories.
    Each row can have multiple ticker badges.
    """
    soup = BeautifulSoup(html, "html.parser")
    rows = []

    # News rows live in a table with class 'news-table' or similar
    # We look for all <tr> that contain news-link elements
    news_table = soup.find("table", {"id": "news-table"})
    if not news_table:
        # Fallback: find any table containing news-link class
        news_table = soup.find("table", class_=lambda c: c and "news" in c.lower())
    if not news_table:
        # Broader fallback
        all_tables = soup.find_all("table")
        for t in all_tables:
            if t.find("a", class_=lambda c: c and "news" in str(c).lower()):
                news_table = t
                break

    if not news_table:
        return rows

    current_date = None
    for tr in news_table.find_all("tr"):
        tds = tr.find_all("td")
        if not tds:
            continue

        # Timestamp cell
        time_text = ""
        for td in tds:
            txt = td.get_text(strip=True)
            if txt and (":" in txt or "Today" in txt or "am" in txt.lower() or "pm" in txt.lower() or "hour" in txt.lower() or "min" in txt.lower()):
                time_text = txt
                break

        # Headline link
        headline = ""
        link_tag = tr.find("a", class_=lambda c: c and "tab-link" in str(c))
        if not link_tag:
            link_tag = tr.find("a", class_=lambda c: c and "news-link" in str(c))
        if not link_tag:
            # any <a> that's not a ticker
            links = tr.find_all("a")
            for a in links:
                cls_val = a.get("class", [])
                cls_str = " ".join(cls_val) if cls_val else ""
                if "ticker" not in cls_str and len(a.get_text(strip=True)) > 15:
                    link_tag = a
                    break
        if link_tag:
            headline = link_tag.get_text(strip=True)

        # All tickers on this row — Finviz renders them as small badge <a> elements
        tickers = []
        for a in tr.find_all("a"):
            cls_val = " ".join(a.get("class", []))
            txt = a.get_text(strip=True)
            # Ticker badges: short uppercase text, specific classes
            if txt and txt.isupper() and 1 <= len(txt) <= 5 and (
                "ticker" in cls_val.lower() or
                "tab-link" not in cls_val.lower()
            ):
                if txt not in tickers and txt != headline:
                    tickers.append(txt)

        # Source (last plain text cell)
        source = ""
        for td in reversed(tds):
            txt = td.get_text(strip=True)
            if txt and len(txt) > 2 and not txt.isupper():
                source = txt
                break

        if headline and tickers:
            rows.append({
                "age": time_text,
                "headline": headline,
                "tickers": tickers,
                "source": source
            })

    return rows

# ── Screener constants ─────────────────────────────────────────────────────────
# v=111 = basic screener view with Ticker, Price, Change, Volume columns
SCREENER_VIEW = "111"
SCREENER_COLS = "0,1,2,65"   # No, Ticker, Price, Change

def _fetch_screener_page(url, ticker_str, start, headers):
    """
    Fetch one page of Finviz screener results (20 rows per page).
    Uses pandas.read_html for reliable table parsing — same approach
    as the proven multi-page scanner.
    Returns a DataFrame with columns [Ticker, Price, ...] or None.
    """
    params = {
        "v": SCREENER_VIEW,
        "t": ticker_str,
        "c": SCREENER_COLS,
        "r": start,          # pagination offset (1, 21, 41, ...)
    }
    try:
        resp = requests.get(url, headers=headers, params=params, timeout=20)
        resp.raise_for_status()
        tables = pd.read_html(StringIO(resp.text))
    except Exception:
        return None

    for t in tables:
        cols = [str(c).lower() for c in t.columns]

        if len(t) == 0:
            continue

        # Must contain these columns
        required = ["ticker", "price", "change", "volume"]
        if not all(any(req in c for c in cols) for req in required):
            continue

        # Finviz screener result tables are exactly 11 columns, max 20 rows
        if len(t) > 20 or len(t.columns) != 11:
            continue

        # Sanity-check first row: Ticker should be a string
        if not isinstance(t.iloc[0]["Ticker"], str):
            continue

        return t

    return None


def fetch_ticker_prices(tickers, cfg):
    """
    Paginate through Finviz screener for the given ticker list.
    Finviz returns 20 rows per page — we step through until no more results.
    Returns dict: { 'TICKER': float_price or None }
    """
    if not tickers:
        return {}

    prices    = {}
    headers   = {"User-Agent": cfg["user_agent"]}
    url       = cfg["finviz_screener_base_url"]
    ticker_str = ",".join(tickers)   # pass full list; Finviz filters server-side

    start = 1
    while True:
        df = _fetch_screener_page(url, ticker_str, start, headers)

        if df is None or len(df) == 0:
            break   # No more pages

        for _, row in df.iterrows():
            ticker = str(row.get("Ticker", "")).strip()
            raw_price = row.get("Price", None)
            if ticker:
                try:
                    prices[ticker] = float(str(raw_price).replace(",", ""))
                except (ValueError, TypeError):
                    prices[ticker] = None

        if len(df) < 20:
            break   # Last page had fewer than 20 rows — we're done

        start += 20
        time.sleep(0.5)   # Brief pause between pages to be polite

    return prices

# ── Keyword matching ───────────────────────────────────────────────────────────
def headline_has_keyword(headline, keywords):
    """Returns list of matched keywords (case-insensitive)."""
    hl_lower = headline.lower()
    matched = [kw for kw in keywords if kw.lower() in hl_lower]
    return matched

# ── Logging ────────────────────────────────────────────────────────────────────
def log_alert(cfg, alert):
    log_path = os.path.join(SCRIPT_DIR, cfg["log_file"])
    with open(log_path, "a", encoding="utf-8") as f:
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        f.write(
            f"{ts} | {alert['priority']:8s} | "
            f"{alert['ticker']:6s} | "
            f"${alert.get('price', '?'):>7} | "
            f"KW: {', '.join(alert.get('keywords', [])) or 'none':30s} | "
            f"{alert['headline'][:80]} | "
            f"{alert['source']}\n"
        )

# ── Display rolling window ─────────────────────────────────────────────────────
def display_rolling(rolling, cfg):
    window = cfg.get("rolling_display_window", 20)
    recent = list(rolling)[-window:]
    print(f"\n{BOLD}{WHITE}  Recent Alerts (last {len(recent)} of {len(rolling)} total):{RESET}")
    print(f"  {DIM}{'─'*76}{RESET}")
    for a in reversed(recent):
        ts    = a['timestamp']
        pl    = priority_label(a['priority'])
        tk    = f"{BOLD}{a['ticker']}{RESET}"
        price = f"${a.get('price', '?')}"
        kws   = ", ".join(a.get("keywords", [])) or ""
        hl    = a['headline'][:55] + ("…" if len(a['headline']) > 55 else "")
        kw_str = f"  {GREEN}↳ {kws}{RESET}" if kws else ""
        print(f"  {DIM}{ts}{RESET}  {pl}  {tk:6s}  {YELLOW}{price:>8}{RESET}  {hl}{kw_str}")
    print()

# ── Main scan loop ─────────────────────────────────────────────────────────────
def main():
    print(f"{BOLD}{CYAN}Starting Finviz News Scanner...{RESET}")
    print(f"Config: {CONFIG_PATH}\n")

    seen_headlines = set()       # Track already-alerted headline+ticker combos
    rolling = deque(maxlen=500)  # Rolling alert history
    scan_count = 0

    while True:
        cfg = load_config()  # Reload config each scan so edits take effect live
        threshold = cfg["price_threshold_dollars"]
        keywords  = cfg["keywords"]
        mode      = cfg.get("keyword_alert_mode", "both")

        cls()
        print_header(cfg)

        scan_count += 1
        print(f"  {DIM}Scan #{scan_count}  |  Fetching news...{RESET}")

        html = fetch_news(cfg)
        if not html:
            time.sleep(cfg["scan_interval_seconds"])
            continue

        rows = parse_news_rows(html)
        all_tickers = list({t for row in rows for t in row["tickers"]})
        print(f"  {DIM}Parsed {len(rows)} news rows  |  {len(all_tickers)} unique tickers  |  Fetching prices...{RESET}")

        prices = fetch_ticker_prices(all_tickers, cfg)
        resolved = sum(1 for v in prices.values() if v is not None)
        print(f"  {DIM}Prices resolved: {resolved}/{len(all_tickers)}{RESET}\n")

        new_alerts_this_scan = []

        for row in rows:
            headline = row["headline"]
            tickers  = row["tickers"]
            source   = row["source"]
            age      = row["age"]
            matched_kws = headline_has_keyword(headline, keywords)

            for ticker in tickers:
                key = f"{ticker}::{headline}"
                if key in seen_headlines:
                    continue  # Already alerted on this combo

                price = prices.get(ticker)
                under_threshold = (price is not None and price <= threshold)

                # Determine priority
                priority = None
                if under_threshold and matched_kws:
                    priority = "HIGH"
                elif under_threshold and mode in ("both", "price"):
                    priority = "PRICE"
                elif matched_kws and mode in ("both", "keyword"):
                    priority = "KEYWORD"

                if priority:
                    seen_headlines.add(key)
                    alert = {
                        "timestamp": datetime.now().strftime("%H:%M:%S"),
                        "priority":  priority,
                        "ticker":    ticker,
                        "price":     f"{price:.2f}" if price else "N/A",
                        "keywords":  matched_kws,
                        "headline":  headline,
                        "source":    source,
                        "age":       age,
                    }
                    rolling.append(alert)
                    log_alert(cfg, alert)
                    new_alerts_this_scan.append(alert)

        # Fire alerts for new hits
        if new_alerts_this_scan:
            # Sort by priority: HIGH first
            order = {"HIGH": 0, "PRICE": 1, "KEYWORD": 2}
            new_alerts_this_scan.sort(key=lambda a: order[a["priority"]])

            for alert in new_alerts_this_scan:
                beep(cfg, alert["priority"])
                time.sleep(0.3)

            print(f"\n{RED}{BOLD}  *** {len(new_alerts_this_scan)} NEW ALERT(S) THIS SCAN ***{RESET}\n")
            for alert in new_alerts_this_scan:
                pl    = priority_label(alert["priority"])
                tk    = f"{BOLD}{alert['ticker']}{RESET}"
                price = f"${alert['price']}"
                kws   = f"  {GREEN}[{', '.join(alert['keywords'])}]{RESET}" if alert["keywords"] else ""
                print(f"  {pl}  {tk:6s}  {YELLOW}{price:>8}{RESET}  {alert['headline'][:60]}{kws}")
                print(f"         {DIM}{alert['source']}  ({alert['age']}){RESET}\n")
        else:
            print(f"  {DIM}No new alerts this scan.{RESET}\n")

        # Display rolling window
        if rolling:
            display_rolling(rolling, cfg)

        # Countdown
        interval = cfg["scan_interval_seconds"]
        print(f"  {DIM}Next scan in {interval}s. Edit config.json to change settings live.{RESET}")
        print(f"  {DIM}Log file: {os.path.join(SCRIPT_DIR, cfg['log_file'])}{RESET}")
        print(f"{CYAN}{'─'*80}{RESET}")

        time.sleep(interval)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print(f"\n\n{YELLOW}Scanner stopped.{RESET}\n")
        sys.exit(0)
