import os
import pandas as pd
from datetime import datetime

OUTPUT_DIR = "data/signals"
FINVIZ_CSV = "data/scans/finviz_export.csv"

# --- Load CSV ---
finviz_df = pd.read_csv(FINVIZ_CSV)
tickers = finviz_df["Ticker"].tolist()

# --- Fetcher ---
def fetch_finviz(ticker):
    row = finviz_df[finviz_df["Ticker"] == ticker]
    if row.empty:
        raise ValueError(f"{ticker} not found in Finviz CSV")
    row = row.iloc[0]
    return {
        "ATR%": row.get("ATR%", 0),
        "Chart": f"https://www.tradingview.com/chart/?symbol={ticker}",
        "GapPct": row.get("GapPct", 0),
        "Gap Dir": row.get("Gap Dir", ""),
        "NEW": row.get("NEW", False),
        "Premarket": row.get("Premarket", 0),
        "RelVol": row.get("RelVol", 0),
        "Score": row.get("Score", 0),
        "Ticker": ticker,
        "Headline": row.get("Headline", "")
    }

# --- Score function ---
def score_stock(metrics):
    score = 0
    score += min(metrics["GapPct"] * 2, 30)
    score += min(metrics["RelVol"] * 10, 25)
    score += min(metrics["ATRpct"], 20)
    if metrics["Float"] < 20:  # optional
        score += 10
    return round(score, 1)

all_signals = []

# --- Process tickers ---
for ticker in tickers:
    try:
        finviz_data = fetch_finviz(ticker)

        metrics = {
            "GapPct": finviz_data.get("GapPct", 0),
            "Float": finviz_data.get("Float", 0),
            "RelVol": finviz_data.get("RelVol", 0),
            "ATRpct": finviz_data.get("ATR%", 0)
        }

        score = score_stock(metrics)

        premarket = finviz_data.get("Premarket", 0)
        entry_zone = [round(premarket * 1.005, 2), round(premarket * 1.01, 2)]
        stop_price = round(premarket * 0.98, 2)
        targets = [round(premarket * 1.02, 2), round(premarket * 1.04, 2)]

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

# --- Save CSV ---
os.makedirs(OUTPUT_DIR, exist_ok=True)
filename = os.path.join(OUTPUT_DIR, datetime.now().strftime("%Y-%m-%d_%H%M_signals.csv"))
pd.DataFrame(all_signals).to_csv(filename, index=False)
print(f"Signals saved to {filename}")
