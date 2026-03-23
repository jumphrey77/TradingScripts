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
  autoCopyOnSelect: true,
  tradePresets:     [],
  bid:       null,
  ask:       null,
  spread:    null,
  spreadPct: null,
  rsi:       null,
  rsi5m:     null,
  rsi15m:    null,
  macd:      null,
  vwap:      null,
  volRatio:  null,
  volCurrent:0,
  volAvg:    0,
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
  // Load autoCopyOnSelect from config
  if (window.copilot && window.copilot.getConfig) {
    const cfg = await window.copilot.getConfig()
    state.autoCopyOnSelect = cfg.autoCopyOnSelect !== false
    state.tradePresets     = cfg.tradePresets || []
    renderPresets()
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
      state.bars   = []
      state.price  = null
      state.rsi    = null
      state.macd   = null
      state.vwap   = null
      // Switch alert cache to new ticker
      if (typeof AlertManager !== 'undefined') AlertManager.setTicker(ticker)
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

  // Entry price set
  $('set-entry-btn').addEventListener('click', () => {
    const val = parseFloat($('entry-input').value)
    if (!isNaN(val) && val > 0) {
      state.entry     = val
      state.entryTime = Date.now()
      // Reset any active preset highlight — entry changed
      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('preset-active'))
      const rrRow = $('rr-row')
      if (rrRow) rrRow.style.display = 'none'
      pushTradeContext()
      updatePnL()
    }
  })

  // Stop input
  $('stop-input').addEventListener('change', e => {
    const val = parseFloat(e.target.value)
    if (!isNaN(val)) {
      state.stop = val
      pushTradeContext()
    }
  })

  // Target inputs
  $('target1-input').addEventListener('change', e => {
    state.target1 = parseFloat(e.target.value) || null
    pushTradeContext()
  })
  $('target2-input').addEventListener('change', e => {
    state.target2 = parseFloat(e.target.value) || null
    pushTradeContext()
  })

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
    hide('main-panel')
    hide('entry-bar')
    return
  }

  hide('off-state')
  show('main-panel')

  // Entry bar
  if (mode === 'intrade' || mode === 'exit') show('entry-bar')
  else hide('entry-bar')

  // Trade levels
  if (mode === 'intrade') { show('intrade-levels'); hide('exit-levels') }
  else if (mode === 'exit') { hide('intrade-levels'); show('exit-levels') }
  else { hide('intrade-levels'); hide('exit-levels') }

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
      ? `Alpaca · ${data.paper ? 'paper' : 'live'}`
      : 'Disconnected'
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
    state.rsi5m      = data.rsi5m  || null
    state.rsi15m     = data.rsi15m || null
    state.macd       = data.macd
    state.vwap       = data.vwap
    state.volRatio   = data.volRatio
    state.volCurrent = data.bar?.volume || 0
    state.volAvg     = data.volAvg
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
  })
}

// ── Display updates ────────────────────────────────────────────────────────────
function updatePriceDisplay() {
  if (state.price === null || isNaN(state.price)) return
  const el     = $('price-display')
  const changeEl = $('change-display')
  el.textContent = `$${state.price.toFixed(3)}`

  if (state.entry) {
    const diff    = state.price - state.entry
    const pct     = (diff / state.entry * 100).toFixed(1)
    const sign    = diff >= 0 ? '+' : ''
    changeEl.textContent = `${sign}$${diff.toFixed(3)} (${sign}${pct}%)`
    changeEl.className   = 'price-change ' + (diff >= 0 ? 'green' : 'red')
    el.className         = 'price-big '    + (diff >= 0 ? 'green' : 'red')
  } else {
    changeEl.textContent = ''
    el.className         = 'price-big'
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
    $('macd-val').textContent = `${sign}${macd.toFixed(4)}`
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
  const ratio = state.volRatio
  if (ratio === null) return
  const pct = Math.min(ratio / 4 * 100, 100)
  $('vol-ratio').textContent  = `${ratio.toFixed(1)}x avg`
  $('vol-ratio').className    = 'vol-ratio ' + (ratio > 3 ? 'red' : ratio > 2 ? 'amber' : 'green')
  $('vol-fill').style.width   = pct + '%'
  $('vol-fill').style.background = ratio > 3
    ? 'var(--red)' : ratio > 2 ? 'var(--amber)' : 'var(--green)'
  $('vol-current').textContent = `Vol: ${state.volCurrent.toLocaleString()}`
  $('vol-avg').textContent     = `Avg: ${state.volAvg.toLocaleString()}`
}

function updatePnL() {
  if (!state.entry || !state.price) return
  const diff    = state.price - state.entry
  const pct     = (diff / state.entry * 100).toFixed(1)
  const amt     = (diff * state.shares).toFixed(2)
  const sign    = diff >= 0 ? '+' : ''
  const str     = `${sign}$${amt} (${sign}${pct}%)`
  const cls     = diff >= 0 ? 'green' : 'red'
  $('pnl-display').textContent = str
  $('pnl-display').className   = 'pnl-display ' + cls
  $('lv-pnl').textContent      = str
  $('lv-pnl').className        = 'level-val ' + cls
}

function updateExitLevels() {
  if (state.mode !== 'exit') return
  $('ex-entry').textContent   = state.entry  ? `$${state.entry.toFixed(3)}`  : '—'
  $('ex-current').textContent = state.price  ? `$${state.price.toFixed(3)}`  : '—'
  $('ex-stop').textContent    = state.stop   ? `$${state.stop.toFixed(3)}`   : '—'
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
  $('lv-entry').textContent = state.entry ? `$${state.entry.toFixed(3)}` : '—'
  $('lv-stop').textContent  = state.stop  ? `$${state.stop.toFixed(3)}`  : '—'
  if (state.entryTime) {
    const elapsed = Date.now() - state.entryTime
    $('lv-time').textContent = formatElapsed(elapsed)
  }
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

// ── Start ──────────────────────────────────────────────────────────────────────
init()
