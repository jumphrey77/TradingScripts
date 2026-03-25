// ============================================
// TRADING COPILOT — MAIN PROCESS (main.js)
// Entry point for the Electron app.
// Manages windows, IPC, and app lifecycle.
// ============================================

const { app, BrowserWindow, ipcMain, globalShortcut, shell } = require('electron')
const path = require('path')
require('dotenv').config()

const AlpacaService = require('./alpacaService')
const ConfigManager  = require('./configManager')

let mainWindow   = null
let configWindow = null
let alpacaService = null

// ── Create main trading panel window ──────────────────────────────────────────
function createMainWindow() {
  const config = ConfigManager.get()

  mainWindow = new BrowserWindow({
    width:     380,
    height:    900,
    minWidth:  380,
    maxWidth:  380,
    minHeight: 600,
    title: 'Trading Copilot',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    alwaysOnTop:       config.alwaysOnTop === true,
    alwaysOnTopLevel:  'screen-saver',
    frame: true,
    resizable: true
  })

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    cleanup()
  })
}

// ── Create config popup window ─────────────────────────────────────────────────
function createConfigWindow() {
  if (configWindow) {
    configWindow.focus()
    return
  }

  configWindow = new BrowserWindow({
    width:     520,
    height:    640,
    minWidth:  520,
    minHeight: 500,
    title:     'Settings',
    parent:    mainWindow,
    modal:     false,
    minimizable:  false,
    maximizable:  false,
    center:       false,        // we position manually below
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    resizable: true             // allow taller for Messages tab
  })

  configWindow.loadFile(path.join(__dirname, '../renderer/config.html'))
  configWindow.setMenu(null)

  // Center on the display the cursor is on (not over the parent window)
  const { screen } = require('electron')
  const cursor  = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { bounds } = display
  const winW = 520, winH = 640
  const x = Math.round(bounds.x + (bounds.width  - winW) / 2)
  const y = Math.round(bounds.y + (bounds.height - winH) / 2)
  configWindow.setPosition(x, y)

  configWindow.on('closed', () => {
    configWindow = null
  })
}

// ── App lifecycle ──────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Init config FIRST before creating window
  // (createMainWindow reads config for alwaysOnTop)
  ConfigManager.init()

  createMainWindow()

  // Init Alpaca if credentials exist
  const config = ConfigManager.get()
  if (config.alpacaKey && config.alpacaSecret) {
    startAlpaca(config)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    cleanup()
    app.quit()
  }
})

// ── Alpaca service management ──────────────────────────────────────────────────
function startAlpaca(config) {
  alpacaService = new AlpacaService(config)

  alpacaService.on('quote', (data) => {
    if (mainWindow) mainWindow.webContents.send('market:quote', data)
  })

  alpacaService.on('bar', (data) => {
    if (mainWindow) mainWindow.webContents.send('market:bar', data)
  })

  alpacaService.on('indicators', (data) => {
    if (mainWindow) mainWindow.webContents.send('market:indicators', data)
  })

  alpacaService.on('alert', (data) => {
    if (mainWindow) mainWindow.webContents.send('market:alert', data)
  })

  alpacaService.on('connected', () => {
    if (mainWindow) mainWindow.webContents.send('alpaca:status', { connected: true, paper: config.paper })
  })

  alpacaService.on('disconnected', () => {
    if (mainWindow) mainWindow.webContents.send('alpaca:status', { connected: false })
  })
}

function cleanup() {
  if (alpacaService) {
    alpacaService.disconnect()
    alpacaService = null
  }
}

// ── IPC Handlers — renderer → main ────────────────────────────────────────────

// Open config window
ipcMain.on('app:openConfig', () => {
  console.log('[Main] Opening config window')
  createConfigWindow()
})

// Subscribe to a ticker
ipcMain.on('market:subscribe', (event, ticker) => {
  if (alpacaService) alpacaService.subscribe(ticker)
})

// Unsubscribe from a ticker
ipcMain.on('market:unsubscribe', (event, ticker) => {
  if (alpacaService) alpacaService.unsubscribe(ticker)
})

// Set trade context (entry, stop, targets)
ipcMain.on('trade:setContext', (event, context) => {
  if (alpacaService) alpacaService.setTradeContext(context)
})

// Save config from config window
ipcMain.on('config:save', (event, config) => {
  ConfigManager.save(config)
  // Apply alwaysOnTop immediately without restart
  if (mainWindow) mainWindow.setAlwaysOnTop(config.alwaysOnTop === true)
  // Restart Alpaca with new credentials
  cleanup()
  startAlpaca(config)
  if (configWindow) configWindow.close()
  // Tell renderer to re-subscribe current ticker with new feed
  if (mainWindow) mainWindow.webContents.send('alpaca:resubscribe')
})

