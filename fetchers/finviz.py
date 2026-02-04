import pandas as pd

FINVIZ_CSV = "data/scans/finviz_export.csv"

# Load full CSV
finviz_df = pd.read_csv(FINVIZ_CSV)

def fetch_finviz(ticker):
    """
    Return Finviz data for the given ticker from CSV
    """
    row = finviz_df[finviz_df["Ticker"] == ticker]
    if row.empty:
        raise ValueError(f"{ticker} not found in Finviz CSV")
    row = row.iloc[0]  # first match
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
