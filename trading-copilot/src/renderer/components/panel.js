// ============================================
// TRADING COPILOT — PANEL CONTROLLER
// Main renderer logic. Manages state, wires
// up UI events, receives market data from
// main process via IPC, updates display.
// ============================================

// ── App state ─────────────────────────────────────────────────────────────────
const state = {
  ticker:    '',
  price:     null,
  autoCopyOnSelect:   true,
  tradePresets:       [],
  lastPreset:         null,
  autoUpdateLevels:   true,
  bid:       null,
  ask:       null,
  spread:    null,
  spreadPct: null,
  rsi:          null,
  rsi5m:        null,
  rsi15m:       null,
  macd:         null,
  macdSignal:   null,
  macdHist:     null,
  ema20:        null,
  ema50:        null,
  sma20:        null,
  vwap:      null,
  volRatio:  null,
  volCurrent:  0,
  volAvg:      0,
  volHigh:     0,   // session high volume bar
  dayLow:      null,
  dayHigh:     null,
  dayOpen:     null,
  sessionHigh: null,
  sessionLow:  null,
  sessionOpen: null,
  high:      null,
  low:       null,
  tape:      'Unknown',
  strategy:  'regular',
  mode:      'off',
  entry:     null,
  stop:      null,
  target1:   null,
  target2:   null,
  entryTime: null,
  shares:    100,
  connected: false,
  bars:      []
}

// ── DOM refs ───────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
  // Restore last active tab
  try {
    const savedTab = localStorage.getItem('activeTab') || 'research'
    switchTab(savedTab)
  } catch(e) { switchTab('research') }

  // Load autoCopyOnSelect from config
  if (window.copilot && window.copilot.getConfig) {
    const cfg = await window.copilot.getConfig()
    state.autoCopyOnSelect = cfg.autoCopyOnSelect !== false
    state.tradePresets     = cfg.tradePresets || []
    state.allowReposition  = cfg.allowReposition === true
    renderPresets()
    populatePresetDropdown()
    initPanelReorder()
    initResizeHandles()
  }
  bindControls()
  await loadMessages()
  startClock()
  setupAlpacaListeners()
  updateModeUI()
}

// ── Clock ──────────────────────────────────────────────────────────────────────
function startClock() {
  const update = () => {
    const now = new Date()
    const et  = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
    $('clock').textContent = et.toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
    }) + ' ET'
  }
  update()
  setInterval(update, 1000)
}

// ── Control binding ────────────────────────────────────────────────────────────
function bindControls() {
  // Ticker input — subscribe on Enter
  $('ticker-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const ticker = e.target.value.toUpperCase().trim()
      if (!ticker) return
      if (state.ticker) window.copilot.unsubscribe(state.ticker)
      state.ticker = ticker
      state.bars    = []
      state.price   = null
      state.volHigh = 0
      state.dayLow     = null
      state.dayHigh    = null
      state.dayOpen    = null
      state.sessionHigh = null
      state.sessionLow  = null
      state.sessionOpen = null
      state.rsi    = null
      state.macd   = null
      state.vwap   = null
      // Switch alert cache to new ticker
      if (typeof AlertManager !== 'undefined') AlertManager.setTicker(ticker)
      updateAlertBadge()
      // UI-9: auto switch to research mode when ticker entered
      if (state.mode === 'off' || state.mode === 'intrade') {
        const modeEl = $('mode-select')
        if (modeEl) modeEl.value = 'research'
        state.mode = 'research'
        updateModeUI()
        // Also switch to Research tab
        switchTab('research')
      }
      // Update feed label with current ticker
      if (window.copilot.getConfig) {
        window.copilot.getConfig().then(cfg => {
          const el = $('feed-label')
          if (el) el.textContent = (cfg.dataFeed || 'iex').toUpperCase() + ' · ' + ticker
        })
      }
      const tape = $('tape-container')
      if (tape) tape.innerHTML = '<div class="no-tape">Waiting for data...</div>'
      // Reset display
      $('price-display').textContent = '$—'
      $('price-display').className   = 'price-big'
      $('rsi-val').textContent  = 'Loading...'
      $('macd-val').textContent = '—'
      $('vwap-val').textContent = '—'
      $('bidask-val').textContent = '—'
      window.copilot.subscribe(ticker)
    }
  })

  // Strategy change
  $('strategy-select').addEventListener('change', e => {
    state.strategy = e.target.value
    updateModeUI()
    pushTradeContext()
  })

  // Mode change
  $('mode-select').addEventListener('change', e => {
    state.mode = e.target.value
    updateModeUI()
  })

  // Entry price set — click OR Enter key
  const applyEntry = () => {
    const val = parseFloat($('entry-input').value)
    if (!isNaN(val) && val > 0) {
      state.entry     = val
      state.entryTime = Date.now()
      pushTradeContext()
      updatePnL()
      // Auto-update levels if enabled and last preset known
      if (state.autoUpdateLevels && state.lastPreset) {
        applyPreset(state.lastPreset)
        showToast('Entry $' + val.toFixed(3) + ' — levels updated')
      } else {
        // Reset preset highlight since entry changed without re-applying
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('preset-active'))
        const rrRow = $('rr-row')
        if (rrRow) rrRow.style.display = 'none'
      }
    }
  }


  // Stop input

  // Target inputs

  // Config button
  $('config-btn').addEventListener('click', () => {
    console.log('[Renderer] Config button clicked')
    window.copilot.openConfig()
  })

  // Favorite buttons rendered dynamically — see renderFavorites()

  // Message dropdown — auto copy on select if enabled
  $('message-select').addEventListener('change', e => {
    updateMessagePreview(e.target.value)
    if (state.autoCopyOnSelect && e.target.value) {
      sendMessageById(e.target.value, true)
    }
  })

  // Send to Claude — manual re-copy
  $('send-claude-btn').addEventListener('click', () => {
    const msgId = $('message-select').value
    if (msgId) sendMessageById(msgId)
  })
}

