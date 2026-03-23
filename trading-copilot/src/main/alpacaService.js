// ============================================
// TRADING COPILOT — ALPACA SERVICE
// Manages the Alpaca WebSocket data stream,
// calculates RSI/MACD/VWAP from bars,
// detects alert conditions, and emits events
// to the main process.
// ============================================

const EventEmitter = require('events')
const Alpaca       = require('@alpacahq/alpaca-trade-api')

class AlpacaService extends EventEmitter {
  constructor(config) {
    super()
    this.config      = config
    this.ticker      = null
    this.client      = null
    this.socket      = null
    this.bars        = []          // rolling 1m bars for indicator calc
    this.bars5m      = []          // rolling 5m bars for RSI 5m
    this.bars15m     = []          // rolling 15m bars for RSI 15m
    this.tradeCtx    = {}          // entry, stop, targets from UI
    this.alertCooldowns = {}       // prevent alert spam
    this.vwapAccum   = { pv: 0, vol: 0 } // price*volume and volume for VWAP
    this._init()
  }

  // ── Initialize Alpaca client ───────────────────────────────────────────────
  _init() {
    try {
      this.client = new Alpaca({
        keyId:    this.config.alpacaKey,
        secretKey: this.config.alpacaSecret,
        baseUrl:  this.config.alpacaBaseUrl,
        paper:    this.config.paper !== false
      })
      this._connect()
    } catch (e) {
      console.error('[Alpaca] Init failed:', e.message)
    }
  }

