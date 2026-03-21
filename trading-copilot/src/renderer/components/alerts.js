// ============================================
// TRADING COPILOT — ALERTS MANAGER
// Renders alert items in the panel.
// Each alert has a Send to Claude button.
// ============================================

const AlertManager = (() => {
  const MAX_ALERTS = 6
  let alertDefs    = []
  let alertLog     = []

  async function init() {
    const data = await window.copilot.getMessages()
    alertDefs  = data.alerts || []
  }

  function add({ alertId, data, timestamp }) {
    const def = alertDefs.find(a => a.id === alertId)
    if (!def) return

    // Resolve the alert template with current state
    const resolvedText = def.template
      ? resolvePlaceholders(def.template, { ...state, ...data })
      : def.label

    const alert = {
      id:        alertId,
      label:     def.label,
      severity:  def.severity,
      text:      resolvedText,
      msgId:     def.message_id,
      timestamp: timestamp || new Date().toISOString(),
      template:  def.template
    }

    alertLog.unshift(alert)
    if (alertLog.length > MAX_ALERTS) alertLog.pop()

    render()

    // Play sound if enabled
    playAlertSound(def.severity)
  }

  function render() {
    const container = document.getElementById('alerts-container')
    if (!container) return

    if (alertLog.length === 0) {
      container.innerHTML = '<div class="no-alerts">No alerts — monitoring active</div>'
      return
    }

    container.innerHTML = alertLog.map(alert => {
      const cls  = severityClass(alert.severity)
      const time = new Date(alert.timestamp).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      })
      return `
        <div class="alert-item ${cls}" data-id="${alert.id}">
          <div class="alert-dot"></div>
          <div class="alert-body">
            <div>${alert.label}</div>
            <div class="alert-time">${time}</div>
          </div>
          <button class="alert-send-btn" onclick="AlertManager.sendAlert('${alert.id}')">
            Send ↗
          </button>
        </div>
      `
    }).join('')
  }

  function sendAlert(alertId) {
    const alert = alertLog.find(a => a.id === alertId)
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
    // Simple audio context beep — no file needed
    try {
      const ctx  = new (window.AudioContext || window.webkitAudioContext)()
      const osc  = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.value = severity === 'danger' ? 880
                          : severity === 'warning' ? 660
                          : 440
      gain.gain.setValueAtTime(0.1, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
      osc.start(ctx.currentTime)
      osc.stop(ctx.currentTime + 0.3)
    } catch (e) {}
  }

  init()
  return { add, sendAlert }
})()
