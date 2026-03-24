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

class ConfigManager {
  constructor() {
    this.configPath = path.join(app.getPath('userData'), 'zipmover_config.json');
    this.config = null;
  }

  async init() {
    try {
      if (await fs.pathExists(this.configPath)) {
        const raw = await fs.readJson(this.configPath);
        this.config = { ...DEFAULT_CONFIG, ...raw };
      } else {
        this.config = { ...DEFAULT_CONFIG };
        await this.save();
      }
      if (this.config.appRoot) {
        await fs.ensureDir(this.config.appRoot);
      }
    } catch (err) {
      console.error('ConfigManager init error:', err);
      this.config = { ...DEFAULT_CONFIG };
    }
  }

  // True on first launch before user picks a root folder
  needsSetup() {
    return !this.config.appRoot || this.config.appRoot.trim() === '';
  }

  // Persist the user-chosen root folder
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