// ── Mode UI updates ────────────────────────────────────────────────────────────
function updateModeUI() {
  const mode     = state.mode
  const strategy = state.strategy

  const show = id => $(id).classList.remove('hidden')
  const hide = id => $(id).classList.add('hidden')

  if (mode === 'off') {
    show('off-state')
    // Hide all tab content areas when off
    document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'))
    return
  }
  hide('off-state')
  // Show current active tab
  const activeTab = localStorage.getItem('activeTab') || 'research'
  const activeEl = document.getElementById('tab-' + activeTab)
  if (activeEl) activeEl.classList.remove('hidden')

  hide('off-state')
  // With tabbed UI, main-panel is no longer a single div — tabs handle visibility

  // Trade form visibility based on mode
  const tradeNoPos = $('trade-no-position')
  if (mode === 'intrade') {
    show('intrade-levels')
    hide('exit-levels')
    if (tradeNoPos) tradeNoPos.classList.add('hidden')
    startPositionsPolling()
  } else if (mode === 'exit') {
    hide('intrade-levels')
    show('exit-levels')
    if (tradeNoPos) tradeNoPos.classList.add('hidden')
  } else {
    hide('intrade-levels')
    hide('exit-levels')
    if (tradeNoPos) tradeNoPos.classList.remove('hidden')
  }

  // Scalp-specific UI
  if (strategy === 'scalp') {
    show('scalp-callout')
    hide('spread-metric')
    // Hide targets for scalp
    if ($('targets-block')) hide('targets-block')
  } else {
    hide('scalp-callout')
    show('spread-metric')
    if ($('targets-block')) show('targets-block')
  }

  // Filter message dropdown for mode/strategy
  filterMessages(mode, strategy)
}

// ── Push trade context to main process ────────────────────────────────────────
function pushTradeContext() {
  window.copilot.setTradeContext({
    ticker:    state.ticker,
    strategy:  state.strategy,
    mode:      state.mode,
    entry:     state.entry,
    stop:      state.stop,
    target1:   state.target1,
    target2:   state.target2,
    entryTime: state.entryTime,
    shares:    state.shares
  })
}

// ── Alpaca data listeners ──────────────────────────────────────────────────────
function setupAlpacaListeners() {

  // Set initial ticker in AlertManager once loaded
  setTimeout(() => {
    if (state.ticker && typeof AlertManager !== 'undefined') {
      AlertManager.setTicker(state.ticker)
    }
  }, 500)

  window.copilot.onStatus(data => {
    state.connected = data.connected
    $('status-dot').className = 'status-dot ' + (data.connected ? 'connected' : 'disconnected')
    $('status-text').textContent = data.connected
      ? 'Alpaca · ' + (data.paper ? 'paper' : 'live')
      : 'Disconnected'
    // BUG-5: update feed label from actual config
    if (window.copilot.getConfig) {
      window.copilot.getConfig().then(cfg => {
        const feed = (cfg.dataFeed || 'iex').toUpperCase()
        const el = $('feed-label')
        if (el) el.textContent = feed + ' · ' + (state.ticker || '—')
      })
    }
  })

  window.copilot.onQuote(data => {
    state.price     = data.price
    state.bid       = data.bid
    state.ask       = data.ask
    state.spread    = data.spread
    state.spreadPct = data.spreadPct
    updatePriceDisplay()
    updateBidAsk()
    updatePnL()
    updateExitLevels()
  })

  window.copilot.onIndicators(data => {
    state.rsi        = data.rsi
    state.rsi5m      = data.rsi5m      || null
    state.rsi15m     = data.rsi15m     || null
    state.macd       = data.macd
    state.macdSignal = data.macdSignal || null
    state.macdHist   = data.macdHist   || null
    state.ema20      = data.ema20      || null
    state.ema50      = data.ema50      || null
    state.sma20      = data.sma20      || null
    state.vwap       = data.vwap
    state.volRatio   = data.volRatio
    state.volCurrent = data.bar?.volume || 0
    state.volAvg     = data.volAvg
    if (state.volCurrent > state.volHigh) state.volHigh = state.volCurrent
    // Track day range from bar data
    // Use session H/L from daily bar (accurate), fallback to bar range
    if (data.sessionHigh) state.sessionHigh = data.sessionHigh
    if (data.sessionLow)  state.sessionLow  = data.sessionLow
    if (data.sessionOpen) state.sessionOpen = data.sessionOpen
    // Legacy fallback
    if (data.high) state.dayHigh = state.sessionHigh || data.high
    if (data.low)  state.dayLow  = state.sessionLow  || data.low
    if (data.bar?.open && !state.dayOpen) state.dayOpen = state.sessionOpen || data.bar.open
    updateRangeBar()
    state.high       = data.high
    state.low        = data.low
    state.bars       = data.bars || []
    updateIndicators()
    updateVolume()
    updateMiniChart()
    updateTapeDirection()
  })

  window.copilot.onBar(data => {
    addTapeRow(data)
  })

  window.copilot.onAlert(data => {
    AlertManager.add(data)
    updateAlertBadge()
  })

  // Re-subscribe current ticker after config save + re-apply UI settings
  window.copilot.onResubscribe(async () => {
    // Reload config to pick up any changed settings (feed, reposition, etc.)
    if (window.copilot.getConfig) {
      const cfg = await window.copilot.getConfig()
      state.allowReposition = cfg.allowReposition === true
      state.tradePresets    = cfg.tradePresets || []
      renderPresets()
      populatePresetDropdown()
      // Re-apply repositioning hover state immediately — no restart needed
      setupRepositionHovers(state.allowReposition)
    }
    if (state.ticker) {
  window.copilot.unsubscribe(state.ticker)
      setTimeout(() => {
        window.copilot.subscribe(state.ticker)
        window.copilot.setTradeContext({ ticker: state.ticker, strategy: state.strategy })
      }, 500)
    }
  })
}

// ── Price formatting ─────────────────────────────────────────────────────────
function fmtPrice(p) {
  if (!p || isNaN(p)) return '--'
  if (p < 10)  return '$' + p.toFixed(4)
  if (p < 100) return '$' + p.toFixed(3)
  return '$' + p.toFixed(2)
}

