# Finviz News Scanner
Real-time Finviz news monitor that alerts you when tickers matching your
price threshold and/or keywords appear in the news feed.

---

## Setup (Windows)

### 1. Install Python
Download from https://python.org — make sure to check "Add Python to PATH" during install.

### 2. Install dependencies
Open Command Prompt and run:
```
pip install requests beautifulsoup4
```

### 3. Place files
Put both files in the same folder:
```
finviz_scanner/
  ├── finviz_scanner.py
  └── config.json
```

### 4. Run the scanner
```
python finviz_scanner.py
```
Or double-click `run_scanner.bat` (see below).

---

## config.json — All Settings

| Setting | Default | Description |
|---|---|---|
| `price_threshold_dollars` | 10.00 | Alert on tickers at or below this price |
| `scan_interval_seconds` | 120 | How often to scan (seconds). Don't go below 60 to avoid rate limiting |
| `news_max_age_hours` | 4 | Ignore headlines older than this |
| `alert_sound_repeat` | 3 | How many beeps per alert |
| `rolling_display_window` | 20 | How many past alerts to show on screen |
| `log_file` | alerts_log.txt | Alert log filename (created automatically) |
| `min_avg_volume` | 500000 | Minimum average volume filter |
| `min_relative_volume` | 2.0 | Minimum relative volume filter |
| `max_float_million` | 100 | Maximum float in millions |
| `keywords` | [...] | List of keywords to match in headlines |
| `keyword_alert_mode` | "both" | "both" = price+keyword alerts; "price" = price only; "keyword" = keyword only |

### Changing price threshold
Edit `config.json` and change:
```json
"price_threshold_dollars": 5.00
```
Changes take effect on the **next scan** — no restart needed.

### Adding/removing keywords
Edit the `keywords` array in `config.json`:
```json
"keywords": [
  "partnership",
  "FDA approval",
  "merger",
  "your custom word here"
]
```

---

## Alert Priority Levels

| Label | Meaning | Beep Pattern |
|---|---|---|
| `[HIGH ★]` | Ticker ≤ price threshold AND keyword matched | Fast triple beep (1200Hz) |
| `[PRICE ↑]` | Ticker ≤ price threshold (no keyword) | Double beep (900Hz) |
| `[KEYWORD]` | Keyword matched but ticker above threshold | Single beep (600Hz) |

---

## Log File
Every alert is appended to `alerts_log.txt` in the same folder.
Format:
```
2026-02-18 06:43:11 | HIGH     | RXT    |    1.12 | KW: partnership | Rackspace and Palantir announce... | Benzinga
```
The log file grows continuously — archive or delete it periodically.

---

## Optional: run_scanner.bat
Create a file called `run_scanner.bat` in the same folder:
```bat
@echo off
cd /d %~dp0
python finviz_scanner.py
pause
```
Double-click it to launch the scanner without opening Command Prompt manually.

---

## Troubleshooting

**No tickers being detected**
Finviz occasionally changes their HTML structure. The parser uses multiple
fallback strategies, but if it breaks, open an issue — the fix is usually
one CSS selector update.

**Getting rate limited / blocked**
- Increase `scan_interval_seconds` to 180 or 300
- The script uses a realistic browser User-Agent by default

**Prices showing as N/A**
The screener price lookup uses a secondary Finviz request. If it fails,
alerts still fire based on keyword matches — price just shows N/A.

**Colors not showing in terminal**
Run in Windows Terminal (not the old cmd.exe) for full color support.
Download: https://aka.ms/terminal
