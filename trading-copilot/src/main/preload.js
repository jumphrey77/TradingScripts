// ============================================
// TRADING COPILOT — PRELOAD SCRIPT
// Secure bridge between Electron main process
// and the renderer (UI). Exposes only what
// the UI needs — nothing more.
// ============================================

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('copilot', {

  // ── Market data (main → renderer) ─────────────────────────────────────────
  onQuote:      (cb) => ipcRenderer.on('market:quote',      (_e, d) => cb(d)),
  onBar:        (cb) => ipcRenderer.on('market:bar',        (_e, d) => cb(d)),
  onIndicators: (cb) => ipcRenderer.on('market:indicators', (_e, d) => cb(d)),
  onAlert:      (cb) => ipcRenderer.on('market:alert',      (_e, d) => cb(d)),
  onStatus:     (cb) => ipcRenderer.on('alpaca:status',     (_e, d) => cb(d)),

  // ── Actions (renderer → main) ──────────────────────────────────────────────
  subscribe:      (ticker)  => ipcRenderer.send('market:subscribe', ticker),
  unsubscribe:    (ticker)  => ipcRenderer.send('market:unsubscribe', ticker),
  setTradeContext:(context) => ipcRenderer.send('trade:setContext', context),
  openConfig:     ()        => ipcRenderer.send('app:openConfig'),

  // ── Config ─────────────────────────────────────────────────────────────────
  getConfig:  ()       => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.send('config:save', config),

  // ── Messages ───────────────────────────────────────────────────────────────
  getMessages:  ()         => ipcRenderer.invoke('messages:get'),
  saveMessages: (messages) => ipcRenderer.send('messages:save', messages),

  // ── Window ─────────────────────────────────────────────────────────────────
  setAlwaysOnTop: (val) => ipcRenderer.send('app:setAlwaysOnTop', val),

  // ── Cleanup ─────────────────────────────────────────────────────────────────
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
})