function fmtDiff(diff, base) {
  if (!diff || !base) return null
  const pct  = (diff / base * 100).toFixed(2)
  const sign = diff >= 0 ? '^' : 'v'
  const abs  = Math.abs(diff)
  const cls  = diff >= 0 ? 'green' : 'red'
  return { text: sign + ' ' + abs.toFixed(abs < 10 ? 4 : abs < 100 ? 3 : 2) + ' (' + pct + '%)', cls }
}

function updatePriceDisplay() {
  if (state.price === null || isNaN(state.price)) return
  const el     = $('price-display')
  const changeEl = $('change-display')
  // BUG-8: smart decimal places
  el.textContent = fmtPrice(state.price)

  // UI-1: show change vs VWAP
  // Show change vs session open (true day change), fallback to VWAP
  const ref = state.sessionOpen || state.dayOpen || state.vwap
  if (ref) {
    const result = fmtDiff(state.price - ref, ref)
    if (result) {
      changeEl.textContent = result.text
      changeEl.className   = 'price-change ' + result.cls
      el.className         = 'price-big ' + result.cls
    }
  } else {
    changeEl.textContent = ''
    el.className = 'price-big'
  }

  // Scalp callout
  if (state.strategy === 'scalp' && state.spread !== null) {
    $('spread-big').textContent = `$${state.spread.toFixed(4)}`
    const pct = state.spreadPct
    const rating = pct <= 0.5 ? '✓ tight'
                 : pct <= 1.0 ? '~ ok'
                 :              '✗ wide'
    const cls    = pct <= 0.5 ? 'green'
                 : pct <= 1.0 ? 'amber'
                 :              'red'
    $('spread-rating').textContent = rating
    $('spread-rating').className   = 'spread-rating ' + cls
    $('spread-big').className      = 'spread-big ' + cls
  }
}

function updateBidAsk() {
  if (state.bid === null || isNaN(state.bid)) return
  if (state.spread === 0 || state.bid === state.ask) {
    // Synthetic — only have last trade price
    $('bidask-val').textContent = `$${state.bid.toFixed(3)} (last trade)`
    $('spread-val').textContent = 'Live quote pending...'
    $('spread-val').className   = 'metric-val muted'
  } else {
    $('bidask-val').textContent = `$${state.bid.toFixed(3)} / $${state.ask.toFixed(3)}`
    $('spread-val').textContent = `$${state.spread.toFixed(4)} (${state.spreadPct.toFixed(1)}%)`
    $('spread-val').className   = 'metric-val ' + (
      state.spreadPct > 1.5 ? 'red' : state.spreadPct > 0.8 ? 'amber' : 'green'
    )
  }
}

function updateIndicators() {
  const rsi   = state.rsi
  const rsi5m  = state.rsi5m
  const rsi15m = state.rsi15m
  const macd   = state.macd

  const setRSI = (elId, val) => {
    const el = $(elId)
    if (!el) return
    if (val !== null && !isNaN(val)) {
      el.textContent = val.toFixed(1)
      el.className   = 'metric-val ' + (val > 70 ? 'red' : val < 30 ? 'green' : 'amber')
    } else {
      el.textContent = '—'
      el.className   = 'metric-val muted'
    }
  }

  setRSI('rsi-val',    rsi)
  setRSI('rsi5m-val',  rsi5m)
  setRSI('rsi15m-val', rsi15m)

  if (macd !== null) {
    const sign = macd >= 0 ? '+' : ''
    const hist = state.macdHist
    const arrow = hist !== null ? (hist > 0 ? ' ▲' : ' ▼') : ''
    $('macd-val').textContent = `${sign}${macd.toFixed(4)}${arrow}`
    $('macd-val').className   = 'metric-val ' + (macd >= 0 ? 'green' : 'red')
  }

  if (state.vwap !== null) {
    $('vwap-val').textContent = `$${state.vwap.toFixed(3)}`
    $('vwap-val').className   = 'metric-val ' + (
      state.price && state.price > state.vwap ? 'green' : 'red'
    )
  }
}

function updateVolume() {
  const ratio   = state.volRatio
  const current = state.volCurrent
  const avg     = state.volAvg
  const high    = state.volHigh || Math.max(current, avg * 3)
  if (ratio === null || !high) return

  // Scale fill width based on session HIGH volume (not 4x avg)
  const fillPct  = Math.min((current / high) * 100, 100)
  const avgPct   = Math.min((avg / high) * 100, 100)

  // Color: below avg = subdued red, above avg = subdued green
  const aboveAvg = current >= avg
  const fillColor = aboveAvg
    ? (ratio > 2.5 ? 'rgba(34,197,94,0.85)' : 'rgba(34,197,94,0.5)')
    : (ratio < 0.5 ? 'rgba(239,68,68,0.75)' : 'rgba(239,68,68,0.45)')

  const ratioEl = $('vol-ratio')
  const fillEl  = $('vol-fill')
  const markEl  = $('vol-avg-mark')
  const curEl   = $('vol-current')
  const avgEl   = $('vol-avg')

  if (ratioEl) {
    ratioEl.textContent = `${ratio.toFixed(1)}x avg`
    ratioEl.className   = 'vol-ratio ' + (aboveAvg ? 'green' : 'red')
  }
  if (fillEl) {
    fillEl.style.width      = fillPct + '%'
    fillEl.style.background = fillColor
  }
  // Move the avg marker
  if (markEl) markEl.style.left = avgPct + '%'

  if (curEl) curEl.textContent = `Vol: ${current.toLocaleString()}`
  if (avgEl) avgEl.textContent = `Avg: ${avg.toLocaleString()}`
}

function updatePnL() {
  // P&L = live market price vs YOUR entry price
  // Never use entry as "current price"
  if (!state.entry) return
  const livePrice = state.price  // always from Alpaca feed
  if (!livePrice) return

  const shares  = parseInt($('order-qty')?.value || state.shares || 100)
  const diff    = livePrice - state.entry
  const pct     = (diff / state.entry * 100).toFixed(1)
  const amt     = (diff * shares).toFixed(2)
  const sign    = diff >= 0 ? '+' : ''
  const str     = `${sign}$${amt} (${sign}${pct}%)`
  const cls     = diff >= 0 ? 'green' : 'red'

  // P&L now shown in positions panel from Alpaca data
  // Nothing to update in main panel
}

