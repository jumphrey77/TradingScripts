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
  bid:       null,
  ask:       null,
  spread:    null,
  spreadPct: null,
  rsi:       null,
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
    window.copilot.openConfig()
  })

  // Emergency exit
  $('emergency-btn').addEventListener('click', () => {
    sendMessageById('msg_015')
  })

  // Move stop
  $('move-stop-btn').addEventListener('click', () => {
    sendMessageById('msg_008')
  })

  // Message dropdown
  $('message-select').addEventListener('change', e => {
    updateMessagePreview(e.target.value)
  })

  // Send to Claude
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
  if (state.price === null) return
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
  if (state.bid === null) return
  $('bidask-val').textContent = `$${state.bid.toFixed(3)} / $${state.ask.toFixed(3)}`
  $('spread-val').textContent = `$${state.spread.toFixed(4)} (${state.spreadPct.toFixed(1)}%)`
  $('spread-val').className   = 'metric-val ' + (
    state.spreadPct > 1.5 ? 'red' : state.spreadPct > 0.8 ? 'amber' : 'green'
  )
}

function updateIndicators() {
  const rsi  = state.rsi
  const macd = state.macd

  if (rsi !== null) {
    $('rsi-val').textContent = rsi.toFixed(1)
    $('rsi-val').className   = 'metric-val ' + (rsi > 70 ? 'red' : rsi < 30 ? 'green' : 'amber')
  }

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

// ── Message handling ───────────────────────────────────────────────────────────
let allMessages = []

async function loadMessages() {
  const data = await window.copilot.getMessages()
  allMessages = data.messages || []
  filterMessages(state.mode, state.strategy)
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
  $('msg-preview').textContent = resolved
  $('msg-preview').classList.remove('hidden')
  $('send-claude-btn').disabled = false
}

function sendMessageById(msgId) {
  const msg = allMessages.find(m => m.id === msgId)
  if (!msg) return
  const resolved = resolvePlaceholders(msg.template, state)
  // Copy to clipboard for paste into Claude chat
  navigator.clipboard.writeText(resolved).then(() => {
    showToast('Copied to clipboard — Ctrl+V into Claude chat')
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