  // ── WebSocket connection ───────────────────────────────────────────────────
  _connect() {
    try {
      console.log('[WS] Initializing data_stream_v2...')
      this.socket = this.client.data_stream_v2
      console.log('[WS] Socket object type:', typeof this.socket)
      console.log('[WS] Socket methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(this.socket)).join(', '))

      this.socket.onConnect(() => {
        console.log('[WS] *** CONNECTED ***')
        this.emit('connected')
        if (this.ticker) {
          console.log('[WS] Auto-subscribing to', this.ticker)
          this._subscribeSocket(this.ticker)
        }
      })

      this.socket.onDisconnect(() => {
        console.log('[WS] *** DISCONNECTED ***')
        this.emit('disconnected')
      })

      this.socket.onStockQuote((quote) => {
        this._handleQuote(quote)
      })

      this.socket.onStockBar((bar) => {
        this._handleBar(bar)
      })

      this.socket.onError((err) => {
        console.error('[WS] *** ERROR ***', err)
      })

      console.log('[WS] Calling connect()...')
      this.socket.connect()
      console.log('[WS] connect() called')

    } catch (e) {
      console.error('[WS] Connect failed:', e.message, e.stack)
    }
  }

  // ── Subscribe to ticker ────────────────────────────────────────────────────
  subscribe(ticker) {
    this.ticker    = ticker.toUpperCase()
    this.bars      = []
    this.bars5m    = []
    this.bars15m   = []
    this.vwapAccum = { pv: 0, vol: 0 }
    this._subscribeSocket(this.ticker)
    // Pre-load historical bars so RSI/MACD are ready immediately
    this._loadHistoricalBars(this.ticker)
    // WebSocket handles live quotes - see _connect()
  }


  async _loadHistoricalBars(ticker) {
    try {
      console.log(`[${ticker}] Loading snapshot + bars...`)
      const dataUrl = this.config.alpacaDataUrl || 'https://data.alpaca.markets'
      const headers = {
        'APCA-API-KEY-ID':     this.config.alpacaKey,
        'APCA-API-SECRET-KEY': this.config.alpacaSecret
      }

      // ── 1. Snapshot — latest quote, trade, minute bar, daily bar ─────────
      const snapResp = await fetch(
        `${dataUrl}/v2/stocks/${ticker}/snapshot?feed=iex`,
        { headers }
      )
      const snap = await snapResp.json()
      console.log(`[${ticker}] Snapshot received`)

      if (!snap.latestQuote && !snap.latestTrade) {
        console.warn(`[${ticker}] No quote or trade data returned - ticker may not trade on IEX feed`)
        console.warn(`[${ticker}] Snapshot keys:`, Object.keys(snap).join(', '))
      }

      if (snap.latestQuote) {
        const q = snap.latestQuote
        const bid       = q.bp || q.bidPrice || 0
        const ask       = q.ap || q.askPrice || 0
        const price     = bid && ask ? (bid + ask) / 2 : (snap.latestTrade?.p || snap.latestTrade?.price || 0)
        const spread    = parseFloat((ask - bid).toFixed(4))
        const spreadPct = ask > 0 ? parseFloat(((ask - bid) / ask * 100).toFixed(2)) : 0
        this.emit('quote', {
          ticker, bid, ask,
          bidSize:   q.bs || q.bidSize || 0,
          askSize:   q.as || q.askSize || 0,
          price, spread, spreadPct,
          time:      q.t || q.timestamp,
          synthetic: false
        })
        console.log(`[${ticker}] Latest quote - bid: ${bid}, ask: ${ask}, price: ${price}`)
      } else if (snap.latestTrade) {
        const p = snap.latestTrade.p || snap.latestTrade.price || 0
        this.emit('quote', {
          ticker, bid: p, ask: p, bidSize: 0, askSize: 0,
          price: p, spread: 0, spreadPct: 0,
          time: snap.latestTrade.t,
          synthetic: true
        })
        console.log(`[Alpaca] No quote, using latest trade price: ${p}`)
      }

      // ── 2. Historical bars — 1m, 5m, 15m in parallel ────────────────────
      const [barsResp, bars5mResp, bars15mResp] = await Promise.all([
        fetch(`${dataUrl}/v2/stocks/${ticker}/bars?timeframe=1Min&limit=50&feed=iex`,  { headers }),
        fetch(`${dataUrl}/v2/stocks/${ticker}/bars?timeframe=5Min&limit=50&feed=iex`,  { headers }),
        fetch(`${dataUrl}/v2/stocks/${ticker}/bars?timeframe=15Min&limit=50&feed=iex`, { headers })
      ])
      const barsData   = await barsResp.json()
      const bars5mData = await bars5mResp.json()
      const bars15mData= await bars15mResp.json()
      const rawBars    = barsData.bars   || []
      const raw5m      = bars5mData.bars || []
      const raw15m     = bars15mData.bars|| []

      if (rawBars.length === 0) {
        console.log(`[${ticker}] No historical bars (market may be closed or ticker not on IEX feed)`)
        // Still emit daily bar info if available from snapshot
        if (snap.dailyBar) {
          const db = snap.dailyBar
          const vwap = db.vw || db.vwap || db.c || db.close || 0
          this.emit('indicators', {
            ticker,
            bar:      { open: db.o, high: db.h, low: db.l, close: db.c, volume: db.v },
            rsi:      null,
            macd:     null,
            vwap,
            volAvg:   0,
            volRatio: 0,
            high:     db.h || 0,
            low:      db.l || 0,
            bars:     []
          })
        }
        return
      }

      // Normalize bar field names (SDK uses different keys than REST)
      const bars = rawBars.map(b => ({
        ticker,
        open:   b.o  || b.open,
        high:   b.h  || b.high,
        low:    b.l  || b.low,
        close:  b.c  || b.close,
        volume: b.v  || b.volume,
        vwap:   b.vw || b.vwap,
        time:   b.t  || b.timestamp
      }))

      // Seed bars and VWAP from Alpaca's own VWAP if available
      this.bars = bars
      const lastBar   = bars[bars.length - 1]
      // Use Alpaca's daily VWAP if available, else calculate from bars
      const alpacaVwap = snap.dailyBar?.vw || snap.dailyBar?.vwap || null
      if (alpacaVwap) {
        // Use Alpaca's official VWAP directly
        this.vwapAccum = { pv: 0, vol: 0, override: alpacaVwap }
      } else {
        this.vwapAccum = { pv: 0, vol: 0 }
        bars.forEach(b => {
          const typical = (b.high + b.low + b.close) / 3
          this.vwapAccum.pv  += typical * b.volume
          this.vwapAccum.vol += b.volume
        })
      }

      const vwap = alpacaVwap
        || (this.vwapAccum.vol > 0
          ? parseFloat((this.vwapAccum.pv / this.vwapAccum.vol).toFixed(4))
          : lastBar.close)

      // Normalize 5m and 15m bars
      const normalize = (raw) => raw.map(b => ({
        ticker,
        open:   b.o  || b.open,
        high:   b.h  || b.high,
        low:    b.l  || b.low,
        close:  b.c  || b.close,
        volume: b.v  || b.volume,
        time:   b.t  || b.timestamp
      }))

      this.bars5m  = normalize(raw5m)
      this.bars15m = normalize(raw15m)

      const rsi5m  = this._calcRSIFromBars(this.bars5m,  14)
      const rsi15m = this._calcRSIFromBars(this.bars15m, 14)

      const indicators = {
        ticker,
        bar:      lastBar,
        rsi:      this._calcRSI(14),
        rsi5m,
        rsi15m,
        macd:     this._calcMACD(),
        vwap,
        volAvg:   this._calcAvgVolume(),
        volRatio: this._calcVolRatio(),
        high:     Math.max(...bars.map(x => x.high)),
        low:      Math.min(...bars.map(x => x.low)),
        bars:     bars.slice(-15)
      }

      console.log(`[${ticker}] Loaded ${bars.length} bars - RSI 1m: ${indicators.rsi} 5m: ${rsi5m} 15m: ${rsi15m}, MACD: ${indicators.macd}, VWAP: ${vwap}`)
      this.emit('indicators', indicators)

    } catch (e) {
      console.error('[Alpaca] Data load failed:', e.message)
    }
  }

  _subscribeSocket(ticker) {
    if (!this.socket) {
      console.error('[WS] Cannot subscribe - socket is null')
      return
    }
    try {
      console.log(`[WS] Subscribing to quotes + bars for ${ticker}`)
      this.socket.subscribeForQuotes([ticker])
      this.socket.subscribeForBars([ticker])
      console.log(`[WS] Subscription confirmed for ${ticker}`)
    } catch (e) {
      console.error('[WS] Subscribe failed:', e.message, e.stack)
    }
  }

  unsubscribe(ticker) {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null }
    if (!this.socket) return
    try {
      this.socket.unsubscribeFromQuotes([ticker])
      this.socket.unsubscribeFromBars([ticker])
    } catch (e) {
      console.error('[Alpaca] Unsubscribe failed:', e.message)
    }
  }