function updateExitLevels() {
  // Exit levels shown via positions panel
}

function updateTapeDirection() {
  if (!state.bars || state.bars.length < 3) return
  const last3 = state.bars.slice(-3)
  const green  = last3.filter(b => b.close >= b.open).length
  state.tape   = green >= 2 ? 'Green' : 'Red'
  if (state.strategy === 'scalp') {
    $('tape-speed').textContent = state.tape === 'Green' ? 'GREEN ↑' : 'RED ↓'
    $('tape-speed').className   = 'tape-speed ' + (state.tape === 'Green' ? 'green' : 'red')
  }
}

// ── Tape feed ──────────────────────────────────────────────────────────────────
function addTapeRow(bar) {
  const container = $('tape-container')
  const noTape    = container.querySelector('.no-tape')
  if (noTape) noTape.remove()

  const direction = bar.close >= bar.open ? 'ASK LIFT' : 'BID HIT '
  const cls       = bar.close >= bar.open ? 'tape-green' : 'tape-red'
  const time      = new Date(bar.time)
  const timeStr   = time.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  })

  const row = document.createElement('div')
  row.className = 'tape-row'
  row.innerHTML = `
    <span class="tape-time">${timeStr}</span>
    <span class="${cls}">${direction} $${bar.close.toFixed(3)} — ${bar.volume.toLocaleString()}</span>
  `
  container.insertBefore(row, container.firstChild)

  // Keep max 20 rows
  while (container.children.length > 20) {
    container.removeChild(container.lastChild)
  }
}

// ── Levels display ─────────────────────────────────────────────────────────────
function updateLevels() {
  // Trade levels now driven by Make a Trade form
  // Nothing to update here - levels shown in calc-levels display
}
setInterval(updateLevels, 1000)

// ── Trade presets ──────────────────────────────────────────────────────────────
function renderPresets() {
  const container = $('preset-btns')
  if (!container) return
  container.innerHTML = ''

  const presets = state.tradePresets
  if (!presets || presets.length === 0) return

  presets.forEach((preset, i) => {
    const btn = document.createElement('button')
    btn.className       = 'btn preset-btn'
    btn.dataset.index   = i
    btn.innerHTML       = `
      <span class="preset-name">${preset.name}</span>
      <span class="preset-pcts">SL ${preset.sl}% · T1 ${preset.t1}% · T2 ${preset.t2}%</span>
    `
    btn.addEventListener('click', () => applyPreset(preset))
    container.appendChild(btn)
  })
}

function applyPreset(preset) {
  if (!state.entry) {
    showToast('Set entry price first')
    return
  }
  // Remember last used preset for auto-update on entry change
  state.lastPreset = preset

  const entry = state.entry
  const stop  = parseFloat((entry * (1 - preset.sl  / 100)).toFixed(3))
  const t1    = parseFloat((entry * (1 + preset.t1  / 100)).toFixed(3))
  const t2    = parseFloat((entry * (1 + preset.t2  / 100)).toFixed(3))

  // Update state
  state.stop    = stop
  state.target1 = t1
  state.target2 = t2

  // Update inputs
  const stopIn = $('stop-input')
  const t1In   = $('target1-input')
  const t2In   = $('target2-input')
  if (stopIn) stopIn.value = stop.toFixed(3)
  if (t1In)   t1In.value   = t1.toFixed(3)
  if (t2In)   t2In.value   = t2.toFixed(3)

  // Update display
  $('lv-stop').textContent = `$${stop.toFixed(3)}`

  // Calculate and show R:R
  const risk    = entry - stop
  const reward  = t2    - entry
  const rr      = risk > 0 ? (reward / risk).toFixed(1) : '—'
  const rrRow   = $('rr-row')
  const rrEl    = $('lv-rr')
  if (rrRow) rrRow.style.display = ''
  if (rrEl) {
    rrEl.textContent = `1 : ${rr}  (risk $${risk.toFixed(3)} / reward $${reward.toFixed(3)})`
    rrEl.className   = 'level-val ' + (parseFloat(rr) >= 2 ? 'green' : parseFloat(rr) >= 1 ? 'amber' : 'red')
  }

  // Push to main process
  pushTradeContext()

  // Visual feedback — highlight active preset
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('preset-active'))
  const activeBtn = document.querySelector(`.preset-btn[data-index="${state.tradePresets.indexOf(preset)}"]`)
  if (activeBtn) activeBtn.classList.add('preset-active')

  showToast(`${preset.name} preset applied — SL $${stop.toFixed(3)} T1 $${t1.toFixed(3)} T2 $${t2.toFixed(3)}`)
}

// ── Message handling ───────────────────────────────────────────────────────────
let allMessages = []

async function loadMessages() {
  const data = await window.copilot.getMessages()
  allMessages = data.messages || []
  filterMessages(state.mode, state.strategy)
  renderFavorites()
}

function renderFavorites() {
  const container = $('favorites-container')
  if (!container) return
  container.innerHTML = ''

  const favs = allMessages.filter(m => m.favorite)
  if (favs.length === 0) return

  favs.forEach(msg => {
    const btn = document.createElement('button')
    btn.className = `btn fav-btn fav-${msg.buttonStyle || 'info'}`
    btn.dataset.msgId = msg.id
    btn.textContent   = msg.buttonText || msg.description
    btn.title         = msg.description
    btn.addEventListener('click', () => sendMessageById(msg.id))
    container.appendChild(btn)
  })
}

function sendAllAlerts() {
  const container = $('alerts-container')
  if (!container) return

  const items = container.querySelectorAll('.alert-item')
  if (items.length === 0) {
    showToast('No alerts to send')
    return
  }

  // Collect all unresolved alert templates
  const lines = [`MULTIPLE ALERTS — ${state.ticker || 'N/A'} ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: true })}`]
  lines.push('')

  let count = 0
  items.forEach((item, i) => {
    const body = item.querySelector('.alert-body div:first-child')
    if (body) {
      lines.push(`[${i + 1}] ${body.textContent.trim()}`)
      count++
    }
  })

  lines.push('')
  lines.push(`Strategy: ${state.strategy || 'N/A'} | Mode: ${state.mode || 'N/A'}`)
  lines.push(`Price: ${state.price ? '$' + state.price.toFixed(3) : 'N/A'} | Entry: ${state.entry ? '$' + state.entry.toFixed(3) : 'N/A'} | RSI: ${state.rsi || 'N/A'} | VWAP: ${state.vwap ? '$' + state.vwap.toFixed(3) : 'N/A'}`)
  lines.push('Is thesis intact or immediate action needed?')

  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    showToast(`${count} alerts copied — Ctrl+V into Claude chat`)
  })
}

