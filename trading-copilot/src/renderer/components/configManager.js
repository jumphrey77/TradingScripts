// ============================================
// TRADING COPILOT — CONFIG MANAGER
// Reads/writes user configuration to a local
// JSON file. Keeps credentials out of code.
// ============================================

const fs   = require('fs')
const path = require('path')

const CONFIG_PATH = path.join(__dirname, '../../config/user-config.json')

const DEFAULTS = {
  alpacaKey:          '',
  alpacaSecret:       '',
  alpacaBaseUrl:      'https://paper-api.alpaca.markets',
  alpacaDataUrl:      'https://data.alpaca.markets',
  paper:              true,
  defaultStrategy:    'regular',
  defaultMode:        'off',
  alertSound:         true,
  refreshMs:          1000,
  autoSendEnabled:    false,
  alertCooldownMs:    30000,
  alwaysOnTop:        false,
  autoCopyOnSelect:   true,
  tradePresets: [
    { name: 'Conservative', sl: 1.0, t1: 2.0, t2: 4.0 },
    { name: 'Standard',     sl: 2.0, t1: 3.0, t2: 6.0 },
    { name: 'Aggressive',   sl: 3.0, t1: 5.0, t2: 10.0 },
    { name: 'Scalp',        sl: 0.5, t1: 1.0, t2: 2.0 }
  ]
}

let _config = { ...DEFAULTS }

function init() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
      _config = { ...DEFAULTS, ...JSON.parse(raw) }
    } else {
      // Write defaults on first run
      save(DEFAULTS)
    }
  } catch (e) {
    console.error('[ConfigManager] Failed to load config:', e.message)
    _config = { ...DEFAULTS }
  }
}

function get() {
  return { ..._config }
}

function save(newConfig) {
  try {
    _config = { ...DEFAULTS, ...newConfig }
    const dir = path.dirname(CONFIG_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(_config, null, 2))
  } catch (e) {
    console.error('[ConfigManager] Failed to save config:', e.message)
  }
}

module.exports = { init, get, save }