  disconnect() {
    if (this.socket) {
      try { this.socket.disconnect() } catch (e) {}
      this.socket = null
    }
  }

  // ── Set trade context from UI ──────────────────────────────────────────────
  setTradeContext(ctx) {
    this.tradeCtx = ctx
  }

  // ── Handle incoming quote (bid/ask/price) ─────────────────────────────────
  _handleQuote(quote) {
    // SDK returns capitalized fields (BidPrice) not shorthand (bp)
    const bid = quote.BidPrice ?? quote.bp ?? 0
    const ask = quote.AskPrice ?? quote.ap ?? 0
    const data = {
      ticker:    quote.Symbol ?? quote.S,
      bid,
      ask,
      bidSize:   quote.BidSize   ?? quote.bs ?? 0,
      askSize:   quote.AskSize   ?? quote.as ?? 0,
      price:     (bid + ask) / 2,
      spread:    parseFloat((ask - bid).toFixed(4)),
      spreadPct: ask > 0 ? parseFloat(((ask - bid) / ask * 100).toFixed(2)) : 0,
      time:      quote.Timestamp ?? quote.t
    }
    this.emit('quote', data)
    this._checkAlerts(data)
  }

  // ── Handle incoming 1m bar ────────────────────────────────────────────────
  _handleBar(bar) {
    const b = {
      ticker:  bar.Symbol ?? bar.S,
      open:    bar.OpenPrice  ?? bar.o,
      high:    bar.HighPrice  ?? bar.h,
      low:     bar.LowPrice   ?? bar.l,
      close:   bar.ClosePrice  ?? bar.c,
      volume:  bar.Volume      ?? bar.v,
      vwap:    bar.VWAP        ?? bar.vw ?? null,
      time:    bar.Timestamp  ?? bar.t
    }

    // Rolling 50 bars max
    this.bars.push(b)
    if (this.bars.length > 50) this.bars.shift()

    // Update VWAP accumulator
    // Use bar's own vwap if Alpaca provides it, else accumulate
    let vwap
    if (b.vwap) {
      vwap = b.vwap  // Alpaca provides intraday VWAP on each bar
    } else {
      const typical = (b.high + b.low + b.close) / 3
      this.vwapAccum.pv  += typical * b.volume
      this.vwapAccum.vol += b.volume
      vwap = this.vwapAccum.vol > 0
        ? parseFloat((this.vwapAccum.pv / this.vwapAccum.vol).toFixed(4))
        : b.close
    }

    // Calculate indicators
    const indicators = {
      ticker:   b.ticker,
      bar:      b,
      rsi:      this._calcRSI(14),
      rsi5m:    this._calcRSIFromBars(this.bars5m,  14),
      rsi15m:   this._calcRSIFromBars(this.bars15m, 14),
      macd:     this._calcMACD(),
      vwap,
      volAvg:   this._calcAvgVolume(),
      volRatio: this._calcVolRatio(),
      high:     Math.max(...this.bars.map(x => x.high)),
      low:      Math.min(...this.bars.map(x => x.low)),
      bars:     this.bars.slice(-15)
    }

    this.emit('bar', b)
    this.emit('indicators', indicators)
    this._checkIndicatorAlerts(indicators)
  }

  // ── RSI Calculation ───────────────────────────────────────────────────────
  _calcRSI(period = 14) {
    return this._calcRSIFromBars(this.bars, period)
  }

  _calcRSIFromBars(bars, period = 14) {
    if (!bars || bars.length < period + 1) return null
    const closes = bars.map(b => b.close)
    let gains = 0, losses = 0

    for (let i = closes.length - period; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1]
      if (diff >= 0) gains  += diff
      else           losses -= diff
    }

