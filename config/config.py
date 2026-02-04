# config.py
# global variables shared
import os

DEBUG = True
DEBUG_API = False        #Debug API Calls - Stops Logging to Terminals
USE_PREMARKET = False
OUTPUT_SYMBOL_ANALYSIS=False

#DIRECTORIES
HISTORY_DIR = "history"
CONFIG_DIR =  "config"

SCAN_DIR = os.path.join(HISTORY_DIR, "scans")
SIGNAL_DIR = os.path.join(HISTORY_DIR, "signals")
EVENT_DIR = os.path.join(HISTORY_DIR, "events")
EXPORTS_DIR = os.path.join(HISTORY_DIR, "exports")

#FILENAMES
OUTPUT_PREFIX = "market_ranked"
EVENT_LOG = os.path.join(EVENT_DIR, "events_log.csv")

CONFIG_FILE_NAME =  "scanner_config.json"
CONFIG_FILE = os.path.join(CONFIG_DIR, CONFIG_FILE_NAME)

#APP SETTINGS
#APP_DEFAULT_THEME = "dark"

# False - Last full trading day (safe weekends)
# True  # Pre-market intraday (live data)
