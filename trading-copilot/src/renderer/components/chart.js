// ============================================
// TRADING COPILOT — MINI CHART
// Draws a simple candlestick/line chart on
// the canvas element using the last 15 bars.
// ============================================

function updateMiniChart() {
  const canvas = document.getElementById('mini-chart')
  if (!canvas || !state.bars || state.bars.length < 2) return

  const ctx    = canvas.getContext('2d')
  const bars   = state.bars.slice(-15)
  const W      = canvas.offsetWidth  || 340
  const H      = canvas.offsetHeight || 56
  canvas.width  = W
  canvas.height = H

  ctx.clearRect(0, 0, W, H)

  const prices = bars.flatMap(b => [b.high, b.low])
  const minP   = Math.min(...prices)
  const maxP   = Math.max(...prices)
  const range  = maxP - minP || 0.01
  const pad    = 6

  const toY = price => H - pad - ((price - minP) / range) * (H - pad * 2)
  const barW = Math.floor((W - pad * 2) / bars.length) - 1

  bars.forEach((bar, i) => {
    const x    = pad + i * (barW + 1)
    const bull = bar.close >= bar.open
    const color= bull ? '#22c55e' : '#ef4444'

    ctx.strokeStyle = color
    ctx.fillStyle   = bull ? color : color
    ctx.lineWidth   = 1

    // Wick
    ctx.beginPath()
    ctx.moveTo(x + barW / 2, toY(bar.high))
    ctx.lineTo(x + barW / 2, toY(bar.low))
    ctx.stroke()

    // Body
    const bodyTop = toY(Math.max(bar.open, bar.close))
    const bodyH   = Math.max(1, Math.abs(toY(bar.open) - toY(bar.close)))
    ctx.fillRect(x, bodyTop, barW, bodyH)
  })

  // VWAP line
  if (state.vwap && state.vwap >= minP && state.vwap <= maxP) {
    const y = toY(state.vwap)
    ctx.strokeStyle = '#f59e0b'
    ctx.lineWidth   = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(pad, y)
    ctx.lineTo(W - pad, y)
    ctx.stroke()
    ctx.setLineDash([])
  }
}