function filterMessages(mode, strategy) {
  const select = $('message-select')
  const prev   = select.value
  select.innerHTML = '<option value="">Select message...</option>'

  allMessages
    .filter(m => {
      // When mode is 'off' show all messages so user can still browse/send
      const modeOk     = mode === 'off' || !m.mode || m.mode.includes(mode)
      const strategyOk = !m.strategy || m.strategy === 'all' || m.strategy === strategy
      return modeOk && strategyOk
    })
    .forEach(m => {
      const opt = document.createElement('option')
      opt.value       = m.id
      opt.textContent = m.description
      select.appendChild(opt)
    })

  // Restore previous selection if still valid
  if (prev && select.querySelector(`option[value="${prev}"]`)) {
    select.value = prev
    updateMessagePreview(prev)
  } else {
    $('msg-preview').classList.add('hidden')
    $('send-claude-btn').disabled = true
  }
}

function updateMessagePreview(msgId) {
  if (!msgId) {
    $('msg-preview').classList.add('hidden')
    $('send-claude-btn').disabled = true
    return
  }
  const msg = allMessages.find(m => m.id === msgId)
  if (!msg) return
  const resolved = resolvePlaceholders(msg.template, state)
  // Highlight resolved token values — find what changed from template
  const highlighted = highlightTokenValues(msg.template, resolved)
  $('msg-preview').innerHTML = highlighted
  $('msg-preview').classList.remove('hidden')
  $('send-claude-btn').disabled = false
}

function highlightTokenValues(template, resolved) {
  // Find all placeholder positions in template and mark resolved values
  const tokenRegex = /\[([A-Z0-9_]+)\]/g
  let result = resolved
  // Escape HTML first
  result = result.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  // Now highlight values that replaced tokens — we do this by resolving
  // each token individually and wrapping in a span
  const tokens = [...template.matchAll(tokenRegex)].map(m => m[0])
  const unique  = [...new Set(tokens)]
  unique.forEach(token => {
    const val = resolvePlaceholders(token, state)
    if (val && val !== 'N/A' && val !== token) {
      const escaped = val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const safe    = val.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      result = result.replace(
        new RegExp(escaped.replace(/&/g,'&amp;'), 'g'),
        `<span class="token-val">${safe}</span>`
      )
    }
  })
  return result
}

function sendMessageById(msgId, silent = false) {
  const msg = allMessages.find(m => m.id === msgId)
  if (!msg) return
  const resolved = resolvePlaceholders(msg.template, state)
  navigator.clipboard.writeText(resolved).then(() => {
    if (!silent) {
      showToast('Copied — Ctrl+V into Claude chat')
    } else {
      showToast('Auto-copied — Ctrl+V into Claude chat')
    }
    // Mark as sent in UI
    markAlertsSent(msgId)
  })
}

function markAlertsSent(msgId) {
  // Visual feedback on favorite buttons
  document.querySelectorAll('.fav-btn').forEach(btn => {
    if (btn.dataset.msgId === msgId) {
      btn.classList.add('fav-sent')
      setTimeout(() => btn.classList.remove('fav-sent'), 2000)
    }
  })
}

// ── Toast notification ─────────────────────────────────────────────────────────
function showToast(text) {
  let toast = document.getElementById('toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'toast'
    toast.style.cssText = `
      position: fixed; bottom: 40px; left: 50%; transform: translateX(-50%);
      background: #1c2028; border: 0.5px solid rgba(255,255,255,0.15);
      color: #e8eaf0; font-size: 11px; padding: 7px 14px;
      border-radius: 6px; z-index: 999; font-family: var(--font-mono);
      white-space: nowrap;
    `
    document.body.appendChild(toast)
  }
  toast.textContent = text
  toast.style.opacity = '1'
  clearTimeout(toast._t)
  toast._t = setTimeout(() => { toast.style.opacity = '0' }, 2000)
}



// ── Trade Form Logic ────────────────────────────────────────────────────────

function onOrderPriceChange() {
  // Auto-recalculate levels when price changes if preset selected
  const presetSel = $('preset-select')
  if (!presetSel || !presetSel.value) return
  const preset = state.tradePresets.find(p => p.name === presetSel.value)
  if (preset) calcLevels(preset)
}

function onPresetSelect(name) {
  if (name === '__manual__') {
    // Clear calculated levels — user will type them
    const fields = ['calc-sl','calc-t1','calc-t2','calc-sl-pct','calc-t1-pct','calc-t2-pct']
    fields.forEach(id => { const el = $(id); if (el) el.textContent = '—' })
    const rrRow = $('rr-row')
    if (rrRow) rrRow.style.display = 'none'
    state.lastPreset = null
    state.stop    = null
    state.target1 = null
    state.target2 = null
    return
  }
  const preset = state.tradePresets.find(p => p.name === name)
  if (!preset) return
  state.lastPreset = preset
  calcLevels(preset)
}

