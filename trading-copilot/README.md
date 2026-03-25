# Trading Copilot

AI-powered day trading panel with Alpaca real-time data and Claude integration.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure credentials

```bash
cp .env.template .env
# Edit .env with your Alpaca API key and secret
```

Or launch the app and use the Settings (⚙) button.

### 3. Get your Alpaca API key


1. Go to https://app.alpaca.markets
2. Switch to Paper Trading account (top left dropdown)
3. Click "API Keys" in the right sidebar
4. Click "Generate New Keys"
5. **Save your Secret Key immediately** — shown only once

### 4. Run

```bash
npm start          # production
npm run dev        # development (with DevTools)
```


---

## How to use


1. **Enter ticker** in the top input, press Enter to subscribe
2. **Select strategy**: Regular or Scalp
3. **Select mode**: Off / Research / In-Trade / Exit Plan
4. **Set entry price** when you enter a trade
5. **Set stop and targets** in the trade levels section
6. **ShareX hotkeys** capture L2 screenshots → Ctrl+V into Claude chat
7. **Message dropdown** → select a preset → preview → Send ↗ copies to clipboard → Ctrl+V


---

## Project structure

```
trading-copilot/
├── src/
│   ├── main/
│   │   ├── main.js           # Electron entry, IPC, window management
│   │   ├── preload.js        # Secure renderer bridge
│   │   ├── alpacaService.js  # WebSocket, indicators, alert detection
│   │   └── configManager.js  # Read/write user config
│   ├── renderer/
│   │   ├── index.html        # Main panel UI
│   │   ├── config.html       # Settings popup
│   │   ├── components/
│   │   │   ├── panel.js      # Main controller, state, IPC listeners
│   │   │   ├── alerts.js     # Alert rendering and management
│   │   │   └── chart.js      # Mini candlestick chart canvas
│   │   └── styles/
│   │       └── panel.css     # Dark terminal theme
│   └── shared/
│       └── placeholders.js   # Template resolver ([T], [P], [E] etc.)
├── data/
│   └── claude_messages.json  # Predefined messages and alert definitions
├── config/
│   └── user-config.json      # Generated on first run (gitignored)
├── .env.template             # Copy to .env with your credentials
└── package.json
```


---

## Placeholders reference

| Placeholder | Value |
|----|----|
| `[T]` | Ticker symbol |
| `[P]` | Current price |
| `[E]` | Entry price |
| `[S]` | Stop loss |
| `[TG1]` / `[TG2]` | Targets |
| `[PNL]` | P&L amount and % |
| `[TIME]` | Time in trade |
| `[RSI]` | RSI 1m |
| `[MACD]` | MACD value |
| `[VWAP]` | VWAP |
| `[VOL]` | Volume vs avg |
| `[SPREAD]` | Bid/ask spread |
| `[TAPE]` | Tape direction |
| `[STRAT]` | Strategy |
| `[TIME_ET]` | Current ET time |


---

## Phases

* **Phase 1 (now)**: Data display + clipboard-based Claude messaging
* **Phase 2**: Auto-send alerts to Claude via API
* **Phase 3**: Alpaca order execution from panel buttons


