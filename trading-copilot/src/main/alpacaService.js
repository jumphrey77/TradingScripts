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
      // IEX feed for free accounts, sip for paid
      const feed = 'iex'
      this.socket = this.client.data_stream_v2

      this.socket.onConnect(() => {
        console.log('[Alpaca] Connected')
        this.emit('connected')
        if (this.ticker) this._subscribeSocket(this.ticker)
      })

      this.socket.onDisconnect(() => {
        console.log('[Alpaca] Disconnected')
        this.emit('disconnected')
      })

      this.socket.onStockQuote((quote) => {
        this._handleQuote(quote)
      })

      this.socket.onStockBar((bar) => {
        this._handleBar(bar)
      })

      this.socket.onError((err) => {
        console.error('[Alpaca] Stream error:', err)
      })

      this.socket.connect()
    } catch (e) {
      console.error('[Alpaca] Connect failed:', e.message)
    }
  }

  // ── Subscribe to ticker ────────────────────────────────────────────────────
  subscribe(ticker) {
    this.ticker = ticker.toUpperCase()
    this.bars   = []
    this.vwapAccum = { pv: 0, vol: 0 }
    this._subscribeSocket(this.ticker)
  }

  _subscribeSocket(ticker) {
    if (!this.socket) return
    try {
      this.socket.subscribeForQuotes([ticker])
      this.socket.subscribeForBars([ticker])
    } catch (e) {
      console.error('[Alpaca] Subscribe failed:', e.message)
    }
  }

  unsubscribe(ticker) {
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
    const data = {
      ticker:    quote.S,
      bid:       quote.bp,
      ask:       quote.ap,
      bidSize:   quote.bs,
      askSize:   quote.as,
      price:     ((quote.bp + quote.ap) / 2),
      spread:    parseFloat((quote.ap - quote.bp).toFixed(4)),
      spreadPct: parseFloat(((quote.ap - quote.bp) / quote.ap * 100).toFixed(2)),
      time:      quote.t
    }
    this.emit('quote', data)
    this._checkAlerts(data)
  }

  // ── Handle incoming 1m bar ────────────────────────────────────────────────
  _handleBar(bar) {
    const b = {
      ticker:  bar.S,
      open:    bar.o,
      high:    bar.h,
      low:     bar.l,
      close:   bar.c,
      volume:  bar.v,
      time:    bar.t
    }

    // Rolling 50 bars max
    this.bars.push(b)
    if (this.bars.length > 50) this.bars.shift()

    // Update VWAP accumulator
    const typical = (b.high + b.low + b.close) / 3
    this.vwapAccum.pv  += typical * b.volume
    this.vwapAccum.vol += b.volume
    const vwap = this.vwapAccum.vol > 0
      ? parseFloat((this.vwapAccum.pv / this.vwapAccum.vol).toFixed(4))
      : b.close

    // Calculate indicators
    const indicators = {
      ticker: b.ticker,
      bar:    b,
      rsi:    this._calcRSI(14),
      macd:   this._calcMACD(),
      vwap,
      volAvg: this._calcAvgVolume(),
      volRatio: this._calcVolRatio(),
      high:   Math.max(...this.bars.map(x => x.high)),
      low:    Math.min(...this.bars.map(x => x.low)),
      bars:   this.bars.slice(-15)  // last 15 bars for mini chart
    }

    this.emit('bar', b)
    this.emit('indicators', indicators)
    this._checkIndicatorAlerts(indicators)
  }

  // ── RSI Calculation ───────────────────────────────────────────────────────
  _calcRSI(period = 14) {
    if (this.bars.length < period + 1) return null
    const closes = this.bars.map(b => b.close)
    let gains = 0, losses = 0

    for (let i = closes.length - period; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1]
      if (diff >= 0) gains  += diff
      else           losses -= diff
    }

    const avgGain = gains  / period
    const avgLoss = losses / period
    if (avgLoss === 0) return 100

    const rs  = avgGain / avgLoss
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

  // ── Fire alert with cooldown ───────────────────────────────────────────────
  _fireAlert(alertId, data) {
    const now      = Date.now()
    const cooldown = 30000 // 30 seconds

    if (this.alertCooldowns[alertId] &&
        now - this.alertCooldowns[alertId] < cooldown) return

    this.alertCooldowns[alertId] = now
    this.emit('alert', { alertId, data, timestamp: new Date().toISOString() })
  }
}

module.exports = AlpacaService