function calcLevels(preset) {
  const priceEl = $('order-price')
  const price   = parseFloat(priceEl?.value) || state.price
  if (!price) return

  const sl = parseFloat((price * (1 - preset.sl  / 100)).toFixed(3))
  const t1 = parseFloat((price * (1 + preset.t1  / 100)).toFixed(3))
  const t2 = parseFloat((price * (1 + preset.t2  / 100)).toFixed(3))

  state.stop    = sl
  state.target1 = t1
  state.target2 = t2

  // Update display
  const set = (id, val, pct) => {
    const el = $(id)
    if (el) el.textContent = '$' + val.toFixed(3)
    const pctEl = $(id + '-pct') || $(pct)
    if (pctEl) pctEl.textContent = preset[pct.replace('calc-','').replace('-pct','')] + '%'
  }

  const slEl  = $('calc-sl');  if (slEl)  slEl.textContent  = '$' + sl.toFixed(3)
  const t1El  = $('calc-t1');  if (t1El)  t1El.textContent  = '$' + t1.toFixed(3)
  const t2El  = $('calc-t2');  if (t2El)  t2El.textContent  = '$' + t2.toFixed(3)

  const slPct = $('calc-sl-pct'); if (slPct) slPct.textContent = '-' + preset.sl + '%'
  const t1Pct = $('calc-t1-pct'); if (t1Pct) t1Pct.textContent = '+' + preset.t1 + '%'
  const t2Pct = $('calc-t2-pct'); if (t2Pct) t2Pct.textContent = '+' + preset.t2 + '%'

  // R:R
  const risk   = price - sl
  const reward = t2    - price
  const rr     = risk > 0 ? (reward / risk).toFixed(1) : '—'
  const rrRow  = $('rr-row')
  const rrEl   = $('lv-rr')
  if (rrRow) rrRow.style.display = ''
  if (rrEl)  {
    rrEl.textContent = '1 : ' + rr
    rrEl.className   = 'calc-val ' + (parseFloat(rr) >= 2 ? 'green' : parseFloat(rr) >= 1 ? 'amber' : 'red')
  }
}

function populatePresetDropdown() {
  const sel = $('preset-select')
  if (!sel) return
  const prev = sel.value
  sel.innerHTML = '<option value="">Select preset...</option>'
  // Manual option — enter levels yourself
  const manOpt = document.createElement('option')
  manOpt.value       = '__manual__'
  manOpt.textContent = 'Manual (enter levels)'
  sel.appendChild(manOpt)
  state.tradePresets.forEach(p => {
    const opt = document.createElement('option')
    opt.value       = p.name
    opt.textContent = p.name + ' (SL ' + p.sl + '% T1 ' + p.t1 + '% T2 ' + p.t2 + '%)'
    sel.appendChild(opt)
  })
  if (prev) sel.value = prev
}

// ── Order submission ─────────────────────────────────────────────────────────
async function submitOrder(side) {
  if (!state.ticker) { showToast('Enter a ticker first'); return }

  const priceEl   = $('order-price')
  const qtyEl     = $('order-qty')
  const typeEl    = $('order-type')
  const statusEl  = $('order-status')
  const buyBtn    = $('buy-btn')

  const orderType = typeEl?.value || 'market'
  const qty       = parseInt(qtyEl?.value || 100)
  const price     = parseFloat(priceEl?.value) || state.price

  if (isNaN(qty) || qty <= 0) { showToast('Invalid quantity'); return }
  if (orderType !== 'market' && (!price || isNaN(price))) {
    showToast('Enter a price for ' + orderType + ' order'); return
  }

  // Build confirmation message
  const priceStr  = orderType === 'market' ? 'market price' : '$' + price.toFixed(3)
  const slStr     = state.stop   ? ' SL $' + state.stop.toFixed(3)   : ''
  const t1Str     = state.target1? ' T1 $' + state.target1.toFixed(3): ''
  const orderClass= (orderType === 'bracket' && state.stop && state.target1) ? 'bracket' : 'simple'
  const msg = 'BUY ' + qty + ' ' + state.ticker + ' at ' + priceStr + slStr + t1Str + ' (' + orderType + (orderClass === 'bracket' ? ' bracket - SL+T1 auto' : '') + ') - Confirm paper trade?'
  if (!confirm(msg)) return

  if (buyBtn) buyBtn.disabled = true
  if (statusEl) statusEl.textContent = 'Submitting...'

  // Build order payload
  const payload = {
    symbol:        state.ticker,
    qty:           String(qty),
    side:          'buy',
    time_in_force: 'day'
  }

  if (orderType === 'market') {
    payload.type = 'market'

  } else if (orderType === 'limit') {
    payload.type        = 'limit'
    payload.limit_price = String(price.toFixed(2))

  } else if (orderType === 'bracket_market') {
    // Market entry + bracket (auto SL + T1)
    payload.type        = 'market'
    payload.order_class = 'bracket'
    if (state.stop) {
      payload.stop_loss = { stop_price: String(state.stop.toFixed(2)) }
    }
    if (state.target1) {
      payload.take_profit = { limit_price: String(state.target1.toFixed(2)) }
    }

  } else if (orderType === 'bracket_limit') {
    // Limit entry + bracket (auto SL + T1)
    payload.type        = 'limit'
    payload.limit_price = String(price.toFixed(2))
    payload.order_class = 'bracket'
    if (state.stop) {
      payload.stop_loss = { stop_price: String(state.stop.toFixed(2)) }
    }
    if (state.target1) {
      payload.take_profit = { limit_price: String(state.target1.toFixed(2)) }
    }
  }

  try {
    const result = await window.copilot.submitOrder(payload)

    if (result.success) {
      const order   = result.order
      const filled  = order.filled_avg_price || order.limit_price || ''
      const status  = order.status || 'submitted'
      const priceShow = filled ? '$' + parseFloat(filled).toFixed(3) : priceStr
      if (statusEl) {
        statusEl.textContent = 'BUY ' + qty + ' @ ' + priceShow + ' - ' + status
        statusEl.className   = 'order-status-line order-ok'
      }
      console.log('[Trade] BUY ' + qty + ' ' + state.ticker + ' submitted - ' + status)
      // Refresh orders after short delay
      setTimeout(() => refreshOrders(), 1500)
      setTimeout(() => refreshPositions(), 3000)
    } else {
      if (statusEl) {
        statusEl.textContent = 'Error: ' + result.error
        statusEl.className   = 'order-status-line order-err'
      }
      showToast('Order failed: ' + result.error)
    }
  } catch (e) {
    console.error('[Trade] Error:', e)
    if (statusEl) statusEl.textContent = 'Error - see console'
  } finally {
    if (buyBtn) buyBtn.disabled = false
  }
}

// ── Positions polling ────────────────────────────────────────────────────────
let _posInterval = null

