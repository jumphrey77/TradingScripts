// src/main/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zipmover', {
  // ── Setup ─────────────────────────────────────────────────────────────────
  browseZipMoverRoot: () =>
    ipcRenderer.invoke('browse-zipmover-root'),

  setAppRoot: (folderPath) =>
    ipcRenderer.invoke('set-app-root', { folderPath }),

  changeAppRoot: (folderPath) =>
    ipcRenderer.invoke('change-app-root', { folderPath }),

  // ── Shell / folder access ─────────────────────────────────────────────────
  openProjectFolder: (name) =>
    ipcRenderer.invoke('open-project-folder', { name }),

  openRootFolder: () =>
    ipcRenderer.invoke('open-root-folder'),

  openRunLog: (name) =>
    ipcRenderer.invoke('open-run-log', { name }),

  // ── Project management ────────────────────────────────────────────────────
  createProject: (name, destinationRoot, excludedFolders) =>
    ipcRenderer.invoke('create-project', { name, destinationRoot, excludedFolders }),

  deleteProject: (name) =>
    ipcRenderer.invoke('delete-project', { name }),

  rebuildMap: (name, excludedFolders) =>
    ipcRenderer.invoke('rebuild-map', { name, excludedFolders }),

  scanRootFolders: (destinationRoot) =>
    ipcRenderer.invoke('scan-root-folders', { destinationRoot }),

  parseGitignore: (destinationRoot) =>
    ipcRenderer.invoke('parse-gitignore', { destinationRoot }),

  updateExclusions: (name, excludedFolders) =>
    ipcRenderer.invoke('update-exclusions', { name, excludedFolders }),

  getProjectDetails: (name) =>
    ipcRenderer.invoke('get-project-details', { name }),

  getProjectMap: (name) =>
    ipcRenderer.invoke('get-project-map', { name }),

  updateMapEntry: (projectName, filename, destination) =>
    ipcRenderer.invoke('update-map-entry', { projectName, filename, destination }),

  // ── Watcher ───────────────────────────────────────────────────────────────
  toggleWatcher: (name, active) =>
    ipcRenderer.invoke('toggle-watcher', { name, active }),

  // ── File system dialogs ───────────────────────────────────────────────────
  browseFolder: () =>
    ipcRenderer.invoke('browse-folder'),

  // ── Config ────────────────────────────────────────────────────────────────
  updateConfig: (updates) =>
    ipcRenderer.invoke('update-config', updates),

  // ── State ─────────────────────────────────────────────────────────────────
  getState: () =>
    ipcRenderer.invoke('get-state'),

  processZip: (projectName, zipPath) =>
    ipcRenderer.invoke('process-zip', { projectName, zipPath }),

  // ── Event listeners ───────────────────────────────────────────────────────
  onNeedsSetup: (callback) => {
    ipcRenderer.on('needs-setup', (event, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('needs-setup');
  },

  onStateUpdate: (callback) => {
    ipcRenderer.on('state-update', (event, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('state-update');
  },

  onWatcherEvent: (callback) => {
    ipcRenderer.on('watcher-event', (event, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('watcher-event');
  },

  onRunComplete: (callback) => {
    ipcRenderer.on('run-complete', (event, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('run-complete');
  },

  onAppError: (callback) => {
    ipcRenderer.on('app-error', (event, message) => callback(message));
    return () => ipcRenderer.removeAllListeners('app-error');
  }
});
