// src/main/main.js
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const ConfigManager    = require('./configManager');
const ProjectManager   = require('./projectManager');
const ZipProcessor     = require('./zipProcessor');
const WatcherManager   = require('./watcherManager');
const CompactWindowManager = require('./compactWindow');
const FileDropHandler  = require('./fileDropHandler');

let mainWindow;
let configManager;
let projectManager;
let zipProcessor;
let watcherManager;
let compactWindowManager;
let fileDropHandler;

// Renderer calls get-state immediately — gate it until init is done
let appReadyResolve;
const appReady = new Promise(resolve => { appReadyResolve = resolve; });

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 900, minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0f1117',
    show: false,
    icon: path.join(__dirname, '../../assets/icon.png')
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.once('ready-to-show', () => { mainWindow.show(); initializeApp(); });
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools();
}

async function initializeApp() {
  try {
    configManager = new ConfigManager();
    await configManager.init();

    compactWindowManager = new CompactWindowManager(configManager, (evt) => {
      sendToMain('compact-event', evt);
      if (evt.type === 'compact-closed') {
        if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
      }
    });

    if (!configManager.needsSetup()) {
      await bootManagers();
    }
  } catch (err) {
    console.error('Failed to initialize app:', err);
    sendError('App initialization failed: ' + err.message);
  } finally {
    appReadyResolve();
  }
}

async function bootManagers() {
  projectManager = new ProjectManager(configManager);
  await projectManager.init();
  zipProcessor   = new ZipProcessor(configManager, projectManager);
  fileDropHandler = new FileDropHandler(configManager, projectManager, zipProcessor);
  watcherManager = new WatcherManager(projectManager, zipProcessor, (event) => {
    sendToMain('watcher-event', event);
    compactWindowManager.send('watcher-event', event);
    if (event.type === 'run-complete') {
      // Refresh state first so renderer gets up-to-date lastRun/fileCount
      sendStateUpdate();
      sendToMain('run-complete', { projectName: event.projectName, result: event.result });
      compactWindowManager.send('run-complete', { projectName: event.projectName, result: event.result });
    }
    if (event.type === 'run-failed') {
      sendStateUpdate();
    }
  });
  const projects = projectManager.getAllProjects();
  for (const p of projects) watcherManager.startWatcher(p.name);
  // Don't sendStateUpdate here — renderer fetches state via get-state after appReady
}

function sendToMain(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function sendStateUpdate() {
  const state = buildState();
  sendToMain('state-update', state);
  compactWindowManager.send('state-update', state);
}

function buildState() {
  return {
    projects: projectManager ? projectManager.getAllProjects() : [],
    config:   configManager  ? configManager.getConfig()      : {},
    watcherStatus: watcherManager ? watcherManager.getStatus() : {},
    needsSetup: configManager ? configManager.needsSetup() : true,
    appVersion: app.getVersion()
  };
}

function sendError(msg) { sendToMain('app-error', msg); }

// ─── IPC: State ──────────────────────────────────────────────────────────────

ipcMain.handle('get-state', async () => {
  await appReady;
  return buildState();
});

// ─── IPC: Setup ──────────────────────────────────────────────────────────────

ipcMain.handle('browse-zipmover-root', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'], title: 'Choose ZipMover Root Folder'
  });
  return r.canceled ? { success: false } : { success: true, path: r.filePaths[0] };
});