function startPositionsPolling() {
  refreshPositions()
  refreshOrders()
  if (_posInterval) clearInterval(_posInterval)
  _posInterval = setInterval(() => {
    if (state.mode === 'intrade' || state.mode === 'exit') {
      refreshPositions()
      refreshOrders()
    }
  }, 5000)
}

async function refreshPositions() {
  const result = await window.copilot.getPositions()
  if (!result.success) return
  const container = $('positions-container')
  if (!container) return
  const positions = result.positions || []

  if (positions.length === 0) {
    container.innerHTML = '<div class="no-data">No open positions</div>'
    return
  }

  container.innerHTML = positions.map(p => {
    const qty      = parseFloat(p.qty)
    const avgEntry = parseFloat(p.avg_entry_price)
    const current  = parseFloat(p.current_price)
    const pnl      = parseFloat(p.unrealized_pl)
    const pnlPct   = parseFloat(p.unrealized_plpc) * 100
    const sign     = pnl >= 0 ? '+' : ''
    const cls      = pnl >= 0 ? 'green' : 'red'
    return '<div class="position-card">' +
      '<div class="pos-header">' +
        '<span class="pos-ticker">' + p.symbol + '</span>' +
        '<span class="pos-qty">' + qty + ' shares</span>' +
        '<span class="pos-pnl ' + cls + '">' + sign + '$' + pnl.toFixed(2) + ' (' + sign + pnlPct.toFixed(1) + '%)</span>' +
      '</div>' +
      '<div class="pos-detail">' +
        '<span class="pos-entry">Entry $' + avgEntry.toFixed(3) + '</span>' +
        '<span class="pos-arrow">→</span>' +
        '<span class="pos-price">Now $' + current.toFixed(3) + '</span>' +
      '</div>' +
    '</div>'
  }).join('')
}

async function refreshOrders() {
  const result = await window.copilot.getPositions()
  // Use orders endpoint
  try {
    const cfg     = await window.copilot.getConfig()
    // Orders fetched via main process — use existing getPositions as pattern
    // For now show from last submitOrder result cached
  } catch(e) {}

  // Fetch today's orders
  const ordResult = await window.copilot.getOrders()
  if (!ordResult || !ordResult.success) return
  const container  = $('orders-container')
  if (!container) return
  const orders = ordResult.orders || []

  if (orders.length === 0) {
    container.innerHTML = '<div class="no-data">No orders today</div>'
    return
  }

  container.innerHTML = orders.map(o => {
    const side     = o.side.toUpperCase()
    const sideCls  = side === 'BUY' ? 'green' : 'red'
    const price    = o.filled_avg_price || o.limit_price || o.stop_price || '—'
    const priceStr = price !== '—' ? '$' + parseFloat(price).toFixed(3) : '—'
    const time     = new Date(o.submitted_at || o.created_at).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: true
    })
    const orderType = o.order_class === 'bracket' ? 'BKT'
                    : o.type === 'market' ? 'MKT'
                    : o.type === 'limit'  ? 'LMT'
                    : o.type || '—'
    return '<div class="order-row">' +
      '<span class="ord-time">' + time + '</span>' +
      '<span class="ord-side ' + sideCls + '">' + side + '</span>' +
      '<span class="ord-ticker">' + o.symbol + '</span>' +
      '<span class="ord-qty">' + o.qty + '</span>' +
      '<span class="ord-type">' + orderType + '</span>' +
      '<span class="ord-price">' + priceStr + '</span>' +
      '<span class="ord-status">' + o.status + '</span>' +
    '</div>'
  }).join('')
}


// ── Tab management ────────────────────────────────────────────────────────────
function switchTab(name) {
  // Save preference
  try { localStorage.setItem('activeTab', name) } catch(e) {}

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === name)
  })
  document.querySelectorAll('.tab-content').forEach(tab => {
    tab.classList.toggle('hidden', tab.id !== 'tab-' + name)
  })

  // Populate log tab when switched to
  if (name === 'log') {
    renderLogTab()
    // Clear badge when log tab is visited
    const badge = document.getElementById('alert-badge')
    if (badge) badge.classList.add('hidden')
  }
}

function renderLogTab() {
  const container   = document.getElementById('log-container')
  const tickerSel   = document.getElementById('log-filter-ticker')
  const severitySel = document.getElementById('log-filter-severity')
  if (!container) return

  const filterTicker   = tickerSel?.value   || ''
  const filterSeverity = severitySel?.value || ''

  // Collect all alerts from all tickers
  const cache = AlertManager.getCache ? AlertManager.getCache() : {}
  let all = []
  Object.entries(cache).forEach(([ticker, alerts]) => {
    alerts.forEach(a => all.push({ ...a, ticker }))
  })

  // Sort newest first
  all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))

  // Filter
  if (filterTicker)   all = all.filter(a => a.ticker === filterTicker)
  if (filterSeverity) all = all.filter(a => a.severity === filterSeverity)

  // Update ticker dropdown options
  const tickers = [...new Set(Object.keys(cache))]
  const prevTicker = tickerSel?.value
  if (tickerSel) {
    tickerSel.innerHTML = '<option value="">All tickers</option>'
    tickers.forEach(t => {
      const opt = document.createElement('option')
      opt.value = t; opt.textContent = t
      tickerSel.appendChild(opt)
    })
    if (prevTicker) tickerSel.value = prevTicker
  }

  if (all.length === 0) {
    container.innerHTML = '<div class="no-data">No alerts in log</div>'
    return
  }

  const now = Date.now()
  container.innerHTML = all.map(alert => {
    const cls  = severityClass(alert.severity)
    const time = new Date(alert.timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    })
    const stale = (now - new Date(alert.timestamp).getTime()) > 10 * 60 * 1000
    const viewBtn = alert.url
      ? '<button class="alert-view-btn" onclick="AlertManager.openUrl(this.dataset.url)" data-url="' + encodeURIComponent(alert.url || '') + '" title="View article">🔗</button>'
      : ''
    return '<div class="alert-item ' + cls + (stale ? ' alert-stale' : '') + '" data-uid="' + alert.uid + '">' +
      '<div class="alert-dot"></div>' +
      '<div class="alert-body">' +
        '<div>' + alert.label + ' <span style="font-size:10px;opacity:0.65;">' + (alert.ticker || '') + '</span></div>' +
        '<div class="alert-time">' + time + (stale ? ' · stale' : '') + '</div>' +
      '</div>' +
      viewBtn +
      '<button class="alert-send-btn" onclick="AlertManager.sendAlertByUid(\'' + alert.uid + '\')">Send ↗</button>' +
      '<button class="alert-x-btn" onclick="AlertManager.removeAlertGlobal(\'' + alert.uid + '\');renderLogTab()" title="Remove">✕</button>' +
    '</div>'
  }).join('')
}

