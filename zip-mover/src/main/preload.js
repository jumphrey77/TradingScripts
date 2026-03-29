// src/main/preload.js
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('zipmover', {
  // ── State ─────────────────────────────────────────────────────────────────
  getState: () => ipcRenderer.invoke('get-state'),

  // ── Setup ─────────────────────────────────────────────────────────────────
  browseZipMoverRoot: () => ipcRenderer.invoke('browse-zipmover-root'),
  setAppRoot:   (fp) => ipcRenderer.invoke('set-app-root',    { folderPath: fp }),
  changeAppRoot:(fp) => ipcRenderer.invoke('change-app-root', { folderPath: fp }),

  // ── Compact window ────────────────────────────────────────────────────────
  openCompact:    ()  => ipcRenderer.invoke('open-compact'),
  closeCompact:   ()  => ipcRenderer.invoke('close-compact'),
  compactResize:  (h) => ipcRenderer.invoke('compact-resize', { height: h }),

  // ── File drop ─────────────────────────────────────────────────────────────
  handleDrop:      (projectName, filePath) => ipcRenderer.invoke('handle-drop',      { projectName, filePath }),
  resolveConflict: (projectName, filename, filePath) => ipcRenderer.invoke('resolve-conflict', { projectName, filename, filePath }),

  // ── Shell ─────────────────────────────────────────────────────────────────
  openProjectFolder: (name) => ipcRenderer.invoke('open-project-folder', { name }),
  openRootFolder:    ()     => ipcRenderer.invoke('open-root-folder'),
  openRunLog:        (name) => ipcRenderer.invoke('open-run-log',      { name }),
  clearRunLog:          (name) => ipcRenderer.invoke('clear-run-log',         { name }),
  getMapWithSizes:      (name) => ipcRenderer.invoke('get-map-with-sizes',    { name }),
  clearZipArchive:      (name) => ipcRenderer.invoke('clear-zip-archive',     { name }),
  getZipArchiveCount:   (name) => ipcRenderer.invoke('get-zip-archive-count', { name }),

  // ── Projects ──────────────────────────────────────────────────────────────
  createProject:   (name, destinationRoot, excludedFolders) => ipcRenderer.invoke('create-project', { name, destinationRoot, excludedFolders }),
  deleteProject:   (name)                => ipcRenderer.invoke('delete-project',         { name }),
  rebuildMap:      (name, excludedFolders) => ipcRenderer.invoke('rebuild-map',           { name, excludedFolders }),
  scanRootFolders: (dest)                => ipcRenderer.invoke('scan-root-folders',       { destinationRoot: dest }),
  parseGitignore:  (dest)                => ipcRenderer.invoke('parse-gitignore',         { destinationRoot: dest }),
  updateExclusions:(name, ef)            => ipcRenderer.invoke('update-exclusions',       { name, excludedFolders: ef }),
  getProjectDetails:(name)               => ipcRenderer.invoke('get-project-details',     { name }),
  getProjectMap:   (name)                => ipcRenderer.invoke('get-project-map',         { name }),
  updateMapEntry:  (pn, fn, dest)        => ipcRenderer.invoke('update-map-entry',        { projectName: pn, filename: fn, destination: dest }),
  updateProjectSettings: (name, settings) => ipcRenderer.invoke('update-project-settings', { name, settings }),
  addWildcard:    (name, pattern, destination, description) => ipcRenderer.invoke('add-wildcard',    { name, pattern, destination, description }),
  removeWildcard: (name, pattern)                           => ipcRenderer.invoke('remove-wildcard', { name, pattern }),
  updateWildcard: (name, oldPattern, newEntry)              => ipcRenderer.invoke('update-wildcard', { name, oldPattern, newEntry }),
  getWildcards:   (name)                                    => ipcRenderer.invoke('get-wildcards',   { name }),
  toggleWatcher:   (name, active)        => ipcRenderer.invoke('toggle-watcher',          { name, active }),
  browseFolder:    ()                    => ipcRenderer.invoke('browse-folder'),
  updateConfig:    (updates)             => ipcRenderer.invoke('update-config',            updates),
  processZip:      (pn, zp)             => ipcRenderer.invoke('process-zip',              { projectName: pn, zipPath: zp }),

  // ── File path resolution (required for drag-and-drop with contextIsolation) ──
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // ── Events ────────────────────────────────────────────────────────────────
  onStateUpdate:  (cb) => { ipcRenderer.on('state-update',  (e, d) => cb(d)); return () => ipcRenderer.removeAllListeners('state-update');  },
  onWatcherEvent: (cb) => { ipcRenderer.on('watcher-event', (e, d) => cb(d)); return () => ipcRenderer.removeAllListeners('watcher-event'); },
  onRunComplete:  (cb) => { ipcRenderer.on('run-complete',  (e, d) => cb(d)); return () => ipcRenderer.removeAllListeners('run-complete');  },
  onAppError:     (cb) => { ipcRenderer.on('app-error',     (e, m) => cb(m)); return () => ipcRenderer.removeAllListeners('app-error');     },
  onCompactEvent: (cb) => { ipcRenderer.on('compact-event', (e, d) => cb(d)); return () => ipcRenderer.removeAllListeners('compact-event'); }
});