ipcMain.handle('set-app-root', async (event, { folderPath }) => {
  try { await configManager.setAppRoot(folderPath); await bootManagers(); return { success: true }; }
  catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('change-app-root', async (event, { folderPath }) => {
  try {
    if (watcherManager) watcherManager.stopAll();
    await configManager.setAppRoot(folderPath);
    await bootManagers();
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

// ─── IPC: Compact window ─────────────────────────────────────────────────────

ipcMain.handle('open-compact', async () => {
  compactWindowManager.open();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  return { success: true };
});

ipcMain.handle('close-compact', async () => {
  compactWindowManager.close();
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
  return { success: true };
});

ipcMain.handle('compact-resize', async (event, { height }) => {
  compactWindowManager.setHeight(height);
  return { success: true };
});

// ─── IPC: File drop ───────────────────────────────────────────────────────────

ipcMain.handle('handle-drop', async (event, { projectName, filePath }) => {
  try {
    const result = await fileDropHandler.handleDrop(projectName, filePath);
    sendStateUpdate();
    if (result.action !== 'conflict') {
      sendToMain('run-complete', { projectName, result: result.result });
      compactWindowManager.send('run-complete', { projectName, result: result.result });
    }
    return { success: true, ...result };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('resolve-conflict', async (event, { projectName, filename, filePath }) => {
  try {
    const result = await fileDropHandler.resolveConflict(projectName, filename, filePath);
    sendStateUpdate();
    sendToMain('run-complete', { projectName, result: result.result });
    compactWindowManager.send('run-complete', { projectName, result: result.result });
    return { success: true, ...result };
  } catch (err) { return { success: false, error: err.message }; }
});

// ─── IPC: Shell ──────────────────────────────────────────────────────────────

ipcMain.handle('open-project-folder', async (event, { name }) => {
  try {
    const p = projectManager.getAllProjects().find(p => p.name === name);
    if (!p) throw new Error('Project not found');
    await shell.openPath(p.projectDir);
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('open-root-folder', async () => {
  try { await shell.openPath(configManager.getAppRoot()); return { success: true }; }
  catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('clear-zip-archive', async (event, { name }) => {
  try {
    const p = projectManager.getAllProjects().find(p => p.name === name);
    if (!p) throw new Error('Project not found');
    const archiveDir = require('path').join(p.projectDir, 'ZipArchive');
    const files = await fs.readdir(archiveDir).catch(() => []);
    for (const f of files) await fs.remove(require('path').join(archiveDir, f));
    return { success: true, count: files.length };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('get-zip-archive-count', async (event, { name }) => {
  try {
    const p = projectManager.getAllProjects().find(p => p.name === name);
    if (!p) return { success: true, count: 0 };
    const archiveDir = require('path').join(p.projectDir, 'ZipArchive');
    const files = await fs.readdir(archiveDir).catch(() => []);
    return { success: true, count: files.filter(f => f.endsWith('.zip')).length };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('clear-run-log', async (event, { name }) => {
  try {
    const p = projectManager.getAllProjects().find(p => p.name === name);
    if (!p) throw new Error('Project not found');
    const logPath = require('path').join(p.projectDir, 'run_log.json');
    await fs.writeJson(logPath, []);
    // Reset nextRunNumber in map too
    await projectManager.resetRunNumber(name);
    sendStateUpdate();
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('open-run-log', async (event, { name }) => {
  try {
    const p = projectManager.getAllProjects().find(p => p.name === name);
    if (!p) throw new Error('Project not found');
    const logPath = path.join(p.projectDir, 'run_log.json');
    if (!(await fs.pathExists(logPath))) return { success: false, error: 'No run log yet.' };
    await shell.openPath(logPath);
    return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

// ─── IPC: Projects ───────────────────────────────────────────────────────────

ipcMain.handle('scan-root-folders', async (event, { destinationRoot }) => {
  try { return { success: true, folders: await projectManager.scanRootFolders(destinationRoot) }; }
  catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('parse-gitignore', async (event, { destinationRoot }) => {
  try { return { success: true, excluded: await projectManager.parseGitignoreFolders(destinationRoot) }; }
  catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('update-exclusions', async (event, { name, excludedFolders }) => {
  try {
    const map = await projectManager.updateExclusionsAndRebuild(name, excludedFolders);
    sendStateUpdate(); return { success: true, map };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('create-project', async (event, { name, destinationRoot, excludedFolders }) => {
  try {
    const project = await projectManager.createProject(name, destinationRoot, excludedFolders || []);
    watcherManager.startWatcher(name);
    sendStateUpdate(); return { success: true, project };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('delete-project', async (event, { name }) => {
  try {
    watcherManager.stopWatcher(name);
    await projectManager.deleteProject(name);
    sendStateUpdate(); return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('rebuild-map', async (event, { name, excludedFolders }) => {
  try {
    const map = await projectManager.rebuildMap(name, excludedFolders);
    sendStateUpdate(); return { success: true, map };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('get-project-details', async (event, { name }) => {
  try { return { success: true, details: await projectManager.getProjectDetails(name) }; }
  catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('get-map-with-sizes', async (event, { name }) => {
  try {
    const map = projectManager.getProjectMap(name);
    if (!map) return { success: false, error: 'No map found' };
    const fs2 = require('fs-extra');
    const filesWithSizes = {};
    for (const [filename, tokenizedPath] of Object.entries(map.files || {})) {
      const absPath = projectManager.resolveDestination(name, tokenizedPath);
      let size = null;
      try { const stat = await fs2.stat(absPath); size = stat.size; } catch (_) {}
      filesWithSizes[filename] = { dest: tokenizedPath, size };
    }
    return { success: true, map: { ...map, filesWithSizes } };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('get-project-map', async (event, { name }) => {
  try { return { success: true, map: projectManager.getProjectMap(name) }; }
  catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('update-map-entry', async (event, { projectName, filename, destination }) => {
  try {
    await projectManager.updateMapEntry(projectName, filename, destination);
    sendStateUpdate(); return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('update-project-settings', async (event, { name, settings }) => {
  try {
    await projectManager.updateProjectSettings(name, settings);
    sendStateUpdate(); return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('toggle-watcher', async (event, { name, active }) => {
  try {
    active ? watcherManager.startWatcher(name) : watcherManager.stopWatcher(name);
    sendStateUpdate(); return { success: true };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('browse-folder', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'], title: 'Select Destination Root Folder'
  });
  return r.canceled ? { success: false } : { success: true, path: r.filePaths[0] };
});

ipcMain.handle('update-config', async (event, updates) => {
  try { await configManager.updateConfig(updates); sendStateUpdate(); return { success: true }; }
  catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('process-zip', async (event, { projectName, zipPath }) => {
  try {
    const result = await zipProcessor.processZip(projectName, zipPath);
    sendStateUpdate();
    sendToMain('run-complete', { projectName, result });
    compactWindowManager.send('run-complete', { projectName, result });
    return { success: true, result };
  } catch (err) { return { success: false, error: err.message }; }
});

// App lifecycle
app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (watcherManager) watcherManager.stopAll();
  if (compactWindowManager) compactWindowManager.close();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
