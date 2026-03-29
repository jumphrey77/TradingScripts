// src/main/compactWindow.js
// Manages the compact always-on-top floating panel window

const { BrowserWindow, screen } = require('electron');
const path = require('path');

const COMPACT_WIDTH  = 340;
const ZONE_HEIGHT    = 110;   // px per zone row
const TITLEBAR_H     = 38;
const STATUSBAR_H    = 22;
const PADDING        = 16;
const COLS           = 2;     // zones per row

function calcHeight(projectCount) {
  const rows = Math.ceil(projectCount / COLS);
  return TITLEBAR_H + STATUSBAR_H + PADDING + (rows * ZONE_HEIGHT) + ((rows - 1) * 6);
}

class CompactWindowManager {
  constructor(configManager, onEvent) {
    this.config = configManager;
    this.onEvent = onEvent;
    this.window = null;
  }

  isOpen() {
    return this.window && !this.window.isDestroyed();
  }

  open() {
    if (this.isOpen()) {
      this.window.focus();
      return;
    }

    const cfg = this.config.getConfig();
    const savedPos = cfg.compactWindowPosition;

    // Default to top-right of primary display
    const display = screen.getPrimaryDisplay();
    const { width: sw, height: sh } = display.workAreaSize;
    const defaultX = sw - COMPACT_WIDTH - 20;
    const defaultY = 20;

    const x = savedPos ? savedPos.x : defaultX;
    const y = savedPos ? savedPos.y : defaultY;

    const savedSize = this.config.getConfig().compactWindowSize;
    const initW = COMPACT_WIDTH;
    const initH = savedSize ? savedSize.h : calcHeight(2);
    this.window = new BrowserWindow({
      width: initW,
      height: initH,
      minWidth: COMPACT_WIDTH,
      maxWidth: COMPACT_WIDTH,
      x, y,
      frame: false,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: false,
      transparent: false,
      backgroundColor: '#0f1117',
      roundedCorners: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    this.window.loadFile(path.join(__dirname, '../renderer/compact.html'));

    // Save position AND size when window is moved or resized
    const saveGeometry = () => {
      if (!this.window || this.window.isDestroyed()) return;
      const [wx, wy] = this.window.getPosition();
      const [ww, wh] = this.window.getSize();
      this.config.updateConfig({ compactWindowPosition: { x: wx, y: wy }, compactWindowSize: { w: ww, h: wh } });
    };
    this.window.on('moved',   saveGeometry);
    this.window.on('resized', saveGeometry);

    this.window.on('closed', () => {
      this.window = null;
      this.onEvent({ type: 'compact-closed' });
    });

    // Prevent navigation on file drop in compact window too
    this.window.webContents.on('will-navigate', (e, url) => {
      if (!url.endsWith('compact.html')) e.preventDefault();
    });
    this.window.webContents.on('will-frame-navigate', (e) => { e.preventDefault(); });

    if (process.argv.includes('--dev')) {
      this.window.webContents.openDevTools({ mode: 'detach' });
    }
  }

  close() {
    if (this.isOpen()) {
      this.window.close();
    }
  }

  send(channel, data) {
    if (this.isOpen()) {
      this.window.webContents.send(channel, data);
    }
  }

  // Resize height to fit content
  setHeight(height) {
    if (this.isOpen()) {
      const [wx, wy] = this.window.getPosition();
      this.window.setBounds({ x: wx, y: wy, width: COMPACT_WIDTH, height: Math.max(120, height) });
    }
  }
}

CompactWindowManager.calcHeight = calcHeight;
CompactWindowManager.COLS = COLS;
module.exports = CompactWindowManager;
