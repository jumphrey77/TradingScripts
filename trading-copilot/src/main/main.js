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
  mainWindow = new BrowserWindow({
    width:  380,
    height: 900,
    minWidth: 340,
    minHeight: 600,
    title: 'Trading Copilot',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    // Stays on top of Robinhood/broker window
    alwaysOnTop: false,
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
    width:  480,
    height: 560,
    title:  'Settings',
    parent: mainWindow,
    modal:  false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    resizable: false
  })

  configWindow.loadFile(path.join(__dirname, '../renderer/config.html'))
  configWindow.setMenu(null)

  configWindow.on('closed', () => {
    configWindow = null
  })
}

// ── App lifecycle ──────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  createMainWindow()

  // Init config manager first
  ConfigManager.init()

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
  // Restart Alpaca with new credentials
  cleanup()
  startAlpaca(config)
  if (configWindow) configWindow.close()
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