    const avgGain = gains  / period
    const avgLoss = losses / period
    if (avgLoss === 0) return 100

    const rs = avgGain / avgLoss
    return parseFloat((100 - 100 / (1 + rs)).toFixed(1))
  }

  // ── MACD Calculation ──────────────────────────────────────────────────────
  _calcMACD() {
    if (this.bars.length < 26) return null
    const closes = this.bars.map(b => b.close)
    const ema12  = this._ema(closes, 12)
    const ema26  = this._ema(closes, 26)
    if (!ema12 || !ema26) return null
    return parseFloat((ema12 - ema26).toFixed(4))
  }

  _ema(data, period) {
    if (data.length < period) return null
    const k      = 2 / (period + 1)
    let ema      = data.slice(0, period).reduce((a, b) => a + b, 0) / period
    for (let i = period; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k)
    }
    return ema
  }

  // ── Volume Calculations ───────────────────────────────────────────────────
  _calcAvgVolume() {
    if (this.bars.length < 2) return 0
    const vols = this.bars.slice(0, -1).map(b => b.volume)
    return Math.round(vols.reduce((a, b) => a + b, 0) / vols.length)
  }

  _calcVolRatio() {
    const avg = this._calcAvgVolume()
    if (!avg || this.bars.length === 0) return 0
    const current = this.bars[this.bars.length - 1].volume
    return parseFloat((current / avg).toFixed(1))
  }

  // ── Alert detection from quote data ───────────────────────────────────────
  _checkAlerts(quote) {
    const ctx = this.tradeCtx

    // Stop hit
    if (ctx.stop && quote.price <= ctx.stop) {
      this._fireAlert('alert_005', { ...quote, ...ctx })
    }

    // Spread too wide (scalp)
    if (ctx.strategy === 'scalp' && quote.spreadPct > 1.5) {
      this._fireAlert('alert_006', quote)
    } else if (ctx.strategy === 'scalp' && quote.spreadPct > 0.8) {
      this._fireAlert('alert_007', quote)
    }

    // Target 1 hit
    if (ctx.target1 && quote.price >= ctx.target1) {
      this._fireAlert('alert_009', { ...quote, ...ctx })
    }

    // Target 2 hit
    if (ctx.target2 && quote.price >= ctx.target2) {
      this._fireAlert('alert_010', { ...quote, ...ctx })
    }
  }

  // ── Alert detection from indicator data ───────────────────────────────────
  _checkIndicatorAlerts(ind) {
    const { rsi, macd, volRatio, vwap } = ind

    if (rsi !== null) {
      if (rsi > 70)  this._fireAlert('alert_001', ind)
      if (rsi < 30)  this._fireAlert('alert_002', ind)
    }

    if (volRatio > 3.0) this._fireAlert('alert_004', ind)
    else if (volRatio > 2.0) this._fireAlert('alert_003', ind)

    // VWAP cross (simple: last bar vs vwap)
    if (this.bars.length >= 2) {
      const prev = this.bars[this.bars.length - 2].close
      const curr = this.bars[this.bars.length - 1].close
      if (prev < vwap && curr >= vwap) this._fireAlert('alert_013', ind)
      if (prev > vwap && curr <= vwap) this._fireAlert('alert_014', ind)
    }

    // Scalp time check
    if (this.tradeCtx.strategy === 'scalp' && this.tradeCtx.entryTime) {
      const elapsed = (Date.now() - this.tradeCtx.entryTime) / 1000
      if (elapsed > 120) this._fireAlert('alert_015', { ...ind, elapsed })
    }
  }

  // ── Fire alert with per-alert cooldowns ──────────────────────────────────
  _fireAlert(alertId, data) {
    const now = Date.now()
    // Per-alert cooldowns — VWAP much longer to avoid noise
    const cooldowns = {
      alert_013: 5 * 60 * 1000,  // VWAP reclaim — 5 min
      alert_014: 5 * 60 * 1000,  // VWAP lost — 5 min
      alert_001: 2 * 60 * 1000,  // RSI overbought — 2 min
      alert_002: 2 * 60 * 1000,  // RSI oversold — 2 min
      alert_003: 60 * 1000,       // Volume 2x — 1 min
      alert_004: 60 * 1000,       // Volume 3x — 1 min
      alert_011: 3 * 60 * 1000,  // MACD cross — 3 min
      alert_012: 3 * 60 * 1000,  // MACD cross up — 3 min
    }
    const cooldown = cooldowns[alertId] || 30000

    if (this.alertCooldowns[alertId] &&
        now - this.alertCooldowns[alertId] < cooldown) return

    this.alertCooldowns[alertId] = now
    this.emit('alert', { alertId, data, timestamp: new Date().toISOString() })
  }
}

module.exports = AlpacaService