// Toggle alwaysOnTop live from renderer
ipcMain.on('app:openExternal', (event, url) => {
  if (url && url.startsWith('http')) {
    const { shell } = require('electron')
    shell.openExternal(url)
  }
})

ipcMain.on('app:setAlwaysOnTop', (event, value) => {
  // 'screen-saver' level ensures window stays above fullscreen/maximized apps
  if (mainWindow) mainWindow.setAlwaysOnTop(value, value ? 'screen-saver' : 'normal')
  const config = ConfigManager.get()
  config.alwaysOnTop = value
  ConfigManager.save(config)
})

// Get current config (for config window to populate)
ipcMain.handle('config:get', () => {
  return ConfigManager.get()
})

// Get messages JSON
ipcMain.handle('messages:get', () => {
  const fs = require('fs')
  const msgPath = path.join(__dirname, '../../data/claude_messages.json')
  try {
    return JSON.parse(fs.readFileSync(msgPath, 'utf8'))
  } catch (e) {
    return { messages: [], alerts: [] }
  }
})

// Save user-edited messages
ipcMain.on('messages:save', (event, messages) => {
  const fs = require('fs')
  const msgPath = path.join(__dirname, '../../data/claude_messages.json')
  fs.writeFileSync(msgPath, JSON.stringify(messages, null, 2))
})

// ── Safe fetch helper for main process ────────────────────────────────────────
async function apiFetch(url, options = {}) {
  // Use built-in fetch if available (Electron 21+/Node 18+)
  if (typeof fetch !== 'undefined') {
    return fetch(url, options)
  }
  // Fallback to Node https module
  const https  = require('https')
  const http   = require('http')
  const { URL } = require('url')
  const parsed = new URL(url)
  const client = parsed.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers:  options.headers || {}
    }
    const req = client.request(reqOptions, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        resolve({
          ok:   res.statusCode >= 200 && res.statusCode < 300,
          json: () => Promise.resolve(JSON.parse(data)),
          text: () => Promise.resolve(data),
          status: res.statusCode
        })
      })
    })
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

// ── Paper trade order execution ────────────────────────────────────────────────
ipcMain.handle('trade:submitOrder', async (event, order) => {
  try {
    const config  = ConfigManager.get()
    const baseUrl = config.alpacaBaseUrl || 'https://paper-api.alpaca.markets'
    // order payload is built fully in renderer and passed through
    const payload = JSON.stringify(order)
    const resp = await apiFetch(`${baseUrl}/v2/orders`, {
      method:  'POST',
      headers: {
        'APCA-API-KEY-ID':     config.alpacaKey,
        'APCA-API-SECRET-KEY': config.alpacaSecret,
        'Content-Type':        'application/json'
      },
      body: payload
    })
    const data = await resp.json()
    if (data.code) console.error('[Trade] Order error:', data.message)
    if (data.code) {
      // Alpaca error response has a code field
      return { success: false, error: data.message || JSON.stringify(data) }
    }
    return { success: true, order: data }
  } catch (e) {
    console.error('[Trade] Order failed:', e.message)
    return { success: false, error: e.message }
  }
})

// ── Get open positions ─────────────────────────────────────────────────────────
ipcMain.handle('trade:getPositions', async () => {
  try {
    const config  = ConfigManager.get()
    const baseUrl = config.alpacaBaseUrl || 'https://paper-api.alpaca.markets'
    const resp    = await apiFetch(`${baseUrl}/v2/positions`, {
      headers: {
        'APCA-API-KEY-ID':     config.alpacaKey,
        'APCA-API-SECRET-KEY': config.alpacaSecret
      }
    })
    const data = await resp.json()
    return { success: true, positions: data }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ── Get today's orders ────────────────────────────────────────────────────────
ipcMain.handle('trade:getOrders', async () => {
  try {
    const config  = ConfigManager.get()
    const baseUrl = config.alpacaBaseUrl || 'https://paper-api.alpaca.markets'
    const resp    = await apiFetch(`${baseUrl}/v2/orders?status=all&limit=20&direction=desc`, {
      headers: {
        'APCA-API-KEY-ID':     config.alpacaKey,
        'APCA-API-SECRET-KEY': config.alpacaSecret
      }
    })
    const data = await resp.json()
    return { success: true, orders: Array.isArray(data) ? data : [] }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ── Get account info ───────────────────────────────────────────────────────────
ipcMain.handle('trade:getAccount', async () => {
  try {
    const config  = ConfigManager.get()
    const baseUrl = config.alpacaBaseUrl || 'https://paper-api.alpaca.markets'
    const resp    = await apiFetch(`${baseUrl}/v2/account`, {
      headers: {
        'APCA-API-KEY-ID':     config.alpacaKey,
        'APCA-API-SECRET-KEY': config.alpacaSecret
      }
    })
    const data = await resp.json()
    return { success: true, account: data }
  } catch (e) {
    return { success: false, error: e.message }
  }
})
