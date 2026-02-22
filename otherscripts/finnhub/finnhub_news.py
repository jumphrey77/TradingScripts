import finnhub
import os
import sys
import json
from datetime import datetime

MY_KEY = "d6cce0hr01qsiik1mr2gd6cce0hr01qsiik1mr30"
START_DATE = "2026-02-01"
END_DATE = "2026-02-15"
ERROR_EXCEED = 429
ERROR_NO_ACCESS = 403
TICKER = "AAPL"
NUM_OF_ARTICLES = 10
OUTPUT_FILE = "news_output.txt"

script_dir = os.path.dirname(os.path.abspath(__file__))

file_path = os.path.join(script_dir, OUTPUT_FILE)

def format_news(articles, title):
    lines = []
    lines.append("\n" + "═" * 80)
    lines.append(f"  🗞️  {title}  —  {len(articles)} articles  |  {datetime.now().strftime('%Y-%m-%d %I:%M %p')}")
    lines.append("═" * 80)

    # Sort newest first
    sorted_articles = sorted(articles, key=lambda x: x['datetime'], reverse=True)

    for i, article in enumerate(sorted_articles[:NUM_OF_ARTICLES], start=1):
        dt = datetime.fromtimestamp(article['datetime']).strftime("%Y-%m-%d %I:%M %p")
        related = article.get('related', '').strip()
        summary = article.get('summary', '').strip()
        
        lines.append(f"  {'─' * 76}")
        lines.append(f"  #{i}  📅 {dt}")
        lines.append(f"  {'─' * 76}")
        lines.append(f"  📰 {article['headline']}")
        lines.append(f"  🔗 {article['url']}")
        lines.append(f"  📡 Source:  {article['source']}")
        if related:
            lines.append(f"  🏷️  Related: {related}")
        if summary:
            lines.append(f"\n  💬 {summary}")
        lines.append("")

    lines.append("═" * 80 + "\n")
    return "\n".join(lines)

def save_and_print(text):
    print(text)
    with open(file_path, "a", encoding="utf-8") as f:
        f.write(text)

# Setup client
finnhub_client = finnhub.Client(api_key=MY_KEY)

# General market news
general = finnhub_client.general_news("general", min_id=0)
output = format_news(general, "GENERAL MARKET NEWS")
save_and_print(output)

# Company specific news
#company = finnhub_client.company_news(TICKER, _from=START_DATE, to=END_DATE)
#output = format_news(company, f"{TICKER} COMPANY NEWS")
#save_and_print(output)



