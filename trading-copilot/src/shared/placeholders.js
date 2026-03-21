// ============================================
// TRADING COPILOT — PLACEHOLDER RESOLVER
// Resolves [T], [P], [E] etc. in message
// templates using live state data.
// Used in the renderer to preview and send
// messages to Claude.
// ============================================

function resolvePlaceholders(template, state) {
  const now = new Date()
  const et  = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const timeET = et.toLocaleTimeString('en-US', {
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }) + ' ET'

  const fmt  = (v, d = 3) => v != null ? `$${parseFloat(v).toFixed(d)}` : 'N/A'
  const fmtN = (v, d = 1) => v != null ? parseFloat(v).toFixed(d) : 'N/A'

  const pnlAmt = state.entry && state.price
    ? ((state.price - state.entry) * (state.shares || 100)).toFixed(2)
    : null
  const pnlPct = state.entry && state.price
    ? (((state.price - state.entry) / state.entry) * 100).toFixed(1)
    : null
  const pnlStr = pnlAmt
    ? `${pnlAmt > 0 ? '+' : ''}$${pnlAmt} (${pnlPct > 0 ? '+' : ''}${pnlPct}%)`
    : 'N/A'

  const elapsed = state.entryTime
    ? formatElapsed(Date.now() - state.entryTime)
    : 'N/A'

  const replacements = {
    '[T]':       state.ticker   || 'N/A',
    '[P]':       fmt(state.price),
    '[E]':       fmt(state.entry),
    '[S]':       fmt(state.stop),
    '[TG1]':     fmt(state.target1),
    '[TG2]':     fmt(state.target2),
    '[PNL]':     pnlStr,
    '[TIME]':    elapsed,
    '[RSI]':     fmtN(state.rsi),
    '[MACD]':    state.macd != null
                   ? (state.macd >= 0 ? '+' : '') + fmtN(state.macd, 4)
                   : 'N/A',
    '[VWAP]':    fmt(state.vwap),
    '[VOL]':     state.volRatio != null ? `${fmtN(state.volRatio)}x avg` : 'N/A',
    '[SPREAD]':  state.spread != null
                   ? `${fmt(state.spread, 4)} (${fmtN(state.spreadPct)}%)`
                   : 'N/A',
    '[TAPE]':    state.tape    || 'N/A',
    '[STRAT]':   state.strategy ? capitalize(state.strategy) : 'N/A',
    '[MODE]':    state.mode    ? capitalize(state.mode)    : 'N/A',
    '[TIME_ET]': timeET,
    '[BID]':     fmt(state.bid),
    '[ASK]':     fmt(state.ask),
    '[HIGH]':    fmt(state.high),
    '[LOW]':     fmt(state.low),
    '[FLOAT]':   state.float   || 'N/A',
    '[PREMP]':   fmt(state.preMarketPrice),
    '[PREMV]':   state.preMarketVolume
                   ? state.preMarketVolume.toLocaleString()
                   : 'N/A'
  }

  let resolved = template
  for (const [key, value] of Object.entries(replacements)) {
    resolved = resolved.replaceAll(key, value)
  }
  return resolved
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

function capitalize(str) {
  if (!str) return ''
  return str.charAt(0).toUpperCase() + str.slice(1)
}

// Works in both Node (main) and browser (renderer)
if (typeof module !== 'undefined') {
  module.exports = { resolvePlaceholders, formatElapsed }
}
