// ============================================
// TRADING COPILOT — ALERTS MANAGER
// Per-ticker alert cache with persistence.
// Each ticker keeps its own alert history.
// Alerts older than 10 min shown as stale.
// ============================================

const AlertManager = (() => {
  const MAX_PER_TICKER = 20
  const STALE_MS       = 10 * 60 * 1000  // 10 minutes
  let alertDefs   = []
  let alertCache  = {}   // { 'AAPL': [...], 'MGRX': [...] }
  let currentTicker = ''

  async function init() {
    const data = await window.copilot.getMessages()
    alertDefs  = data.alerts || []
    // Load from localStorage
    try {
      const saved = localStorage.getItem('alertCache')
      if (saved) alertCache = JSON.parse(saved)
    } catch (e) {}
  }

  function save() {
    try { localStorage.setItem('alertCache', JSON.stringify(alertCache)) } catch (e) {}
  }

  function setTicker(ticker) {
    currentTicker = ticker
    render()
  }

  function add({ alertId, data, timestamp }) {
    const def = alertDefs.find(a => a.id === alertId)
    if (!def) return
    const ticker = (typeof state !== 'undefined' && state.ticker) ? state.ticker : ''
    if (!ticker) return

    const resolvedText = def.template
      ? resolvePlaceholders(def.template, { ...state, ...data })
      : def.label

    const alert = {
      uid:       Date.now() + Math.random().toString(36).slice(2),
      id:        alertId,
      label:     def.label,
      severity:  def.severity,
      text:      resolvedText,
      msgId:     def.message_id,
      timestamp: timestamp || new Date().toISOString(),
      template:  def.template,
      ticker
    }

    if (!alertCache[ticker]) alertCache[ticker] = []
    alertCache[ticker].unshift(alert)
    if (alertCache[ticker].length > MAX_PER_TICKER) {
      alertCache[ticker] = alertCache[ticker].slice(0, MAX_PER_TICKER)
    }
    save()
    render()
    playAlertSound(def.severity)
  }

  function removeAlert(uid) {
    if (!currentTicker || !alertCache[currentTicker]) return
    alertCache[currentTicker] = alertCache[currentTicker].filter(a => a.uid !== uid)
    save()
    render()
  }

  function clearTicker(ticker) {
    if (!ticker) return
    delete alertCache[ticker]
    save()
    render()
  }

  function clearAll() {
    alertCache = {}
    try { localStorage.removeItem('alertCache') } catch (e) {}
    render()
  }

  function render() {
    const container  = document.getElementById('alerts-container')
    const sendAllRow = document.getElementById('send-all-row')
    if (!container) return

    const alerts = (currentTicker && alertCache[currentTicker]) || []

    if (alerts.length === 0) {
      container.innerHTML = '<div class="no-alerts">No alerts — monitoring active</div>'
      if (sendAllRow) sendAllRow.classList.add('hidden')
      return
    }

    // Show Send All when 2+ alerts
    if (sendAllRow) {
      if (alerts.length >= 2) sendAllRow.classList.remove('hidden')
      else sendAllRow.classList.add('hidden')
    }

    const now = Date.now()

    // Clear All header
    const clearHeader = `
      <div class="alerts-clear-row">
        <span class="alerts-count">${alerts.length} alert${alerts.length !== 1 ? 's' : ''}</span>
        <button class="alerts-clear-all-btn" onclick="AlertManager.clearTicker('${currentTicker}')">
          Clear all
        </button>
      </div>`

    const items = alerts.map(alert => {
      const cls   = severityClass(alert.severity)
      const time  = new Date(alert.timestamp).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      })
      const stale    = (now - new Date(alert.timestamp).getTime()) > STALE_MS
      const staleTag = stale ? ' alert-stale' : ''
      return `
        <div class="alert-item ${cls}${staleTag}" data-uid="${alert.uid}">
          <div class="alert-dot"></div>
          <div class="alert-body">
            <div>${alert.label} <span style="font-size:10px;opacity:0.65;">${alert.ticker || ''}</span></div>
            <div class="alert-time">${time}${stale ? ' · stale' : ''}</div>
          </div>
          <button class="alert-send-btn" onclick="AlertManager.sendAlert('${alert.uid}')">Send ↗</button>
          <button class="alert-x-btn" onclick="AlertManager.removeAlert('${alert.uid}')" title="Remove">✕</button>
        </div>`
    }).join('')

    container.innerHTML = clearHeader + items
  }

  function sendAlert(uid) {
    const ticker = currentTicker
    const alerts = alertCache[ticker] || []
    const alert  = alerts.find(a => a.uid === uid)
    if (!alert || !alert.template) return
    const resolved = resolvePlaceholders(alert.template, state)
    navigator.clipboard.writeText(resolved).then(() => {
      showToast('Alert copied — Ctrl+V into Claude chat')
    })
  }

  function severityClass(severity) {
    const map = {
      danger:  'alert-danger',
      warning: 'alert-warning',
      info:    'alert-info',
      success: 'alert-success'
    }
    return map[severity] || 'alert-info'
  }

  function playAlertSound(severity) {
    try {
      const ctx  = new (window.AudioContext || window.webkitAudioContext)()
      const osc  = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.value = severity === 'danger' ? 880 : severity === 'warning' ? 660 : 440
      gain.gain.setValueAtTime(0.1, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
      osc.start(ctx.currentTime)
      osc.stop(ctx.currentTime + 0.3)
    } catch (e) {}
  }

  init()
  return { add, sendAlert, removeAlert, clearTicker, clearAll, setTicker, render }
})()
