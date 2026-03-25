// src/main/configManager.js
const path = require('path');
const fs = require('fs-extra');
const { app } = require('electron');

const DEFAULT_CONFIG = {
  version: '1.0.0',
  appRoot: '',
  backupRetentionRuns: 10,
  zipArchivePattern: 'Run{NNN}-{YYYY}{MM}{DD}-{HH}{mm}-{originalName}',
  watcherDebounceMs: 1500,
  logLevel: 'info'
};

const LEGACY_APP_ROOT = path.join(app.getPath('userData'), 'projects');

class ConfigManager {
  constructor() {
    this.configPath = path.join(app.getPath('userData'), 'zipmover_config.json');
    this.config = null;
  }

  async init() {
    let raw = null;

    // ── Step 1: Read the config file ────────────────────────────────────────
    try {
      if (await fs.pathExists(this.configPath)) {
        raw = await fs.readJson(this.configPath);
        console.log('[Config] Read config file. appRoot in file:', raw.appRoot);
      } else {
        console.log('[Config] No config file found — fresh install.');
      }
    } catch (err) {
      console.error('[Config] Failed to read config file:', err.message);
      // raw stays null — handled below
    }

    // ── Step 2: Build config — raw values ALWAYS win over defaults ──────────
    if (raw !== null) {
      this.config = { ...DEFAULT_CONFIG, ...raw };
    } else {
      this.config = { ...DEFAULT_CONFIG };
    }

    // ── Step 3: Upgrade guard — never let appRoot go blank if we have it ────
    // If merged result has blank appRoot but raw had a real value, restore it.
    if (!this.config.appRoot || this.config.appRoot.trim() === '') {
      if (raw && raw.appRoot && raw.appRoot.trim() !== '') {
        // Raw file had a valid path — restore directly
        console.log('[Config] Upgrade guard: restoring appRoot from raw:', raw.appRoot);
        this.config.appRoot = raw.appRoot.trim();
      } else if (await fs.pathExists(LEGACY_APP_ROOT)) {
        // v1 legacy path exists on disk
        console.log('[Config] Upgrade guard: restoring legacy appRoot:', LEGACY_APP_ROOT);
        this.config.appRoot = LEGACY_APP_ROOT;
      }
      // If appRoot was restored, persist it
      if (this.config.appRoot) {
        await this.save();
      }
    }

    // ── Step 4: Ensure the root folder exists ────────────────────────────────
    if (this.config.appRoot) {
      try {
        await fs.ensureDir(this.config.appRoot);
      } catch (err) {
        console.error('[Config] Could not ensure appRoot exists:', err.message);
        // Don't blank appRoot just because ensureDir failed — path may be on
        // a network drive that isn't mounted yet
      }
    }

    console.log('[Config] Final appRoot:', this.config.appRoot);
    console.log('[Config] needsSetup:', this.needsSetup());
  }

  needsSetup() {
    return !this.config.appRoot || this.config.appRoot.trim() === '';
  }

  async setAppRoot(folderPath) {
    await fs.ensureDir(folderPath);
    this.config.appRoot = folderPath;
    await this.save();
  }

  getConfig() {
    return { ...this.config };
  }

  getAppRoot() {
    return this.config.appRoot;
  }

  async updateConfig(updates) {
    this.config = { ...this.config, ...updates };
    await this.save();
  }

  async save() {
    await fs.ensureDir(path.dirname(this.configPath));
    await fs.writeJson(this.configPath, this.config, { spaces: 2 });
  }

  formatZipArchiveName(originalName, runNumber) {
    const now = new Date();
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    const baseName = path.basename(originalName, '.zip');
    return this.config.zipArchivePattern
      .replace('{NNN}', pad(runNumber, 3))
      .replace('{YYYY}', now.getFullYear())
      .replace('{MM}', pad(now.getMonth() + 1))
      .replace('{DD}', pad(now.getDate()))
      .replace('{HH}', pad(now.getHours()))
      .replace('{mm}', pad(now.getMinutes()))
      .replace('{originalName}', baseName)
      + '.zip';
  }

  formatWorkingFolderName(runNumber) {
    const now = new Date();
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `WorkingRun${String(runNumber).padStart(3,'0')}-${ts}`;
  }
}

module.exports = ConfigManager;