function severityClass(severity) {
  const map = { danger: 'alert-danger', warning: 'alert-warning', info: 'alert-info', success: 'alert-success' }
  return map[severity] || 'alert-info'
}

function updateAlertBadge() {
  const badge = document.getElementById('alert-badge')
  if (!badge) return
  const cache = AlertManager.getCache ? AlertManager.getCache() : {}
  const ticker = state.ticker
  const count = (cache[ticker] || []).length
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count
    badge.classList.remove('hidden')
  } else {
    badge.classList.add('hidden')
  }
}


// ── Panel reordering ─────────────────────────────────────────────────────────
const DEFAULT_PANEL_ORDER = ['alerts', 'tape', 'send-claude', 'quick-send']

function initPanelReorder() {
  // Load saved order
  let order = DEFAULT_PANEL_ORDER
  try {
    const saved = localStorage.getItem('panelOrder')
    if (saved) order = JSON.parse(saved)
  } catch(e) {}
  applyPanelOrder(order)

  // Load reposition setting
  const allowRepo = state.allowReposition
  setupRepositionHovers(allowRepo)
}

function applyPanelOrder(order) {
  const container = document.getElementById('panels-container')
  if (!container) return
  order.forEach(panelId => {
    const el = container.querySelector('[data-panel-id="' + panelId + '"]')
    if (el) container.appendChild(el)
  })
}

function movePanel(panelId, direction) {
  const container = document.getElementById('panels-container')
  if (!container) return
  const panels = Array.from(container.querySelectorAll('.reorder-panel'))
  const idx    = panels.findIndex(p => p.dataset.panelId === panelId)
  if (idx === -1) return

  if (direction === 'up' && idx > 0) {
    container.insertBefore(panels[idx], panels[idx - 1])
  } else if (direction === 'down' && idx < panels.length - 1) {
    container.insertBefore(panels[idx + 1], panels[idx])
  }

  // Save new order
  const newOrder = Array.from(container.querySelectorAll('.reorder-panel'))
    .map(p => p.dataset.panelId)
  try { localStorage.setItem('panelOrder', JSON.stringify(newOrder)) } catch(e) {}
}

function setupRepositionHovers(enabled) {
  document.querySelectorAll('.reorder-panel').forEach(panel => {
    const handle = panel.querySelector('.panel-reorder-handle')
    if (!handle) return

    if (!enabled) {
      handle.classList.add('hidden')
      return
    }

    panel.addEventListener('mouseenter', () => handle.classList.remove('hidden'))
    panel.addEventListener('mouseleave', () => handle.classList.add('hidden'))
  })
}



// ── Panel resize handles ──────────────────────────────────────────────────────
function initResizeHandles() {
  document.querySelectorAll('.resize-handle').forEach(handle => {
    const targetId = handle.dataset.target
    const target   = document.getElementById(targetId)
    if (!target) return

    // Restore saved height
    try {
      const saved = localStorage.getItem('panelHeight:' + targetId)
      if (saved) target.style.height = saved + 'px'
    } catch(e) {}

    let startY = 0, startH = 0, dragging = false

    handle.addEventListener('mousedown', e => {
      dragging = true
      startY   = e.clientY
      startH   = target.offsetHeight
      document.body.style.cursor   = 'ns-resize'
      document.body.style.userSelect = 'none'
      e.preventDefault()
    })

    document.addEventListener('mousemove', e => {
      if (!dragging) return
      const newH = Math.max(60, Math.min(500, startH + (e.clientY - startY)))
      target.style.height = newH + 'px'
    })

    document.addEventListener('mouseup', () => {
      if (!dragging) return
      dragging = false
      document.body.style.cursor    = ''
      document.body.style.userSelect = ''
      // Save height
      try {
        localStorage.setItem('panelHeight:' + targetId, target.offsetHeight)
      } catch(e) {}
    })
  })
}


// ── Price range bar ────────────────────────────────────────────────────────────
function updateRangeBar() {
  const low   = state.sessionLow  || state.dayLow
  const high  = state.sessionHigh || state.dayHigh
  const price = state.price
  if (!low || !high || !price || high === low) return
  const range    = high - low
  const pricePct = Math.min(100, Math.max(0, (price - low) / range * 100))
  const fill     = document.getElementById('range-fill')
  const cursor   = document.getElementById('range-cursor')
  const lowEl    = document.getElementById('range-low')
  const highEl   = document.getElementById('range-high')
  const pctEl    = document.getElementById('range-pct')
  if (fill)   { fill.style.left = '0%'; fill.style.width = pricePct + '%' }
  if (cursor) cursor.style.left = pricePct + '%'
  const dSign = '$'
  const fmt2 = v => dSign + v.toFixed(2)
  if (lowEl)  lowEl.textContent  = 'L ' + fmt2(low)
  if (highEl) highEl.textContent = 'H ' + fmt2(high)
  if (pctEl)  {
    const fromLow = ((price - low) / range * 100).toFixed(0)
    pctEl.textContent = fromLow + '% from low'
    pctEl.className   = 'range-pct ' + (pricePct > 50 ? 'green' : 'red')
  }
}

// ── TRD-4: Subscribe to held positions for live price updates ─────────────────
let _positionTickers = new Set()

async function subscribePositionTickers() {
  const result = await window.copilot.getPositions()
  if (!result || !result.success) return
  const positions = result.positions || []
  positions.forEach(pos => {
    const sym = pos.symbol
    if (!_positionTickers.has(sym) && sym !== state.ticker) {
      _positionTickers.add(sym)
      window.copilot.subscribe(sym)
    }
  })
}


init()
