import os
import pandas as pd
from datetime import datetime

OUTPUT_DIR = "data/signals"

# --- Replace this with your actual tickers ---
tickers = ["EVTV"]

# --- Dummy fetch function for Finviz ---
def fetch_finviz(ticker):
    """
    Return a dict like the JSON you already scrape from Finviz.
    """
    # Example from your API output
    return {
        "ATR%": 43.48,
        "Chart": f"https://www.tradingview.com/chart/?symbol={ticker}",
        "GapPct": 34.02,
        "Gap Dir": "Up",
        "NEW": True,
        "Premarket": 2.6,
        "RelVol": 0.91,
        "Score": 1346.06,
        "Ticker": ticker,
        "Headline": "EVTV spikes on news"
    }

# --- Scoring function ---
def score_stock(metrics):
    score = 0
    score += min(metrics["GapPct"] * 2, 30)
    score += min(metrics["RelVol"] * 10, 25)
    score += min(metrics["ATRpct"], 20)
    if metrics["Float"] < 20:  # optional, default 0
        score += 10
    return round(score, 1)

all_signals = []

for ticker in tickers:
    try:
        # --- FETCH DATA ---
        finviz_data = fetch_finviz(ticker)

        # --- METRICS ---
        metrics = {
            "GapPct": finviz_data.get("GapPct", 0),
            "Float": finviz_data.get("Float", 0),
            "RelVol": finviz_data.get("RelVol", 0),
            "ATRpct": finviz_data.get("ATR%", 0)
        }

        # --- SCORE ---
        score = score_stock(metrics)

        # --- SIMPLE TRADE PLAN ---
        premarket = finviz_data.get("Premarket", 0)
        entry_zone = [round(premarket * 1.005, 2), round(premarket * 1.01, 2)]
        stop_price = round(premarket * 0.98, 2)
        targets = [round(premarket * 1.02, 2), round(premarket * 1.04, 2)]

        # --- SIGNAL OBJECT ---
        signal = {
            "Ticker": ticker,
            "Timestamp": datetime.now().isoformat(),
            "Score": score,
            "Pattern": "Premarket Breakout",
            "Catalyst": finviz_data.get("Headline", ""),
            "Entry": entry_zone,
            "Stop": stop_price,
            "Targets": targets,
            "Metrics": metrics,
            "Flags": ["NEW"] if finviz_data.get("NEW", False) else []
        }

        all_signals.append(signal)

    except Exception as e:
        print(f"Error processing {ticker}: {e}")

# --- WRITE CSV ---
os.makedirs(OUTPUT_DIR, exist_ok=True)
filename = os.path.join(OUTPUT_DIR, datetime.now().strftime("%Y-%m-%d_%H%M_signals.csv"))

df = pd.DataFrame(all_signals)
df.to_csv(filename, index=False)

print(f"Signals saved to {filename}")
